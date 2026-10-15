/**
 * service-worker.js — Background service worker for ArchiveLens
 *
 * Responsibilities:
 *  - Crawl orchestration (BFS up to configurable depth)
 *  - Ollama communication for entity extraction, relationship scoring, and brief generation
 *  - IndexedDB writes for all persistent data
 *  - Session autosave every 5 minutes during an active crawl
 *  - Integration with factcheck, entityresolver, and crawlpolicy modules
 */

import { openDB, dbGet, dbPut, dbGetAll, getSetting, setSetting } from '../lib/db.js';
import { enqueueFetch, isCaptchaBlocked, resumeDomain } from './crawlpolicy.js';
import { resolveEntities } from './entityresolver.js';
import { verifyFindings } from './factcheck.js';

// ── Archival source configuration ─────────────────────────────────────────────

/**
 * Default archive source configuration.
 * Each entry describes how to discover and extract document content.
 * Users can extend this list in settings without modifying source code.
 */
const DEFAULT_ARCHIVE_SOURCES = [
  {
    id: 'theblackvault',
    name: 'The Black Vault',
    domain: 'www.theblackvault.com',
    searchUrl: 'https://www.theblackvault.com/documentarchive/?s={QUERY}',
    // Links to individual document pages inside search results
    linkSelector: 'h2.entry-title a',
    // The main body text of a document page
    contentSelector: '.entry-content',
    // Quirk: many documents link to external PDF hosts; follow those links
    followExternalPdfs: true,
    enabled: true,
  },
  {
    id: 'cia_crest',
    name: 'CIA CREST Reading Room',
    domain: 'www.cia.gov',
    searchUrl: 'https://www.cia.gov/readingroom/search/site/{QUERY}',
    linkSelector: '.views-field-title a',
    contentSelector: '.field-items',
    // Quirk: many docs are PDFs hosted on the same domain
    followExternalPdfs: false,
    enabled: true,
  },
  {
    id: 'wikileaks',
    name: 'WikiLeaks',
    domain: 'wikileaks.org',
    searchUrl: 'https://wikileaks.org/search?q={QUERY}',
    linkSelector: 'div.result h3 a',
    contentSelector: 'div.wiki-content, div.document-content',
    followExternalPdfs: false,
    enabled: true,
  },
  {
    id: 'nsarchive',
    name: 'National Security Archive',
    domain: 'nsarchive.gwu.edu',
    searchUrl: 'https://nsarchive.gwu.edu/search?query={QUERY}',
    linkSelector: '.view-content .views-row h3 a',
    contentSelector: '.field-type-text-with-summary',
    followExternalPdfs: true,
    enabled: true,
  },
  {
    id: 'internetarchive',
    name: 'Internet Archive',
    domain: 'archive.org',
    searchUrl: 'https://archive.org/search?query={QUERY}',
    linkSelector: 'div.results h3 a',
    contentSelector: '#descript',
    // Quirk: item pages embed text/PDF viewers; extract from metadata JSON when possible
    followExternalPdfs: true,
    enabled: true,
  },
];

// ── Ollama prompt templates ───────────────────────────────────────────────────

/**
 * PROMPT 1: Entity extraction from a document chunk.
 *
 * Output schema:
 * {
 *   "entities": [
 *     {
 *       "name": string,
 *       "type": "person"|"organization"|"location"|"date"|"operation"|"fileNumber"|"other",
 *       "role": string,
 *       "confidence": float  // 0.0–1.0, model-estimated (not statistically calibrated)
 *     }
 *   ],
 *   "relationships": [
 *     {
 *       "entity_a": string,
 *       "entity_b": string,
 *       "relationship": string,
 *       "date": string,
 *       "location": string,
 *       "action": string,
 *       "confidence": float
 *     }
 *   ],
 *   "relevance_to_subject": float  // 0.0–1.0
 * }
 */
