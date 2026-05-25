import { useState, useCallback, useRef } from 'react'
import MyceliumCanvas from './MyceliumCanvas.jsx'
import ConnectionsGraph from './ConnectionsGraph.jsx'

// ─── Palette ──────────────────────────────────────────────────────────────────

const C = {
  bgDeep:  '#08080f',
  bgMain:  '#0f0f1a',
  bgCard:  '#161624',
  bgPanel: '#1e1e2a',
  gold:    '#c9a84c',
  violet:  '#9b72d8',
  amber:   '#e8a23a',
  purple:  '#6b3fa0',
  cream:   '#e8e4d8',
  warm:    '#585450',
  dim:     '#8884a0',
  border:  '#2a2a3a',
  red:     '#d45a5a',
}

// ─── System prompts ───────────────────────────────────────────────────────────

const SYS_MAP = `You are FUNGA.I., an adaptive investigative intelligence system. \
Your role is to map the investigation space for the given topic.

Analyse what you know and extract: key entities (people, organisations, events, \
documents, locations, government bodies, programs, financial nodes, media assets), \
known relationships, timeline anchors, and the best archive search vectors.

Return ONLY valid JSON — no markdown, no explanation, no code fences:
{
  "subject": "string",
  "entities": [
    { "name": "string", "type": "person|org|event|document|location|government_body|program|financial|media", "notes": "string" }
  ],
  "relationships": [
    { "from": "string", "to": "string", "relation": "string" }
  ],
  "timeline": [
    { "date": "string", "event": "string" }
  ],
  "searchVectors": ["string"],
  "archiveSources": ["blackvault","ciaCrest","wikileaks","nsarchive","internetArchive"]
}`

const SYS_EXPAND = `You are FUNGA.I. extending an investigation network. Given an \
initial entity map, identify the second-degree connections that are structurally \
implied but not yet named — adjacent government bodies, intelligence programs, \
financial nodes, media assets, institutional affiliations, predecessor and successor \
operations, cross-network patterns.

Think in systems: who funds this, who oversees it, who benefits, what preceded it, \
what ran in parallel, what was suppressed and by whom. Follow the money, the \
jurisdiction, and the timeline.

Return ONLY valid JSON — no markdown, no explanation, no code fences, no preamble. \
Your response must begin with '{' and end with '}'.
{
  "expandedEntities": [
    {
      "name": "string",
      "type": "government_body|program|financial|media|person|org|network",
      "connection": "string (which known entity links here and how)",
      "priority": "high|medium|low"
    }
  ],
  "systemicPatterns": ["string (cross-cutting structural patterns)"],
  "suggestedThreads": ["string (specific investigation threads to pursue)"]
}`

const SYS_RESEARCH = `You are FUNGA.I. conducting deep investigative research. You have \
been provided an entity map, a second-degree network expansion, and where available, \
archive document excerpts.

For each entity — primary and expanded — trace one level outward: who funded it, \
who oversaw it, what preceded or followed it, what parallel programs or operations \
existed, and what institutional affiliations connect it to broader power structures.

Analyse all evidence. Extract claims with confidence scores (0.0–1.0). Identify \
corroborated patterns. Flag inconsistencies and evidence gaps.

Return ONLY valid JSON — no markdown, no explanation, no code fences:
{
  "subject": "string",
  "findings": [
    {
      "claim": "string",
      "confidence": 0.0,
      "sources": ["string"],
      "entities": ["string"],
      "date": "string"
    }
  ],
  "entities": [
    {
      "name": "string",
      "type": "string",
      "confidence": 0.0,
      "aliases": ["string"],
      "notes": "string"
    }
  ],
  "inconsistencies": [
    { "entity": "string", "detail": "string" }
  ],
  "gaps": ["string"],
  "corroborated": ["string"]
}`

const SYS_SYNTH = `You are FUNGA.I. synthesizing a completed investigation. \
Using the entity map and research findings provided, produce a comprehensive, \
sourced intelligence brief.

Return ONLY valid JSON — no markdown, no explanation, no code fences, no preamble. \
Your response must begin with '{' and end with '}'. Nothing before or after the JSON object.
{
  "subject": "string",
  "summary": "string",
  "timeline": [
    { "date": "string", "event": "string", "confidence": 0.0, "sources": ["string"] }
  ],
  "cast": [
    { "name": "string", "role": "string", "notes": "string" }
  ],
  "keyFindings": ["string"],
  "subplots": ["string"],
  "inconsistencies": [
    { "entity": "string", "detail": "string", "citations": ["string"] }
  ],
  "followUpDirectives": ["string"],
  "confidence": 0.0
}`

// ─── Example prompts ──────────────────────────────────────────────────────────

const EXAMPLES = [
  'MKUltra program key figures and documents',
  'Operation Paperclip scientist recruitment 1945–1955',
  'COINTELPRO targets and methods 1956–1971',
  'TWA Flight 800 investigation inconsistencies',
  'Missing scientists 2022–2026 pattern',
  'GEC-Marconi SDI scientist deaths 1982–1990',
  'COINTELPRO',
]

// ─── Models ───────────────────────────────────────────────────────────────────

const EXTRACT_MODEL = 'claude-haiku-4-5-20251001'
const SYNTH_MODEL   = 'claude-sonnet-4-6'

