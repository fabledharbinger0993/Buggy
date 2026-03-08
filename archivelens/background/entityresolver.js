/**
 * entityresolver.js — Cross-archive entity resolution for ArchiveLens
 *
 * Determines when the same real-world person, organisation, or operation
 * appears under different names/aliases across archives and merges them into
 * a single canonical entity node in the graph.
 *
 * Two-stage approach:
 *  1. Deterministic: normalised string matching
 *  2. Probabilistic: Ollama-based semantic similarity for ambiguous pairs
 */

import { openDB, dbPut, dbGetAll } from '../lib/db.js';
import { getSetting } from '../lib/db.js';

// ── String normalisation ──────────────────────────────────────────────────────

/** Common honorifics to strip before comparison. */
const HONORIFICS = [
  'mr', 'mrs', 'ms', 'dr', 'prof', 'gen', 'col', 'lt', 'sgt', 'cpl',
  'adm', 'brig', 'maj', 'cpt', 'cmdr', 'sr', 'jr', 'ii', 'iii', 'iv',
];

/**
 * Normalise an entity surface form for deterministic matching.
 *
 * Steps:
 *  1. Lower-case
 *  2. Strip punctuation (keep spaces)
 *  3. Remove honorifics / suffixes
 *  4. Collapse whitespace
 *
 * Examples:
 *   "James Angleton"     → "james angleton"
 *   "ANGLETON, James"    → "james angleton"   (comma-surname detection)
 *   "J. Angleton"        → "j angleton"
 *   "Dr. Henry Kissinger"→ "henry kissinger"
 *
 * @param {string} name
 * @returns {string}
 */
export function normalise(name) {
  if (!name) return '';

  let s = name.toLowerCase();

  // Detect "SURNAME, Firstname" format and invert to "firstname surname"
  const commaMatch = s.match(/^([^,]+),\s*(.+)$/);
  if (commaMatch) {
    s = `${commaMatch[2]} ${commaMatch[1]}`;
  }

  // Strip punctuation (preserve spaces)
  s = s.replace(/[^a-z0-9\s]/g, ' ');

  // Remove honorifics
  s = s
    .split(/\s+/)
    .filter((token) => !HONORIFICS.includes(token))
    .join(' ');

  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();

  return s;
}

// ── Ollama prompt for entity resolution ──────────────────────────────────────

/**
 * Build the Ollama resolution prompt for two candidate entity descriptions.
 *
 * Expected JSON output schema:
 * {
 *   "likely_same": boolean,
 *   "confidence": float,   // 0.0–1.0, self-assessed by the model
 *   "reasoning": string
 * }
 *
 * NOTE: confidence is model-estimated, not statistically calibrated.
 */
function buildResolutionPrompt(entityA, entityB, subject) {
  return {
    system:
      'You are an expert archival research analyst performing entity resolution. ' +
      'Respond in raw JSON only. No preamble, markdown, or explanation.',
    user:
      `Research subject: "${subject}"\n\n` +
      `Entity A:\n${JSON.stringify(entityA, null, 2)}\n\n` +
      `Entity B:\n${JSON.stringify(entityB, null, 2)}\n\n` +
      'Do these two entries refer to the same real-world person, organisation, or operation? ' +
      'Consider their names, aliases, roles, affiliations, and co-occurring documents.\n\n' +
      'Respond with ONLY this JSON (no markdown, no explanation):\n' +
      '{\n' +
      '  "likely_same": <boolean>,\n' +
      '  "confidence": <float 0.0-1.0>,\n' +
      '  "reasoning": "<one sentence explanation>"\n' +
      '}',
  };
}

// ── Ollama call ───────────────────────────────────────────────────────────────