function buildExtractionPrompt(subject, contextCues, chunkText) {
  return {
    system:
      'You are an expert intelligence analyst and information extraction system. ' +
      'Extract named entities and relationships from the provided archival document text. ' +
      'Respond in raw JSON only. No preamble, markdown, or explanation.',
    user:
      `Primary search subject: "${subject}"\n` +
      (contextCues ? `Context cues: ${contextCues}\n` : '') +
      '\nDocument text:\n' +
      '"""\n' + chunkText + '\n"""\n\n' +
      'Extract ALL named entities (persons, organisations, locations, dates, operations, file numbers) ' +
      'and their relationships. For each entity provide an inferred role. ' +
      'For each relationship include date, location, and action when discernible. ' +
      'Include a relevance_to_subject score for this chunk.\n\n' +
      'IMPORTANT: confidence values are model self-assessments (0.0–1.0) and are NOT ' +
      'statistically calibrated probabilities.\n\n' +
      'Respond with ONLY this JSON:\n' +
      '{\n' +
      '  "entities": [\n' +
      '    { "name": "...", "type": "person|organization|location|date|operation|fileNumber|other",\n' +
      '      "role": "...", "confidence": 0.0 }\n' +
      '  ],\n' +
      '  "relationships": [\n' +
      '    { "entity_a": "...", "entity_b": "...", "relationship": "...",\n' +
      '      "date": "...", "location": "...", "action": "...", "confidence": 0.0 }\n' +
      '  ],\n' +
      '  "relevance_to_subject": 0.0\n' +
      '}',
  };
}

/**
 * PROMPT 2: Relationship scoring between two entities relative to a search subject.
 *
 * Output schema:
 * {
 *   "entity_a": string,
 *   "entity_b": string,
 *   "relationship_strength": float,
 *   "relationship_type": string,
 *   "co_occurrence_confidence": float,
 *   "notes": string
 * }
 */
function buildRelationshipScoringPrompt(subject, entityA, entityB, coOccurrences) {
  return {
    system:
      'You are an expert archival analyst scoring entity relationships. ' +
      'Respond in raw JSON only. No preamble, markdown, or explanation.',
    user:
      `Research subject: "${subject}"\n\n` +
      `Entity A: ${JSON.stringify(entityA)}\n` +
      `Entity B: ${JSON.stringify(entityB)}\n\n` +
      `These entities co-occur in ${coOccurrences} documents. ` +
      'Score the strength of their relationship relative to the search subject.\n\n' +
      'Respond with ONLY this JSON:\n' +
      '{\n' +
      '  "entity_a": "...",\n' +
      '  "entity_b": "...",\n' +
      '  "relationship_strength": 0.0,\n' +
      '  "relationship_type": "...",\n' +
      '  "co_occurrence_confidence": 0.0,\n' +
      '  "notes": "..."\n' +
      '}',
  };
}

/**
 * PROMPT 3: Context brief generation from the compiled entity graph.
 *
 * Output schema:
 * {
 *   "timeline": [
 *     { "date": string, "event": string, "sources": string[] }
 *   ],
 *   "cast": [
 *     { "name": string, "role": string, "relationship_to_subject": string }
 *   ],
 *   "subplots": [ string ],
 *   "follow_up_directives": [
 *     { "query": string, "reason": string }
 *   ],
 *   "narrative": string
 * }
 */
function buildBriefPrompt(subject, entityGraph, citationLog) {
  const topEntities = (entityGraph.entities || [])
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    .slice(0, 30);
  const topDocs = (citationLog || [])
    .sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))
    .slice(0, 20);

  return {
    system:
      'You are a senior intelligence analyst synthesising archival research findings. ' +
      'Respond in raw JSON only. No preamble, markdown, or explanation.',
    user:
      `Primary subject: "${subject}"\n\n` +
      `Top entities:\n${JSON.stringify(topEntities, null, 2)}\n\n` +
      `Key source documents:\n${JSON.stringify(topDocs.map((d) => ({
        title: d.title, url: d.url, date: d.date, summary: d.summary,
      })), null, 2)}\n\n` +
      'Synthesise a structured research brief. Include a chronological timeline with ' +
      'inline source citations, a cast of connected characters with roles, identified ' +
      'sub-plots, and specific follow-up search directives.\n\n' +
      'Respond with ONLY this JSON:\n' +
      '{\n' +
      '  "timeline": [ { "date": "...", "event": "...", "sources": ["url1"] } ],\n' +
      '  "cast": [ { "name": "...", "role": "...", "relationship_to_subject": "..." } ],\n' +
      '  "subplots": [ "..." ],\n' +
      '  "follow_up_directives": [ { "query": "...", "reason": "..." } ],\n' +
      '  "narrative": "..."\n' +
      '}',
  };
}

