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
import { fileURLToPath } from "url";
import path from "path";
import { existsSync } from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
import { batchExtractChunks } from "./batchextract.js";
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

// CORS — allow browser-based clients (CARTOGRAPHER artifact, local extension)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

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

// ─── Embeddings (Stage 3) ─────────────────────────────────────────────────────

app.post("/embed", async (req, res) => {
  try {
    const settings = await getSettings();
    if (settings.embeddingsEnabled === false) {
      return res.status(503).json({ error: "embeddings disabled in settings" });
    }
    const texts = Array.isArray(req.body?.texts) ? req.body.texts : [];
    if (!texts.length) return res.status(400).json({ error: "texts[] required" });
    const { embedTexts } = await import("./embeddings.js");
    const result = await embedTexts(texts, { model: req.body?.model || settings.embeddingsModel });
    res.json(result);
  } catch (err) {
    console.error("[/embed] failed:", err);
    res.status(500).json({ error: err?.message || "embedding failed" });
  }
});

app.post("/vector-cluster", async (req, res) => {
  try {
    const settings = await getSettings();
    if (settings.embeddingsEnabled === false) {
      return res.status(503).json({ error: "embeddings disabled in settings" });
    }
    const chunks = Array.isArray(req.body?.chunks) ? req.body.chunks : [];
    if (!chunks.length) return res.status(400).json({ error: "chunks[] required" });
    const threshold = Number(req.body?.threshold ?? 0.78);

    const { embedTexts, clusterByCosine } = await import("./embeddings.js");
    const { vectors, model, dim } = await embedTexts(
      chunks.map((c) => c.text || ""),
      { model: req.body?.model || settings.embeddingsModel }
    );

    const items = chunks.map((c, i) => ({ id: c.id || String(i), vector: vectors[i] }));
    const clusters = clusterByCosine(items, threshold);

    res.json({
      model,
      dim,
      threshold,
      clusters: clusters.map((c, i) => ({
        clusterId: `c${i}`,
        memberIds: c.memberIds,
      })),
    });
  } catch (err) {
    console.error("[/vector-cluster] failed:", err);
    res.status(500).json({ error: err?.message || "clustering failed" });
  }
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
      const chunkInputs = chunks.map((text, i) => ({
        chunkId: `${doc.id}:${i}`,
        sourceUrl: doc.url,
        chunkText: text,
        documentId: doc.id
      }));

      let docEntities = [];
      let docClaims = [];

      const extractions = await batchExtractChunks({
        chunks: chunkInputs,
        subject,
        contextCue,
        batchSize: Math.max(1, Number(settings.chunkBatchSize || 5)),
        concurrency: Math.max(1, Number(settings.ollamaConcurrency || 1)),
        callOllama: ({ system, prompt, meta }) =>
          callOllama(settings, system, prompt, span, { ...meta, documentId: doc.id })
      });

      for (const result of extractions) {
        for (const ent of result.entities || []) {
          docEntities.push(ent.name);
          entitiesRaw.push({ ...ent, sessionId: session.id, documentIds: [doc.id] });
        }

        for (const claim of result.claims || []) {
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
      subject,
      useGlobalSynthesis: settings.useGlobalSynthesis !== false,
      callOllama: ({ system, prompt, meta }) => callOllama(settings, system, prompt, span, { operation: "entity_resolution", ...(meta || {}) })
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

// ─── Claude API — drop-in replacement for callOllama + _ollamaChat ────────────
//
// Replaces all Ollama calls with Anthropic Claude API.
// Same call signatures as the functions they replace so no pipeline changes needed.
//
// Required env var: ANTHROPIC_API_KEY
// Optional:        BUGGY_MODEL (default: claude-haiku-4-5-20251001 — fast + cheap for bulk extraction)
//                  BUGGY_SYNTH_MODEL (default: claude-sonnet-4-6 — for context brief + tribunal)

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const EXTRACT_MODEL = process.env.BUGGY_MODEL       || "claude-haiku-4-5-20251001";
const SYNTH_MODEL   = process.env.BUGGY_SYNTH_MODEL || "claude-sonnet-4-6";

async function callClaude(system, prompt, { model = EXTRACT_MODEL, maxTokens = 2048 } = {}) {
  const resp = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Claude API error ${resp.status}: ${err?.error?.message || "unknown"}`);
  }

  const data = await resp.json();
  return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("") || "{}";
}

// Drop-in for callOllama — used in pipeline for extraction, entity resolution, fact-check
async function callOllama(settings, system, prompt, parentSpan, meta = {}) {
  const span = startSpan("claude.generate", {
    "claude.model": EXTRACT_MODEL,
    "claude.operation": meta.operation || "unknown"
  }, parentSpan || null);

  try {
    addSpanEvent(span, "claude.request", { promptLength: String(prompt || "").length });
    // Use Haiku for bulk extraction tasks, Sonnet for synthesis
    const isSynth = ["context_brief", "document_summary"].includes(meta.operation);
    const result = await callClaude(system, prompt, {
      model: isSynth ? SYNTH_MODEL : EXTRACT_MODEL,
      maxTokens: isSynth ? 4096 : 2048,
    });
    setSpanAttribute(span, "claude.response_length", String(result).length);
    endSpan(span, { ok: true });
    return result;
  } catch (error) {
    endSpan(span, { error });
    throw error;
  }
}

// Drop-in for _ollamaChat — used in congress/tribunal (skeptic/advocate/synthesizer)
async function _ollamaChat(system, userContent, settings) {
  const raw = await callClaude(system, userContent, {
    model: SYNTH_MODEL,
    maxTokens: 1024,
  });
  return cleanJsonResponse(raw);
}
async function runSessionTribunal(sessionId, subject, stats, settings) {
  const content = `Research subject: ${subject}\nClaims found: ${stats.claimCount}\nEntities found: ${stats.entityCount}\nInconsistencies: ${stats.inconsistencyCount}`;

  const SKEPTIC = "You are the Skeptic reviewing an archival research session. Identify gaps, uncorroborated claims, bias risks, and data quality issues. Return ONLY valid JSON: {\"findings\":[],\"severity\":\"low|medium|high\",\"flags\":[]}";
  const ADVOCATE = "You are the Advocate reviewing an archival research session. Identify strong signals, well-corroborated chains, and healthy research breadth. Return ONLY valid JSON: {\"findings\":[],\"health_score\":0.0,\"improvements\":[]}";
  const SYNTHESIZER = "You are the Synthesizer reviewing an archival research session. Given Skeptic and Advocate findings, produce a balanced synthesis with next-step directives. Return ONLY valid JSON: {\"synthesis\":\"\",\"action_items\":[],\"memory_tags\":[]}";

  let skeptic = {}, advocate = {};
  try { skeptic = await _ollamaChat(SKEPTIC, content, settings); } catch { /* silent */ }
  try { advocate = await _ollamaChat(ADVOCATE, content, settings); } catch { /* silent */ }

  let synth = {};
  try {
    const synthContent = `${content}\n\nSkeptic: ${JSON.stringify(skeptic.findings || [])}\nAdvocate: ${JSON.stringify(advocate.findings || [])}`;
    synth = await _ollamaChat(SYNTHESIZER, synthContent, settings);
  } catch { /* silent */ }

  // Persist to session as congress_review field
  try {
    const sessions = await getAll("sessions");
    const session = sessions.find((s) => s.id === sessionId);
    if (session) {
      await put("sessions", {
        ...session,
        congress_review: { skeptic, advocate, synthesizer: synth, reviewedAt: Date.now() },
        lastModified: Date.now(),
      });
    }
  } catch { /* silent */ }
}

app.post("/congress/review", async (req, res) => {
  // Return immediately — tribunal runs in background
  res.json({ ok: true });
  try {
    const { sessionId, subject = "unknown", claimCount = 0, entityCount = 0, inconsistencyCount = 0 } = req.body || {};
    if (!sessionId) return;
    const s = await getSettings();
    runSessionTribunal(sessionId, subject, { claimCount, entityCount, inconsistencyCount }, s).catch(() => {});
  } catch { /* silent */ }
});

// ─── Claude proxy (keeps API key server-side) ─────────────────────────────────

app.post("/claude", async (req, res) => {
  try {
    const { system, prompt, model } = req.body || {};
    if (!prompt) return res.status(400).json({ ok: false, error: "prompt required" });
    const text = await callClaude(system || "", prompt, {
      model: model || EXTRACT_MODEL,
      maxTokens: 4096,
    });
    res.json({ ok: true, text });
  } catch (err) {
    console.error("[/claude]", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Static web app (Railway production) ──────────────────────────────────────

const WEB_DIST = path.resolve(__dirname, "../web/dist");
if (existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST));
  // SPA fallback — only for non-API GET requests
  app.get("*", (req, res) => {
    res.sendFile(path.join(WEB_DIST, "index.html"));
  });
  console.log(`[buggy-service] serving web app from ${WEB_DIST}`);
}

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[buggy-service] listening on http://localhost:${PORT}`);
  console.log(`[buggy-service] data dir: ${process.env.BUGGY_DATA_DIR || "~/.buggy-service"}`);
});

// ─── Startup validation ───────────────────────────────────────────────────────
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("[buggy-service] FATAL: ANTHROPIC_API_KEY env var is required.");
  console.error("[buggy-service] Set it in your .env file or deployment environment.");
  process.exit(1);
}