// ─── Style object ─────────────────────────────────────────────────────────────

const S = {
  root: {
    minHeight: '100vh',
    background: `radial-gradient(ellipse at 20% 0%, #120827 0%, #0a0810 40%, ${C.bgDeep} 65%)`,
    color: C.cream,
    fontFamily: '"Space Mono", monospace',
    fontSize: '14px',
    lineHeight: 1.6,
  },

  header: {
    position: 'relative',
    height: '176px',
    overflow: 'hidden',
    borderBottom: `1px solid ${C.border}`,
    display: 'flex',
    alignItems: 'center',
    padding: '0 36px',
  },

  headerBg: {
    position: 'absolute',
    inset: 0,
    zIndex: 0,
  },

  headerContent: {
    position: 'relative',
    zIndex: 1,
    display: 'flex',
    alignItems: 'center',
    gap: '22px',
  },

  logo: {
    width: '80px',
    height: '80px',
    borderRadius: '50%',
    border: `2px solid ${C.amber}`,
    objectFit: 'cover',
    flexShrink: 0,
    mixBlendMode: 'screen',
    boxShadow: `0 0 28px #823cff66, 0 0 12px ${C.amber}44`,
  },

  logoPlaceholder: {
    width: '80px',
    height: '80px',
    borderRadius: '50%',
    border: `2px solid ${C.amber}`,
    background: `radial-gradient(circle at 40% 35%, #823cff55, ${C.bgPanel})`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '32px',
    flexShrink: 0,
    boxShadow: `0 0 28px #823cff66, 0 0 12px ${C.amber}44`,
  },

  wordmarkBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: '5px',
  },

  eyebrow: {
    fontFamily: '"Space Mono", monospace',
    fontSize: '9px',
    color: C.purple,
    letterSpacing: '0.3em',
    textTransform: 'uppercase',
  },

  wordmark: {
    fontFamily: '"Orbitron", sans-serif',
    fontSize: '32px',
    fontWeight: 700,
    color: '#e8e4d8',
    letterSpacing: '0.15em',
    textTransform: 'uppercase',
    lineHeight: 1,
    textShadow: '0 0 18px rgba(130,60,255,0.5), 0 0 36px rgba(130,60,255,0.2)',
  },

  subhead: {
    fontFamily: '"Space Mono", monospace',
    fontStyle: 'italic',
    fontSize: '12px',
    color: C.warm,
  },

  main: {
    maxWidth: '920px',
    margin: '0 auto',
    padding: '32px 24px',
  },

  section: {
    marginBottom: '28px',
  },

  label: {
    display: 'block',
    fontSize: '10px',
    color: C.dim,
    letterSpacing: '0.22em',
    textTransform: 'uppercase',
    marginBottom: '8px',
    fontFamily: '"Orbitron", sans-serif',
  },

  input: {
    width: '100%',
    background: C.bgCard,
    border: `1px solid ${C.border}`,
    borderRadius: '6px',
    color: C.cream,
    fontFamily: '"Space Mono", monospace',
    fontSize: '15px',
    padding: '14px 16px',
    outline: 'none',
    boxSizing: 'border-box',
    resize: 'vertical',
    minHeight: '84px',
    transition: 'border-color 0.2s',
  },

  row: {
    display: 'flex',
    gap: '12px',
    alignItems: 'flex-start',
  },

  btnPrimary: {
    background: `linear-gradient(135deg, ${C.purple} 0%, ${C.violet} 100%)`,
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    padding: '14px 28px',
    fontFamily: '"Orbitron", sans-serif',
    fontSize: '13px',
    letterSpacing: '0.12em',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    fontWeight: 700,
    boxShadow: `0 0 16px ${C.purple}44`,
  },

  btnSecondary: {
    background: 'transparent',
    color: C.dim,
    border: `1px solid ${C.border}`,
    borderRadius: '6px',
    padding: '14px 20px',
    fontFamily: '"Space Mono", monospace',
    fontSize: '13px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },

  btnGhost: {
    background: 'transparent',
    color: C.amber,
    border: `1px solid ${C.amber}44`,
    borderRadius: '4px',
    padding: '7px 14px',
    fontFamily: '"Space Mono", monospace',
    fontSize: '11px',
    cursor: 'pointer',
  },

  exampleGrid: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '8px',
    marginTop: '14px',
  },

  exampleChip: {
    background: C.bgPanel,
    border: `1px solid ${C.border}`,
    borderRadius: '999px',
    color: C.dim,
    padding: '6px 14px',
    fontSize: '12px',
    cursor: 'pointer',
    fontFamily: '"Space Mono", monospace',
  },

  phases: {
    display: 'flex',
    gap: '8px',
    marginBottom: '20px',
  },

  phaseStep: {
    flex: 1,
    padding: '13px 16px',
    borderRadius: '7px',
    border: `1px solid ${C.border}`,
    background: C.bgCard,
    transition: 'border-color 0.3s, box-shadow 0.3s',
  },

  phaseNum: {
    fontFamily: '"Orbitron", sans-serif',
    fontSize: '10px',
    letterSpacing: '0.15em',
    marginBottom: '4px',
  },

  phaseLabel: {
    fontFamily: '"Orbitron", sans-serif',
    fontSize: '11px',
    letterSpacing: '0.1em',
  },

  phaseMeta: {
    fontSize: '10px',
    marginTop: '5px',
    fontFamily: '"Space Mono", monospace',
  },

  status: {
    background: C.bgCard,
    border: `1px solid ${C.border}`,
    borderRadius: '6px',
    padding: '14px 16px',
    color: C.dim,
    fontFamily: '"Space Mono", monospace',
    fontSize: '13px',
    minHeight: '48px',
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    marginBottom: '20px',
  },

  spinner: {
    display: 'inline-block',
    width: '12px',
    height: '12px',
    border: `2px solid ${C.border}`,
    borderTopColor: C.amber,
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
    flexShrink: 0,
  },

  errorBox: {
    background: '#200e0e',
    border: `1px solid ${C.red}66`,
    borderRadius: '6px',
    padding: '14px 16px',
    color: C.red,
    fontFamily: '"Space Mono", monospace',
    fontSize: '13px',
    marginBottom: '20px',
  },

  card: {
    background: C.bgCard,
    border: `1px solid ${C.border}`,
    borderRadius: '8px',
    padding: '16px',
    marginBottom: '10px',
  },

  cardTitle: {
    fontFamily: '"Orbitron", sans-serif',
    fontSize: '13px',
    color: C.cream,
    letterSpacing: '0.08em',
    marginBottom: '4px',
  },

  tag: {
    display: 'inline-block',
    padding: '2px 9px',
    borderRadius: '999px',
    fontSize: '10px',
    letterSpacing: '0.08em',
    fontFamily: '"Orbitron", sans-serif',
    textTransform: 'uppercase',
  },

  tagPerson:   { background: `${C.violet}22`, color: C.violet, border: `1px solid ${C.violet}44` },
  tagOrg:      { background: `${C.amber}22`,  color: C.amber,  border: `1px solid ${C.amber}44` },
  tagEvent:    { background: `${C.gold}22`,   color: C.gold,   border: `1px solid ${C.gold}44` },
  tagLocation: { background: `${C.purple}22`, color: C.purple, border: `1px solid ${C.purple}44` },
  tagDocument: { background: '#1e2e1e',       color: '#6ab88a', border: '1px solid #3a5a3a' },

  confBar: {
    height: '3px',
    borderRadius: '999px',
    background: C.border,
    marginTop: '10px',
    overflow: 'hidden',
  },

  tabs: {
    display: 'flex',
    gap: '2px',
    borderBottom: `1px solid ${C.border}`,
    marginBottom: '22px',
  },

  tab: {
    padding: '10px 18px',
    fontFamily: '"Orbitron", sans-serif',
    fontSize: '10px',
    letterSpacing: '0.12em',
    cursor: 'pointer',
    color: C.dim,
    background: 'transparent',
    border: 'none',
    borderBottom: '2px solid transparent',
    textTransform: 'uppercase',
  },

  tabActive: {
    color: C.amber,
    borderBottomColor: C.amber,
  },

  resultSection: {
    marginBottom: '28px',
  },

  resultHeader: {
    fontFamily: '"Orbitron", sans-serif',
    fontSize: '12px',
    color: C.cream,
    letterSpacing: '0.15em',
    textTransform: 'uppercase',
    marginBottom: '14px',
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
  },

  badge: {
    background: C.bgPanel,
    border: `1px solid ${C.border}`,
    borderRadius: '999px',
    padding: '2px 10px',
    fontSize: '11px',
    color: C.dim,
    fontFamily: '"Space Mono", monospace',
    fontWeight: 'normal',
  },

  timelineDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: C.amber,
    position: 'absolute',
    left: '-5px',
    top: '5px',
    flexShrink: 0,
  },

  timelineDate: {
    fontFamily: '"Orbitron", sans-serif',
    fontSize: '11px',
    color: C.gold,
    minWidth: '88px',
    paddingTop: '1px',
    flexShrink: 0,
  },

  timelineEvent: {
    color: C.cream,
    fontSize: '13px',
    lineHeight: 1.5,
  },

  entityGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
    gap: '10px',
  },

  footer: {
    textAlign: 'center',
    padding: '20px 0 36px',
    color: C.warm,
    fontSize: '11px',
    fontFamily: '"Space Mono", monospace',
    opacity: 0.45,
    borderTop: `1px solid ${C.border}`,
    marginTop: '20px',
  },
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function safeJSON(raw) {
  if (!raw) return null
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
  try { return JSON.parse(cleaned) } catch { /* fall through */ }
  // Extract outermost {...} block in case Claude added preamble/postamble text
  const match = cleaned.match(/\{[\s\S]*\}/)
  if (match) {
    try { return JSON.parse(match[0]) } catch { /* fall through */ }
  }
  return null
}

