/**
 * buggy-service — Buggy archive research pipeline as a standalone HTTP service.
 *
 * This is the service-worker.js pipeline extracted from the archivelens Chrome
 * extension into a Node.js HTTP server. All core pipeline logic is identical;
 * the only replacements are:
 *   - chrome.runtime.onMessage  → Express routes
 *   - IndexedDB (db.js)         → SQLite (db.js in this directory)
 *   - chrome.notifications      → console.log
 *   - chrome.tabs (active page) → explicit url param in POST /crawl
 *   - chrome.downloads          → JSON response body
 *
 * Routes:
 *   POST /search         { subject, sources[], contextCue?, depth? }
 *   POST /crawl          { url, subject?, contextCue?, depth? }
 *   GET  /jobs/:id       → { status, progress, sessionId, traceId }
 *   GET  /sessions       → [...sessions] (sorted by lastModified desc)
 *   GET  /sessions/:id   → full session bundle
 *   GET  /settings       → settings object
 *   POST /settings       → merge + save partial settings
 *   GET  /health         → { ok: true }
 */

import express from "express";
import { randomUUID } from "crypto";
import {
  bulkPut,
  ensureDefaultSettings,
  getAll,
  getAllByIndex,
  getSettings,
  put,
  updateSettings
} from "./db.js";
import { DEFAULT_ARCHIVAL_SOURCES, buildSearchUrl, mergeSourceConfig } from "./sources.js";
import { OLLAMA_PROMPTS, cleanJsonResponse } from "./prompts.js";
import {
  CaptchaDetectedError,
  PermanentHttpError,
  RetryableHttpError,
  policyFetch,
  resumeDomain
} from "./crawlpolicy.js";
import { resolveEntities } from "./entityresolver.js";
import { verifyFindings } from "./factcheck.js";
import {
  addSpanEvent,
  endSpan,
  flushTraces,
  initTracing,
  recordException,
  setSpanAttribute,
  startSpan,
  traceAsync
} from "./tracing.js";

const PORT = parseInt(process.env.BUGGY_PORT || "5050", 10);
const app = express();
app.use(express.json());

// Active jobs: jobId → { status, progress, sessionId, traceId, updatedAt }
const activeJobs = new Map();

// ─── Startup ──────────────────────────────────────────────────────────────────

const settings = await ensureDefaultSettings();
initTracing({
  enabled: settings.tracingEnabled !== false,
  endpoint: settings.tracingEndpoint || "http://localhost:4318/v1/traces",
  serviceName: settings.tracingServiceName || "buggy-service",
  scopeName: "buggy.background"
});

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "buggy-service" });
});