// ── Text chunking ─────────────────────────────────────────────────────────────

const CHUNK_SIZE_TOKENS = 2000;
const CHUNK_OVERLAP_TOKENS = 200;
// Approximate: 1 token ≈ 4 characters
const CHARS_PER_TOKEN = 4;

/**
 * Split text into overlapping chunks for Ollama processing.
 * Documents > 2,000 tokens are split with 200-token overlap.
 *
 * @param {string} text
 * @returns {string[]}
 */
function chunkText(text) {
  const chunkChars = CHUNK_SIZE_TOKENS * CHARS_PER_TOKEN;
  const overlapChars = CHUNK_OVERLAP_TOKENS * CHARS_PER_TOKEN;

  if (text.length <= chunkChars) return [text];

  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkChars, text.length);
    chunks.push(text.slice(start, end));
    start += chunkChars - overlapChars;
  }
  return chunks;
}

/** Autosave interval during active crawls (ms). */
const AUTOSAVE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes



function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ── Ollama communication ──────────────────────────────────────────────────────

async function callOllama(db, prompt) {
  const endpoint = await getSetting(db, 'ollamaEndpoint', 'http://localhost:11434');
  const model = await getSetting(db, 'ollamaModel', 'mistral');

  const resp = await fetch(`${endpoint}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, system: prompt.system, prompt: prompt.user, stream: false }),
  });
  if (!resp.ok) throw new Error(`Ollama error ${resp.status}`);
  const data = await resp.json();
  return JSON.parse(data.response.trim());
}

// ── Document text extraction ──────────────────────────────────────────────────

/**
 * Extract visible text from an HTML body string using a CSS selector.
 *
 * @param {string} html         - raw HTML
 * @param {string} selector     - CSS selector for content element
 * @returns {string}            - extracted text content
 */
function extractTextFromHtml(html, selector) {
  // Use DOMParser (available in service workers on modern browsers) or fallback
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const el = doc.querySelector(selector);
    return el ? el.innerText || el.textContent || '' : doc.body.textContent || '';
  } catch {
    // Fallback: strip HTML tags
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

/**
 * Extract document links from a search-result page.
 *
 * @param {string} html         - raw HTML of search results page
 * @param {string} selector     - CSS selector for link elements
 * @param {string} baseUrl      - base URL for resolving relative hrefs
 * @returns {string[]}          - absolute URLs of discovered documents
 */
function extractLinks(html, selector, baseUrl) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const base = new URL(baseUrl);
    return Array.from(doc.querySelectorAll(selector))
      .map((a) => {
        try { return new URL(a.getAttribute('href') || '', base).href; }
        catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ── Core crawl logic ──────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Crawl a single URL, extract text, run Ollama extraction on chunks,
 * and persist the document + extracted entities to IndexedDB.
 *
 * @param {object} params
 * @param {string} params.url
 * @param {string} params.sessionId
 * @param {string} params.subject
 * @param {string} params.contextCues
 * @param {string} params.archiveId
 * @param {string} params.contentSelector
 * @param {object} params.db
 * @param {string} params.contactEmail
 * @param {number} params.userDelayMs
 * @returns {Promise<object|null>} the persisted document record, or null on failure
 */
async function crawlDocument({
  url, sessionId, subject, contextCues, archiveId,
  contentSelector, db, contactEmail, userDelayMs,
}) {
  const fetchResult = await enqueueFetch(url, { contactEmail, userDelayMs });

  if (!fetchResult.ok) {
    // Log access-denied and other failures to IndexedDB for manual review
    const docRecord = {
      id: uuidv4(),
      sessionId,
      url,
      title: url,
      archive: archiveId,
      date: '',
      bodyText: '',
      summary: '',
      entities: [],
      relevanceScore: 0,
      accessStatus: fetchResult.accessStatus || 'error',
      fetchedAt: Date.now(),
    };
    await dbPut(db, 'documents', docRecord);
    return null;
  }

  const bodyText = extractTextFromHtml(fetchResult.body, contentSelector);
  if (!bodyText.trim()) return null;

  // Chunk the document and run extraction on each chunk
  const chunks = chunkText(bodyText);
  const allEntities = [];
  const allRelationships = [];
  let totalRelevance = 0;

  for (const chunk of chunks) {
    try {
      const prompt = buildExtractionPrompt(subject, contextCues, chunk);
      const result = await callOllama(db, prompt);
      allEntities.push(...(result.entities || []));
      allRelationships.push(...(result.relationships || []));
      totalRelevance += result.relevance_to_subject || 0;
    } catch {
      // Ollama unavailable for this chunk — continue
    }
  }

  const relevanceScore = chunks.length > 0 ? totalRelevance / chunks.length : 0;

  // Generate a one-sentence summary using the first chunk
  let summary = '';
  try {
    const summaryPrompt = {
      system: 'Summarise the document in one sentence. Respond with plain text only.',
      user: bodyText.slice(0, 800),
    };
    const endpoint = await getSetting(db, 'ollamaEndpoint', 'http://localhost:11434');
    const model = await getSetting(db, 'ollamaModel', 'mistral');
    const resp = await fetch(`${endpoint}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, system: summaryPrompt.system, prompt: summaryPrompt.user, stream: false }),
    });
    if (resp.ok) {
      const data = await resp.json();
      summary = (data.response || '').trim().slice(0, 300);
    }
  } catch { /* summary generation is best-effort */ }

  // Extract a rough title from the HTML
  let title = url;
  try {
    const parser = new DOMParser();
    const htmlDoc = parser.parseFromString(fetchResult.body, 'text/html');
    title = htmlDoc.title || url;
  } catch { /* ignore */ }

  const docRecord = {
    id: uuidv4(),
    sessionId,
    url,
    title,
    archive: archiveId,
    date: '',
    bodyText,
    summary,
    entities: allEntities.map((e) => e.name),
    relevanceScore,
    accessStatus: 'ok',
    fetchedAt: Date.now(),
    // Raw extracted data (used by entityresolver and factcheck)
    _rawEntities: allEntities,
    _rawRelationships: allRelationships.map((r) => ({
      ...r,
      sourceDocumentIds: [], // populated after doc ID assigned
    })),
  };

  // Back-fill the document ID into relationships
  docRecord._rawRelationships = docRecord._rawRelationships.map((r) => ({
    ...r,
    sourceDocumentIds: [docRecord.id],
  }));

  await dbPut(db, 'documents', docRecord);
  return docRecord;
}

