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

const activeJobs = new Map();
let tracingSignature = "";

function configureTracing(settings) {
  const signature = [
    String(settings.tracingEnabled),
    settings.tracingEndpoint || "",
    settings.tracingServiceName || "archivelens-extension"
  ].join("|");

  if (signature === tracingSignature) {
    return;
  }

  tracingSignature = signature;
  initTracing({
    enabled: settings.tracingEnabled !== false,
    endpoint: settings.tracingEndpoint || "http://localhost:4318/v1/traces",
    serviceName: settings.tracingServiceName || "archivelens-extension",
    scopeName: "archivelens.background"
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await ensureDefaultSettings();
  configureTracing(settings);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case "GET_SETTINGS":
      return getSettings();
    case "SAVE_SETTINGS": {
      const saved = await updateSettings(message.payload || {});
      configureTracing(saved);
      return saved;
    }
    case "GET_SOURCES": {
      const settings = await getSettings();
      return mergeSourceConfig(DEFAULT_ARCHIVAL_SOURCES, settings.archives || {});
    }
    case "START_SEARCH":
      return startSearchSession(message.payload);
    case "START_DEEP_CRAWL":
      return startDeepCrawl(message.payload);
    case "GET_SESSION":
      return buildSessionBundle(message.sessionId);
    case "LIST_SESSIONS":
      return listSessions(message.query || "");
    case "EXPORT_SESSION_JSON":
      return exportSessionJson(message.sessionId);
    case "EXPORT_OBSIDIAN":
      return exportObsidian(message.sessionId);
    case "MANUAL_SAVE_SESSION":
      return manualSave(message.sessionId);
    case "RESUME_DOMAIN":
      resumeDomain(message.domain);
      return { resumed: true };
    case "GET_JOB_STATE":
      return activeJobs.get(message.jobId) || null;
    default:
      throw new Error(`Unknown message type: ${message.type}`);
  }
}

async function startSearchSession(payload) {
  const settings = await getSettings();
  configureTracing(settings);
  const sources = mergeSourceConfig(DEFAULT_ARCHIVAL_SOURCES, settings.archives || {});
  const selectedSources = payload.sources
    .map((id) => sources[id])
    .filter(Boolean);

  if (!payload.subject?.trim()) {
    throw new Error("A primary subject is required");
  }

  const session = await createSessionRecord(payload.subject, payload.contextCue, payload.sources);
  const jobId = session.id;
  const rootSpan = startSpan("session.search", {
    "session.id": session.id,
    "search.subject": payload.subject,
    "search.source_count": selectedSources.length
  });

  activeJobs.set(jobId, {
    status: "active",
    progress: "Queued",
    sessionId: session.id,
    traceId: rootSpan.traceId
  });
  runSearchPipeline(session, selectedSources, settings, payload, rootSpan).catch((error) => {
    recordException(rootSpan, error);
    endSpan(rootSpan, { error });
    activeJobs.set(jobId, {
      status: "error",
      progress: error.message,
      sessionId: session.id,
      traceId: rootSpan.traceId
    });
  });

  return { jobId, sessionId: session.id, traceId: rootSpan.traceId };
}

async function startDeepCrawl(payload) {
  const settings = await getSettings();
  configureTracing(settings);
  const session = await createSessionRecord(payload.subject || "Deep Crawl", payload.contextCue || "", payload.sources || []);
  const jobId = session.id;
  const rootSpan = startSpan("session.deep_crawl", {
    "session.id": session.id,
    "crawl.subject": payload.subject || "Deep Crawl"
  });

  activeJobs.set(jobId, {
    status: "active",
    progress: "Queued",
    sessionId: session.id,
    traceId: rootSpan.traceId
  });
  runDeepCrawlPipeline(session, payload, settings, rootSpan).catch((error) => {
    recordException(rootSpan, error);
    endSpan(rootSpan, { error });
    activeJobs.set(jobId, {
      status: "error",
      progress: error.message,
      sessionId: session.id,
      traceId: rootSpan.traceId
    });
  });

  return { jobId, sessionId: session.id, traceId: rootSpan.traceId };
}

async function runSearchPipeline(session, selectedSources, settings, payload, parentSpan) {
  return traceAsync(
    "pipeline.search",
    async (span) => {
      updateJob(session.id, "Crawling search sources");

      const documents = [];
      for (const source of selectedSources) {
        const searchUrl = buildSearchUrl(source, payload.subject, payload.contextCue || "");
        const hits = await crawlFromUrl({
          session,
          seedUrl: searchUrl,
          source,
          maxDepth: Number(payload.depth || settings.crawlDepth || 2),
          settings,
          parentSpan: span
        });
        documents.push(...hits);
      }

      setSpanAttribute(span, "documents.total", documents.length);
      await ingestAndAnalyze(session, documents, payload.subject, payload.contextCue || "", settings, span);
      endSpan(parentSpan, { ok: true });
      await flushTraces();
    },
    {
      parentSpan,
      attributes: {
        "session.id": session.id,
        "search.subject": payload.subject
      }
    }
  );
}

async function runDeepCrawlPipeline(session, payload, settings, parentSpan) {
  return traceAsync(
    "pipeline.deep_crawl",
    async (span) => {
      updateJob(session.id, "Reading active page context");

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) {
        throw new Error("No active tab available for deep crawl");
      }

      const extraction = await chrome.tabs.sendMessage(tab.id, { type: "EXTRACT_PAGE" });
      const seedUrl = extraction?.url || tab.url;
      if (!seedUrl) {
        throw new Error("Unable to determine active page URL");
      }

      const source = {
        id: "active-page",
        name: "Active Page",
        domain: new URL(seedUrl).hostname,
        selectors: {
          resultLinks: "a[href]"
        }
      };

      const docs = await crawlFromUrl({
        session,
        seedUrl,
        source,
        maxDepth: Number(payload.depth || settings.crawlDepth || 2),
        settings,
        parentSpan: span
      });

      setSpanAttribute(span, "documents.total", docs.length);
      await ingestAndAnalyze(session, docs, payload.subject || "Deep Crawl", payload.contextCue || "", settings, span);
      endSpan(parentSpan, { ok: true });
      await flushTraces();
    },
    {
      parentSpan,
      attributes: {
        "session.id": session.id,
        "crawl.mode": "active-page"
      }
    }
  );
}