app.get("/settings", async (_req, res) => {
  try {
    res.json(await getSettings());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/settings", async (req, res) => {
  try {
    const saved = await updateSettings(req.body || {});
    initTracing({
      enabled: saved.tracingEnabled !== false,
      endpoint: saved.tracingEndpoint || "http://localhost:4318/v1/traces",
      serviceName: saved.tracingServiceName || "buggy-service",
      scopeName: "buggy.background"
    });
    res.json(saved);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/search", async (req, res) => {
  try {
    const result = await startSearchSession(req.body || {});
    res.json({ ok: true, result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/crawl", async (req, res) => {
  try {
    const result = await startDeepCrawl(req.body || {});
    res.json({ ok: true, result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get("/jobs/:id", (req, res) => {
  const job = activeJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

app.get("/sessions", async (req, res) => {
  try {
    res.json(await listSessions(req.query.q || ""));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/sessions/:id", async (req, res) => {
  try {
    res.json(await buildSessionBundle(req.params.id));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.get("/sessions/:id/export", async (req, res) => {
  try {
    const bundle = await buildSessionBundle(req.params.id);
    res.setHeader("Content-Type", "application/json");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="buggy-session-${req.params.id}.json"`
    );
    res.json(bundle);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.post("/resume-domain", (req, res) => {
  const { domain } = req.body || {};
  if (!domain) return res.status(400).json({ error: "domain required" });
  resumeDomain(domain);
  res.json({ resumed: true });
});

// ─── Pipeline ─────────────────────────────────────────────────────────────────

async function startSearchSession(payload) {
  const settings = await getSettings();
  const sources = mergeSourceConfig(DEFAULT_ARCHIVAL_SOURCES, settings.archives || {});
  const selectedSources = (payload.sources || []).map((id) => sources[id]).filter(Boolean);

  if (!payload.subject?.trim()) throw new Error("A primary subject is required");

  const session = await createSessionRecord(payload.subject, payload.contextCue, payload.sources || []);
  const jobId = session.id;
  const rootSpan = startSpan("session.search", {
    "session.id": session.id,
    "search.subject": payload.subject,
    "search.source_count": selectedSources.length
  });

  activeJobs.set(jobId, { status: "active", progress: "Queued", sessionId: session.id, traceId: rootSpan.traceId });

  runSearchPipeline(session, selectedSources, settings, payload, rootSpan).catch((err) => {
    recordException(rootSpan, err);
    endSpan(rootSpan, { error: err });
    activeJobs.set(jobId, { status: "error", progress: err.message, sessionId: session.id, traceId: rootSpan.traceId });
  });

  return { jobId, sessionId: session.id, traceId: rootSpan.traceId };
}

async function startDeepCrawl(payload) {
  if (!payload.url?.trim()) throw new Error("url is required for deep crawl");

  const settings = await getSettings();
  const session = await createSessionRecord(
    payload.subject || "Deep Crawl",
    payload.contextCue || "",
    []
  );
  const jobId = session.id;
  const rootSpan = startSpan("session.deep_crawl", {
    "session.id": session.id,
    "crawl.url": payload.url
  });

  activeJobs.set(jobId, { status: "active", progress: "Queued", sessionId: session.id, traceId: rootSpan.traceId });

  runDeepCrawlPipeline(session, payload, settings, rootSpan).catch((err) => {
    recordException(rootSpan, err);
    endSpan(rootSpan, { error: err });
    activeJobs.set(jobId, { status: "error", progress: err.message, sessionId: session.id, traceId: rootSpan.traceId });
  });

  return { jobId, sessionId: session.id, traceId: rootSpan.traceId };
}

async function runSearchPipeline(session, selectedSources, settings, payload, parentSpan) {
  return traceAsync("pipeline.search", async (span) => {
    updateJob(session.id, "Crawling search sources");
    const documents = [];

    for (const source of selectedSources) {
      const searchUrl = buildSearchUrl(source, payload.subject, payload.contextCue || "");
      const hits = await crawlFromUrl({
        session, seedUrl: searchUrl, source,
        maxDepth: Number(payload.depth || settings.crawlDepth || 2),
        settings, parentSpan: span
      });
      documents.push(...hits);
    }

    setSpanAttribute(span, "documents.total", documents.length);
    await ingestAndAnalyze(session, documents, payload.subject, payload.contextCue || "", settings, span);
    endSpan(parentSpan, { ok: true });
    await flushTraces();
  }, { parentSpan, attributes: { "session.id": session.id, "search.subject": payload.subject } });
}

async function runDeepCrawlPipeline(session, payload, settings, parentSpan) {
  return traceAsync("pipeline.deep_crawl", async (span) => {
    updateJob(session.id, "Reading seed URL");

    const seedUrl = payload.url;
    const source = {
      id: "deep-crawl",
      name: "Deep Crawl",
      domain: new URL(seedUrl).hostname,
      selectors: { resultLinks: "a[href]" }
    };

    const docs = await crawlFromUrl({
      session, seedUrl, source,
      maxDepth: Number(payload.depth || settings.crawlDepth || 2),
      settings, parentSpan: span
    });

    setSpanAttribute(span, "documents.total", docs.length);
    await ingestAndAnalyze(session, docs, payload.subject || "Deep Crawl", payload.contextCue || "", settings, span);
    endSpan(parentSpan, { ok: true });
    await flushTraces();
  }, { parentSpan, attributes: { "session.id": session.id, "crawl.mode": "url" } });
}

async function ingestAndAnalyze(session, documents, subject, contextCue, settings, parentSpan) {
  return traceAsync("pipeline.ingest_and_analyze", async (span) => {
    updateJob(session.id, `Processing ${documents.length} documents`);

    const confidenceThreshold = Number(settings.confidenceThreshold || 0.6);
    const entitiesRaw = [];
    const claimsRaw = [];

    for (const doc of documents) {
      addSpanEvent(span, "document.processing.start", { "document.url": doc.url });
      const chunks = chunkText(doc.text || "", settings.chunkTokenLimit || 2000, settings.chunkOverlapTokens || 200);
      let docEntities = [];
      let docClaims = [];

      for (let i = 0; i < chunks.length; i++) {
        const prompt = OLLAMA_PROMPTS.entityExtraction.userTemplate({
          subject, contextCue, chunkText: chunks[i], chunkId: `${doc.id}:${i}`, sourceUrl: doc.url
        });

        const raw = await callOllama(settings, OLLAMA_PROMPTS.entityExtraction.system, prompt, span, {
          operation: "entity_extraction", chunkIndex: i, documentId: doc.id
        });

        let parsed;
        try { parsed = cleanJsonResponse(raw); } catch { parsed = { entities: [], claims: [] }; }

        for (const ent of parsed.entities || []) {
          docEntities.push(ent.name);
          entitiesRaw.push({ ...ent, sessionId: session.id, documentIds: [doc.id] });
        }

        for (const claim of parsed.claims || []) {
          const claimRow = {
            id: randomUUID(), sessionId: session.id, documentId: doc.id,
            subjectEntity: claim.subject_entity, objectEntity: claim.object_entity,
            relation: claim.relation, date: claim.date, location: claim.location,
            action: claim.action, quote: claim.quote, confidence: Number(claim.confidence || 0)
          };
          docClaims.push(claimRow);
          claimsRaw.push(claimRow);
        }
      }

      doc.entities = [...new Set(docEntities)];
      doc.claims = docClaims;
      doc.relevance = computeDocRelevance(docClaims);
      doc.summary = await summarizeDocument(settings, doc, subject, span);
      doc.status = doc.relevance >= confidenceThreshold ? "RELEVANT" : "LOW_CONFIDENCE";
      addSpanEvent(span, "document.processing.complete", {
        "document.id": doc.id, "document.relevance": doc.relevance, "document.claims": doc.claims.length
      });
    }

    updateJob(session.id, "Resolving cross-archive entities");
    const resolvedEntities = await resolveEntities(entitiesRaw, {
      callOllama: ({ system, prompt }) => callOllama(settings, system, prompt, span, { operation: "entity_resolution" })
    });

    const entityByName = new Map();
    for (const entity of resolvedEntities) {
      for (const alias of entity.aliases || [entity.name]) {
        entityByName.set(alias.toLowerCase(), entity.id);
      }
    }

    const entityGraph = {
      subject,
      entities: resolvedEntities,
      claims: claimsRaw.map((claim) => ({
        ...claim,
        subjectEntityId: entityByName.get(String(claim.subjectEntity || "").toLowerCase()) || null,
        objectEntityId: entityByName.get(String(claim.objectEntity || "").toLowerCase()) || null
      }))
    };

    updateJob(session.id, "Running findings verification");
    const verified = await verifyFindings(entityGraph, documents, {
      sessionId: session.id,
      callOllama: ({ system, prompt }) => callOllama(settings, system, prompt, span, { operation: "fact_check" })
    });

    updateJob(session.id, "Generating context brief");
    const brief = await buildContextBrief(settings, subject, verified.entityGraph, documents, span);

    await persistSessionData(session, documents, verified.entityGraph.entities, verified.entityGraph.claims, brief);
    await updateThreads(verified.entityGraph.entities, session.id);

    const completed = { ...session, status: "complete", lastModified: Date.now(), brief, stats: {
      documents: documents.length,
      entities: verified.entityGraph.entities.length,
      claims: verified.entityGraph.claims.length
    }};
    await put("sessions", completed);

    setSpanAttribute(span, "session.status", "complete");
    setSpanAttribute(span, "entities.total", verified.entityGraph.entities.length);
    setSpanAttribute(span, "claims.total", verified.entityGraph.claims.length);
    updateJob(session.id, "Complete", "complete");
    console.log(`[buggy] Search complete: ${subject} — ${documents.length} docs, ${verified.entityGraph.entities.length} entities`);
  }, { parentSpan, attributes: { "session.id": session.id, "session.subject": subject, "documents.count": documents.length } });
}

async function crawlFromUrl({ session, seedUrl, source, maxDepth, settings, parentSpan }) {
  return traceAsync("crawl.source", async (span) => {
    const visited = new Set();
    const queue = [{ url: seedUrl, depth: 0 }];
    const docs = [];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visited.has(current.url) || current.depth > maxDepth) continue;
      visited.add(current.url);

      const fetchResult = await fetchWithRetries(current.url, settings.maxRetries || 3, settings, span);

      if (!fetchResult.ok) {
        docs.push({
          id: randomUUID(), sessionId: session.id, archive: source.name,
          domain: new URL(current.url).hostname, url: current.url, title: current.url,
          date: "", text: "", entities: [], claims: [], status: fetchResult.status || "FETCH_FAILED"
        });
        continue;
      }

      const document = await buildDocumentRow(session.id, source, current.url, fetchResult.response);
      docs.push(document);

      if (current.depth < maxDepth) {
        const links = extractLinks(fetchResult.text, current.url);
        for (const link of links) {
          if (!visited.has(link)) queue.push({ url: link, depth: current.depth + 1 });
        }
      }
    }

    setSpanAttribute(span, "crawl.documents", docs.length);
    setSpanAttribute(span, "crawl.visited_urls", visited.size);
    return docs;
  }, { parentSpan, attributes: { "crawl.seed_url": seedUrl, "crawl.source": source.name, "crawl.depth": maxDepth } });
}

async function fetchWithRetries(url, maxRetries, settings, parentSpan) {
  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      addSpanEvent(parentSpan, "fetch.attempt", { "url.full": url, attempt });
      const response = await policyFetch(url, {}, settings);
      const text = await cloneToText(response);
      return { ok: true, response, text };
    } catch (error) {
      if (error instanceof CaptchaDetectedError) {
        addSpanEvent(parentSpan, "fetch.result", { "url.full": url, status: "CAPTCHA_PAUSED" });
        console.warn(`[buggy] CAPTCHA detected: ${url}`);
        return { ok: false, status: "CAPTCHA_PAUSED" };
      }
      if (error instanceof PermanentHttpError && error.status === 403) {
        addSpanEvent(parentSpan, "fetch.result", { "url.full": url, status: "ACCESS_DENIED" });
        return { ok: false, status: "ACCESS_DENIED" };
      }
      if (error instanceof RetryableHttpError) {
        if (attempt >= Math.min(maxRetries, error.maxRetries || maxRetries)) {
          return { ok: false, status: `HTTP_${error.status}` };
        }
        await sleep(error.baseDelayMs * Math.pow(2, attempt));
        attempt++;
        continue;
      }
      if (attempt >= maxRetries) return { ok: false, status: "FETCH_FAILED" };
      await sleep(1000 * Math.pow(2, attempt));
      attempt++;
    }
  }
  return { ok: false, status: "FETCH_FAILED" };
}

async function buildDocumentRow(sessionId, source, url, response) {
  const ctype = response.headers.get("content-type") || "";
  const isPdf = ctype.includes("pdf") || /\.pdf$/i.test(url);
  const text = isPdf ? "" : await cloneToText(response);
  return {
    id: randomUUID(), sessionId, archive: source.name, domain: new URL(url).hostname,
    url, title: deriveTitle(text, url), date: "", text, isPdf,
    pdfExtractionPending: isPdf, entities: [], claims: [], relevance: 0, status: "FETCHED"
  };
}

async function buildContextBrief(settings, subject, entityGraph, documents, parentSpan) {
  const timelineRows = entityGraph.claims
    .filter((c) => c.date)
    .map((c) => `${c.date}: ${c.subjectEntity} ${c.relation} ${c.objectEntity} [${c.documentId}]`)
    .slice(0, 300);

  const inconsistencies = entityGraph.entities
    .filter((e) => e.consistencyFlag === "DISCREPANCY")
    .map((e) => ({ entity: e.name, details: e.discrepancies || [] }));

  const prompt = OLLAMA_PROMPTS.contextBrief.userTemplate({
    subject, timelineRows, entities: entityGraph.entities, claims: entityGraph.claims, inconsistencies
  });

  const raw = await callOllama(settings, OLLAMA_PROMPTS.contextBrief.system, prompt, parentSpan, {
    operation: "context_brief", subject
  });
  try {
    return cleanJsonResponse(raw);
  } catch {
    return {
      subject, timeline: [], cast: [], subplots: [], follow_up_search_directives: [],
      unresolved_inconsistencies: inconsistencies.map((i) => ({ entity: i.entity, detail: "Conflicting descriptions detected", citations: [] }))
    };
  }
}

async function summarizeDocument(settings, doc, subject, parentSpan) {
  const snippet = stripHtml(doc.text || "").slice(0, 3000);
  if (!snippet) return "PDF or non-text content captured; parse in results panel.";

  const prompt = [
    `Subject: ${subject}`, `Document URL: ${doc.url}`,
    "Summarize this document in one sentence focused on subject relevance.",
    `Return JSON only: {"summary":"string"}`, snippet
  ].join("\n\n");

  const raw = await callOllama(settings, "You summarize archival documents in concise JSON.", prompt, parentSpan, {
    operation: "document_summary", documentId: doc.id
  });
  try {
    const parsed = cleanJsonResponse(raw);
    return parsed.summary || "Summary unavailable";
  } catch {
    return "Summary unavailable";
  }
}

async function persistSessionData(session, documents, entities, claims, brief) {
  await bulkPut("documents", documents);
  await bulkPut("entities", entities);
  await bulkPut("claims", claims);
  await put("sessions", {
    ...session, lastModified: Date.now(), brief,
    documentIds: documents.map((d) => d.id),
    entityIds: entities.map((e) => e.id),
    claimIds: claims.map((c) => c.id)
  });
}

async function updateThreads(entities, sessionId) {
  for (const entity of entities) {
    const current = await getThread(entity.id);
    const nextSessions = [...new Set([...(current?.sessionIds || []), sessionId])];
    await put("threads", { entityId: entity.id, entityName: entity.name, sessionIds: nextSessions });
  }
}

async function getThread(entityId) {
  const rows = await getAll("threads");
  return rows.find((r) => r.entityId === entityId) || null;
}

async function createSessionRecord(subject, contextCue, sources) {
  const now = Date.now();
  const session = {
    id: randomUUID(),
    title: `${subject} (${new Date(now).toISOString().slice(0, 10)})`,
    subject, contextCue, sources, createdAt: now, lastModified: now, status: "active"
  };
  await put("sessions", session);
  return session;
}

async function buildSessionBundle(sessionId) {
  const sessions = await getAll("sessions");
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) throw new Error("Session not found");

  const [documents, entities, claims, threads] = await Promise.all([
    getAllByIndex("documents", "by_session", sessionId),
    getAllByIndex("entities",  "by_session", sessionId),
    getAllByIndex("claims",    "by_session", sessionId),
    getAll("threads")
  ]);

  return { session, documents, entityGraph: { subject: session.subject, entities, claims }, threads };
}

async function listSessions(query) {
  const sessions = await getAll("sessions");
  const q = query.trim().toLowerCase();
  if (!q) return sessions.sort((a, b) => b.lastModified - a.lastModified);

  const entities = await getAll("entities");
  const entitiesBySession = new Map();
  for (const e of entities) {
    if (!entitiesBySession.has(e.sessionId)) entitiesBySession.set(e.sessionId, []);
    entitiesBySession.get(e.sessionId).push(e.name.toLowerCase());
  }

  return sessions
    .filter((s) => s.title.toLowerCase().includes(q) || (entitiesBySession.get(s.id) || []).some((n) => n.includes(q)))
    .sort((a, b) => b.lastModified - a.lastModified);
}

async function callOllama(settings, system, prompt, parentSpan, meta = {}) {
  const span = startSpan("ollama.generate", {
    "ollama.model": settings.ollamaModel || "llama3",
    "ollama.operation": meta.operation || "unknown"
  }, parentSpan || null);

  const endpoint = settings.ollamaEndpoint || "http://localhost:11434/api/generate";
  const payload = {
    model: settings.ollamaModel || "llama3",
    prompt: `${system}\n\n${prompt}`,
    stream: false,
    options: { temperature: 0.1 }
  };

  let res;
  try {
    addSpanEvent(span, "ollama.request", { endpoint, promptLength: String(prompt || "").length });
    res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  } catch (error) {
    endSpan(span, { error });
    throw error;
  }

  addSpanEvent(span, "ollama.response", { status: res.status });
  if (!res.ok) {
    endSpan(span, { ok: false, message: `Ollama HTTP ${res.status}` });
    throw new Error(`Ollama error: ${res.status}`);
  }

  const data = await res.json();
  setSpanAttribute(span, "ollama.response_length", String(data.response || "").length);
  endSpan(span, { ok: true });
  return data.response || "{}";
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function updateJob(jobId, progress, status = "active") {
  const state = activeJobs.get(jobId) || { sessionId: jobId };
  activeJobs.set(jobId, { ...state, status, progress, updatedAt: Date.now() });
}

function deriveTitle(text, url) {
  const match = String(text || "").match(/<title>([^<]+)<\/title>/i);
  return match ? match[1].trim() : url;
}

function extractLinks(html, baseUrl) {
  const links = new Set();
  const hrefRe = /href=["']([^"'#]+)["']/gi;
  let match;
  while ((match = hrefRe.exec(html || ""))) {
    try {
      const candidate = new URL(match[1], baseUrl).toString();
      if (candidate.startsWith("http://") || candidate.startsWith("https://")) links.add(candidate);
    } catch { continue; }
  }
  return [...links].slice(0, 120);
}

function chunkText(text, limitTokens = 2000, overlapTokens = 200) {
  const words = String(text || "").replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean);
  if (words.length <= limitTokens) return [words.join(" ")];
  const chunks = [];
  let start = 0;
  while (start < words.length) {
    const end = Math.min(start + limitTokens, words.length);
    chunks.push(words.slice(start, end).join(" "));
    if (end >= words.length) break;
    start = Math.max(0, end - overlapTokens);
  }
  return chunks;
}

function computeDocRelevance(claims) {
  if (!claims.length) return 0;
  return claims.reduce((sum, c) => sum + Number(c.confidence || 0), 0) / claims.length;
}

function stripHtml(text) {
  return String(text || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

async function cloneToText(response) {
  try { return await response.clone().text(); } catch { return ""; }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Autosave active sessions every five minutes (mirrors service-worker interval)
setInterval(async () => {
  const sessions = await getAll("sessions");
  const active = sessions.filter((s) => s.status === "active");
  for (const session of active) {
    await put("sessions", { ...session, lastModified: Date.now() });
  }
}, 5 * 60 * 1000);

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[buggy-service] listening on http://localhost:${PORT}`);
  console.log(`[buggy-service] data dir: ${process.env.BUGGY_DATA_DIR || "~/.buggy-service"}`);
});
