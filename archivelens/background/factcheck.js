/**
 * factcheck.js — Ollama-based findings verification and fact-checking pipeline
 *
 * Verifies extracted claims and entities on two axes:
 *  1. Cross-document corroboration (UNCORROBORATED / SINGLE-SOURCE / CORROBORATED)
 *  2. Entity consistency checking across sources (CONSISTENT / DISCREPANCY)
 *
 * All verification results are written back to IndexedDB before resolution.
 */

import { openDB, dbPut, dbGetAll, getSetting } from '../lib/db.js';

// ── Constants ────────────────────────────────────────────────────────────────

/** Batch size for Ollama calls (entities/claims per batch). */
const BATCH_SIZE = 10;

/** Delay between Ollama batches (ms). */
const BATCH_DELAY_MS = 500;

// ── Ollama prompt: entity consistency checking ────────────────────────────────

/**
 * Build the consistency-checking prompt sent to Ollama.
 *
 * Expected JSON output schema:
 * {
 *   "entity": string,
 *   "consistent": boolean,
 *   "conflicting_attributes": [
 *     {
 *       "attribute": string,
 *       "value_a": string,
 *       "source_a": string,
 *       "value_b": string,
 *       "source_b": string
 *     }
 *   ]
 * }
 * If no conflicts exist, conflicting_attributes is an empty array.
 *
 * NOTE: The model cannot produce statistically calibrated confidence values.
 * All self-assessed scores are model-estimated and are labelled as such in the UI.
 */
