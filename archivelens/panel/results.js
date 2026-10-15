/**
 * results.js — Results panel controller for ArchiveLens
 *
 * Loads session data from the background service worker and populates:
 *  - the D3.js force-directed graph (Vein Diagram)
 *  - the Citation Log table
 *  - the Subject Context Brief
 */

import { renderGraph } from './graph.js';

// ── State ─────────────────────────────────────────────────────────────────────

let sessionData = null;
let currentSortCol = 'relevanceScore';
let currentSortAsc = false;
let citationFilter = '';
let thresholdScore = 0.6;

// ── DOM refs ─────────────────────────────────────────────────────────────────

const loadingEl = document.getElementById('loading');
const tabs = document.querySelectorAll('.result-tab');
const panels = {
  graph: document.getElementById('panel-graph'),
  citations: document.getElementById('panel-citations'),
  brief: document.getElementById('panel-brief'),
};

// ── Tab switching ─────────────────────────────────────────────────────────────

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    tabs.forEach((t) => t.classList.remove('active'));
    Object.values(panels).forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    const name = tab.dataset.tab;
    if (panels[name]) panels[name].classList.add('active');
  });
});

// ── Initialise ────────────────────────────────────────────────────────────────

async function init() {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('session');

  if (!sessionId) {
    showError('No session ID in URL. Open this panel from the ArchiveLens popup.');
    return;
  }

  let data;
  try {
    data = await chrome.runtime.sendMessage({
      action: 'getSession',
      payload: { sessionId },
    });
  } catch (err) {
    showError(`Failed to load session: ${err.message}`);
    return;
  }

  if (!data || !data.session) {
    showError('Session not found or still loading. Please wait and refresh.');
    return;
  }

  sessionData = data;
  await renderAll(data);

  // Listen for crawl completion to auto-refresh
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'crawlComplete' && msg.payload?.sessionId === sessionId) {
      chrome.runtime.sendMessage({ action: 'getSession', payload: { sessionId } })
        .then((updated) => { sessionData = updated; renderAll(updated); })
        .catch(console.error);
    }
    if (msg.action === 'captchaDetected') {
      showCaptchaAlert(msg.payload.domain);
    }
  });
}

async function renderAll(data) {
  loadingEl.classList.add('hidden');

  const { session, documents = [], entities = [] } = data;

  // Set page title
  document.getElementById('session-title').textContent =
    session.title || session.subject || 'Results';
  document.title = `ArchiveLens — ${session.title || session.subject || 'Results'}`;

  // Build entity graph structure
  const entityGraph = {
    entities,
    relationships: documents.flatMap((d) => d._rawRelationships || []),
  };

  // ── Render graph ────────────────────────────────────────────────────────
  panels.graph.classList.remove('hidden');
  renderGraph(entityGraph, session.subject, onNodeClick);

  // ── Render citation log ─────────────────────────────────────────────────
  renderCitationLog(documents);

  // ── Render context brief ────────────────────────────────────────────────
  renderBrief(session, entities, documents);

  // ── Show first active panel ─────────────────────────────────────────────
  tabs[0].click();
}

// ── Node click handler ────────────────────────────────────────────────────────

function onNodeClick(entity) {
  // Switch to citations tab and filter by this entity's name
  const entityName = entity.canonical;
  document.querySelector('[data-tab="citations"]').click();
  document.getElementById('citation-search').value = entityName;
  citationFilter = entityName.toLowerCase();
  renderCitationLog(sessionData?.documents || []);
}

// ── Citation log ──────────────────────────────────────────────────────────────

