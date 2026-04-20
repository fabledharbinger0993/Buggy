import { OLLAMA_PROMPTS, cleanJsonResponse } from "./prompts.js";

function stripHonorifics(value) {
  return value.replace(/\b(mr|mrs|ms|dr|sir|gen|lt|col|capt|maj|prof)\.?,?\s+/gi, "");
}

export function normalizeEntityName(value) {
  return stripHonorifics((value || "").toLowerCase())
    .replace(/[.,/#!$%^&*;:{}=\-_`~()\[\]"']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function resolveEntities(entityList, options) {
  const byCanonical = new Map();

  for (const entity of entityList) {
    const norm = normalizeEntityName(entity.name);
    if (!norm) {
      continue;
    }

    const existing = byCanonical.get(norm);
    if (!existing) {
      byCanonical.set(norm, {
        id: crypto.randomUUID(),
        name: entity.name,
        normalizedName: norm,
        type: entity.type || "other",
        role: entity.role || "",
        confidence: entity.confidence || 0,
        aliases: [...new Set([entity.name, ...(entity.aliases || [])])],
        documentIds: new Set(entity.documentIds || []),
        merge_log: [],
        sessionId: entity.sessionId
      });
      continue;
    }

    existing.aliases = [...new Set([...existing.aliases, entity.name, ...(entity.aliases || [])])];
    for (const docId of entity.documentIds || []) {
      existing.documentIds.add(docId);
    }
    existing.confidence = Math.max(existing.confidence || 0, entity.confidence || 0);
  }

  const canonical = Array.from(byCanonical.values());
  await probabilisticMerge(canonical, options);

  return canonical.map((row) => ({
    ...row,
    documentIds: Array.from(row.documentIds || []),
    aliases: Array.from(new Set(row.aliases || []))
  }));
}

async function probabilisticMerge(canonical, options) {
  const pairs = [];

  for (let i = 0; i < canonical.length; i += 1) {
    for (let j = i + 1; j < canonical.length; j += 1) {
      const a = canonical[i];
      const b = canonical[j];

      const overlap = intersectionCount(a.documentIds, b.documentIds);
      if (overlap >= 2) {
        pairs.push([a, b]);
      }
    }
  }

  for (const [a, b] of pairs) {
    if (!canonical.includes(a) || !canonical.includes(b)) {
      continue;
    }

    const prompt = OLLAMA_PROMPTS.entityResolution.userTemplate({
      entityA: a.name,
      entityB: b.name,
      context: {
        aliasesA: a.aliases,
        aliasesB: b.aliases,
        docsA: Array.from(a.documentIds),
        docsB: Array.from(b.documentIds)
      }
    });

    const raw = await options.callOllama({
      system: OLLAMA_PROMPTS.entityResolution.system,
      prompt
    });

    let result;
    try {
      result = cleanJsonResponse(raw);
    } catch (_err) {
      result = { likely_same: false, confidence: 0, reasoning: "Could not parse model output" };
    }

    if (result.likely_same && Number(result.confidence || 0) >= 0.75) {
      mergeCanonical(a, b, result.reasoning || "Merged by probabilistic resolver");
      canonical.splice(canonical.indexOf(b), 1);
    } else {
      a.possibleDuplicates = a.possibleDuplicates || [];
      a.possibleDuplicates.push({
        candidateId: b.id,
        candidateName: b.name,
        confidence: Number(result.confidence || 0),
        reasoning: result.reasoning || "Model was uncertain"
      });
    }
  }
}

function mergeCanonical(target, source, reason) {
  target.aliases = [...new Set([...(target.aliases || []), ...(source.aliases || []), source.name])];
  for (const docId of source.documentIds || []) {
    target.documentIds.add(docId);
  }
  target.merge_log = target.merge_log || [];
  target.merge_log.push({
    mergedFrom: source.id,
    mergedName: source.name,
    reason,
    timestamp: Date.now()
  });
}

function intersectionCount(aSet, bSet) {
  let count = 0;
  for (const value of aSet || []) {
    if (bSet.has(value)) {
      count += 1;
    }
  }
  return count;
}
