/**
 * db.js — SQLite drop-in for the IndexedDB interface used by archivelens.
 *
 * Provides identical async API: put, bulkPut, get, getAll, getAllByIndex,
 * remove, ensureDefaultSettings, getSettings, updateSettings.
 *
 * Indexed fields are stored as real columns alongside a `data` JSON blob
 * so getAllByIndex() can run efficient WHERE queries without scanning JSON.
 */

import Database from "better-sqlite3";
import { createRequire } from "module";
import { mkdirSync, existsSync } from "fs";
import path from "path";
import os from "os";

const DATA_DIR = process.env.BUGGY_DATA_DIR || path.join(os.homedir(), ".buggy-service");
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, "buggy.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ─── Schema ───────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id           TEXT PRIMARY KEY,
    status       TEXT NOT NULL DEFAULT 'active',
    lastModified INTEGER NOT NULL DEFAULT 0,
    data         TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_by_status   ON sessions(status);
  CREATE INDEX IF NOT EXISTS sessions_by_modified ON sessions(lastModified);

  CREATE TABLE IF NOT EXISTS documents (
    id        TEXT PRIMARY KEY,
    sessionId TEXT NOT NULL,
    url       TEXT NOT NULL DEFAULT '',
    domain    TEXT NOT NULL DEFAULT '',
    data      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS documents_by_session ON documents(sessionId);
  CREATE INDEX IF NOT EXISTS documents_by_url     ON documents(url);
  CREATE INDEX IF NOT EXISTS documents_by_domain  ON documents(domain);

  CREATE TABLE IF NOT EXISTS entities (
    id        TEXT PRIMARY KEY,
    sessionId TEXT NOT NULL,
    name      TEXT NOT NULL DEFAULT '',
    data      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS entities_by_session ON entities(sessionId);
  CREATE INDEX IF NOT EXISTS entities_by_name    ON entities(name);

  CREATE TABLE IF NOT EXISTS claims (
    id                  TEXT PRIMARY KEY,
    sessionId           TEXT NOT NULL,
    corroborationStatus TEXT NOT NULL DEFAULT 'UNCORROBORATED',
    data                TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS claims_by_session ON claims(sessionId);
  CREATE INDEX IF NOT EXISTS claims_by_status  ON claims(corroborationStatus);

  CREATE TABLE IF NOT EXISTS threads (
    entityId TEXT PRIMARY KEY,
    data     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS crawlCache (
    key  TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );
`);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function serialize(value) {
  return JSON.stringify(value);
}

function deserialize(raw) {
  if (!raw) return null;
  return JSON.parse(raw);
}

function extractIndexedColumns(storeName, value) {
  switch (storeName) {
    case "sessions":
      return {
        status: value.status || "active",
        lastModified: value.lastModified || 0
      };
    case "documents":
      return {
        sessionId: value.sessionId || "",
        url: value.url || "",
        domain: value.domain || ""
      };
    case "entities":
      return {
        sessionId: value.sessionId || "",
        name: value.name || ""
      };
    case "claims":
      return {
        sessionId: value.sessionId || "",
        corroborationStatus: value.corroborationStatus || "UNCORROBORATED"
      };
    default:
      return {};
  }
}

// ─── Core Operations ──────────────────────────────────────────────────────────

export async function put(storeName, value) {
  const idx = extractIndexedColumns(storeName, value);
  const cols = Object.keys(idx);
  const data = serialize(value);

  if (storeName === "settings") {
    db.prepare(
      "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(value.key, data);
    return;
  }

  if (storeName === "threads") {
    db.prepare(
      "INSERT INTO threads(entityId, data) VALUES(?, ?) ON CONFLICT(entityId) DO UPDATE SET data = excluded.data"
    ).run(value.entityId, data);
    return;
  }

  if (storeName === "crawlCache") {
    db.prepare(
      "INSERT INTO crawlCache(key, data) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data"
    ).run(value.key, data);
    return;
  }

  const colNames = ["id", ...cols, "data"].join(", ");
  const placeholders = ["?", ...cols.map(() => "?"), "?"].join(", ");
  const updates = [...cols.map((c) => `${c} = excluded.${c}`), "data = excluded.data"].join(", ");

  db.prepare(
    `INSERT INTO ${storeName}(${colNames}) VALUES(${placeholders}) ON CONFLICT(id) DO UPDATE SET ${updates}`
  ).run(value.id, ...cols.map((c) => idx[c]), data);
}

export async function bulkPut(storeName, values) {
  const doAll = db.transaction((rows) => {
    for (const row of rows) {
      put(storeName, row);
    }
  });
  doAll(values);
}

export async function get(storeName, key) {
  if (storeName === "settings") {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return row ? deserialize(row.value) : null;
  }
  if (storeName === "threads") {
    const row = db.prepare("SELECT data FROM threads WHERE entityId = ?").get(key);
    return row ? deserialize(row.data) : null;
  }
  if (storeName === "crawlCache") {
    const row = db.prepare("SELECT data FROM crawlCache WHERE key = ?").get(key);
    return row ? deserialize(row.data) : null;
  }
  const row = db.prepare(`SELECT data FROM ${storeName} WHERE id = ?`).get(key);
  return row ? deserialize(row.data) : null;
}

export async function getAll(storeName) {
  if (storeName === "settings") {
    return db.prepare("SELECT value FROM settings").all().map((r) => deserialize(r.value));
  }
  if (storeName === "threads") {
    return db.prepare("SELECT data FROM threads").all().map((r) => deserialize(r.data));
  }
  if (storeName === "crawlCache") {
    return db.prepare("SELECT data FROM crawlCache").all().map((r) => deserialize(r.data));
  }
  return db.prepare(`SELECT data FROM ${storeName}`).all().map((r) => deserialize(r.data));
}

export async function getAllByIndex(storeName, indexName, key) {
  const colMap = {
    documents: { by_session: "sessionId", by_url: "url", by_domain: "domain" },
    entities:  { by_session: "sessionId", by_name: "name" },
    claims:    { by_session: "sessionId", by_status: "corroborationStatus" },
    sessions:  { by_status: "status",    by_modified: "lastModified" }
  };

  const col = colMap[storeName]?.[indexName];
  if (!col) throw new Error(`Unknown index: ${storeName}.${indexName}`);

  return db
    .prepare(`SELECT data FROM ${storeName} WHERE ${col} = ?`)
    .all(key)
    .map((r) => deserialize(r.data));
}

export async function remove(storeName, key) {
  if (storeName === "threads") {
    db.prepare("DELETE FROM threads WHERE entityId = ?").run(key);
    return;
  }
  if (storeName === "crawlCache") {
    db.prepare("DELETE FROM crawlCache WHERE key = ?").run(key);
    return;
  }
  db.prepare(`DELETE FROM ${storeName} WHERE id = ?`).run(key);
}

// ─── Settings Helpers ─────────────────────────────────────────────────────────

export function getDefaultSettings() {
  return {
    ollamaEndpoint: process.env.BUGGY_OLLAMA_URL || "http://localhost:11434/api/generate",
    ollamaModel: process.env.BUGGY_AGENT_MODEL || "qwen2.5-coder:7b",
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
    tracingServiceName: "buggy-service"
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