async function ingestAndAnalyze(session, documents, subject, contextCue, settings, parentSpan) {
  return traceAsync(
    "pipeline.ingest_and_analyze",
    async (span) => {
  updateJob(session.id, `Processing ${documents.length} documents`);

  const confidenceThreshold = Number(settings.confidenceThreshold || 0.6);
  const entitiesRaw = [];
  const claimsRaw = [];

  for (const doc of documents) {
    addSpanEvent(span, "document.processing.start", { "document.url": doc.url });
    const chunks = chunkText(doc.text || "", settings.chunkTokenLimit || 2000, settings.chunkOverlapTokens || 200);
    let docEntities = [];
    let docClaims = [];

    for (let i = 0; i < chunks.length; i += 1) {
      const prompt = OLLAMA_PROMPTS.entityExtraction.userTemplate({
        subject,
        contextCue,
        chunkText: chunks[i],
        chunkId: `${doc.id}:${i}`,
        sourceUrl: doc.url
      });

      const raw = await callOllama(settings, OLLAMA_PROMPTS.entityExtraction.system, prompt, span, {
        operation: "entity_extraction",
        chunkIndex: i,
        documentId: doc.id
      });
      let parsed;
      try {
        parsed = cleanJsonResponse(raw);
      } catch (_err) {
        parsed = { entities: [], claims: [] };
      }

      for (const ent of parsed.entities || []) {
        docEntities.push(ent.name);
        entitiesRaw.push({
          ...ent,
          sessionId: session.id,
          documentIds: [doc.id]
        });
      }

      for (const claim of parsed.claims || []) {
        const claimRow = {
          id: crypto.randomUUID(),
          sessionId: session.id,
          documentId: doc.id,
          subjectEntity: claim.subject_entity,
          objectEntity: claim.object_entity,
          relation: claim.relation,
          date: claim.date,
          location: claim.location,
          action: claim.action,
          quote: claim.quote,
          confidence: Number(claim.confidence || 0)
        };
        docClaims.push(claimRow);
        claimsRaw.push(claimRow);
      }
    }

    doc.entities = Array.from(new Set(docEntities));
    doc.claims = docClaims;
    doc.relevance = computeDocRelevance(docClaims);
    doc.summary = await summarizeDocument(settings, doc, subject, span);
    doc.status = doc.relevance >= confidenceThreshold ? "RELEVANT" : "LOW_CONFIDENCE";
    addSpanEvent(span, "document.processing.complete", {
      "document.id": doc.id,
      "document.relevance": doc.relevance,
      "document.claims": doc.claims.length
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

  const completed = {
    ...session,
    status: "complete",
    lastModified: Date.now(),
    brief,
    stats: {
      documents: documents.length,
      entities: verified.entityGraph.entities.length,
      claims: verified.entityGraph.claims.length
    }
  };
  await put("sessions", completed);
  setSpanAttribute(span, "session.status", "complete");
  setSpanAttribute(span, "entities.total", verified.entityGraph.entities.length);
  setSpanAttribute(span, "claims.total", verified.entityGraph.claims.length);
  updateJob(session.id, "Complete", "complete");

  chrome.notifications.create({
    type: "basic",
    iconUrl: "icon.png",
    title: "ArchiveLens crawl complete",
    message: `${subject}: ${documents.length} documents processed`
  });
    },
    {
      parentSpan,
      attributes: {
        "session.id": session.id,
        "session.subject": subject,
        "documents.count": documents.length
      }
    }
  );
}

async function crawlFromUrl({ session, seedUrl, source, maxDepth, settings, parentSpan }) {
  return traceAsync(
    "crawl.source",
    async (span) => {
      const visited = new Set();
      const queue = [{ url: seedUrl, depth: 0 }];
      const docs = [];

      while (queue.length > 0) {
        const current = queue.shift();
        if (!current || visited.has(current.url) || current.depth > maxDepth) {
          continue;
        }
        visited.add(current.url);

        const fetchResult = await fetchWithRetries(current.url, settings.maxRetries || 3, settings, span);

        if (!fetchResult.ok) {
          docs.push({
            id: crypto.randomUUID(),
            sessionId: session.id,
            archive: source.name,
            domain: new URL(current.url).hostname,
            url: current.url,
            title: current.url,
            date: "",
            text: "",
            entities: [],
            claims: [],
            status: fetchResult.status || "FETCH_FAILED"
          });
          continue;
        }

        const document = await buildDocumentRow(session.id, source, current.url, fetchResult.response);
        docs.push(document);

        if (current.depth < maxDepth) {
          const links = extractLinks(fetchResult.text, current.url);
          for (const link of links) {
            if (!visited.has(link)) {
              queue.push({ url: link, depth: current.depth + 1 });
            }
          }
        }
      }

      setSpanAttribute(span, "crawl.documents", docs.length);
      setSpanAttribute(span, "crawl.visited_urls", visited.size);
      return docs;
    },
    {
      parentSpan,
      attributes: {
        "crawl.seed_url": seedUrl,
        "crawl.source": source.name,
        "crawl.depth": maxDepth
      }
    }
  );
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
        notifyCaptcha(url);
        return { ok: false, status: "CAPTCHA_PAUSED" };
      }

      if (error instanceof PermanentHttpError && error.status === 403) {
        addSpanEvent(parentSpan, "fetch.result", { "url.full": url, status: "ACCESS_DENIED" });
        return { ok: false, status: "ACCESS_DENIED" };
      }

      if (error instanceof RetryableHttpError) {
        if (attempt >= Math.min(maxRetries, error.maxRetries || maxRetries)) {
          addSpanEvent(parentSpan, "fetch.result", { "url.full": url, status: `HTTP_${error.status}` });
          return { ok: false, status: `HTTP_${error.status}` };
        }
        const delayMs = error.baseDelayMs * Math.pow(2, attempt);
        await sleep(delayMs);
        attempt += 1;
        continue;
      }

      if (attempt >= maxRetries) {
        addSpanEvent(parentSpan, "fetch.result", { "url.full": url, status: "FETCH_FAILED" });
        return { ok: false, status: "FETCH_FAILED" };
      }

      await sleep(1000 * Math.pow(2, attempt));
      attempt += 1;
    }
  }

  return { ok: false, status: "FETCH_FAILED" };
}

