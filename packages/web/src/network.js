// network.js — a saved investigation network ("case") built from consecutive searches.
//
// Each search's raw phase output is stored as-is in network.searches; the merged view
// (deduplicated entities, relationships, findings, ...) is derived on read by
// mergeNetwork(), so a merge rule can change without rewriting saved data.

export function emptyNetwork(name = 'Untitled network') {
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    name,
    createdAt: now,
    updatedAt: now,
    searches: [],        // [{ id, topic, at, map, expand, res, synth }]
    networkBrief: null,  // { at, searchCount, synth } — whole-network synthesis, on demand
  }
}

const norm = s => String(s ?? '').trim().toLowerCase()

// Dedupe by key, keeping first occurrence order. merge(existing, incoming) may update in place.
function dedupe(items, keyOf, merge) {
  const byKey = new Map()
  for (const item of items) {
    const key = keyOf(item)
    if (!key) continue
    if (byKey.has(key)) merge?.(byKey.get(key), item)
    else byKey.set(key, { ...item })
  }
  return [...byKey.values()]
}

function mergeEntities(tagged) {
  return dedupe(
    tagged,
    e => norm(e.name),
    (cur, e) => {
      if ((!cur.type || cur.type === 'entity') && e.type) cur.type = e.type
      if (!cur.notes && e.notes) cur.notes = e.notes
      if (e.confidence != null) cur.confidence = Math.max(Number(cur.confidence ?? 0), Number(e.confidence))
      if (e.aliases?.length) cur.aliases = [...new Set([...(cur.aliases || []), ...e.aliases])]
      for (const t of e.foundIn) if (!cur.foundIn.includes(t)) cur.foundIn.push(t)
    },
  )
}

const uniqueStrings = list => dedupe(list.filter(Boolean).map(s => ({ s })), x => norm(x.s)).map(x => x.s)

// Merge the searches (plus an optional in-progress one) into one map / research / cast view.
export function mergeNetwork(searches) {
  const tag = (items, topic) => (items || []).map(x => ({ ...x, foundIn: [topic] }))

  const mapEntities = [], relationships = [], timeline = [], searchVectors = [], archiveSources = []
  const findings = [], resEntities = [], inconsistencies = [], gaps = [], corroborated = [], cast = []

  for (const s of searches) {
    const { topic, map, res, synth } = s
    mapEntities.push(...tag(map?.entities, topic))
    relationships.push(...(map?.relationships || []))
    timeline.push(...(map?.timeline || []))
    searchVectors.push(...(map?.searchVectors || []))
    archiveSources.push(...(map?.archiveSources || []))
    findings.push(...(res?.findings || []).map(f => ({ ...f, topic })))
    resEntities.push(...tag(res?.entities, topic))
    inconsistencies.push(...(res?.inconsistencies || []))
    gaps.push(...(res?.gaps || []))
    corroborated.push(...(res?.corroborated || []))
    cast.push(...(synth?.cast || []))
  }

  const hasMap = searches.some(s => s.map)
  const hasRes = searches.some(s => s.res)
  const hasSynth = searches.some(s => s.synth)

  return {
    map: hasMap ? {
      entities:       mergeEntities(mapEntities),
      relationships:  dedupe(relationships, r => r.from && r.to && `${norm(r.from)}|${norm(r.relation)}|${norm(r.to)}`),
      timeline:       dedupe(timeline, t => (t.date || t.event) && `${norm(t.date)}|${norm(t.event)}`),
      searchVectors:  uniqueStrings(searchVectors),
      archiveSources: uniqueStrings(archiveSources),
    } : null,
    res: hasRes ? {
      findings:        dedupe(findings, f => norm(f.claim)),
      entities:        mergeEntities(resEntities),
      inconsistencies: dedupe(inconsistencies, i => `${norm(i.entity)}|${norm(i.detail)}`),
      gaps:            uniqueStrings(gaps),
      corroborated:    uniqueStrings(corroborated),
    } : null,
    synth: hasSynth ? { cast: dedupe(cast, c => norm(c.name)) } : null,
  }
}

// Compact description of the existing network, fed to later searches so the model links
// new findings to nodes already in the case instead of starting cold.
export function networkContext(merged, { maxEntities = 120, maxRelationships = 80 } = {}) {
  const entities = [...(merged.map?.entities || []), ...(merged.res?.entities || [])]
  const seen = new Set()
  const names = []
  for (const e of entities) {
    const key = norm(e.name)
    if (!key || seen.has(key)) continue
    seen.add(key)
    names.push(e.type ? `${e.name} (${e.type})` : e.name)
  }
  if (!names.length) return ''
  const rels = (merged.map?.relationships || [])
    .slice(0, maxRelationships)
    .map(r => `${r.from} — ${r.relation} → ${r.to}`)
  return [
    `Entities: ${names.slice(0, maxEntities).join('; ')}`,
    rels.length ? `Relationships:\n${rels.join('\n')}` : '',
  ].filter(Boolean).join('\n')
}

// Input for a whole-network brief, capped so the synthesis prompt stays bounded as the case grows.
export function networkSynthesisInput(network, merged, { maxFindings = 100 } = {}) {
  const findings = [...(merged.res?.findings || [])]
    .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))
    .slice(0, maxFindings)
  return {
    searches: network.searches.map(s => ({ topic: s.topic, summary: s.synth?.summary || '' })),
    entities: merged.map?.entities || [],
    relationships: merged.map?.relationships || [],
    timeline: merged.map?.timeline || [],
    findings,
    inconsistencies: merged.res?.inconsistencies || [],
  }
}

export function summarize(network) {
  return {
    id: network.id,
    name: network.name,
    updatedAt: network.updatedAt,
    searchCount: network.searches?.length || 0,
  }
}
