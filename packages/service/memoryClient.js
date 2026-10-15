const BASE = process.env.HOLOGRAIM_URL

export async function queryMemory(query, topK = 5, minConfidence = 0.0) {
  if (!BASE) return null
  const r = await fetch(`${BASE}/memory/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, top_k: topK, min_confidence: minConfidence }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => null)
  if (!r?.ok) return null
  return r.json()
}

export async function storeMemory({ content, confidence = 0.7, source = '', tags = [] }) {
  if (!BASE) return
  fetch(`${BASE}/memory/store`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, confidence, source, tags }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {})
}

export async function graphNeighbors(concept, depth = 2) {
  if (!BASE) return null
  const r = await fetch(
    `${BASE}/memory/neighbors?concept=${encodeURIComponent(concept)}&depth=${depth}`,
    { signal: AbortSignal.timeout(3000) },
  ).catch(() => null)
  if (!r?.ok) return null
  return r.json()
}
