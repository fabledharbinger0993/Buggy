// spore.js
// The processLead implementation for ExpansionEngine.
// Each spore is one Haiku call that researches a single lead, scores its
// relevance to the investigation topic, and surfaces up to 3 new leads.
// Cheap (Haiku), runs serially or in parallel batches via the engine.

const RELEVANCE_THRESHOLD = 0.35; // discard leads below this score
const MAX_NEW_LEADS       = 3;    // max new leads per spore

const SYS_SPORE = `You are an investigative intelligence sub-agent — a spore.
You receive a single lead (an entity, claim, program, or keyword) and an
investigation topic. Your job is to:
1. Summarise what is known about this lead in the context of the topic (150-300 words).
2. Score its relevance to the topic (0.0–1.0).
3. Identify up to ${MAX_NEW_LEADS} NEW leads worth pursuing — entities, programs,
   people, events, financial nodes, or government bodies not yet named.
4. Note the specific connection between this lead and the investigation topic.

Prioritise non-obvious second- and third-degree connections. Think like a network
analyst following money, jurisdiction, and institutional affiliations.

Return ONLY valid JSON, begin with { and end with }:
{
  "context": "string",
  "relevance": 0.0,
  "connection": "string (one sentence: how this lead ties to the topic)",
  "newLeads": [
    { "type": "person|org|event|program|financial|government_body|location", "value": "string", "rationale": "string" }
  ]
}`;

function safeParseJSON(raw) {
  if (!raw) return null;
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) { try { return JSON.parse(match[0]); } catch { /* fall through */ } }
  return null;
}

// Bound into the engine via: engine.expand((lead, eng) => processLead(lead, eng, ctx))
export async function processLead(lead, engine, { topic, graph, callClaude }) {
  const { type, value, depth = 0 } = lead;

  let raw;
  try {
    raw = await callClaude(
      SYS_SPORE,
      `Investigation topic: ${topic}\n\nLead [${type}]: ${value}`,
      { model: 'claude-haiku-4-5-20251001', maxTokens: 1024 },
    );
  } catch {
    return { newLeads: [], result: null };
  }

  const data = safeParseJSON(raw);
  if (!data || typeof data.relevance !== 'number' || data.relevance < RELEVANCE_THRESHOLD) {
    return { newLeads: [], result: null };
  }

  // Register in graph
  graph.addNode({
    id:          value,
    type,
    depth,
    context:     data.context    || '',
    relevance:   data.relevance,
    connections: data.connection ? [data.connection] : [],
  });

  // Extract new leads
  const newLeads = (data.newLeads || [])
    .filter(nl => nl?.value?.trim())
    .slice(0, MAX_NEW_LEADS)
    .map(nl => ({
      type:        nl.type    || 'entity',
      value:       nl.value.trim(),
      rationale:   nl.rationale || '',
      parentValue: value,
    }));

  // Add edges
  for (const nl of newLeads) {
    graph.addEdge(value, nl.value, data.relevance, nl.rationale);
  }

  return {
    newLeads,
    result: { leadValue: value, leadType: type, depth, relevance: data.relevance },
  };
}
