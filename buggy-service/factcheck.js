import { bulkPut, getAllByIndex } from "./db.js";
import { OLLAMA_PROMPTS, cleanJsonResponse } from "./prompts.js";

const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 500;

export async function verifyFindings(entityGraph, citationLog, options) {
  const sessionId = options.sessionId;
  const callOllama = options.callOllama;

  const claims = await annotateCorroboration(entityGraph.claims || [], citationLog || []);
  const entities = await annotateEntityConsistency(entityGraph.entities || [], citationLog || [], callOllama);

  // Persist verification metadata back into canonical stores for session rehydration.
  await bulkPut("claims", claims.map((claim) => ({ ...claim, sessionId })));
  await bulkPut("entities", entities.map((entity) => ({ ...entity, sessionId })));

  return {
    entityGraph: {
      ...entityGraph,
      claims,
      entities
    },
    citationLog
  };
}

async function annotateCorroboration(claims, citationLog) {
  const docById = new Map(citationLog.map((doc) => [doc.id, doc]));

  return claims.map((claim) => {
    const matches = claims.filter((candidate) => fuzzyClaimMatch(claim, candidate));
    const domains = new Set(
      matches
        .map((m) => docById.get(m.documentId)?.domain)
        .filter(Boolean)
    );

    let status = "UNCORROBORATED";
    if (domains.size >= 2) {
      status = "CORROBORATED";
    } else if (domains.size === 1 && matches.length > 1) {
      status = "SINGLE-SOURCE";
    }

    return {
      ...claim,
      corroborationStatus: status
    };
  });
}

async function annotateEntityConsistency(entities, citationLog, callOllama) {
  const docsByEntity = new Map();

  for (const doc of citationLog) {
    for (const entityName of doc.entities || []) {
      if (!docsByEntity.has(entityName)) {
        docsByEntity.set(entityName, []);
      }
      docsByEntity.get(entityName).push(doc);
    }
  }

  const output = [...entities];

  for (let i = 0; i < output.length; i += BATCH_SIZE) {
    const batch = output.slice(i, i + BATCH_SIZE);

    await Promise.all(
      batch.map(async (entity) => {
        const docs = docsByEntity.get(entity.name) || [];
        if (docs.length < 2) {
          entity.consistencyFlag = "CONSISTENT";
          entity.discrepancies = [];
          return;
        }

        const descriptions = docs.map((doc) => {
          return [
            `source: ${doc.url}`,
            `archive: ${doc.archive}`,
            `summary: ${doc.summary || ""}`,
            `entity_mentions: ${(doc.entityMentions?.[entity.name] || []).join("; ")}`
          ].join("\n");
        });

        const prompt = OLLAMA_PROMPTS.entityConsistency.userTemplate({
          entity: entity.name,
          descriptions
        });

        const raw = await callOllama({
          system: OLLAMA_PROMPTS.entityConsistency.system,
          prompt
        });

        let parsed;
        try {
          parsed = cleanJsonResponse(raw);
        } catch (_err) {
          parsed = {
            entity: entity.name,
            consistent: true,
            conflicting_attributes: []
          };
        }

        entity.consistencyFlag = parsed.consistent ? "CONSISTENT" : "DISCREPANCY";
        entity.discrepancies = parsed.conflicting_attributes || [];
      })
    );

    await delay(BATCH_DELAY_MS);
  }

  return output;
}

function fuzzyClaimMatch(a, b) {
  const subjectMatch = normalize(a.subjectEntity) === normalize(b.subjectEntity);
  const objectMatch = normalize(a.objectEntity) === normalize(b.objectEntity);
  const relationMatch = normalize(a.relation) === normalize(b.relation);

  const dateMatch = normalize(a.date) && normalize(a.date) === normalize(b.date);
  const locationMatch = normalize(a.location) && normalize(a.location) === normalize(b.location);
  const actionMatch = normalize(a.action) && normalize(a.action) === normalize(b.action);

  return subjectMatch && objectMatch && relationMatch && (dateMatch || locationMatch || actionMatch);
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
