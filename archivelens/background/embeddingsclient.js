/**
 * embeddingsclient.js — Stage 3: HTTP client for the buggy-service
 * `/embed` and `/vector-cluster` endpoints.
 *
 * The service URL is read from settings (`embeddingsServiceUrl`). When the
 * URL is blank or the service is unreachable, all calls return `null` so
 * the pipeline can degrade gracefully to its original ordering.
 */

const DEFAULT_TIMEOUT_MS = 8_000;

function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/**
 * @param {string} baseUrl
 * @param {string[]} texts
 * @returns {Promise<{ vectors: number[][], dim: number, model: string } | null>}
 */
export async function embedTextsViaService(baseUrl, texts) {
  if (!baseUrl || !texts?.length) return null;
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts }),
      signal: timeoutSignal(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * @param {string} baseUrl
 * @param {Array<{id:string,text:string}>} chunks
 * @param {number} [threshold]
 * @returns {Promise<{ clusters: Array<{clusterId:string,memberIds:string[]}> } | null>}
 */
export async function clusterChunksViaService(baseUrl, chunks, threshold = 0.78) {
  if (!baseUrl || !chunks?.length) return null;
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/vector-cluster`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chunks, threshold }),
      signal: timeoutSignal(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