async function buildDocumentRow(sessionId, source, url, response) {
  const ctype = response.headers.get("content-type") || "";
  const isPdf = ctype.includes("pdf") || /\.pdf$/i.test(url);
  const text = isPdf ? "" : await cloneToText(response);

  const title = deriveTitle(text, url);
  return {
    id: crypto.randomUUID(),
    sessionId,
    archive: source.name,
    domain: new URL(url).hostname,
    url,
    title,
    date: "",
    text,
    isPdf,
    pdfExtractionPending: isPdf,
    entities: [],
    claims: [],
    relevance: 0,
    status: "FETCHED"
  };
}

function deriveTitle(text, url) {
  const match = String(text || "").match(/<title>([^<]+)<\/title>/i);
  if (match) {
    return match[1].trim();
  }
  return url;
}

function extractLinks(html, baseUrl) {
  const links = new Set();
  const hrefRe = /href=["']([^"'#]+)["']/gi;
  let match;

  while ((match = hrefRe.exec(html || ""))) {
    try {
      const candidate = new URL(match[1], baseUrl).toString();
      if (candidate.startsWith("http://") || candidate.startsWith("https://")) {
        links.add(candidate);
      }
    } catch (_err) {
      continue;
    }
  }

  return Array.from(links).slice(0, 120);
}