async function callOllama(db, prompt) {
  const endpoint = await getSetting(db, 'ollamaEndpoint', 'http://localhost:11434');
  const model = await getSetting(db, 'ollamaModel', 'mistral');

  const resp = await fetch(`${endpoint}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      system: prompt.system,
      prompt: prompt.user,
      stream: false,
    }),
  });

  if (!resp.ok) throw new Error(`Ollama error: ${resp.status}`);
  const data = await resp.json();
  return JSON.parse(data.response.trim());
}

// ── UUID generation ───────────────────────────────────────────────────────────

function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ── Co-occurrence counting ────────────────────────────────────────────────────

/**
 * Count shared document IDs between two raw entity objects.
 * @param {{documentIds: string[]}} a
 * @param {{documentIds: string[]}} b
 * @returns {number}
 */
function coOccurrenceCount(a, b) {
  const setA = new Set(a.documentIds || []);
  return (b.documentIds || []).filter((id) => setA.has(id)).length;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Resolve a list of raw extracted entities into a deduplicated, canonicalised
 * list. Merges aliases, handles deterministic and probabilistic matching.
 *
 * @param {object[]} entityList - raw entities from extraction
 * @param {string}   sessionId
 * @param {string}   subject    - primary search subject (for Ollama context)
 * @returns {Promise<object[]>} canonicalised entity list
 */
export async function resolveEntities(entityList, sessionId, subject) {
  const db = await openDB();

  // ── Stage 1: Deterministic normalised string matching ────────────────────

  // Map from normalised key → canonical entity
  const canonical = new Map();

  for (const raw of entityList) {
    const key = normalise(raw.name || raw.canonical || '');
    if (!key) continue;

    if (canonical.has(key)) {
      // Merge into existing canonical entry
      const existing = canonical.get(key);
      const surfaceForm = raw.name || raw.canonical;
      if (!existing.aliases.includes(surfaceForm)) {
        existing.aliases.push(surfaceForm);
      }
      // Merge document references
      const docSet = new Set(existing.documentIds);
      for (const id of raw.documentIds || []) docSet.add(id);
      existing.documentIds = Array.from(docSet);
    } else {
      // Create new canonical entry
      const surfaceForm = raw.name || raw.canonical || key;
      canonical.set(key, {
        id: uuidv4(),
        sessionId,
        canonical: surfaceForm,
        type: raw.type || 'other',
        aliases: [surfaceForm],
        role: raw.role || '',
        attributes: raw.attributes || {},
        consistencyFlag: null,
        discrepancies: [],
        merge_log: [],
        documentIds: [...(raw.documentIds || [])],
        confidence: raw.confidence || 0,
      });
    }
  }

  const entities = Array.from(canonical.values());

  // ── Stage 2: Probabilistic Ollama-based resolution ──────────────────────
  // For pairs that share ≥ 2 co-occurring documents but were not merged by
  // Stage 1, ask Ollama whether they refer to the same real-world entity.

  const MERGE_CONFIDENCE_THRESHOLD = 0.75;
  const merged = new Set(); // entity IDs already merged away

  for (let i = 0; i < entities.length; i++) {
    if (merged.has(entities[i].id)) continue;
    for (let j = i + 1; j < entities.length; j++) {
      if (merged.has(entities[j].id)) continue;

      const sharedDocs = coOccurrenceCount(entities[i], entities[j]);
      if (sharedDocs < 2) continue;

      let result;
      try {
        const prompt = buildResolutionPrompt(
          { name: entities[i].canonical, role: entities[i].role, aliases: entities[i].aliases },
          { name: entities[j].canonical, role: entities[j].role, aliases: entities[j].aliases },
          subject
        );
        result = await callOllama(db, prompt);
      } catch {
        // If Ollama is unavailable, skip probabilistic merge for this pair
        continue;
      }

      if (result.likely_same === true && result.confidence >= MERGE_CONFIDENCE_THRESHOLD) {
        // Merge entity[j] into entity[i]
        const logEntry = {
          mergedFrom: entities[j].canonical,
          mergedInto: entities[i].canonical,
          confidence: result.confidence,
          reasoning: result.reasoning,
          mergedAt: Date.now(),
        };
        entities[i].aliases.push(...entities[j].aliases.filter((a) => !entities[i].aliases.includes(a)));
        const docSet = new Set(entities[i].documentIds);
        for (const id of entities[j].documentIds) docSet.add(id);
        entities[i].documentIds = Array.from(docSet);
        entities[i].merge_log.push(logEntry);
        merged.add(entities[j].id);
      } else if (result.likely_same === true && result.confidence < MERGE_CONFIDENCE_THRESHOLD) {
        // Flag as possible duplicate for manual review
        entities[i].possibleDuplicate = entities[j].id;
        entities[j].possibleDuplicate = entities[i].id;
      }
    }
  }

  // Filter out merged-away entities and persist the rest
  const final = entities.filter((e) => !merged.has(e.id));
  for (const entity of final) {
    await dbPut(db, 'entities', entity);
  }

  return final;
}
