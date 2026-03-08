const DB_NAME = "archivelens";
const DB_VERSION = 3;

let dbPromise;

export function getDefaultSettings() {
  return {
    ollamaEndpoint: "http://localhost:11434/api/generate",
    ollamaModel: "llama3",
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
    tracingServiceName: "archivelens-extension"
  };
}

export async function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;

        if (!db.objectStoreNames.contains("settings")) {
          db.createObjectStore("settings", { keyPath: "key" });
        }

        if (!db.objectStoreNames.contains("sessions")) {
          const sessions = db.createObjectStore("sessions", { keyPath: "id" });
          sessions.createIndex("by_status", "status", { unique: false });
          sessions.createIndex("by_modified", "lastModified", { unique: false });
        }

        if (!db.objectStoreNames.contains("documents")) {
          const docs = db.createObjectStore("documents", { keyPath: "id" });
          docs.createIndex("by_session", "sessionId", { unique: false });
          docs.createIndex("by_url", "url", { unique: false });
          docs.createIndex("by_domain", "domain", { unique: false });
        }

        if (!db.objectStoreNames.contains("entities")) {
          const entities = db.createObjectStore("entities", { keyPath: "id" });
          entities.createIndex("by_session", "sessionId", { unique: false });
          entities.createIndex("by_name", "name", { unique: false });
        }

        if (!db.objectStoreNames.contains("claims")) {
          const claims = db.createObjectStore("claims", { keyPath: "id" });
          claims.createIndex("by_session", "sessionId", { unique: false });
          claims.createIndex("by_status", "corroborationStatus", { unique: false });
        }

        if (!db.objectStoreNames.contains("threads")) {
          db.createObjectStore("threads", { keyPath: "entityId" });
        }

        if (!db.objectStoreNames.contains("crawlCache")) {
          db.createObjectStore("crawlCache", { keyPath: "key" });
        }

        if (!db.objectStoreNames.contains("archives")) {
          db.createObjectStore("archives", { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}

export async function put(storeName, value) {
  const db = await openDb();
  return tx(db, storeName, "readwrite", (store) => store.put(value));
}

export async function bulkPut(storeName, values) {
  const db = await openDb();
  return tx(db, storeName, "readwrite", (store) => {
    for (const value of values) {
      store.put(value);
    }
  });
}

export async function get(storeName, key) {
  const db = await openDb();
  return tx(db, storeName, "readonly", (store) => store.get(key));
}

export async function getAll(storeName) {
  const db = await openDb();
  return tx(db, storeName, "readonly", (store) => store.getAll());
}

export async function getAllByIndex(storeName, indexName, key) {
  const db = await openDb();
  return tx(db, storeName, "readonly", (store) => store.index(indexName).getAll(key));
}

export async function remove(storeName, key) {
  const db = await openDb();
  return tx(db, storeName, "readwrite", (store) => store.delete(key));
}

export async function ensureDefaultSettings() {
  const existing = await get("settings", "user");
  if (existing) {
    return existing.value;
  }
  const defaults = getDefaultSettings();
  await put("settings", { key: "user", value: defaults });
  return defaults;
}

export async function getSettings() {
  const row = await get("settings", "user");
  if (row && row.value) {
    return row.value;
  }
  return ensureDefaultSettings();
}

export async function updateSettings(partial) {
  const current = await getSettings();
  const merged = { ...current, ...partial };
  await put("settings", { key: "user", value: merged });
  return merged;
}

function tx(db, storeName, mode, cb) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    const result = cb(store);

    transaction.oncomplete = () => {
      if (result && typeof result.onsuccess === "function") {
        return;
      }
      if (result && typeof result.result !== "undefined") {
        resolve(result.result);
      } else {
        resolve(undefined);
      }
    };

    transaction.onerror = () => reject(transaction.error);

    if (result && typeof result.onsuccess !== "undefined") {
      result.onsuccess = () => resolve(result.result);
      result.onerror = () => reject(result.error);
    }
  });
}
