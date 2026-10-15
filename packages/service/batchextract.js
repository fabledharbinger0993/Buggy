/**
 * batchextract.js — Stage 1: batch entity extraction.
 *
 * Groups multiple chunks into a single Ollama call to amortize prompt overhead.
 * Falls back to per-chunk extraction if batched JSON parsing fails, so the
 * pipeline degrades gracefully without losing data.
 */

import { OLLAMA_PROMPTS, cleanJsonResponse } from "./prompts.js";

/**
 * @typedef {Object} ChunkInput
 * @property {string} chunkId         Unique chunk id, e.g. `${docId}:${index}`
 * @property {string} sourceUrl       Origin URL of the chunk
 * @property {string} chunkText       Raw text payload
 * @property {string} documentId      Parent document id (for attribution)
 */

/**
 * @typedef {Object} ChunkExtraction
 * @property {string} chunkId
 * @property {string} documentId
 * @property {Array<Object>} entities
 * @property {Array<Object>} claims
 */

/**
 * Extract entities/claims across many chunks, batching when possible.
 *
 * @param {Object} args
 * @param {Array<ChunkInput>} args.chunks
 * @param {string} args.subject
 * @param {string} args.contextCue
 * @param {number} [args.batchSize=5]
 * @param {number} [args.concurrency=1]
 * @param {function(Object): Promise<string>} args.callOllama
 *        Signature: ({ system, prompt, meta }) => raw string response
 * @returns {Promise<Array<ChunkExtraction>>}
 */
export async function batchExtractChunks({
  chunks,
  subject,
  contextCue,
  batchSize = 5,
  concurrency = 1,
  callOllama,
}) {
  if (!chunks?.length) return [];

  const batches = [];
  for (let i = 0; i < chunks.length; i += batchSize) {
    batches.push(chunks.slice(i, i + batchSize));
  }

  const runBatch = async (batch, batchIndex) => {
    // Single-item batches use the original (cheaper, more reliable) prompt
    if (batch.length === 1) {
      return [await extractSingle(batch[0], subject, contextCue, callOllama)];
    }

    const prompt = OLLAMA_PROMPTS.batchEntityExtraction.userTemplate({
      subject,
      contextCue,
      chunks: batch,
    });

    let raw;
    try {
      raw = await callOllama({
        system: OLLAMA_PROMPTS.batchEntityExtraction.system,
        prompt,
        meta: {
          operation: "batch_entity_extraction",
          batchIndex,
          batchSize: batch.length,
        },
      });
    } catch (err) {
      console.warn(`[batchextract] batch ${batchIndex} threw, falling back to per-chunk:`, err?.message);
      return fallbackPerChunk(batch, subject, contextCue, callOllama);
    }

    let parsed;
    try {
      parsed = cleanJsonResponse(raw);
    } catch {
      console.warn(`[batchextract] batch ${batchIndex} returned unparseable JSON; falling back`);
      return fallbackPerChunk(batch, subject, contextCue, callOllama);
    }

    const resultsById = new Map(
      (parsed.results || []).map((r) => [String(r.chunk_id), r])
    );

    return batch.map((chunk) => {
      const hit = resultsById.get(chunk.chunkId);
      if (!hit) {
        // Model dropped a chunk — extract it solo so we don't lose data
        return null;
      }
      return {
        chunkId: chunk.chunkId,
        documentId: chunk.documentId,
        entities: hit.entities || [],
        claims: hit.claims || [],
      };
    });
  };

  // Run batches with bounded concurrency
  const results = new Array(batches.length);
  let cursor = 0;
  async function worker() {
    while (cursor < batches.length) {
      const myIndex = cursor++;
      results[myIndex] = await runBatch(batches[myIndex], myIndex);
    }
  }
  const workers = Array.from({ length: Math.max(1, concurrency) }, () => worker());
  await Promise.all(workers);

  // Fill any dropped-by-model chunks with single-chunk fallback
  const flat = results.flat();
  const finalOut = [];
  for (let i = 0; i < flat.length; i++) {
    if (flat[i]) {
      finalOut.push(flat[i]);
    } else {
      finalOut.push(await extractSingle(chunks[i], subject, contextCue, callOllama));
    }
  }
  return finalOut;
}

async function fallbackPerChunk(batch, subject, contextCue, callOllama) {
  const out = [];
  for (const chunk of batch) {
    out.push(await extractSingle(chunk, subject, contextCue, callOllama));
  }
  return out;
}

async function extractSingle(chunk, subject, contextCue, callOllama) {
  const prompt = OLLAMA_PROMPTS.entityExtraction.userTemplate({
    subject,
    contextCue,
    chunkText: chunk.chunkText,
    chunkId: chunk.chunkId,
    sourceUrl: chunk.sourceUrl,
  });

  let raw;
  try {
    raw = await callOllama({
      system: OLLAMA_PROMPTS.entityExtraction.system,
      prompt,
      meta: {
        operation: "entity_extraction",
        chunkId: chunk.chunkId,
        documentId: chunk.documentId,
      },
    });
  } catch {
    return { chunkId: chunk.chunkId, documentId: chunk.documentId, entities: [], claims: [] };
  }

  let parsed;
  try {
    parsed = cleanJsonResponse(raw);
  } catch {
    parsed = { entities: [], claims: [] };
  }

  return {
    chunkId: chunk.chunkId,
    documentId: chunk.documentId,
    entities: parsed.entities || [],
    claims: parsed.claims || [],
  };
}