function chunkText(text, limitTokens = 2000, overlapTokens = 200) {
  const words = String(text || "").replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean);
  if (words.length <= limitTokens) {
    return [words.join(" ")];
  }

  const chunks = [];
  let start = 0;
  while (start < words.length) {
    const end = Math.min(start + limitTokens, words.length);
    chunks.push(words.slice(start, end).join(" "));
    if (end >= words.length) {
      break;
    }
    start = Math.max(0, end - overlapTokens);
  }
  return chunks;
}

function computeDocRelevance(claims) {
  if (!claims.length) {
    return 0;
  }
  const total = claims.reduce((sum, claim) => sum + Number(claim.confidence || 0), 0);
  return total / claims.length;
}

async function summarizeDocument(settings, doc, subject, parentSpan) {
  const snippet = stripHtml(doc.text || "").slice(0, 3000);
  if (!snippet) {
    return "PDF or non-text content captured; parse in results panel.";
  }

  const prompt = [
    `Subject: ${subject}`,
    `Document URL: ${doc.url}`,
    "Summarize this document in one sentence focused on subject relevance.",
    "Return JSON only: {\"summary\":\"string\"}",
    snippet
  ].join("\n\n");

  const raw = await callOllama(settings, "You summarize archival documents in concise JSON.", prompt, parentSpan, {
    operation: "document_summary",
    documentId: doc.id
  });
  try {
    const parsed = cleanJsonResponse(raw);
    return parsed.summary || "Summary unavailable";
  } catch (_err) {
    return "Summary unavailable";
  }
}

async function buildContextBrief(settings, subject, entityGraph, documents, parentSpan) {
  const timelineRows = entityGraph.claims
    .filter((claim) => claim.date)
    .map((claim) => `${claim.date}: ${claim.subjectEntity} ${claim.relation} ${claim.objectEntity} [${claim.documentId}]`)
    .slice(0, 300);

  const inconsistencies = entityGraph.entities
    .filter((entity) => entity.consistencyFlag === "DISCREPANCY")
    .map((entity) => ({ entity: entity.name, details: entity.discrepancies || [] }));

  const prompt = OLLAMA_PROMPTS.contextBrief.userTemplate({
    subject,
    timelineRows,
    entities: entityGraph.entities,
    claims: entityGraph.claims,
    inconsistencies
  });

  const raw = await callOllama(settings, OLLAMA_PROMPTS.contextBrief.system, prompt, parentSpan, {
    operation: "context_brief",
    subject
  });
  try {
    return cleanJsonResponse(raw);
  } catch (_err) {
    return {
      subject,
      timeline: [],
      cast: [],
      subplots: [],
      follow_up_search_directives: [],
      unresolved_inconsistencies: inconsistencies.map((item) => ({
        entity: item.entity,
        detail: "Conflicting descriptions detected",
        citations: []
      }))
    };
  }
}

async function persistSessionData(session, documents, entities, claims, brief) {
  await bulkPut("documents", documents);
  await bulkPut("entities", entities);
  await bulkPut("claims", claims);

  await put("sessions", {
    ...session,
    lastModified: Date.now(),
    brief,
    documentIds: documents.map((doc) => doc.id),
    entityIds: entities.map((entity) => entity.id),
    claimIds: claims.map((claim) => claim.id)
  });
}

async function updateThreads(entities, sessionId) {
  for (const entity of entities) {
    const current = await getThread(entity.id);
    const nextSessions = Array.from(new Set([...(current?.sessionIds || []), sessionId]));
    await put("threads", {
      entityId: entity.id,
      entityName: entity.name,
      sessionIds: nextSessions
    });
  }
}

async function getThread(entityId) {
  const rows = await getAll("threads");
  return rows.find((row) => row.entityId === entityId) || null;
}

async function createSessionRecord(subject, contextCue, sources) {
  const now = Date.now();
  const date = new Date(now).toISOString().slice(0, 10);

  const session = {
    id: crypto.randomUUID(),
    title: `${subject} (${date})`,
    subject,
    contextCue,
    sources,
    createdAt: now,
    lastModified: now,
    status: "active"
  };

  await put("sessions", session);
  return session;
}

async function buildSessionBundle(sessionId) {
  const sessions = await getAll("sessions");
  const session = sessions.find((row) => row.id === sessionId);
  if (!session) {
    throw new Error("Session not found");
  }

  const [documents, entities, claims, threads] = await Promise.all([
    getAllByIndex("documents", "by_session", sessionId),
    getAllByIndex("entities", "by_session", sessionId),
    getAllByIndex("claims", "by_session", sessionId),
    getAll("threads")
  ]);

  return {
    session,
    documents,
    entityGraph: {
      subject: session.subject,
      entities,
      claims
    },
    threads
  };
}