function confColor(c) {
  const v = Number(c || 0)
  if (v >= 0.75) return C.amber
  if (v >= 0.50) return C.gold
  return C.warm
}

function confFill(pct, color) {
  return {
    height: '100%',
    width: `${Math.min(100, Math.round(Number(pct || 0) * 100))}%`,
    background: color || C.violet,
    borderRadius: '999px',
  }
}

function tagVariant(type) {
  switch ((type || '').toLowerCase()) {
    case 'person':   return S.tagPerson
    case 'org':      return S.tagOrg
    case 'event':    return S.tagEvent
    case 'location': return S.tagLocation
    default:         return S.tagDocument
  }
}

// ─── API helpers ──────────────────────────────────────────────────────────────

async function callClaude(model, system, prompt, maxTokens = 8192) {
  const resp = await fetch('/claude', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system, prompt, model, maxTokens }),
  })
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}))
    throw new Error(`Claude proxy ${resp.status}: ${err?.error || resp.statusText}`)
  }
  const data = await resp.json()
  if (!data.ok) throw new Error(data.error || 'Claude proxy error')
  return data.text || ''
}

// Retries once if safeJSON parse fails — catches transient formatting errors
async function callClaudeJSON(model, system, prompt, maxTokens = 8192) {
  const raw = await callClaude(model, system, prompt, maxTokens)
  const parsed = safeJSON(raw)
  if (parsed) return parsed
  // Retry once with an explicit reminder
  const raw2 = await callClaude(model, system, prompt + '\n\nIMPORTANT: Your response must be valid JSON only. Begin with { and end with }.', maxTokens)
  return safeJSON(raw2)
}