// ── BFS crawler ───────────────────────────────────────────────────────────────

/**
 * Perform a breadth-first crawl starting from search result URLs, following
 * document links up to `maxDepth` levels.
 *
 * @param {object} params
 * @param {string}   params.sessionId
 * @param {string}   params.subject
 * @param {string}   params.contextCues
 * @param {string[]} params.archiveIds     - IDs of archives to search
 * @param {number}   params.maxDepth       - crawl depth (default: 2)
 * @param {object}   params.db
 * @param {string}   params.contactEmail
 * @param {number}   params.userDelayMs
 * @returns {Promise<{documents: object[], entities: object[], relationships: object[]}>}
 */
async function runCrawl({
  sessionId, subject, contextCues, archiveIds, maxDepth = 2,
  db, contactEmail, userDelayMs,
}) {
  const sources = await getSetting(db, 'archiveSources', DEFAULT_ARCHIVE_SOURCES);
  const activeSources = sources.filter(
    (s) => s.enabled && archiveIds.includes(s.id)
  );

  const visitedUrls = new Set();
  const allDocuments = [];
  const allRawEntities = [];
  const allRawRelationships = [];

  // Queue entries: { url, depth, archiveId, contentSelector }
  const queue = [];

  // Seed the queue with search result URLs
  for (const source of activeSources) {
    const searchUrl = source.searchUrl.replace(
      '{QUERY}',
      encodeURIComponent(subject)
    );
    queue.push({ url: searchUrl, depth: 0, archiveId: source.id, source });
  }

  const autosaveInterval = setInterval(async () => {
    await autosaveSession(db, sessionId, allDocuments, allRawEntities);
  }, AUTOSAVE_INTERVAL_MS);

  try {
    while (queue.length > 0) {
      const { url, depth, archiveId, source } = queue.shift();

      if (visitedUrls.has(url)) continue;
      visitedUrls.add(url);

      const fetchResult = await enqueueFetch(url, { contactEmail, userDelayMs });
      if (!fetchResult.ok) continue;

      if (depth === 0) {
        // This is a search result page — extract links to documents
        const links = extractLinks(fetchResult.body, source.linkSelector, url);
        for (const link of links) {
          if (!visitedUrls.has(link) && depth + 1 <= maxDepth) {
            queue.push({ url: link, depth: depth + 1, archiveId, source });
          }
        }
      } else {
        // This is a document page — extract and process
        const doc = await crawlDocument({
          url, sessionId, subject, contextCues,
          archiveId, contentSelector: source.contentSelector,
          db, contactEmail, userDelayMs,
        });

        if (doc) {
          allDocuments.push(doc);
          allRawEntities.push(...(doc._rawEntities || []).map((e) => ({
            ...e, documentIds: [doc.id], sessionId,
          })));
          allRawRelationships.push(...(doc._rawRelationships || []));

          // Follow links to deeper pages if within depth limit
          if (depth + 1 <= maxDepth) {
            const deepLinks = extractLinks(fetchResult.body, source.linkSelector, url);
            for (const link of deepLinks) {
              if (!visitedUrls.has(link)) {
                queue.push({ url: link, depth: depth + 1, archiveId, source });
              }
            }
          }
        }
      }
    }
  } finally {
    clearInterval(autosaveInterval);
  }

  // ── Post-crawl processing ────────────────────────────────────────────────

  // Resolve entities (deduplication and canonicalisation)
  const resolvedEntities = await resolveEntities(allRawEntities, sessionId, subject);

  // Build entity graph
  const entityGraph = {
    entities: resolvedEntities,
    relationships: allRawRelationships,
  };

  // Score key relationships via Ollama
  const topPairs = findTopEntityPairs(resolvedEntities, allRawRelationships);
  for (const { a, b, count } of topPairs.slice(0, 20)) {
    try {
      const prompt = buildRelationshipScoringPrompt(subject, a, b, count);
      const scored = await callOllama(db, prompt);
      // Attach scored data to relationships
      const rel = allRawRelationships.find(
        (r) => r.entity_a === a.canonical && r.entity_b === b.canonical
      );
      if (rel) Object.assign(rel, scored);
    } catch { /* best effort */ }
  }

  // Verify findings (corroboration + consistency)
  const { entityGraph: verifiedGraph, citationLog: verifiedCitationLog } =
    await verifyFindings(entityGraph, allDocuments, sessionId);

  // Generate context brief
  let brief = null;
  try {
    const prompt = buildBriefPrompt(subject, verifiedGraph, verifiedCitationLog);
    brief = await callOllama(db, prompt);
  } catch { /* brief generation is best-effort */ }

  return {
    documents: allDocuments,
    entityGraph: verifiedGraph,
    citationLog: verifiedCitationLog,
    brief,
  };
}

