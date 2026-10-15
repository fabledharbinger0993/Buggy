/**
 * db.js — IndexedDB schema and access module for ArchiveLens
 *
 * Object stores:
 *  - sessions:   research sessions (UUID keyed)
 *  - documents:  crawled/extracted documents
 *  - entities:   canonical resolved entity records
 *  - claims:     factual claims with corroboration metadata
 *  - threads:    entity-UUID → session-UUID[] linkage
 *  - robotsCache: robots.txt cache per domain
 *  - settings:   user configuration key-value store
 */

const DB_NAME = 'ArchiveLens';
const DB_VERSION = 1;

/** Open (and upgrade) the database. Returns a Promise<IDBDatabase>. */
export function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;

      // ── sessions ──────────────────────────────────────────────────────────
      if (!db.objectStoreNames.contains('sessions')) {
        const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
        sessions.createIndex('status', 'status', { unique: false });
        sessions.createIndex('lastModified', 'lastModified', { unique: false });
      }

      // ── documents ─────────────────────────────────────────────────────────
      if (!db.objectStoreNames.contains('documents')) {
        const docs = db.createObjectStore('documents', { keyPath: 'id' });
        docs.createIndex('sessionId', 'sessionId', { unique: false });
        docs.createIndex('url', 'url', { unique: false });
        docs.createIndex('archive', 'archive', { unique: false });
        docs.createIndex('relevanceScore', 'relevanceScore', { unique: false });
      }

      // ── entities ──────────────────────────────────────────────────────────
      if (!db.objectStoreNames.contains('entities')) {
        const entities = db.createObjectStore('entities', { keyPath: 'id' });
        entities.createIndex('sessionId', 'sessionId', { unique: false });
        entities.createIndex('type', 'type', { unique: false });
        entities.createIndex('canonical', 'canonical', { unique: false });
      }

      // ── claims ────────────────────────────────────────────────────────────
      if (!db.objectStoreNames.contains('claims')) {
        const claims = db.createObjectStore('claims', { keyPath: 'id' });
        claims.createIndex('sessionId', 'sessionId', { unique: false });
        claims.createIndex('corroborationStatus', 'corroborationStatus', { unique: false });
        claims.createIndex('entityId', 'entityId', { unique: false });
      }

      // ── threads ───────────────────────────────────────────────────────────
      if (!db.objectStoreNames.contains('threads')) {
        const threads = db.createObjectStore('threads', { keyPath: 'entityId' });
        threads.createIndex('entityId', 'entityId', { unique: true });
      }

      // ── robotsCache ───────────────────────────────────────────────────────
      if (!db.objectStoreNames.contains('robotsCache')) {
        const robots = db.createObjectStore('robotsCache', { keyPath: 'domain' });
        robots.createIndex('fetchedAt', 'fetchedAt', { unique: false });
      }

      // ── settings ──────────────────────────────────────────────────────────
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Generic get by key from an object store. */
export function dbGet(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Generic put (upsert) into an object store. */
export function dbPut(db, storeName, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Get all records from a store, optionally filtered by index + value. */
export function dbGetAll(db, storeName, indexName, indexValue) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    let req;
    if (indexName && indexValue !== undefined) {
      req = store.index(indexName).getAll(indexValue);
    } else {
      req = store.getAll();
    }
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Delete a record by key. */
export function dbDelete(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/** Read a settings value; returns defaultValue if not set. */
export async function getSetting(db, key, defaultValue) {
  const record = await dbGet(db, 'settings', key);
  return record ? record.value : defaultValue;
}

/** Write a settings value. */
export function setSetting(db, key, value) {
  return dbPut(db, 'settings', { key, value });
}

/**
 * Session record schema:
 * {
 *   id: string (UUID),
 *   title: string,
 *   subject: string,
 *   contextCues: string,
 *   archives: string[],
 *   status: 'active' | 'complete' | 'archived',
 *   created: number (timestamp),
 *   lastModified: number (timestamp),
 *   documentIds: string[],
 *   entityIds: string[],
 *   claimIds: string[]
 * }
 *
 * Document record schema:
 * {
 *   id: string (UUID),
 *   sessionId: string,
 *   url: string,
 *   title: string,
 *   archive: string,
 *   date: string,
 *   bodyText: string,
 *   summary: string,
 *   entities: string[] (UUIDs),
 *   relevanceScore: number,
 *   accessStatus: 'ok' | 'ACCESS_DENIED' | 'error',
 *   fetchedAt: number
 * }
 *
 * Entity record schema:
 * {
 *   id: string (UUID),
 *   sessionId: string,
 *   canonical: string,
 *   type: 'person' | 'organization' | 'location' | 'date' | 'operation' | 'fileNumber' | 'other',
 *   aliases: string[],
 *   role: string,
 *   attributes: object,
 *   consistencyFlag: 'CONSISTENT' | 'DISCREPANCY' | null,
 *   discrepancies: object[],
 *   merge_log: object[],
 *   documentIds: string[],
 *   confidence: number
 * }
 *
 * Claim record schema:
 * {
 *   id: string (UUID),
 *   sessionId: string,
 *   entityId: string,
 *   relatedEntityId: string,
 *   relationship: string,
 *   date: string,
 *   location: string,
 *   action: string,
 *   sourceDocumentIds: string[],
 *   sourceDomains: string[],
 *   corroborationStatus: 'UNCORROBORATED' | 'SINGLE-SOURCE' | 'CORROBORATED',
 *   confidence: number
 * }
 *
 * Thread record schema:
 * {
 *   entityId: string (UUID) — keyPath,
 *   sessionIds: string[]
 * }
 *
 * RobotsCache record schema:
 * {
 *   domain: string — keyPath,
 *   disallowedPaths: string[],
 *   fetchedAt: number
 * }
 */