function buildConsistencyPrompt(entityName, descriptions) {
  return {
    system:
      'You are an expert archival analyst performing entity consistency verification. ' +
      'Respond in raw JSON only. No preamble, markdown, or explanation.',
    user:
      `Entity: "${entityName}"\n\n` +
      'The following descriptions of this entity were extracted from different source documents:\n\n' +
      descriptions
        .map((d, i) => `Source ${i + 1} (${d.sourceUrl}):\n${JSON.stringify(d.attributes, null, 2)}`)
        .join('\n\n') +
      '\n\nCompare the descriptive attributes (role, affiliation, date ranges, locations). ' +
      'Identify any contradictions between sources.\n\n' +
      'Respond with ONLY this JSON (no markdown, no explanation):\n' +
      '{\n' +
      '  "entity": "<entity name>",\n' +
      '  "consistent": <boolean>,\n' +
      '  "conflicting_attributes": [\n' +
      '    {\n' +
      '      "attribute": "<attribute name>",\n' +
      '      "value_a": "<value from source A>",\n' +
      '      "source_a": "<URL of source A>",\n' +
      '      "value_b": "<value from source B>",\n' +
      '      "source_b": "<URL of source B>"\n' +
      '    }\n' +
      '  ]\n' +
      '}',
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * Extract the domain from a URL string; returns '' on failure.
 * @param {string} url
 * @returns {string}
 */
function extractDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
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

// ── Corroboration axis ────────────────────────────────────────────────────────

/**
 * Determine corroboration status for a claim.
 *
 * @param {object}   claim        - claim object (has sourceDocumentIds)
 * @param {object[]} allDocuments - all session documents
 * @returns {'UNCORROBORATED'|'SINGLE-SOURCE'|'CORROBORATED'}
 */
function computeCorroborationStatus(claim, allDocuments) {
  if (!claim.sourceDocumentIds || claim.sourceDocumentIds.length === 0) {
    return 'UNCORROBORATED';
  }

  // Collect distinct archive domains for the source documents
  const domains = new Set();
  for (const docId of claim.sourceDocumentIds) {
    const doc = allDocuments.find((d) => d.id === docId);
    if (doc && doc.url) {
      const domain = extractDomain(doc.url);
      if (domain) domains.add(domain);
    }
  }

  if (domains.size === 0) return 'UNCORROBORATED';
  if (domains.size === 1) return 'SINGLE-SOURCE';
  return 'CORROBORATED';
}

// ── Entity consistency axis ───────────────────────────────────────────────────

/**
 * Build a list of per-document attribute descriptions for an entity.
 *
 * @param {object}   entity       - canonical entity record
 * @param {object[]} allDocuments - all session documents
 * @returns {Array<{sourceUrl: string, attributes: object}>}
 */
function buildEntityDescriptions(entity, allDocuments) {
  const descriptions = [];
  for (const docId of entity.documentIds || []) {
    const doc = allDocuments.find((d) => d.id === docId);
    if (!doc) continue;
    // Gather any attributes extracted in the context of this specific document
    const attrs = {
      role: entity.role || 'unknown',
      ...((entity.attributesByDoc && entity.attributesByDoc[docId]) || {}),
    };
    descriptions.push({ sourceUrl: doc.url, attributes: attrs });
  }
  return descriptions;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Verify all findings for a session.
 *
 * Annotates every claim with a corroborationStatus and every entity with a
 * consistencyFlag (and discrepancies if applicable). Results are written back
 * to IndexedDB and returned as an annotated copy of the inputs.
 *
 * @param {object}   entityGraph  - { entities: object[], relationships: object[] }
 * @param {object[]} citationLog  - array of document/claim objects
 * @param {string}   sessionId
 * @returns {Promise<{entityGraph: object, citationLog: object[]}>}
 */
export async function verifyFindings(entityGraph, citationLog, sessionId) {
  const db = await openDB();
  const allDocuments = await dbGetAll(db, 'documents', 'sessionId', sessionId);

  // ── Axis 1: Cross-document corroboration ─────────────────────────────────

  const claims = entityGraph.relationships || [];

  // Process claims in batches of BATCH_SIZE
  for (let i = 0; i < claims.length; i += BATCH_SIZE) {
    const batch = claims.slice(i, i + BATCH_SIZE);

    for (const claim of batch) {
      claim.corroborationStatus = computeCorroborationStatus(claim, allDocuments);
      claim.id = claim.id || uuidv4();
      claim.sessionId = sessionId;
      await dbPut(db, 'claims', claim);
    }

    if (i + BATCH_SIZE < claims.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  // ── Axis 2: Entity consistency checking ──────────────────────────────────

  const entities = entityGraph.entities || [];

  for (let i = 0; i < entities.length; i += BATCH_SIZE) {
    const batch = entities.slice(i, i + BATCH_SIZE);

    for (const entity of batch) {
      // Only run consistency check for entities appearing in multiple documents
      if ((entity.documentIds || []).length < 2) {
        entity.consistencyFlag = 'CONSISTENT';
        entity.discrepancies = [];
        await dbPut(db, 'entities', entity);
        continue;
      }

      const descriptions = buildEntityDescriptions(entity, allDocuments);
      if (descriptions.length < 2) {
        entity.consistencyFlag = 'CONSISTENT';
        entity.discrepancies = [];
        await dbPut(db, 'entities', entity);
        continue;
      }

      try {
        const prompt = buildConsistencyPrompt(entity.canonical, descriptions);
        const result = await callOllama(db, prompt);

        entity.consistencyFlag = result.consistent ? 'CONSISTENT' : 'DISCREPANCY';
        entity.discrepancies = result.conflicting_attributes || [];
      } catch {
        // Ollama unavailable — mark as unverified rather than failing
        entity.consistencyFlag = null;
        entity.discrepancies = [];
      }

      await dbPut(db, 'entities', entity);
    }

    if (i + BATCH_SIZE < entities.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  // Annotate the citation log entries with their corroboration status
  const annotatedCitationLog = citationLog.map((entry) => {
    const relatedClaims = claims.filter(
      (c) => c.sourceDocumentIds && c.sourceDocumentIds.includes(entry.id)
    );
    return {
      ...entry,
      corroborationStatuses: relatedClaims.map((c) => c.corroborationStatus),
    };
  });

  return {
    entityGraph: { ...entityGraph, entities, relationships: claims },
    citationLog: annotatedCitationLog,
  };
}
