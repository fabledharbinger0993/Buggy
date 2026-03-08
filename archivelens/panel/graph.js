/**
 * graph.js — D3.js force-directed graph renderer for ArchiveLens
 *
 * Renders an interactive force-directed node-link graph where:
 *  - Nodes represent canonical entities
 *  - Edges represent relationships, weighted by co-occurrence and confidence
 *  - The primary search subject is the root node (larger, distinct colour)
 *  - Edge style reflects corroboration status:
 *      CORROBORATED   → solid full-weight stroke
 *      SINGLE-SOURCE  → solid dimmed stroke
 *      UNCORROBORATED → dashed stroke
 *
 * Supports zoom, pan, node drag, PNG export, and JSON export.
 * Calls back into results.js via the exported renderGraph() function.
 */

// ── Colour map ────────────────────────────────────────────────────────────────

const NODE_COLORS = {
  root:         '#f9a84f',
  person:       '#4f9cf9',
  organization: '#6fcf97',
  location:     '#bb87fc',
  operation:    '#eb5757',
  date:         '#f2994a',
  fileNumber:   '#56ccf2',
  other:        '#8b95a8',
};

// ── Edge style by corroboration ───────────────────────────────────────────────

function edgeStyle(corroborationStatus) {
  switch (corroborationStatus) {
    case 'CORROBORATED':
      return { stroke: '#6fcf97', strokeWidth: 1.5, dashArray: null, opacity: 0.85 };
    case 'SINGLE-SOURCE':
      return { stroke: '#4f9cf9', strokeWidth: 1, dashArray: null, opacity: 0.45 };
    case 'UNCORROBORATED':
    default:
      return { stroke: '#eb5757', strokeWidth: 1, dashArray: '4 4', opacity: 0.55 };
  }
}

// ── Main render function ──────────────────────────────────────────────────────

/**
 * Render the force-directed graph into #graph-container.
 *
 * @param {object} entityGraph - { entities: [], relationships: [] }
 * @param {string} subject     - primary search subject (root node label)
 * @param {Function} onNodeClick - callback(entity) when a node is clicked
 */
