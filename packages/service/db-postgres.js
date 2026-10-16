/**
 * db-postgres.js — Postgres backend for db.js, used when DATABASE_URL is set.
 *
 * Same layout as db-sqlite.js: indexed fields are real columns next to a `data`
 * JSON blob. `data` is TEXT rather than JSONB because JSONB rejects the \u0000
 * escapes that crawled documents can contain. Identifiers are quoted because
 * Postgres folds unquoted names (sessionId, crawlCache, ...) to lowercase.
 */

import pg from "pg";

// FungAI's tables live in their own schema so they cannot collide with tables
// other apps have created in `public` of a shared database (Railway's does).
const SCHEMA = "fungai";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  options: `-c search_path=${SCHEMA}`
});
// An idle client losing its connection must not crash the process; the pool replaces it.
pool.on("error", (err) => console.error("[db] idle Postgres client error:", err.message));

// ─── Schema ───────────────────────────────────────────────────────────────────

await pool.query(`
  CREATE SCHEMA IF NOT EXISTS ${SCHEMA};

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id             TEXT PRIMARY KEY,
    status         TEXT NOT NULL DEFAULT 'active',
    "lastModified" BIGINT NOT NULL DEFAULT 0,
    data           TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_by_status   ON sessions(status);
  CREATE INDEX IF NOT EXISTS sessions_by_modified ON sessions("lastModified");

  CREATE TABLE IF NOT EXISTS documents (
    id          TEXT PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    url         TEXT NOT NULL DEFAULT '',
    domain      TEXT NOT NULL DEFAULT '',
    data        TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS documents_by_session ON documents("sessionId");
  CREATE INDEX IF NOT EXISTS documents_by_url     ON documents(url);
  CREATE INDEX IF NOT EXISTS documents_by_domain  ON documents(domain);

  CREATE TABLE IF NOT EXISTS entities (
    id          TEXT PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    name        TEXT NOT NULL DEFAULT '',
    data        TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS entities_by_session ON entities("sessionId");
  CREATE INDEX IF NOT EXISTS entities_by_name    ON entities(name);

  CREATE TABLE IF NOT EXISTS claims (
    id                    TEXT PRIMARY KEY,
    "sessionId"           TEXT NOT NULL,
    "corroborationStatus" TEXT NOT NULL DEFAULT 'UNCORROBORATED',
    data                  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS claims_by_session ON claims("sessionId");
  CREATE INDEX IF NOT EXISTS claims_by_status  ON claims("corroborationStatus");

  CREATE TABLE IF NOT EXISTS threads (
    "entityId" TEXT PRIMARY KEY,
    data       TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS "crawlCache" (
    key  TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );
`);

// ─── Store layout ─────────────────────────────────────────────────────────────

// keyCol: primary key column; dataCol: JSON blob column; indexes: index name → column.
// Doubles as an allowlist: storeName is interpolated into SQL only after lookup here.
const STORES = {
  settings:   { table: "settings",     keyCol: "key",      dataCol: "value", indexes: {} },
  threads:    { table: "threads",      keyCol: '"entityId"', dataCol: "data", indexes: {} },
  crawlCache: { table: '"crawlCache"', keyCol: "key",      dataCol: "data",  indexes: {} },
  sessions:   { table: "sessions",     keyCol: "id",       dataCol: "data",
                indexes: { by_status: "status", by_modified: '"lastModified"' } },
  documents:  { table: "documents",    keyCol: "id",       dataCol: "data",
                indexes: { by_session: '"sessionId"', by_url: "url", by_domain: "domain" } },
  entities:   { table: "entities",     keyCol: "id",       dataCol: "data",
                indexes: { by_session: '"sessionId"', by_name: "name" } },
  claims:     { table: "claims",       keyCol: "id",       dataCol: "data",
                indexes: { by_session: '"sessionId"', by_status: '"corroborationStatus"' } }
};

function store(storeName) {
  const s = STORES[storeName];
  if (!s) throw new Error(`Unknown store: ${storeName}`);
  return s;
}

function deserialize(raw) {
  if (!raw) return null;
  return JSON.parse(raw);
}

// Returns [quotedColumn, value] pairs for the indexed columns of a row.
function indexedColumns(storeName, value) {
  switch (storeName) {
    case "sessions":
      return [["status", value.status || "active"], ['"lastModified"', value.lastModified || 0]];
    case "documents":
      return [['"sessionId"', value.sessionId || ""], ["url", value.url || ""], ["domain", value.domain || ""]];
    case "entities":
      return [['"sessionId"', value.sessionId || ""], ["name", value.name || ""]];
    case "claims":
      return [['"sessionId"', value.sessionId || ""],
              ['"corroborationStatus"', value.corroborationStatus || "UNCORROBORATED"]];
    default:
      return [];
  }
}

function keyOf(storeName, value) {
  if (storeName === "settings" || storeName === "crawlCache") return value.key;
  if (storeName === "threads") return value.entityId;
  return value.id;
}

function upsertQuery(storeName, value) {
  const s = store(storeName);
  const idx = indexedColumns(storeName, value);
  const cols = [s.keyCol, ...idx.map(([c]) => c), s.dataCol];
  const params = [keyOf(storeName, value), ...idx.map(([, v]) => v), JSON.stringify(value)];
  const placeholders = params.map((_, i) => `$${i + 1}`).join(", ");
  const updates = cols.slice(1).map((c) => `${c} = EXCLUDED.${c}`).join(", ");
  return {
    text: `INSERT INTO ${s.table}(${cols.join(", ")}) VALUES(${placeholders})
           ON CONFLICT(${s.keyCol}) DO UPDATE SET ${updates}`,
    values: params
  };
}

// ─── Core Operations ──────────────────────────────────────────────────────────

export async function put(storeName, value) {
  await pool.query(upsertQuery(storeName, value));
}

export async function bulkPut(storeName, values) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const row of values) await client.query(upsertQuery(storeName, row));
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function get(storeName, key) {
  const s = store(storeName);
  const { rows } = await pool.query(
    `SELECT ${s.dataCol} AS data FROM ${s.table} WHERE ${s.keyCol} = $1`, [key]
  );
  return rows[0] ? deserialize(rows[0].data) : null;
}

export async function getAll(storeName) {
  const s = store(storeName);
  const { rows } = await pool.query(`SELECT ${s.dataCol} AS data FROM ${s.table}`);
  return rows.map((r) => deserialize(r.data));
}

export async function getAllByIndex(storeName, indexName, key) {
  const s = store(storeName);
  const col = s.indexes[indexName];
  if (!col) throw new Error(`Unknown index: ${storeName}.${indexName}`);
  const { rows } = await pool.query(`SELECT data FROM ${s.table} WHERE ${col} = $1`, [key]);
  return rows.map((r) => deserialize(r.data));
}

export async function remove(storeName, key) {
  const s = store(storeName);
  await pool.query(`DELETE FROM ${s.table} WHERE ${s.keyCol} = $1`, [key]);
}
