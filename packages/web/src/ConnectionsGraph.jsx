import { useRef, useEffect, useState } from 'react'
import * as d3 from 'd3'

// ─── Palette (matches App.jsx) ────────────────────────────────────────────────
const C = {
  bgCard:  '#0e0e1a',
  border:  '#2a2a3a',
  cream:   '#e8e4d8',
  dim:     '#8884a0',
  violet:  '#9b72d8',
  amber:   '#ff8c00',
  gold:    '#c9a84c',
  purple:  '#823cff',
  green:   '#6ab88a',
  red:     '#d45a5a',
}

function nodeColor(type) {
  switch ((type || '').toLowerCase()) {
    case 'person':          return C.purple
    case 'org':             return C.amber
    case 'event':           return C.gold
    case 'location':        return C.violet
    case 'document':        return C.green
    case 'government_body': return C.violet
    case 'program':         return C.gold
    case 'financial':       return C.green
    case 'media':           return C.amber
    case 'network':         return C.dim
    default:                return C.dim
  }
}

function buildGraph(mapData, resData, synthData, memoryData) {
  const nodeMap = new Map()  // lowercase name → node object
  const linkSet = new Set()  // "from→to" dedup key
  const links   = []

  function addNode(name, type, confidence, fromMemory = false) {
    if (!name?.trim()) return
    const key = name.trim().toLowerCase()
    if (!nodeMap.has(key)) {
      nodeMap.set(key, {
        id:         key,
        label:      name.trim(),
        type:       type || 'entity',
        r:          type === 'person' ? 8 : 6,
        conf:       Number(confidence ?? 0.7),
        fromMemory,
      })
    } else if (!fromMemory) {
      // Fresh discovery takes precedence — clear memory-only flag
      nodeMap.get(key).fromMemory = false
    }
  }

  // Memory nodes & edges (added first; fresh data below can override)
  for (const n of memoryData?.nodes || []) addNode(n.name, n.type, n.confidence ?? 0.5, true)
  for (const e of memoryData?.edges || []) {
    const s = e.from?.trim().toLowerCase()
    const t = e.to?.trim().toLowerCase()
    addNode(e.from, 'entity', 0.5, true)
    addNode(e.to,   'entity', 0.5, true)
    if (s && t && s !== t) {
      const key = `${s}→${t}`
      if (!linkSet.has(key)) {
        linkSet.add(key)
        links.push({ source: s, target: t, label: e.relation || 'recalled', fromMemory: true })
      }
    }
  }

  // SPORE CAST entities & relationships
  for (const e of mapData?.entities || []) addNode(e.name, e.type, 1)
  for (const r of mapData?.relationships || []) {
    const s = r.from?.trim().toLowerCase()
    const t = r.to?.trim().toLowerCase()
    addNode(r.from, 'entity', 1)
    addNode(r.to,   'entity', 1)
    if (s && t && s !== t) {
      const key = `${s}→${t}`
      if (!linkSet.has(key)) {
        linkSet.add(key)
        links.push({ source: s, target: t, label: r.relation || '' })
      }
    }
  }

  // MYCELIUM SPREAD entities
  for (const e of resData?.entities || []) addNode(e.name, e.type, e.confidence)

  // Infer links from co-occurrence in findings
  for (const f of resData?.findings || []) {
    const ents = (f.entities || []).filter(Boolean)
    for (let i = 0; i < ents.length; i++) {
      addNode(ents[i], 'person', f.confidence)
      for (let j = i + 1; j < ents.length; j++) {
        addNode(ents[j], 'person', f.confidence)
        const s = ents[i].toLowerCase()
        const t = ents[j].toLowerCase()
        const key = [s, t].sort().join('↔')
        if (!linkSet.has(key)) {
          linkSet.add(key)
          links.push({ source: s, target: t, label: 'co-occurs', inferred: true })
        }
      }
    }
  }

  // FRUITING BODY cast
  for (const c of synthData?.cast || []) addNode(c.name, 'person', 1)

  return { nodes: [...nodeMap.values()], links }
}