async function listSessions(query) {
  const sessions = await getAll("sessions");
  const q = query.trim().toLowerCase();
  if (!q) {
    return sessions.sort((a, b) => b.lastModified - a.lastModified);
  }

  const entities = await getAll("entities");
  const entitiesBySession = new Map();
  for (const entity of entities) {
    if (!entitiesBySession.has(entity.sessionId)) {
      entitiesBySession.set(entity.sessionId, []);
    }
    entitiesBySession.get(entity.sessionId).push(entity.name.toLowerCase());
  }

  return sessions
    .filter((session) => {
      const titleMatch = session.title.toLowerCase().includes(q);
      const entityMatch = (entitiesBySession.get(session.id) || []).some((name) => name.includes(q));
      return titleMatch || entityMatch;
    })
    .sort((a, b) => b.lastModified - a.lastModified);
}

async function manualSave(sessionId) {
  const sessions = await getAll("sessions");
  const session = sessions.find((row) => row.id === sessionId);
  if (!session) {
    throw new Error("Session not found");
  }

  const next = { ...session, lastModified: Date.now() };
  await put("sessions", next);
  return next;
}

async function exportSessionJson(sessionId) {
  const bundle = await buildSessionBundle(sessionId);
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  await chrome.downloads.download({
    url,
    filename: `archivelens/session-${sessionId}.json`,
    saveAs: true
  });

  return { exported: true };
}

async function exportObsidian(sessionId) {
  const bundle = await buildSessionBundle(sessionId);
  const { session, documents, entityGraph } = bundle;

  const downloads = [];

  for (const entity of entityGraph.entities) {
    const relatedClaims = entityGraph.claims.filter(
      (claim) => claim.subjectEntityId === entity.id || claim.objectEntityId === entity.id
    );

    const lines = [
      `# ${entity.name}`,
      "",
      "## Aliases",
      ...(entity.aliases || []).map((alias) => `- ${alias}`),
      "",
      "## Related Claims",
      ...relatedClaims.map((claim) => `- [[${claim.subjectEntity}]] ${claim.relation} [[${claim.objectEntity}]] (${claim.date || "undated"})`)
    ];

    const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
    downloads.push({
      url: URL.createObjectURL(blob),
      filename: `archivelens/obsidian/${sanitize(entity.name)}.md`
    });
  }

  for (const doc of documents) {
    const lines = [
      `# ${doc.title}`,
      "",
      `- URL: ${doc.url}`,
      `- Archive: ${doc.archive}`,
      `- Relevance: ${doc.relevance ?? 0}`,
      "",
      "## Entities",
      ...(doc.entities || []).map((name) => `- [[${name}]]`),
      "",
      "## Summary",
      doc.summary || ""
    ];

    const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
    downloads.push({
      url: URL.createObjectURL(blob),
      filename: `archivelens/obsidian/docs/${sanitize(doc.title || doc.id)}.md`
    });
  }

  for (const item of downloads) {
    await chrome.downloads.download({
      ...item,
      saveAs: false
    });
  }

  return { exported: true, files: downloads.length, session: session.title };
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
    options: {
      temperature: 0.1
    }
  };

  let res;
  try {
    addSpanEvent(span, "ollama.request", {
      endpoint,
      hasSystemPrompt: Boolean(system),
      promptLength: String(prompt || "").length
    });

    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
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

function notifyCaptcha(url) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icon.png",
    title: "ArchiveLens crawl paused",
    message: `CAPTCHA detected for ${new URL(url).hostname}. Resume manually when ready.`
  });
}

function updateJob(jobId, progress, status = "active") {
  const state = activeJobs.get(jobId) || { sessionId: jobId };
  activeJobs.set(jobId, {
    ...state,
    status,
    progress,
    updatedAt: Date.now()
  });
}

function sanitize(value) {
  return String(value || "item")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 80);
}

function stripHtml(text) {
  return String(text || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

async function cloneToText(response) {
  const clone = response.clone();
  try {
    return await clone.text();
  } catch (_err) {
    return "";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Autosave active sessions every five minutes.
setInterval(async () => {
  const sessions = await getAll("sessions");
  const active = sessions.filter((session) => session.status === "active");
  for (const session of active) {
    await put("sessions", { ...session, lastModified: Date.now() });
  }
}, 5 * 60 * 1000);