function renderCitationLog(documents) {
  const tbody = document.getElementById('citation-tbody');
  tbody.innerHTML = '';

  let filtered = documents.filter((doc) => {
    if (doc.relevanceScore < thresholdScore) return false;
    if (!citationFilter) return true;
    const needle = citationFilter.toLowerCase();
    return (
      (doc.title || '').toLowerCase().includes(needle) ||
      (doc.archive || '').toLowerCase().includes(needle) ||
      (doc.entities || []).some((e) => e.toLowerCase().includes(needle))
    );
  });

  // Sort
  filtered.sort((a, b) => {
    const va = a[currentSortCol] ?? '';
    const vb = b[currentSortCol] ?? '';
    const cmp = typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb));
    return currentSortAsc ? cmp : -cmp;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--text2)">No documents match current filters.</td></tr>`;
    return;
  }

  for (const doc of filtered) {
    const tr = document.createElement('tr');

    const score = typeof doc.relevanceScore === 'number' ? doc.relevanceScore.toFixed(2) : '—';
    const scoreClass = doc.relevanceScore >= 0.7 ? 'score-high' : doc.relevanceScore >= 0.5 ? 'score-med' : 'score-low';
    const corrStatus = doc.corroborationStatuses?.[0] || null;
    const corrClass = corrStatus === 'CORROBORATED' ? 'corr-corroborated' : corrStatus === 'SINGLE-SOURCE' ? 'corr-single-source' : corrStatus ? 'corr-uncorroborated' : '';
    const accessClass = doc.accessStatus === 'ok' ? 'status-ok' : doc.accessStatus === 'ACCESS_DENIED' ? 'status-access-denied' : 'status-error';

    tr.innerHTML = `
      <td title="${escHtml(doc.url)}">
        <a href="${escHtml(doc.url)}" target="_blank" rel="noopener noreferrer">${escHtml(truncate(doc.title, 50))}</a>
        ${doc.accessStatus !== 'ok' ? `<span class="${accessClass}"> [${escHtml(doc.accessStatus)}]</span>` : ''}
      </td>
      <td>${escHtml(doc.archive || '—')}</td>
      <td>${escHtml(doc.date || '—')}</td>
      <td><span class="score-badge ${scoreClass}">${score}</span></td>
      <td class="${corrClass}">${corrStatus || '—'}</td>
      <td title="${escHtml(doc.summary || '')}">${escHtml(truncate(doc.summary, 80))}</td>
      <td title="${escHtml((doc.entities || []).join(', '))}">${escHtml(truncate((doc.entities || []).join(', '), 50))}</td>
    `;
    tbody.appendChild(tr);
  }
}

// ── Citation log filtering and sorting ───────────────────────────────────────

document.getElementById('citation-search').addEventListener('input', (e) => {
  citationFilter = e.target.value.toLowerCase();
  renderCitationLog(sessionData?.documents || []);
});

document.getElementById('threshold-input').addEventListener('input', (e) => {
  const parsed = parseFloat(e.target.value);
  thresholdScore = Number.isFinite(parsed) ? parsed : 0.6;
  renderCitationLog(sessionData?.documents || []);
});

document.querySelectorAll('#panel-citations th[data-col]').forEach((th) => {
  th.addEventListener('click', () => {
    const col = th.dataset.col;
    if (currentSortCol === col) {
      currentSortAsc = !currentSortAsc;
    } else {
      currentSortCol = col;
      currentSortAsc = false;
    }
    renderCitationLog(sessionData?.documents || []);
  });
});

// ── Context brief ─────────────────────────────────────────────────────────────

function renderBrief(session, entities, documents) {
  const brief = session.brief;

  if (!brief) {
    document.getElementById('brief-narrative').textContent =
      'Context brief not yet generated. The crawl may still be in progress, or Ollama was unavailable.';
    return;
  }

  // Narrative
  const narrativeEl = document.getElementById('brief-narrative');
  narrativeEl.textContent = brief.narrative || '(No narrative generated.)';

  // Timeline
  const timelineEl = document.getElementById('brief-timeline');
  timelineEl.innerHTML = '';
  for (const entry of brief.timeline || []) {
    const div = document.createElement('div');
    div.className = 'timeline-entry';
    div.innerHTML = `
      <div class="timeline-date">${escHtml(entry.date || '?')}</div>
      <div>
        ${escHtml(entry.event || '')}
        ${(entry.sources || []).map((s) => `<a href="${escHtml(s)}" target="_blank" rel="noopener noreferrer">[source]</a>`).join(' ')}
      </div>
    `;
    timelineEl.appendChild(div);
  }

  // Cast
  const castEl = document.getElementById('brief-cast');
  castEl.innerHTML = '';
  for (const member of brief.cast || []) {
    const div = document.createElement('div');
    div.className = 'cast-entry';
    div.innerHTML = `
      <div class="cast-name">${escHtml(member.name || '')}</div>
      <div class="cast-role">${escHtml(member.role || '')} — ${escHtml(member.relationship_to_subject || '')}</div>
    `;
    castEl.appendChild(div);
  }

  // Subplots
  const subplotsEl = document.getElementById('brief-subplots');
  subplotsEl.innerHTML = '';
  for (const subplot of brief.subplots || []) {
    const li = document.createElement('li');
    li.textContent = subplot;
    subplotsEl.appendChild(li);
  }

  // Unresolved inconsistencies (from entity consistency checking)
  const inconsistentEntities = entities.filter((e) => e.consistencyFlag === 'DISCREPANCY');
  if (inconsistentEntities.length > 0) {
    const section = document.getElementById('brief-inconsistencies-section');
    section.style.display = '';
    const container = document.getElementById('brief-inconsistencies');
    container.innerHTML = '';
    for (const entity of inconsistentEntities) {
      for (const disc of entity.discrepancies || []) {
        const div = document.createElement('div');
        div.className = 'inconsistency-entry';
        div.innerHTML = `
          <strong>${escHtml(entity.canonical)}</strong> — attribute: <em>${escHtml(disc.attribute)}</em><br/>
          <strong>Source A</strong> (<a href="${escHtml(disc.source_a)}" target="_blank" rel="noopener noreferrer">${escHtml(disc.source_a)}</a>): ${escHtml(disc.value_a)}<br/>
          <strong>Source B</strong> (<a href="${escHtml(disc.source_b)}" target="_blank" rel="noopener noreferrer">${escHtml(disc.source_b)}</a>): ${escHtml(disc.value_b)}
        `;
        container.appendChild(div);
      }
    }
  }

  // Follow-up directives (clickable re-search triggers)
  const followupsEl = document.getElementById('brief-followups');
  followupsEl.innerHTML = '';
  for (const directive of brief.follow_up_directives || []) {
    const span = document.createElement('span');
    span.className = 'follow-up-btn';
    span.title = directive.reason || '';
    span.textContent = `🔎 ${directive.query}`;
    span.addEventListener('click', () => {
      // Open a new popup/search with this query pre-filled
      const url = chrome.runtime.getURL(
        `popup/popup.html?q=${encodeURIComponent(directive.query)}`
      );
      chrome.tabs.create({ url });
    });
    followupsEl.appendChild(span);
  }
}