async function fetchPriorIntelligence(topic) {
  const [memR, neighborsR] = await Promise.allSettled([
    fetch('/memory/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: topic, top_k: 5, min_confidence: 0.4 }),
    }).then(r => r.json()),
    fetch(`/memory/neighbors?concept=${encodeURIComponent(topic)}&depth=2`).then(r => r.json()),
  ])
  const memories  = memR.status       === 'fulfilled' ? (memR.value?.results   || []) : []
  const neighbors = neighborsR.status === 'fulfilled' ? (neighborsR.value?.neighbors || []) : []
  return { memories, neighbors }
}

async function callBuggy(subject, sources) {
  try {
    const resp = await fetch('/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject, sources: sources || [], depth: 1 }),
    })
    if (!resp.ok) return ''
    const data = await resp.json()
    if (!data?.ok) return ''
    return ''
  } catch {
    return ''
  }
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function PhaseStep({ num, label, active, done }) {
  const color       = done ? C.amber : active ? C.violet : C.dim
  const borderColor = done ? `${C.amber}88` : active ? `${C.violet}88` : C.border
  const shadow      = active ? `0 0 14px ${C.violet}33` : 'none'
  return (
    <div style={{ ...S.phaseStep, borderColor, boxShadow: shadow }}>
      <div style={{ ...S.phaseNum, color }}>{num}</div>
      <div style={{ ...S.phaseLabel, color }}>{label}</div>
      {done   && <div style={{ ...S.phaseMeta, color: C.amber }}>✓ complete</div>}
      {active && <div style={{ ...S.phaseMeta, color: C.violet }}>● active</div>}
    </div>
  )
}

