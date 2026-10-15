/**
 * synthesis.js — Stage 2: global entity synthesis.
 *
 * Replaces the O(n^2) probabilistic merge loop in entityresolver with a
 * single Ollama call that clusters all candidates at once. The original
 * pairwise resolver remains in entityresolver.js as a fallback (used when
 * `useGlobalSynthesis` is disabled in settings).
 */

import { OLLAMA_PROMPTS, cleanJsonResponse } from "./prompts.js";

/**
 * Cluster canonical-entity candidates via one model call.
 *
 * @param {Object} args
 * @param {string} args.subject
 * @param {Array<Object>} args.canonical
 *   Each entry shape: { id, name, type, aliases[], documentIds (Set or Array) }
 * @param {function(Object): Promise<string>} args.callOllama
 * @param {number} [args.maxCandidates=80]
 *   Hard cap to keep the prompt within context. Above this we fall back.
 * @returns {Promise<Array<Object>>} Resolved canonical entities (Sets normalized to Arrays)
 */
export async function globalSynthesizeEntities({ subject, canonical, callOllama, maxCandidates = 80 }) {
  if (!canonical?.length) return [];

  if (canonical.length > maxCandidates) {
    // Too many candidates for one prompt — let caller fall back to pairwise.
    return null;
  }

  const candidates = canonical.map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type || "other",
    aliases: Array.from(c.aliases || []),
    document_ids: Array.from(c.documentIds || []),
  }));

  const prompt = OLLAMA_PROMPTS.globalEntitySynthesis.userTemplate({ subject, candidates });

  let raw;
  try {
    raw = await callOllama({
      system: OLLAMA_PROMPTS.globalEntitySynthesis.system,
      prompt,
      meta: { operation: "global_entity_synthesis", candidates: candidates.length },
    });
  } catch (err) {
    console.warn("[synthesis] global synthesis call failed:", err?.message);
    return null;
  }

  let parsed;
  try {
    parsed = cleanJsonResponse(raw);
  } catch {
    console.warn("[synthesis] global synthesis returned unparseable JSON");
    return null;
  }

  if (!parsed?.clusters?.length) return null;

  const byId = new Map(canonical.map((c) => [c.id, c]));
  const consumed = new Set();
  const merged = [];

  for (const cluster of parsed.clusters) {
    const canonicalId = cluster.canonical_id;
    const target = byId.get(canonicalId);
    if (!target || consumed.has(canonicalId)) continue;
    consumed.add(canonicalId);

    target.merge_log = target.merge_log || [];

    for (const memberId of cluster.member_ids || []) {
      if (memberId === canonicalId || consumed.has(memberId)) continue;
      const source = byId.get(memberId);
      if (!source) continue;
      consumed.add(memberId);

      target.aliases = [...new Set([...(target.aliases || []), ...(source.aliases || []), source.name])];
      for (const docId of source.documentIds || []) {
        target.documentIds.add(docId);
      }
      target.merge_log.push({
        mergedFrom: source.id,
        mergedName: source.name,
        reason: cluster.merge_reason || "Global synthesis cluster",
        confidence: Number(cluster.confidence || 0),
        timestamp: Date.now(),
      });
    }

    if (cluster.canonical_name && typeof cluster.canonical_name === "string") {
      target.aliases = [...new Set([target.canonical_name, ...(target.aliases || []), target.name])];
    }

    merged.push(target);
  }

  // Include any candidates the model omitted as singleton survivors
  for (const c of canonical) {
    if (!consumed.has(c.id)) {
      merged.push(c);
    }
  }

  return merged.map((row) => ({
    ...row,
    documentIds: Array.from(row.documentIds || []),
    aliases: Array.from(new Set(row.aliases || [])),
  }));
}