/**
 * Find the top co-occurring entity pairs for relationship scoring.
 */
function findTopEntityPairs(entities, relationships) {
  const pairCounts = new Map();
  for (const rel of relationships) {
    const key = [rel.entity_a, rel.entity_b].sort().join('|||');
    pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
  }

  const pairs = [];
  for (const [key, count] of pairCounts.entries()) {
    const [nameA, nameB] = key.split('|||');
    const a = entities.find((e) => e.canonical === nameA || (e.aliases || []).includes(nameA));
    const b = entities.find((e) => e.canonical === nameB || (e.aliases || []).includes(nameB));
    if (a && b) pairs.push({ a, b, count });
  }

  return pairs.sort((x, y) => y.count - x.count);
}

// ── Session autosave ──────────────────────────────────────────────────────────

async function autosaveSession(db, sessionId, documents, entities) {
  const session = await dbGet(db, 'sessions', sessionId);
  if (!session) return;
  session.lastModified = Date.now();
  session.documentIds = documents.map((d) => d.id);
  session.entityIds = entities.map((e) => e.id || e.name);
  await dbPut(db, 'sessions', session);
}

// ── Message handler ───────────────────────────────────────────────────────────

/**
 * Handle messages from the popup and results panel.
 *
 * Supported actions:
 *   startSearch    — begin a new search session
 *   deepCrawl      — crawl the currently active tab's page
 *   getSession     — retrieve a session by ID
 *   getSessions    — list all sessions
 *   saveSession    — manually save/update a session
 *   exportSession  — export session as JSON
 *   resumeDomain   — resume crawl after user resolves CAPTCHA
 *   getSettings    — retrieve all user settings
 *   saveSettings   — persist user settings
 *   getSources     — get archive source configuration
 *   saveSources    — persist archive source configuration
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: err.message }));
  return true; // keep message channel open for async response
});

async function handleMessage(message, sender) {
  const db = await openDB();

  switch (message.action) {

    case 'startSearch': {
      const {
        subject, contextCues, archiveIds, maxDepth = 2,
      } = message.payload;

      const sessionId = uuidv4();
      const contactEmail = await getSetting(db, 'contactEmail', '');
      const userDelayMs = (await getSetting(db, 'requestDelay', 3)) * 1000;

      // Create session record
      const session = {
        id: sessionId,
        title: `${subject} — ${new Date().toLocaleDateString()}`,
        subject,
        contextCues: contextCues || '',
        archives: archiveIds,
        status: 'active',
        created: Date.now(),
        lastModified: Date.now(),
        documentIds: [],
        entityIds: [],
        claimIds: [],
      };
      await dbPut(db, 'sessions', session);

      // Run crawl asynchronously
      runCrawl({ sessionId, subject, contextCues, archiveIds, maxDepth, db, contactEmail, userDelayMs })
        .then(async (results) => {
          session.status = 'complete';
          session.lastModified = Date.now();
          session.documentIds = results.documents.map((d) => d.id);
          session.entityIds = results.entityGraph.entities.map((e) => e.id);
          session.brief = results.brief;
          await dbPut(db, 'sessions', session);

          // Update thread links for entities appearing across sessions
          await updateThreadLinks(db, results.entityGraph.entities, sessionId);

          // Notify the results panel
          chrome.runtime.sendMessage({
            action: 'crawlComplete',
            payload: { sessionId, summary: { docCount: results.documents.length } },
          }).catch(() => {}); // tab may have closed
        })
        .catch(console.error);

      return { sessionId };
    }

    case 'deepCrawl': {
      const { url, maxDepth = 2 } = message.payload;
      const subject = await getSetting(db, 'lastSubject', url);
      const contextCues = await getSetting(db, 'lastContextCues', '');
      const archiveIds = [detectArchiveFromUrl(url)].filter(Boolean);
      const contactEmail = await getSetting(db, 'contactEmail', '');
      const userDelayMs = (await getSetting(db, 'requestDelay', 3)) * 1000;
      const sessionId = uuidv4();

      const session = {
        id: sessionId,
        title: `Deep Crawl: ${url.slice(0, 60)} — ${new Date().toLocaleDateString()}`,
        subject,
        contextCues,
        archives: archiveIds,
        status: 'active',
        created: Date.now(),
        lastModified: Date.now(),
        documentIds: [], entityIds: [], claimIds: [],
      };
      await dbPut(db, 'sessions', session);

      runCrawl({ sessionId, subject, contextCues, archiveIds: archiveIds.length ? archiveIds : ['custom'], maxDepth, db, contactEmail, userDelayMs, seedUrl: url })
        .then(async (results) => {
          session.status = 'complete';
          session.documentIds = results.documents.map((d) => d.id);
          session.entityIds = results.entityGraph.entities.map((e) => e.id);
          await dbPut(db, 'sessions', session);
          chrome.runtime.sendMessage({ action: 'crawlComplete', payload: { sessionId } }).catch(() => {});
        })
        .catch(console.error);

      return { sessionId };
    }

    case 'getSession': {
      const session = await dbGet(db, 'sessions', message.payload.sessionId);
      const documents = session ? await dbGetAll(db, 'documents', 'sessionId', session.id) : [];
      const entities = session ? await dbGetAll(db, 'entities', 'sessionId', session.id) : [];
      return { session, documents, entities };
    }

    case 'getSessions': {
      const sessions = await dbGetAll(db, 'sessions');
      return { sessions };
    }

    case 'saveSession': {
      const { session } = message.payload;
      session.lastModified = Date.now();
      await dbPut(db, 'sessions', session);
      return { ok: true };
    }

    case 'exportSession': {
      const { sessionId } = message.payload;
      const session = await dbGet(db, 'sessions', sessionId);
      const documents = await dbGetAll(db, 'documents', 'sessionId', sessionId);
      const entities = await dbGetAll(db, 'entities', 'sessionId', sessionId);
      const claims = await dbGetAll(db, 'claims', 'sessionId', sessionId);
      return { session, documents, entities, claims };
    }

    case 'resumeDomain': {
      resumeDomain(message.payload.domain);
      return { ok: true };
    }

    case 'getSettings': {
      const keys = ['ollamaEndpoint', 'ollamaModel', 'contactEmail', 'requestDelay', 'confidenceThreshold'];
      const settings = {};
      for (const key of keys) {
        settings[key] = await getSetting(db, key, null);
      }
      return { settings };
    }

    case 'saveSettings': {
      const { settings } = message.payload;
      for (const [key, value] of Object.entries(settings)) {
        await setSetting(db, key, value);
      }
      return { ok: true };
    }

    case 'getSources': {
      const sources = await getSetting(db, 'archiveSources', DEFAULT_ARCHIVE_SOURCES);
      return { sources };
    }

    case 'saveSources': {
      await setSetting(db, 'archiveSources', message.payload.sources);
      return { ok: true };
    }

    default:
      return { error: `Unknown action: ${message.action}` };
  }
}

// ── Thread link maintenance ───────────────────────────────────────────────────

async function updateThreadLinks(db, entities, sessionId) {
  for (const entity of entities) {
    const thread = await dbGet(db, 'threads', entity.id).catch(() => null);
    if (thread) {
      if (!thread.sessionIds.includes(sessionId)) {
        thread.sessionIds.push(sessionId);
        await dbPut(db, 'threads', thread);
      }
    } else {
      await dbPut(db, 'threads', { entityId: entity.id, sessionIds: [sessionId] });
    }
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

function detectArchiveFromUrl(url) {
  // Use URL parsing for accurate hostname matching rather than substring search,
  // which could be spoofed by URLs like "evil.com/?ref=cia.gov".
  try {
    const { hostname } = new URL(url);
    if (hostname === 'www.theblackvault.com' || hostname === 'theblackvault.com') return 'theblackvault';
    if (hostname === 'www.cia.gov' || hostname === 'cia.gov') return 'cia_crest';
    if (hostname === 'wikileaks.org' || hostname === 'www.wikileaks.org') return 'wikileaks';
    if (hostname === 'nsarchive.gwu.edu') return 'nsarchive';
    if (hostname === 'archive.org' || hostname === 'www.archive.org') return 'internetarchive';
  } catch {
    // Invalid URL — return null
  }
  return null;
}

// ── CAPTCHA event relay ───────────────────────────────────────────────────────
// Forward CAPTCHA detection events to the popup/results UI

self.addEventListener('captchaDetected', (event) => {
  chrome.runtime.sendMessage({
    action: 'captchaDetected',
    payload: event.detail,
  }).catch(() => {});
});
