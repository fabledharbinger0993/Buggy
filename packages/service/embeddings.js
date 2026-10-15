/**
 * embeddings.js — Stage 3: local feature-extraction embeddings.
 *
 * Wraps @xenova/transformers (ONNX runtime) so the service can produce
 * sentence embeddings without calling out to OpenAI or Ollama. The pipeline
 * is loaded lazily on first use and cached for the process lifetime.
 *
 * Default model: Xenova/all-MiniLM-L6-v2 (384-dim, ~22MB on disk).
 */

let pipelinePromise = null;
let pipelineModel = null;

async function getPipeline(modelId) {
  const id = modelId || "Xenova/all-MiniLM-L6-v2";
  if (pipelinePromise && pipelineModel === id) return pipelinePromise;

  pipelineModel = id;
  pipelinePromise = (async () => {
    // Dynamic import — keeps the rest of the service usable even if the
    // optional dep is missing.
    const { pipeline } = await import("@xenova/transformers");
    return pipeline("feature-extraction", id, { quantized: true });
  })();

  return pipelinePromise;
}

/**
 * Compute embeddings for a list of input strings.
 * Returns Float32Array vectors as plain number[] arrays for JSON serialization.
 *
 * @param {string[]} texts
 * @param {Object} [opts]
 * @param {string} [opts.model]
 * @returns {Promise<{ vectors: number[][], model: string, dim: number }>}
 */
export async function embedTexts(texts, opts = {}) {
  if (!Array.isArray(texts) || texts.length === 0) {
    return { vectors: [], model: opts.model || "Xenova/all-MiniLM-L6-v2", dim: 0 };
  }

  const extractor = await getPipeline(opts.model);
  const out = await extractor(texts, { pooling: "mean", normalize: true });
  // out.tolist() returns nested array; for single input it's [dim], else [n][dim]
  const arr = out.tolist();
  const vectors = Array.isArray(arr[0]) ? arr : [arr];
  return {
    vectors,
    model: pipelineModel,
    dim: vectors[0]?.length || 0,
  };
}

/**
 * Cosine similarity between two unit-normalized vectors.
 * Vectors from `embedTexts` are already L2-normalized, so this is a dot product.
 */
export function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Greedy clustering of items by cosine similarity to a centroid.
 * Centroid is the average of accepted member vectors (then re-normalized).
 *
 * @param {Array<{ id: string, vector: number[] }>} items
 * @param {number} threshold cosine similarity threshold to join a cluster
 * @returns {Array<{ centroid: number[], memberIds: string[] }>}
 */
export function clusterByCosine(items, threshold = 0.78) {
  const clusters = [];

  for (const item of items) {
    let best = null;
    let bestScore = -1;
    for (const cluster of clusters) {
      const score = cosineSim(item.vector, cluster.centroid);
      if (score > bestScore) {
        bestScore = score;
        best = cluster;
      }
    }

    if (best && bestScore >= threshold) {
      best.memberIds.push(item.id);
      // Recompute mean centroid then renormalize
      const dim = best.centroid.length;
      const next = new Array(dim);
      for (let i = 0; i < dim; i++) {
        next[i] = best.centroid[i] + (item.vector[i] - best.centroid[i]) / best.memberIds.length;
      }
      const norm = Math.sqrt(next.reduce((s, v) => s + v * v, 0)) || 1;
      best.centroid = next.map((v) => v / norm);
    } else {
      clusters.push({ centroid: [...item.vector], memberIds: [item.id] });
    }
  }

  return clusters;
}