// ── Export handlers ───────────────────────────────────────────────────────────

document.getElementById('btn-export-csv').addEventListener('click', () => {
  if (!sessionData?.documents?.length) return;
  const headers = ['Title', 'URL', 'Archive', 'Date', 'Score', 'Summary', 'Entities'];
  const rows = sessionData.documents.map((doc) => [
    csvCell(doc.title),
    csvCell(doc.url),
    csvCell(doc.archive),
    csvCell(doc.date),
    doc.relevanceScore?.toFixed(2) ?? '',
    csvCell(doc.summary),
    csvCell((doc.entities || []).join('; ')),
  ]);
  const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  downloadBlob(csv, 'archivelens-citations.csv', 'text/csv');
});

document.getElementById('btn-export-md').addEventListener('click', () => {
  if (!sessionData?.documents?.length) return;
  const { session, documents } = sessionData;
  const lines = [
    `# ArchiveLens Citation Log — ${session.title || session.subject}`,
    `Generated: ${new Date().toISOString()}`,
    '',
    '| Title | Archive | Date | Score | Summary |',
    '|-------|---------|------|-------|---------|',
    ...documents.map((doc) =>
      `| [${mdCell(doc.title)}](${doc.url}) | ${mdCell(doc.archive)} | ${mdCell(doc.date)} | ${doc.relevanceScore?.toFixed(2) ?? '—'} | ${mdCell(doc.summary)} |`
    ),
  ];
  downloadBlob(lines.join('\n'), 'archivelens-citations.md', 'text/markdown');
});

document.getElementById('btn-export-json').addEventListener('click', () => {
  if (!sessionData) return;
  const json = JSON.stringify(sessionData, null, 2);
  downloadBlob(json, 'archivelens-session.json', 'application/json');
  // Also expose for graph export
  if (window.__exportGraphJson) {
    const eg = { entities: sessionData.entities || [], relationships: [] };
    window.__exportGraphJson(eg);
  }
});

document.getElementById('btn-export-png').addEventListener('click', () => {
  if (window.__exportGraphPng) window.__exportGraphPng();
});

// ── CAPTCHA alert ─────────────────────────────────────────────────────────────

function showCaptchaAlert(domain) {
  const alertBanner = document.createElement('div');
  alertBanner.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; z-index: 9999;
    background: rgba(242,153,74,0.9); color: #fff; padding: 8px 16px;
    font-size: 13px; display: flex; align-items: center; gap: 12px;
  `;
  alertBanner.innerHTML = `
    <strong>⚠️ CAPTCHA detected on ${escHtml(domain)}</strong>
    — Please resolve it manually in the tab, then click
    <button onclick="chrome.runtime.sendMessage({action:'resumeDomain',payload:{domain:'${escHtml(domain)}'}}); this.parentElement.remove();"
            style="background:#fff; color:#333; border:none; border-radius:4px; padding:3px 8px; cursor:pointer; font-size:12px">
      Resume
    </button>
    <button onclick="this.parentElement.remove()"
            style="background:transparent; border:none; color:#fff; cursor:pointer; margin-left:auto; font-size:16px">✕</button>
  `;
  document.body.prepend(alertBanner);
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function showError(msg) {
  loadingEl.innerHTML = `<span style="color:var(--danger)">${escHtml(msg)}</span>`;
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(str, max) {
  const s = String(str || '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function csvCell(val) {
  const s = String(val || '').replace(/"/g, '""');
  return `"${s}"`;
}

function mdCell(val) {
  return String(val || '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function downloadBlob(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

// ── Boot ──────────────────────────────────────────────────────────────────────

init().catch((err) => showError(err.message));