function EntityCard({ entity }) {
  const conf = Number(entity.confidence ?? -1)
  return (
    <div style={S.card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
        <div style={S.cardTitle}>{entity.name}</div>
        <span style={{ ...S.tag, ...tagVariant(entity.type) }}>{entity.type || 'entity'}</span>
      </div>
      {conf >= 0 && (
        <div style={S.confBar}>
          <div style={confFill(conf, confColor(conf))} />
        </div>
      )}
      {entity.notes && (
        <div style={{ fontSize: '12px', color: C.dim, marginTop: '8px', lineHeight: 1.5 }}>
          {entity.notes}
        </div>
      )}
      {entity.aliases?.length > 0 && (
        <div style={{ marginTop: '6px', fontSize: '11px', color: C.warm }}>
          aka: {entity.aliases.join(', ')}
        </div>
      )}
    </div>
  )
}

function FindingCard({ finding, idx }) {
  const conf = Number(finding.confidence || 0)
  return (
    <div style={{ ...S.card, borderLeft: `3px solid ${confColor(conf)}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'flex-start' }}>
        <div style={{ fontSize: '13px', color: C.cream, lineHeight: 1.6, flex: 1 }}>
          {idx != null && (
            <span style={{ color: C.dim, marginRight: '8px', fontFamily: '"Orbitron", sans-serif', fontSize: '11px' }}>
              {String(idx + 1).padStart(2, '0')}.
            </span>
          )}
          {finding.claim}
        </div>
        <div style={{ fontFamily: '"Orbitron", sans-serif', fontSize: '12px', color: confColor(conf), flexShrink: 0 }}>
          {Math.round(conf * 100)}%
        </div>
      </div>
      {finding.date && (
        <div style={{ marginTop: '6px', fontSize: '11px', color: C.gold, fontFamily: '"Orbitron", sans-serif' }}>
          {finding.date}
        </div>
      )}
      {finding.entities?.length > 0 && (
        <div style={{ marginTop: '8px', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {finding.entities.map((e, i) => (
            <span key={i} style={{ ...S.tag, ...S.tagPerson }}>{e}</span>
          ))}
        </div>
      )}
      <div style={S.confBar}>
        <div style={confFill(conf, confColor(conf))} />
      </div>
    </div>
  )
}

function CastCard({ person }) {
  return (
    <div style={S.card}>
      <div style={S.cardTitle}>{person.name}</div>
      {person.role && (
        <div style={{ fontSize: '11px', color: C.violet, marginTop: '4px', fontFamily: '"Orbitron", sans-serif', letterSpacing: '0.08em' }}>
          {person.role}
        </div>
      )}
      {person.notes && (
        <div style={{ fontSize: '12px', color: C.dim, marginTop: '8px', lineHeight: 1.5 }}>
          {person.notes}
        </div>
      )}
    </div>
  )
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [topic,        setTopic]        = useState('')
  const [phase,        setPhase]        = useState('idle')
  const [mapData,      setMapData]      = useState(null)
  const [resData,      setResData]      = useState(null)
  const [synthData,    setSynthData]    = useState(null)
  const [error,        setError]        = useState('')
  const [statusMsg,    setStatusMsg]    = useState('')
  const [activeTab,    setActiveTab]    = useState('map')
  const [logoError,    setLogoError]    = useState(false)
  const abortRef = useRef(false)

  const entityCount =
    (mapData?.entities?.length  || 0) +
    (resData?.entities?.length  || 0) +
    (synthData?.cast?.length    || 0)

  const resetAndRun = useCallback(async () => {
    if (!topic.trim()) return
    abortRef.current = false
    setError('')
    setMapData(null)
    setResData(null)
    setSynthData(null)
    setActiveTab('map')

    // ── Phase 1: SPORE CAST ──────────────────────────────────────────────────
    try {
      setPhase('mapping')
      setStatusMsg('Querying memory network for prior intelligence…')
      const { memories, neighbors } = await fetchPriorIntelligence(topic)
      const memCtx      = memories.map(r => r.content).join('\n')
      const neighborCtx = neighbors.map(n => n.concept).join(', ')

      setStatusMsg('Casting spores — mapping the investigation space…')

      const map = await callClaudeJSON(
        EXTRACT_MODEL,
        SYS_MAP,
        `Investigation topic: ${topic}` +
        (memCtx      ? `\n\nPrior intelligence from memory:\n${memCtx}`                          : '') +
        (neighborCtx ? `\n\nRelated concepts from prior investigations: ${neighborCtx}` : ''),
      )
      if (abortRef.current) return
      if (!map) throw new Error('SPORE CAST returned unparseable JSON. Check that the Buggy service is running and the API key is configured.')
      setMapData(map)

      // ── Web Expansion: second-degree network trace ───────────────────────
      setStatusMsg('Extending the web — tracing second-degree connections…')
      const expand = await callClaudeJSON(
        EXTRACT_MODEL,
        SYS_EXPAND,
        `Investigation topic: ${topic}\n\nEntity map:\n${JSON.stringify(map, null, 2)}`,
        2048,
      ) || {}
      if (abortRef.current) return

      // ── Phase 2: MYCELIUM SPREAD ─────────────────────────────────────────
      setPhase('researching')
      setStatusMsg('Spreading mycelium — querying archive sources…')

      let archiveCtx = ''
      archiveCtx = await callBuggy(topic, map.archiveSources || [])
      if (archiveCtx) setStatusMsg('Spreading mycelium — analysing archive context…')

      const resPrompt = [
        `Investigation topic: ${topic}`,
        '',
        'Entity map from SPORE CAST:',
        JSON.stringify(map, null, 2),
        expand.expandedEntities?.length
          ? `\nSecond-degree network expansion:\n${JSON.stringify(expand, null, 2)}`
          : '',
        archiveCtx ? `\nArchive context:\n${archiveCtx}` : '',
        '',
        'Conduct deep research. For each entity — primary and expanded — trace ' +
        'funding, oversight, predecessors, successors, and parallel operations. ' +
        'Extract findings with confidence scores. Flag all inconsistencies.',
      ].filter(Boolean).join('\n')

      const res = await callClaudeJSON(SYNTH_MODEL, SYS_RESEARCH, resPrompt)
      if (abortRef.current) return
      if (!res) throw new Error('MYCELIUM SPREAD returned unparseable JSON.')
      setResData(res)

      // ── Phase 3: FRUITING BODY ───────────────────────────────────────────
      setPhase('synthesizing')
      setStatusMsg('Forming fruiting body — synthesising intelligence brief…')

      const synthPrompt = [
        `Investigation topic: ${topic}`,
        '',
        'Entity map (SPORE CAST):',
        JSON.stringify(map, null, 2),
        '',
        'Research findings (MYCELIUM SPREAD):',
        JSON.stringify(res, null, 2),
        '',
        'Produce the final intelligence brief with timeline, cast, key findings, ' +
        'subplots, inconsistencies, and follow-up directives.',
      ].join('\n')

      const synth = await callClaudeJSON(SYNTH_MODEL, SYS_SYNTH, synthPrompt)
      if (abortRef.current) return
      if (!synth) throw new Error('FRUITING BODY returned unparseable JSON.')
      setSynthData(synth)

      // Persist synthesis to the memory pool (fire-and-forget)
      if (synth.summary) {
        fetch('/memory/store', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content:    `[${topic}] ${synth.summary}`,
            confidence: synth.confidence || 0.7,
            source:     topic,
            tags:       (synth.cast || []).map(c => c.name).slice(0, 10),
          }),
        }).catch(() => {})
      }

      setPhase('done')
      setStatusMsg('Investigation complete.')
      setActiveTab('synth')
    } catch (err) {
      if (!abortRef.current) {
        setError(err.message)
        setPhase('error')
        setStatusMsg('')
      }
    }
  }, [topic])

  function handleReset() {
    abortRef.current = true
    setPhase('idle')
    setMapData(null)
    setResData(null)
    setSynthData(null)
    setError('')
    setStatusMsg('')
    setTopic('')
  }

  function handleFollowUp(directive) {
    handleReset()
    setTimeout(() => {
      setTopic(directive)
    }, 50)
  }

  const isActive = ['mapping', 'researching', 'synthesizing'].includes(phase)
  const isDone   = phase === 'done'
  const isIdle   = phase === 'idle' || phase === 'error'

  const TABS = [
    { id: 'map',   label: 'Spore Map',     data: mapData  },
    { id: 'res',   label: 'Mycelium',      data: resData  },
    { id: 'synth', label: 'Fruiting Body', data: synthData },
    { id: 'graph', label: 'Connections',   data: mapData || resData || synthData },
  ]

  return (
    <div style={S.root}>
      <style>{`
        * { box-sizing: border-box; }
        @keyframes spin { to { transform: rotate(360deg); } }
        textarea:focus, input:focus { border-color: ${C.violet} !important; }
        button:hover { opacity: 0.88; }
        ::-webkit-scrollbar { width: 5px; }
        ::-webkit-scrollbar-track { background: ${C.bgMain}; }
        ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 3px; }
      `}</style>

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <header style={S.header}>
        <div style={S.headerBg}>
          <MyceliumCanvas activeEntityCount={entityCount} />
        </div>
        <div style={S.headerContent}>
          {logoError ? (
            <div style={S.logoPlaceholder}>🍄</div>
          ) : (
            <img
              src="/logo.png"
              alt="FungAI P.I."
              style={S.logo}
              onError={() => setLogoError(true)}
            />
          )}
          <div style={S.wordmarkBlock}>
            <div style={S.eyebrow}>Adaptive Investigative Intelligence</div>
            <div style={S.wordmark}>FUNGA.I. P.I.</div>
            <div style={S.subhead}>Mycelium maps the hidden network. So do we.</div>
          </div>
        </div>
      </header>

      {/* ── Main ─────────────────────────────────────────────────────────── */}
      <main style={S.main}>

        {/* Error */}
        {error && (
          <div style={S.errorBox}>⚠ {error}</div>
        )}

        {/* ── Idle: topic input ─────────────────────────────────────────── */}
        {isIdle && (
          <div style={S.section}>
            <label style={S.label}>Investigation Topic</label>
            <textarea
              style={S.input}
              placeholder="Describe what you want to investigate…"
              value={topic}
              onChange={e => setTopic(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) resetAndRun() }}
            />
            <div style={S.exampleGrid}>
              {EXAMPLES.map((ex, i) => (
                <button key={i} style={S.exampleChip} onClick={() => setTopic(ex)}>
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── Idle: action buttons ──────────────────────────────────────── */}
        {isIdle && (
          <div style={{ ...S.row, marginBottom: '28px' }}>
            <button style={S.btnPrimary} onClick={resetAndRun}>
              ◉ Inoculate
            </button>
            {topic.trim() && (
              <button style={S.btnSecondary} onClick={handleReset}>
                ↺ Clear Substrate
              </button>
            )}
          </div>
        )}

        {/* ── Active / done: phase indicators ──────────────────────────── */}
        {(isActive || isDone) && (
          <>
            <div style={S.phases}>
              <PhaseStep
                num="01" label="SPORE CAST"
                active={phase === 'mapping'}
                done={['researching', 'synthesizing', 'done'].includes(phase)}
              />
              <PhaseStep
                num="02" label="MYCELIUM SPREAD"
                active={phase === 'researching'}
                done={['synthesizing', 'done'].includes(phase)}
              />
              <PhaseStep
                num="03" label="FRUITING BODY"
                active={phase === 'synthesizing'}
                done={phase === 'done'}
              />
            </div>

            {/* Status line */}
            {(isActive || statusMsg) && (
              <div style={S.status}>
                {isActive && <div style={S.spinner} />}
                <span style={{ color: isActive ? C.violet : C.amber }}>{statusMsg}</span>
              </div>
            )}

            {/* Reset button */}
            <div style={{ marginBottom: '24px' }}>
              <button style={S.btnSecondary} onClick={handleReset}>↺ Clear Substrate</button>
            </div>

            {/* ── Results ───────────────────────────────────────────────── */}
            {(mapData || resData || synthData) && (
              <>
                {/* Tab bar */}
                <div style={S.tabs}>
                  {TABS.map(t => (
                    <button
                      key={t.id}
                      style={{
                        ...S.tab,
                        ...(activeTab === t.id ? S.tabActive : {}),
                        opacity: t.data ? 1 : 0.35,
                        cursor: t.data ? 'pointer' : 'default',
                      }}
                      onClick={() => t.data && setActiveTab(t.id)}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>

                {/* ── MAP tab ─────────────────────────────────────────── */}
                {activeTab === 'map' && mapData && (
                  <div>
                    {/* Entities */}
                    {mapData.entities?.length > 0 && (
                      <div style={S.resultSection}>
                        <div style={S.resultHeader}>
                          Entities <span style={S.badge}>{mapData.entities.length}</span>
                        </div>
                        <div style={S.entityGrid}>
                          {mapData.entities.map((e, i) => <EntityCard key={i} entity={e} />)}
                        </div>
                      </div>
                    )}

                    {/* Relationships */}
                    {mapData.relationships?.length > 0 && (
                      <div style={S.resultSection}>
                        <div style={S.resultHeader}>
                          Relationships <span style={S.badge}>{mapData.relationships.length}</span>
                        </div>
                        {mapData.relationships.map((r, i) => (
                          <div key={i} style={{ ...S.card, display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 16px' }}>
                            <span style={{ fontFamily: '"Orbitron", sans-serif', fontSize: '12px', color: C.cream }}>{r.from}</span>
                            <span style={{ color: C.amber, fontSize: '11px', fontFamily: '"Space Mono", monospace' }}>— {r.relation} →</span>
                            <span style={{ fontFamily: '"Orbitron", sans-serif', fontSize: '12px', color: C.cream }}>{r.to}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Timeline */}
                    {mapData.timeline?.length > 0 && (
                      <div style={S.resultSection}>
                        <div style={S.resultHeader}>Timeline</div>
                        <div style={{ borderLeft: `2px solid ${C.border}`, paddingLeft: '24px' }}>
                          {mapData.timeline.map((t, i) => (
                            <div key={i} style={{ display: 'flex', gap: '14px', marginBottom: '14px', position: 'relative' }}>
                              <div style={S.timelineDot} />
                              <div style={S.timelineDate}>{t.date}</div>
                              <div style={S.timelineEvent}>{t.event}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Search vectors */}
                    {mapData.searchVectors?.length > 0 && (
                      <div style={S.resultSection}>
                        <div style={S.resultHeader}>Search Vectors</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                          {mapData.searchVectors.map((v, i) => (
                            <span key={i} style={{ ...S.tag, ...S.tagDocument, fontSize: '12px', padding: '5px 14px' }}>
                              {v}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* ── RESEARCH tab ─────────────────────────────────────── */}
                {activeTab === 'res' && resData && (
                  <div>
                    {/* Findings */}
                    {resData.findings?.length > 0 && (
                      <div style={S.resultSection}>
                        <div style={S.resultHeader}>
                          Findings <span style={S.badge}>{resData.findings.length}</span>
                        </div>
                        {resData.findings.map((f, i) => (
                          <FindingCard key={i} finding={f} idx={i} />
                        ))}
                      </div>
                    )}

                    {/* Resolved entities */}
                    {resData.entities?.length > 0 && (
                      <div style={S.resultSection}>
                        <div style={S.resultHeader}>
                          Resolved Entities <span style={S.badge}>{resData.entities.length}</span>
                        </div>
                        <div style={S.entityGrid}>
                          {resData.entities.map((e, i) => <EntityCard key={i} entity={e} />)}
                        </div>
                      </div>
                    )}

                    {/* Inconsistencies */}
                    {resData.inconsistencies?.length > 0 && (
                      <div style={S.resultSection}>
                        <div style={{ ...S.resultHeader, color: C.red }}>
                          ⚠ Inconsistencies <span style={S.badge}>{resData.inconsistencies.length}</span>
                        </div>
                        {resData.inconsistencies.map((inc, i) => (
                          <div key={i} style={{ ...S.card, borderLeft: `3px solid ${C.red}` }}>
                            <div style={{ fontFamily: '"Orbitron", sans-serif', fontSize: '12px', color: C.cream, marginBottom: '5px' }}>
                              {inc.entity}
                            </div>
                            <div style={{ fontSize: '13px', color: C.dim }}>{inc.detail}</div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Evidence gaps */}
                    {resData.gaps?.length > 0 && (
                      <div style={S.resultSection}>
                        <div style={S.resultHeader}>Evidence Gaps</div>
                        <ul style={{ color: C.dim, fontSize: '13px', paddingLeft: '20px', lineHeight: 2.2 }}>
                          {resData.gaps.map((g, i) => <li key={i}>{g}</li>)}
                        </ul>
                      </div>
                    )}

                    {/* Corroborated */}
                    {resData.corroborated?.length > 0 && (
                      <div style={S.resultSection}>
                        <div style={{ ...S.resultHeader, color: C.amber }}>✓ Corroborated</div>
                        <ul style={{ color: C.cream, fontSize: '13px', paddingLeft: '20px', lineHeight: 2.2 }}>
                          {resData.corroborated.map((c, i) => <li key={i}>{c}</li>)}
                        </ul>
                      </div>
                    )}
                  </div>
                )}

                {/* ── CONNECTIONS tab ──────────────────────────────────── */}
                {activeTab === 'graph' && (
                  <div style={S.resultSection}>
                    <div style={S.resultHeader}>
                      Entity Network
                      <span style={S.badge}>
                        {(mapData?.entities?.length || 0) + (resData?.entities?.length || 0)} nodes
                      </span>
                    </div>
                    <div style={{ fontSize: '11px', color: C.dim, marginBottom: '12px', fontFamily: '"Space Mono", monospace' }}>
                      Drag nodes · scroll to zoom · solid lines = mapped relationships · dashed = co-occurrence
                    </div>
                    <ConnectionsGraph
                      mapData={mapData}
                      resData={resData}
                      synthData={synthData}
                    />
                  </div>
                )}

                {/* ── SYNTHESIS tab ─────────────────────────────────────── */}
                {activeTab === 'synth' && synthData && (
                  <div>
                    {/* Summary card */}
                    {synthData.summary && (
                      <div style={{ ...S.card, background: C.bgPanel, borderColor: `${C.violet}55`, marginBottom: '22px' }}>
                        <div style={{ fontFamily: '"Orbitron", sans-serif', fontSize: '10px', color: C.violet, letterSpacing: '0.2em', marginBottom: '10px' }}>
                          INTELLIGENCE SUMMARY
                        </div>
                        <div style={{ fontSize: '15px', color: C.cream, lineHeight: 1.75 }}>
                          {synthData.summary}
                        </div>
                        {synthData.confidence != null && (
                          <div style={{ marginTop: '14px' }}>
                            <div style={{ fontSize: '11px', color: C.dim, marginBottom: '5px' }}>
                              Overall confidence:{' '}
                              <span style={{ color: confColor(synthData.confidence) }}>
                                {Math.round(Number(synthData.confidence) * 100)}%
                              </span>
                            </div>
                            <div style={S.confBar}>
                              <div style={confFill(synthData.confidence, confColor(synthData.confidence))} />
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Key findings */}
                    {synthData.keyFindings?.length > 0 && (
                      <div style={S.resultSection}>
                        <div style={S.resultHeader}>Key Findings</div>
                        <ol style={{ color: C.cream, fontSize: '13px', paddingLeft: '22px', lineHeight: 2.1 }}>
                          {synthData.keyFindings.map((f, i) => (
                            <li key={i} style={{ marginBottom: '8px' }}>{f}</li>
                          ))}
                        </ol>
                      </div>
                    )}

                    {/* Verified timeline */}
                    {synthData.timeline?.length > 0 && (
                      <div style={S.resultSection}>
                        <div style={S.resultHeader}>Verified Timeline</div>
                        <div style={{ borderLeft: `2px solid ${C.amber}44`, paddingLeft: '24px' }}>
                          {synthData.timeline.map((t, i) => (
                            <div key={i} style={{ display: 'flex', gap: '14px', marginBottom: '18px', position: 'relative' }}>
                              <div style={{ ...S.timelineDot, background: confColor(t.confidence ?? 0.5) }} />
                              <div style={S.timelineDate}>{t.date}</div>
                              <div>
                                <div style={S.timelineEvent}>{t.event}</div>
                                {t.confidence != null && (
                                  <div style={{ fontSize: '11px', color: confColor(t.confidence), marginTop: '3px' }}>
                                    {Math.round(Number(t.confidence) * 100)}% confidence
                                  </div>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Cast */}
                    {synthData.cast?.length > 0 && (
                      <div style={S.resultSection}>
                        <div style={S.resultHeader}>
                          Cast <span style={S.badge}>{synthData.cast.length}</span>
                        </div>
                        <div style={S.entityGrid}>
                          {synthData.cast.map((c, i) => <CastCard key={i} person={c} />)}
                        </div>
                      </div>
                    )}

                    {/* Subplots */}
                    {synthData.subplots?.length > 0 && (
                      <div style={S.resultSection}>
                        <div style={S.resultHeader}>Sub-plots</div>
                        <ul style={{ color: C.dim, fontSize: '13px', paddingLeft: '20px', lineHeight: 2.2 }}>
                          {synthData.subplots.map((s, i) => <li key={i}>{s}</li>)}
                        </ul>
                      </div>
                    )}

                    {/* Inconsistencies */}
                    {synthData.inconsistencies?.length > 0 && (
                      <div style={S.resultSection}>
                        <div style={{ ...S.resultHeader, color: C.red }}>
                          ⚠ Unresolved Inconsistencies
                        </div>
                        {synthData.inconsistencies.map((inc, i) => (
                          <div key={i} style={{ ...S.card, borderLeft: `3px solid ${C.red}` }}>
                            <div style={{ fontFamily: '"Orbitron", sans-serif', fontSize: '12px', color: C.cream, marginBottom: '5px' }}>
                              {inc.entity}
                            </div>
                            <div style={{ fontSize: '13px', color: C.dim }}>{inc.detail}</div>
                            {inc.citations?.length > 0 && (
                              <div style={{ marginTop: '8px', fontSize: '11px', color: C.warm }}>
                                {inc.citations.join(' · ')}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Follow-up directives */}
                    {synthData.followUpDirectives?.length > 0 && (
                      <div style={S.resultSection}>
                        <div style={S.resultHeader}>Follow-up Directives</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                          {synthData.followUpDirectives.map((d, i) => (
                            <button key={i} style={S.btnGhost} onClick={() => handleFollowUp(d)}>
                              → {d}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </main>

      <footer style={S.footer}>
        FUNGA.I. P.I. — Adaptive Investigative Intelligence — Mycelium maps the hidden network
      </footer>
    </div>
  )
}
