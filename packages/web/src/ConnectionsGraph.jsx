import { useRef, useEffect } from 'react'
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
    case 'person':   return C.purple
    case 'org':      return C.amber
    case 'event':    return C.gold
    case 'location': return C.violet
    case 'document': return C.green
    default:         return C.dim
  }
}

function buildGraph(mapData, resData, synthData) {
  const nodeMap = new Map()  // lowercase name → node object
  const linkSet = new Set()  // "from→to" dedup key
  const links   = []

  function addNode(name, type, confidence) {
    if (!name?.trim()) return
    const key = name.trim().toLowerCase()
    if (!nodeMap.has(key)) {
      nodeMap.set(key, {
        id:    key,
        label: name.trim(),
        type:  type || 'entity',
        r:     type === 'person' ? 8 : 6,
        conf:  Number(confidence ?? 0.7),
      })
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

export default function ConnectionsGraph({ mapData, resData, synthData }) {
  const containerRef = useRef(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const { nodes, links } = buildGraph(mapData, resData, synthData)

    // Clear previous render
    el.innerHTML = ''

    if (!nodes.length) {
      el.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:${C.dim};font-family:'Space Mono',monospace;font-size:12px;">No entities mapped yet</div>`
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
      .force('link',    d3.forceLink(links).id(d => d.id).distance(100).strength(0.4))
      .force('charge',  d3.forceManyBody().strength(-220))
      .force('center',  d3.forceCenter(W / 2, H / 2))
      .force('collide', d3.forceCollide().radius(d => d.r + 10))

    // ── Links ──────────────────────────────────────────────────────────────────
    const link = root.append('g')
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke', d => d.inferred ? `${C.border}` : `${C.amber}55`)
      .attr('stroke-width', d => d.inferred ? 0.5 : 1)
      .attr('stroke-dasharray', d => d.inferred ? '3,3' : null)
      .attr('marker-end', d => d.inferred ? null : 'url(#arrow)')

    // ── Link labels ────────────────────────────────────────────────────────────
    const linkLabel = root.append('g')
      .selectAll('text')
      .data(links.filter(l => l.label && !l.inferred))
      .join('text')
      .attr('fill', C.dim)
      .attr('font-family', '"Space Mono", monospace')
      .attr('font-size', 9)
      .attr('text-anchor', 'middle')
      .text(d => d.label)

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

    // Glow ring
    node.append('circle')
      .attr('r', d => d.r + 4)
      .attr('fill', 'none')
      .attr('stroke', d => nodeColor(d.type))
      .attr('stroke-width', 0.5)
      .attr('opacity', 0.3)

    // Main circle
    node.append('circle')
      .attr('r', d => d.r)
      .attr('fill', d => `${nodeColor(d.type)}dd`)
      .attr('stroke', d => nodeColor(d.type))
      .attr('stroke-width', 1.5)
      .style('filter', d => `drop-shadow(0 0 4px ${nodeColor(d.type)})`)

    // Labels
    node.append('text')
      .attr('dy', d => d.r + 12)
      .attr('text-anchor', 'middle')
      .attr('fill', C.cream)
      .attr('font-family', '"Orbitron", sans-serif')
      .attr('font-size', 9)
      .attr('letter-spacing', '0.05em')
      .text(d => d.label.length > 18 ? d.label.slice(0, 16) + '…' : d.label)

    // ── Tick ───────────────────────────────────────────────────────────────────
    sim.on('tick', () => {
      link
        .attr('x1', d => d.source.x)
        .attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x)
        .attr('y2', d => d.target.y)

      linkLabel
        .attr('x', d => (d.source.x + d.target.x) / 2)
        .attr('y', d => (d.source.y + d.target.y) / 2 - 4)

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
  }, [mapData, resData, synthData])

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '480px', borderRadius: '8px', overflow: 'hidden' }}
    />
  )
}
