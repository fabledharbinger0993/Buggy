export const OLLAMA_PROMPTS = {
  entityExtraction: {
    system: [
      "You extract entities and claims from archival text.",
      "Output raw JSON only, no markdown, no prose, no code fences.",
      "If uncertain, keep values conservative and include confidence field as model-estimated relevance only."
    ].join(" "),
    userTemplate: ({ subject, contextCue, chunkText, chunkId, sourceUrl }) => `Task: Extract entities and factual claims relevant to subject.\n\nSubject: ${subject}\nContext Cues: ${contextCue || "None"}\nSource URL: ${sourceUrl}\nChunk ID: ${chunkId}\n\nChunk Text:\n${chunkText}\n\nReturn JSON with schema:\n{\n  "chunk_id": "string",\n  "entities": [\n    {\n      "name": "string",\n      "type": "person|organization|location|date|operation|file_number|other",\n      "aliases": ["string"],\n      "role": "string",\n      "confidence": 0.0\n    }\n  ],\n  "claims": [\n    {\n      "subject_entity": "string",\n      "object_entity": "string",\n      "relation": "string",\n      "date": "string",\n      "location": "string",\n      "action": "string",\n      "quote": "string",\n      "confidence": 0.0\n    }\n  ]\n}`
  },
  relationshipScoring: {
    system: [
      "You score relationship strength between two entities for a specific research subject.",
      "Output raw JSON only, no markdown or explanation."
    ].join(" "),
    userTemplate: ({ subject, entityA, entityB, evidence }) => `Subject: ${subject}\nEntity A: ${entityA}\nEntity B: ${entityB}\nEvidence snippets:\n${evidence.join("\n---\n")}\n\nReturn JSON schema:\n{\n  "entity_a": "string",\n  "entity_b": "string",\n  "relation": "string",\n  "cooccurrence_count": 0,\n  "confidence": 0.0,\n  "relevance_to_subject": 0.0\n}`
  },
  contextBrief: {
    system: [
      "You synthesize archival findings into structured analysis.",
      "Output raw JSON only. Do not include markdown wrappers."
    ].join(" "),
    userTemplate: ({ subject, timelineRows, entities, claims, inconsistencies }) => `Create a subject context brief for: ${subject}\n\nTimeline rows:\n${timelineRows.join("\n")}\n\nEntities:\n${JSON.stringify(entities)}\n\nClaims:\n${JSON.stringify(claims)}\n\nInconsistencies:\n${JSON.stringify(inconsistencies)}\n\nReturn JSON schema:\n{\n  "subject": "string",\n  "timeline": [\n    {\n      "date": "string",\n      "event": "string",\n      "citations": ["document_id"]\n    }\n  ],\n  "cast": [\n    {\n      "entity": "string",\n      "role": "string",\n      "relationship_to_subject": "string",\n      "citations": ["document_id"]\n    }\n  ],\n  "subplots": [\n    {\n      "thread": "string",\n      "summary": "string",\n      "citations": ["document_id"]\n    }\n  ],\n  "follow_up_search_directives": [\n    {\n      "query": "string",\n      "reason": "string"\n    }\n  ],\n  "unresolved_inconsistencies": [\n    {\n      "entity": "string",\n      "detail": "string",\n      "citations": ["document_id"]\n    }\n  ]\n}`
  },
  entityConsistency: {
    system: [
      "You compare entity descriptions across source documents for consistency.",
      "Output raw JSON only, no markdown, no commentary."
    ].join(" "),
    userTemplate: ({ entity, descriptions }) => `Entity: ${entity}\nDescriptions by source:\n${descriptions.join("\n\n")}\n\nReturn JSON schema:\n{\n  "entity": "string",\n  "consistent": true,\n  "conflicting_attributes": [\n    {\n      "attribute": "string",\n      "value_a": "string",\n      "source_a": "string",\n      "value_b": "string",\n      "source_b": "string"\n    }\n  ]\n}`
  },
  entityResolution: {
    system: [
      "You determine if two entity mentions refer to the same real-world entity.",
      "Output raw JSON only."
    ].join(" "),
    userTemplate: ({ entityA, entityB, context }) => `Entity A: ${entityA}\nEntity B: ${entityB}\nContext:\n${JSON.stringify(context)}\n\nReturn JSON schema:\n{\n  "likely_same": true,\n  "confidence": 0.0,\n  "reasoning": "string"\n}`
  }
};

export function cleanJsonResponse(raw) {
  const trimmed = (raw || "").trim();
  if (!trimmed) {
    return {};
  }
  const noFence = trimmed.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  return JSON.parse(noFence);
}
