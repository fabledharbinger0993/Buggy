/**
 * db.js — storage for the IndexedDB interface used by archivelens.
 *
 * Provides identical async API: put, bulkPut, get, getAll, getAllByIndex,
 * remove, ensureDefaultSettings, getSettings, updateSettings.
 *
 * Backend: Postgres when DATABASE_URL is set (Railway), otherwise a local
 * SQLite file (development). Only the chosen backend's driver is loaded.
 */

const backend = process.env.DATABASE_URL
  ? await import("./db-postgres.js")
  : await import("./db-sqlite.js");

console.log(`[db] using ${process.env.DATABASE_URL ? "Postgres" : "SQLite"} storage`);

export const { put, bulkPut, get, getAll, getAllByIndex, remove } = backend;

// ─── Settings Helpers ─────────────────────────────────────────────────────────

export function getDefaultSettings() {
  return {
    ollamaEndpoint: process.env.fungai_OLLAMA_URL || "http://localhost:11434/api/generate",
    ollamaModel: process.env.fungai_AGENT_MODEL || "qwen2.5-coder:7b",
    confidenceThreshold: 0.6,
    crawlDepth: 2,
    crawlDelaySeconds: 3,
    contactEmail: "researcher@example.com",
    archives: {},
    maxRetries: 3,
    chunkTokenLimit: 2000,
    chunkOverlapTokens: 200,
    tracingEnabled: true,
    tracingEndpoint: "http://localhost:4318/v1/traces",
    tracingServiceName: "fungai-service",
    // Stage 1: batch entity extraction
    chunkBatchSize: 5,
    ollamaConcurrency: 1,
    // Stage 2: global synthesis (single-call entity clustering)
    useGlobalSynthesis: true,
    // Stage 3: embeddings (in-process via @xenova/transformers)
    embeddingsEnabled: true,
    useSemanticClustering: false,
    embeddingsModel: "Xenova/all-MiniLM-L6-v2"
  };
}

export async function ensureDefaultSettings() {
  const existing = await get("settings", "user");
  if (existing) return existing.value ?? existing;
  const defaults = getDefaultSettings();
  await put("settings", { key: "user", value: defaults });
  return defaults;
}

export async function getSettings() {
  const row = await get("settings", "user");
  if (row && row.value) return row.value;
  if (row && typeof row === "object" && !row.key) return row;
  return ensureDefaultSettings();
}

export async function updateSettings(partial) {
  const current = await getSettings();
  const merged = { ...current, ...partial };
  await put("settings", { key: "user", value: merged });
  return merged;
}