export default function ConnectionsGraph({ mapData, resData, synthData, memoryData }) {
  const containerRef  = useRef(null)
  const manualLinksRef = useRef([])  // persists across renders
  const pendingRef    = useRef(null)  // source node id awaiting second click
  const nodeSelRef    = useRef(null)  // live D3 node selection for un-highlighting
  const [linkMode, setLinkMode] = useState(false)
  const linkModeRef   = useRef(false)

  // Keep linkModeRef in sync without re-running the D3 effect
  useEffect(() => { linkModeRef.current = linkMode }, [linkMode])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const { nodes, links } = buildGraph(mapData, resData, synthData, memoryData)
    // Merge manual links added by the user; clone to avoid mutation issues
    const liveLinkData = [...links, ...manualLinksRef.current]
    pendingRef.current = null

    el.innerHTML = ''

    if (!nodes.length) {
      const msg = document.createElement('div')
      Object.assign(msg.style, {
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100%', color: C.dim, fontFamily: "'Space Mono',monospace", fontSize: '12px',
      })
      msg.textContent = 'No entities mapped yet'
      el.appendChild(msg)
      return
    }

    const W = el.clientWidth  || 800
    const H = el.clientHeight || 480

    // ── SVG shell ──────────────────────────────────────────────────────────────
    const svg = d3.select(el)
      .append('svg')
      .attr('width', W)
      .attr('height', H)
      .style('background', C.bgCard)
      .style('border-radius', '8px')

    const root = svg.append('g')

    svg.call(
      d3.zoom()
        .scaleExtent([0.2, 5])
        .on('zoom', e => root.attr('transform', e.transform))
    )

    // ── Arrow marker ───────────────────────────────────────────────────────────
    svg.append('defs').append('marker')
      .attr('id', 'arrow')
      .attr('viewBox', '0 -4 8 8')
      .attr('refX', 14)
      .attr('refY', 0)
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-4L8,0L0,4')
      .attr('fill', `${C.amber}88`)

    // ── Force simulation ───────────────────────────────────────────────────────
    const sim = d3.forceSimulation(nodes)
      .force('link',    d3.forceLink(liveLinkData).id(d => d.id).distance(100).strength(0.4))
      .force('charge',  d3.forceManyBody().strength(-220))
      .force('center',  d3.forceCenter(W / 2, H / 2))
      .force('collide', d3.forceCollide().radius(d => d.r + 10))

    // ── Link rendering (reusable for live additions) ───────────────────────────
    const linkGroup      = root.append('g')
    const linkLabelGroup = root.append('g')

    function renderLinks() {
      linkGroup.selectAll('line')
        .data(liveLinkData)
        .join('line')
        .attr('stroke', d => d.manual
          ? `${C.gold}88`
          : d.fromMemory
            ? `${C.dim}55`
            : d.inferred ? C.border : `${C.amber}55`)
        .attr('stroke-width', d => d.manual ? 1.5 : (d.fromMemory || d.inferred) ? 0.5 : 1)
        .attr('stroke-dasharray', d => d.manual ? '6,2' : d.fromMemory ? '4,4' : d.inferred ? '3,3' : null)
        .attr('marker-end', d => (!d.fromMemory && !d.inferred && !d.manual) ? 'url(#arrow)' : null)

      linkLabelGroup.selectAll('text')
        .data(liveLinkData.filter(l => l.label && !l.inferred))
        .join('text')
        .attr('fill', C.dim)
        .attr('font-family', '"Space Mono", monospace')
        .attr('font-size', 9)
        .attr('text-anchor', 'middle')
        .text(d => d.label)
    }

    renderLinks()

    // ── Nodes ──────────────────────────────────────────────────────────────────
    const node = root.append('g')
      .selectAll('g')
      .data(nodes)
      .join('g')
      .style('cursor', 'grab')
      .call(
        d3.drag()
          .on('start', (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y })
          .on('drag',  (e, d) => { d.fx = e.x; d.fy = e.y })
          .on('end',   (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null })
      )

    nodeSelRef.current = node

    // Glow ring — hidden for memory-recalled nodes
    node.append('circle')
      .attr('r', d => d.r + 4)
      .attr('fill', 'none')
      .attr('stroke', d => nodeColor(d.type))
      .attr('stroke-width', 0.5)
      .attr('opacity', d => d.fromMemory ? 0 : 0.3)

    // Main circle
    node.append('circle')
      .classed('main-circle', true)
      .attr('r', d => d.r)
      .attr('fill', d => `${nodeColor(d.type)}${d.fromMemory ? '33' : 'dd'}`)
      .attr('stroke', d => nodeColor(d.type))
      .attr('stroke-width', 1.5)
      .attr('stroke-dasharray', d => d.fromMemory ? '3,3' : null)
      .style('filter', d => d.fromMemory ? null : `drop-shadow(0 0 4px ${nodeColor(d.type)})`)

    // Labels
    node.append('text')
      .attr('dy', d => d.r + 12)
      .attr('text-anchor', 'middle')
      .attr('fill', d => d.fromMemory ? C.dim : C.cream)
      .attr('font-family', '"Orbitron", sans-serif')
      .attr('font-size', 9)
      .attr('letter-spacing', '0.05em')
      .text(d => d.label.length > 18 ? d.label.slice(0, 16) + '…' : d.label)

    // ── Manual link: click two nodes to draw a thread ──────────────────────────
    node.on('click', (e, d) => {
      if (!linkModeRef.current) return
      e.stopPropagation()

      if (!pendingRef.current) {
        // First click — highlight as source
        pendingRef.current = d.id
        d3.select(e.currentTarget).select('.main-circle')
          .attr('stroke', C.gold)
          .attr('stroke-width', 3)
      } else {
        const srcId = pendingRef.current
        pendingRef.current = null

        // Un-highlight source
        node.filter(n => n.id === srcId).select('.main-circle')
          .attr('stroke', n => nodeColor(n.type))
          .attr('stroke-width', 1.5)

        if (srcId !== d.id) {
          liveLinkData.push({ source: srcId, target: d.id, label: 'manual', manual: true })
          manualLinksRef.current.push({ source: srcId, target: d.id, label: 'manual', manual: true })
          sim.force('link').links(liveLinkData)
          renderLinks()
          sim.alpha(0.3).restart()
        }
      }
    })

    // ── Tick ───────────────────────────────────────────────────────────────────
    sim.on('tick', () => {
      linkGroup.selectAll('line')
        .attr('x1', d => d.source.x ?? 0)
        .attr('y1', d => d.source.y ?? 0)
        .attr('x2', d => d.target.x ?? 0)
        .attr('y2', d => d.target.y ?? 0)

      linkLabelGroup.selectAll('text')
        .attr('x', d => ((d.source.x ?? 0) + (d.target.x ?? 0)) / 2)
        .attr('y', d => ((d.source.y ?? 0) + (d.target.y ?? 0)) / 2 - 4)

      node.attr('transform', d => `translate(${d.x},${d.y})`)
    })

    // ── Legend ─────────────────────────────────────────────────────────────────
    const types = [...new Set(nodes.map(n => n.type))].slice(0, 5)
    const legend = svg.append('g').attr('transform', 'translate(14,14)')
    types.forEach((t, i) => {
      const g = legend.append('g').attr('transform', `translate(0,${i * 18})`)
      g.append('circle').attr('r', 5).attr('cx', 6).attr('cy', 6).attr('fill', `${nodeColor(t)}cc`).attr('stroke', nodeColor(t)).attr('stroke-width', 1)
      g.append('text').attr('x', 16).attr('y', 10).attr('fill', C.dim).attr('font-family', '"Space Mono", monospace').attr('font-size', 9).text(t)
    })

    return () => { sim.stop() }
  }, [mapData, resData, synthData, memoryData])

  function toggleLinkMode() {
    // Un-highlight any pending node before toggling off
    if (linkMode && pendingRef.current && nodeSelRef.current) {
      const id = pendingRef.current
      nodeSelRef.current.filter(n => n.id === id).select('.main-circle')
        .attr('stroke', n => nodeColor(n.type))
        .attr('stroke-width', 1.5)
    }
    pendingRef.current = null
    setLinkMode(m => !m)
  }

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={toggleLinkMode}
        title={linkMode ? 'Cancel — click to exit link mode' : 'Link Nodes — click two nodes to draw a thread'}
        style={{
          position:    'absolute',
          top:         8,
          right:       8,
          zIndex:      10,
          background:  linkMode ? C.gold : 'transparent',
          color:       linkMode ? C.bgCard : C.dim,
          border:      `1px solid ${linkMode ? C.gold : C.border}`,
          borderRadius: '4px',
          fontFamily:  '"Space Mono", monospace',
          fontSize:    '10px',
          padding:     '4px 10px',
          cursor:      'pointer',
          letterSpacing: '0.05em',
        }}
      >
        {linkMode ? '✕ CANCEL' : '⊕ LINK NODES'}
      </button>
      <div
        ref={containerRef}
        style={{ width: '100%', height: '480px', borderRadius: '8px', overflow: 'hidden' }}
      />
    </div>
  )
}