export function renderGraph(entityGraph, subject, onNodeClick) {
  const container = document.getElementById('graph-container');
  container.innerHTML = '';

  const width = container.clientWidth || window.innerWidth;
  const height = container.clientHeight || window.innerHeight;

  const entities = entityGraph.entities || [];
  const relationships = entityGraph.relationships || [];

  if (entities.length === 0) {
    container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#8b95a8;font-size:14px">No entities to display.</div>';
    return;
  }

  // ── Build node and link data ────────────────────────────────────────────

  // Map entity ID → entity for quick lookup
  const entityMap = new Map(entities.map((e) => [e.id, e]));

  // Assign a root flag to the entity whose canonical name best matches the subject
  const subjectLower = (subject || '').toLowerCase();
  for (const e of entities) {
    e._isRoot = (e.canonical || '').toLowerCase().includes(subjectLower);
  }
  // Ensure at least one root
  if (!entities.some((e) => e._isRoot) && entities.length > 0) {
    entities[0]._isRoot = true;
  }

  // Deduplicate relationships by entity pair (keep highest-confidence version)
  const linkMap = new Map();
  for (const rel of relationships) {
    const key = [rel.entity_a, rel.entity_b].sort().join('|||');
    if (!linkMap.has(key) || (rel.confidence || 0) > (linkMap.get(key).confidence || 0)) {
      linkMap.set(key, rel);
    }
  }

  // Build D3 nodes and links
  const nodes = entities.map((e) => ({
    id: e.id,
    label: e.canonical,
    type: e.type || 'other',
    isRoot: e._isRoot,
    confidence: e.confidence || 0,
    consistencyFlag: e.consistencyFlag,
    discrepancies: e.discrepancies || [],
    role: e.role || '',
    entity: e,
  }));

  const nodeIdSet = new Set(nodes.map((n) => n.id));

  // Resolve entity name → node ID (for relationships that use name strings)
  function resolveNodeId(nameOrId) {
    if (nodeIdSet.has(nameOrId)) return nameOrId;
    // Try canonical name match
    const found = entities.find(
      (e) => e.canonical === nameOrId || (e.aliases || []).includes(nameOrId)
    );
    return found ? found.id : null;
  }

  const links = [];
  for (const [, rel] of linkMap) {
    const sourceId = resolveNodeId(rel.entity_a);
    const targetId = resolveNodeId(rel.entity_b);
    if (sourceId && targetId && sourceId !== targetId) {
      links.push({
        source: sourceId,
        target: targetId,
        corroborationStatus: rel.corroborationStatus || 'UNCORROBORATED',
        confidence: rel.confidence || 0,
        relationship: rel.relationship || '',
      });
    }
  }

  // ── D3 setup ────────────────────────────────────────────────────────────

  const svg = d3.select(container)
    .append('svg')
    .attr('width', width)
    .attr('height', height)
    .attr('xmlns', 'http://www.w3.org/2000/svg');

  // Define arrow markers for directed edges
  const defs = svg.append('defs');
  ['CORROBORATED', 'SINGLE-SOURCE', 'UNCORROBORATED'].forEach((status) => {
    const style = edgeStyle(status);
    defs.append('marker')
      .attr('id', `arrow-${status}`)
      .attr('viewBox', '0 -4 8 8')
      .attr('refX', 14)
      .attr('refY', 0)
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-4L8,0L0,4')
      .attr('fill', style.stroke)
      .attr('opacity', style.opacity);
  });

  // Zoomable group
  const g = svg.append('g').attr('class', 'zoom-group');

  const zoom = d3.zoom()
    .scaleExtent([0.1, 6])
    .on('zoom', (event) => g.attr('transform', event.transform));

  svg.call(zoom);

  // ── Force simulation ─────────────────────────────────────────────────────

  const simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id((d) => d.id).distance(90).strength(0.4))
    .force('charge', d3.forceManyBody().strength(-200))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide().radius((d) => nodeRadius(d) + 6))
    .alphaDecay(0.03);

  // ── Edges ───────────────────────────────────────────────────────────────

  const link = g.append('g')
    .attr('class', 'links')
    .selectAll('line')
    .data(links)
    .join('line')
    .attr('stroke', (d) => edgeStyle(d.corroborationStatus).stroke)
    .attr('stroke-width', (d) => edgeStyle(d.corroborationStatus).strokeWidth)
    .attr('stroke-dasharray', (d) => edgeStyle(d.corroborationStatus).dashArray || null)
    .attr('opacity', (d) => edgeStyle(d.corroborationStatus).opacity)
    .attr('marker-end', (d) => `url(#arrow-${d.corroborationStatus})`);

  // ── Nodes ───────────────────────────────────────────────────────────────

  const nodeGroup = g.append('g')
    .attr('class', 'nodes')
    .selectAll('g')
    .data(nodes)
    .join('g')
    .attr('class', 'node')
    .style('cursor', 'pointer')
    .call(
      d3.drag()
        .on('start', (event, d) => {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          d.fx = d.x; d.fy = d.y;
        })
        .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
        .on('end', (event, d) => {
          if (!event.active) simulation.alphaTarget(0);
          d.fx = null; d.fy = null;
        })
    );

  // Node circles
  nodeGroup.append('circle')
    .attr('r', (d) => nodeRadius(d))
    .attr('fill', (d) => nodeColor(d))
    .attr('stroke', (d) => d.consistencyFlag === 'DISCREPANCY' ? '#eb5757' : 'rgba(255,255,255,0.15)')
    .attr('stroke-width', (d) => d.consistencyFlag === 'DISCREPANCY' ? 2.5 : 1);

  // Node labels
  nodeGroup.append('text')
    .attr('dy', (d) => nodeRadius(d) + 10)
    .attr('text-anchor', 'middle')
    .attr('font-size', (d) => d.isRoot ? '12px' : '10px')
    .attr('font-weight', (d) => d.isRoot ? '700' : '400')
    .attr('fill', (d) => d.isRoot ? '#f9a84f' : '#c4cbd9')
    .attr('pointer-events', 'none')
    .text((d) => truncateLabel(d.label, d.isRoot ? 24 : 18));

  // Discrepancy indicator ring
  nodeGroup.filter((d) => d.consistencyFlag === 'DISCREPANCY')
    .append('circle')
    .attr('r', (d) => nodeRadius(d) + 4)
    .attr('fill', 'none')
    .attr('stroke', '#eb5757')
    .attr('stroke-width', 1.5)
    .attr('stroke-dasharray', '3 2')
    .attr('opacity', 0.7);

  // ── Tooltip ─────────────────────────────────────────────────────────────

  const tooltip = document.getElementById('node-tooltip');
  const tooltipName = document.getElementById('tooltip-name');
  const tooltipType = document.getElementById('tooltip-type');
  const tooltipRole = document.getElementById('tooltip-role');
  const tooltipFlag = document.getElementById('tooltip-flag');

  nodeGroup
    .on('mouseover', (event, d) => {
      tooltipName.textContent = d.label;
      tooltipType.textContent = `Type: ${d.type}`;
      tooltipRole.textContent = d.role ? `Role: ${d.role}` : '';
      if (d.consistencyFlag) {
        tooltipFlag.textContent = d.consistencyFlag === 'DISCREPANCY'
          ? '⚠️ DISCREPANCY — conflicting attributes found'
          : '✅ CONSISTENT';
        tooltipFlag.className = `tooltip-flag ${d.consistencyFlag === 'DISCREPANCY' ? 'flag-discrepancy' : 'flag-consistent'}`;
      } else {
        tooltipFlag.textContent = '';
      }
      tooltip.style.display = 'block';
      tooltip.style.left = `${event.clientX + 12}px`;
      tooltip.style.top = `${event.clientY - 8}px`;
    })
    .on('mousemove', (event) => {
      tooltip.style.left = `${event.clientX + 12}px`;
      tooltip.style.top = `${event.clientY - 8}px`;
    })
    .on('mouseleave', () => {
      tooltip.style.display = 'none';
    })
    .on('click', (event, d) => {
      event.stopPropagation();
      if (onNodeClick) onNodeClick(d.entity);
    });

  // ── Simulation tick ──────────────────────────────────────────────────────

  simulation.on('tick', () => {
    link
      .attr('x1', (d) => d.source.x)
      .attr('y1', (d) => d.source.y)
      .attr('x2', (d) => d.target.x)
      .attr('y2', (d) => d.target.y);

    nodeGroup.attr('transform', (d) => `translate(${d.x},${d.y})`);
  });

  // ── Zoom controls ────────────────────────────────────────────────────────

  document.getElementById('btn-zoom-in').onclick = () =>
    svg.transition().call(zoom.scaleBy, 1.4);
  document.getElementById('btn-zoom-out').onclick = () =>
    svg.transition().call(zoom.scaleBy, 0.7);
  document.getElementById('btn-zoom-fit').onclick = () =>
    svg.transition().call(zoom.transform, d3.zoomIdentity);

  // ── PNG export ───────────────────────────────────────────────────────────

  window.__exportGraphPng = function () {
    simulation.stop();
    const svgEl = container.querySelector('svg');
    const serializer = new XMLSerializer();
    const svgStr = serializer.serializeToString(svgEl);
    const blob = new Blob([svgStr], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = svgEl.width.baseVal.value;
      canvas.height = svgEl.height.baseVal.value;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#14171e';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob((pngBlob) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(pngBlob);
        a.download = 'archivelens-graph.png';
        a.click();
      });
    };
    img.src = url;
  };

  // ── JSON export ──────────────────────────────────────────────────────────

  window.__exportGraphJson = function (entityGraph) {
    const json = JSON.stringify(entityGraph, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'archivelens-graph.json';
    a.click();
  };

  return { simulation, svg, zoom };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function nodeRadius(d) {
  if (d.isRoot) return 18;
  const base = 7 + (d.confidence || 0) * 6;
  return Math.min(base, 14);
}

function nodeColor(d) {
  if (d.isRoot) return NODE_COLORS.root;
  return NODE_COLORS[d.type] || NODE_COLORS.other;
}

function truncateLabel(text, maxLen) {
  if (!text) return '';
  return text.length > maxLen ? text.slice(0, maxLen - 1) + '…' : text;
}
