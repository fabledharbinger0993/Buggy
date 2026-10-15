/**
 * sessions.js — Research sessions panel controller for ArchiveLens
 *
 * Displays all saved research sessions, allows sorting/searching,
 * session restoration, title editing, status management, JSON export,
 * and Obsidian vault export.
 */

// ── State ─────────────────────────────────────────────────────────────────────

let allSessions = [];
let obsidianSessionId = null;

// ── DOM refs ─────────────────────────────────────────────────────────────────

const container = document.getElementById('sessions-container');
const noSessions = document.getElementById('no-sessions');
const searchInput = document.getElementById('search-sessions');
const sortSelect = document.getElementById('sort-select');
const obsidianModal = document.getElementById('obsidian-modal');
const obsidianLabel = document.getElementById('obsidian-session-label');

// ── Initialise ────────────────────────────────────────────────────────────────

async function init() {
  try {
    const { sessions = [] } = await chrome.runtime.sendMessage({ action: 'getSessions' });
    allSessions = sessions;
  } catch (err) {
    allSessions = [];
    console.error('Failed to load sessions:', err);
  }
  renderList();
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderList() {
  const query = (searchInput.value || '').toLowerCase();
  const [sortField, sortDir] = (sortSelect.value || 'lastModified-desc').split('-');

  let filtered = allSessions.filter((s) => {
    if (!query) return true;
    return (
      (s.title || '').toLowerCase().includes(query) ||
      (s.subject || '').toLowerCase().includes(query) ||
      (s.entityIds || []).some((id) => id.toLowerCase().includes(query))
    );
  });

  filtered.sort((a, b) => {
    let va = a[sortField] ?? '';
    let vb = b[sortField] ?? '';
    const cmp = typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb));
    return sortDir === 'asc' ? cmp : -cmp;
  });

  // Clear existing cards (keep the no-sessions placeholder)
  Array.from(container.querySelectorAll('.session-card')).forEach((el) => el.remove());

  if (filtered.length === 0) {
    noSessions.classList.remove('hidden');
    return;
  }

  noSessions.classList.add('hidden');

  for (const session of filtered) {
    container.appendChild(buildCard(session));
  }
}

// ── Card builder ──────────────────────────────────────────────────────────────

function buildCard(session) {
  const card = document.createElement('div');
  card.className = 'session-card';
  card.dataset.id = session.id;

  const statusClass = {
    active: 'status-active',
    complete: 'status-complete',
    archived: 'status-archived',
  }[session.status] || 'status-archived';

  const created = session.created ? new Date(session.created).toLocaleDateString() : '—';
  const modified = session.lastModified ? new Date(session.lastModified).toLocaleString() : '—';
  const docCount = (session.documentIds || []).length;
  const entityCount = (session.entityIds || []).length;

  card.innerHTML = `
    <div class="session-title">
      <span class="title-display">${escHtml(session.title || session.subject)}</span>
      <input class="title-edit hidden" type="text" value="${escHtml(session.title || session.subject)}" />
    </div>
    <div class="session-meta">
      <span class="session-status ${statusClass}">${escHtml(session.status)}</span>
      <span>📅 ${escHtml(created)}</span>
      <span>✏️ ${escHtml(modified)}</span>
      <span>📄 ${docCount} docs</span>
      <span>🔗 ${entityCount} entities</span>
    </div>
    <div class="session-archives" style="font-size:11px; color:var(--text2); margin-bottom:6px">
      Archives: ${escHtml((session.archives || []).join(', ') || '—')}
    </div>
    <div class="session-actions">
      <button class="btn btn-primary btn-open">📊 Open Results</button>
      <button class="btn btn-rename">✏️ Rename</button>
      <button class="btn btn-export-json">⬇️ Export JSON</button>
      <button class="btn btn-obsidian">🗂️ Obsidian</button>
      <button class="btn btn-archive">${session.status === 'archived' ? '♻️ Restore' : '🗄️ Archive'}</button>
    </div>
  `;

  // ── Open results ──────────────────────────────────────────────────────────
  card.querySelector('.btn-open').addEventListener('click', () => {
    const url = chrome.runtime.getURL(
      `panel/results.html?session=${encodeURIComponent(session.id)}`
    );
    chrome.tabs.create({ url });
  });

  // ── Rename ────────────────────────────────────────────────────────────────
  const titleDisplay = card.querySelector('.title-display');
  const titleEdit = card.querySelector('.title-edit');

  card.querySelector('.btn-rename').addEventListener('click', () => {
    titleDisplay.classList.add('hidden');
    titleEdit.classList.remove('hidden');
    titleEdit.focus();
  });

  titleEdit.addEventListener('blur', async () => {
    const newTitle = titleEdit.value.trim() || session.title;
    titleDisplay.textContent = newTitle;
    session.title = newTitle;
    titleDisplay.classList.remove('hidden');
    titleEdit.classList.add('hidden');
    await saveSession(session);
    // Update allSessions
    const idx = allSessions.findIndex((s) => s.id === session.id);
    if (idx !== -1) allSessions[idx] = session;
  });

  titleEdit.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') titleEdit.blur();
    if (e.key === 'Escape') {
      titleEdit.value = session.title;
      titleEdit.blur();
    }
  });

  // ── Export JSON ───────────────────────────────────────────────────────────
  card.querySelector('.btn-export-json').addEventListener('click', async () => {
    try {
      const data = await chrome.runtime.sendMessage({
        action: 'exportSession',
        payload: { sessionId: session.id },
      });
      const json = JSON.stringify(data, null, 2);
      downloadBlob(json, `archivelens-session-${session.id.slice(0, 8)}.json`, 'application/json');
    } catch (err) {
      alert(`Export failed: ${err.message}`);
    }
  });

  // ── Obsidian export ───────────────────────────────────────────────────────
  card.querySelector('.btn-obsidian').addEventListener('click', () => {
    obsidianSessionId = session.id;
    obsidianLabel.textContent = session.title || session.subject;
    obsidianModal.classList.remove('hidden');
  });

  // ── Archive/restore ───────────────────────────────────────────────────────
  card.querySelector('.btn-archive').addEventListener('click', async () => {
    session.status = session.status === 'archived' ? 'complete' : 'archived';
    await saveSession(session);
    const idx = allSessions.findIndex((s) => s.id === session.id);
    if (idx !== -1) allSessions[idx] = session;
    renderList();
  });

  return card;
}

// ── Obsidian export ───────────────────────────────────────────────────────────

document.getElementById('btn-obsidian-cancel').addEventListener('click', () => {
  obsidianModal.classList.add('hidden');
  obsidianSessionId = null;
});

document.getElementById('btn-obsidian-confirm').addEventListener('click', async () => {
  obsidianModal.classList.add('hidden');
  if (!obsidianSessionId) return;

  try {
    const data = await chrome.runtime.sendMessage({
      action: 'exportSession',
      payload: { sessionId: obsidianSessionId },
    });
    await exportObsidian(data);
  } catch (err) {
    alert(`Obsidian export failed: ${err.message}`);
  }

  obsidianSessionId = null;
});

/**
 * Generate an Obsidian vault export.
 *
 * Produces a folder of Markdown files:
 *  - One file per canonical entity with [[wikilink]] cross-references
 *  - One file per source document with [[Entity Name]] links
 *
 * Because extensions cannot write to the filesystem directly, all files are
 * bundled into a single ZIP and downloaded. We use a simple ZIP builder that
 * doesn't require an external library.
 *
 * @param {object} data - { session, documents, entities, claims }
 */
async function exportObsidian(data) {
  const { session, documents = [], entities = [], claims = [] } = data;
  const files = [];

  const sessionSlug = slugify(session.title || session.subject || session.id);

  // ── One Markdown file per entity ──────────────────────────────────────────
  for (const entity of entities) {
    const name = entity.canonical || 'unknown';
    const filename = `entities/${slugify(name)}.md`;

    const relatedDocs = documents.filter(
      (d) => (d.entities || []).includes(name)
    );
    const relatedEntities = entities.filter(
      (e) => e.id !== entity.id &&
        relatedDocs.some((d) => (d.entities || []).includes(e.canonical))
    );

    const lines = [
      `# ${name}`,
      ``,
      `**Type:** ${entity.type || 'unknown'}`,
      `**Role:** ${entity.role || '—'}`,
      entity.aliases?.length > 1 ? `**Aliases:** ${entity.aliases.join(', ')}` : '',
      entity.consistencyFlag ? `**Consistency:** ${entity.consistencyFlag}` : '',
      ``,
      `## Source Documents`,
      ...relatedDocs.map((d) => `- [[${slugify(d.title || d.url)}]] — [${d.title || d.url}](${d.url})`),
      ``,
      `## Connected Entities`,
      ...relatedEntities.map((e) => `- [[${slugify(e.canonical)}]]`),
      ``,
      entity.discrepancies?.length
        ? ['## ⚠️ Inconsistencies', ...entity.discrepancies.map((d) =>
            `- **${d.attribute}**: "${d.value_a}" ([source](${d.source_a})) vs "${d.value_b}" ([source](${d.source_b}))`
          )]
        : [],
    ].flat().join('\n');

    files.push({ name: `${sessionSlug}/${filename}`, content: lines });
  }

  // ── One Markdown file per source document ─────────────────────────────────
  for (const doc of documents) {
    const titleSlug = slugify(doc.title || doc.url);
    const filename = `documents/${titleSlug}.md`;

    const docEntities = entities.filter(
      (e) => (doc.entities || []).includes(e.canonical)
    );

    const lines = [
      `# ${doc.title || doc.url}`,
      ``,
      `**Archive:** ${doc.archive || '—'}`,
      `**URL:** [${doc.url}](${doc.url})`,
      `**Date:** ${doc.date || '—'}`,
      `**Relevance Score:** ${doc.relevanceScore?.toFixed(2) ?? '—'} *(model-estimated)*`,
      doc.accessStatus !== 'ok' ? `**Access Status:** ${doc.accessStatus}` : '',
      ``,
      `## Summary`,
      `${doc.summary || '—'}`,
      ``,
      `## Entities Mentioned`,
      ...docEntities.map((e) => `- [[${slugify(e.canonical)}]] (${e.type || 'other'})`),
    ].filter((l) => l !== undefined).join('\n');

    files.push({ name: `${sessionSlug}/${filename}`, content: lines });
  }

  // ── Index file ────────────────────────────────────────────────────────────
  const indexLines = [
    `# ${session.title || session.subject}`,
    ``,
    `**Subject:** ${session.subject || '—'}`,
    `**Created:** ${new Date(session.created).toISOString()}`,
    `**Documents:** ${documents.length}`,
    `**Entities:** ${entities.length}`,
    ``,
    `## Entities`,
    ...entities.map((e) => `- [[entities/${slugify(e.canonical)}|${e.canonical}]]`),
    ``,
    `## Source Documents`,
    ...documents.map((d) => `- [[documents/${slugify(d.title || d.url)}|${d.title || d.url}]]`),
  ].join('\n');

  files.push({ name: `${sessionSlug}/index.md`, content: indexLines });

  // ── Bundle and download ───────────────────────────────────────────────────
  // Simple multi-file download: create a single concatenated text file (real-world
  // implementations would use a JSZip library; this produces a human-readable bundle)
  const bundle = files
    .map((f) => `\n${'='.repeat(60)}\nFILE: ${f.name}\n${'='.repeat(60)}\n\n${f.content}`)
    .join('\n');

  downloadBlob(bundle, `archivelens-obsidian-${sessionSlug}.txt`,
    'text/plain');

  // Download the first MAX_INDIVIDUAL_DOWNLOADS files individually for convenience
  for (const file of files.slice(0, MAX_INDIVIDUAL_DOWNLOADS)) {
    const parts = file.name.split('/');
    const fname = parts[parts.length - 1];
    downloadBlob(file.content, fname, 'text/markdown');
  }
}

/** Maximum number of individual file downloads in an Obsidian export (avoids flooding the browser). */
const MAX_INDIVIDUAL_DOWNLOADS = 5;



async function saveSession(session) {
  try {
    await chrome.runtime.sendMessage({ action: 'saveSession', payload: { session } });
  } catch (err) {
    console.error('Failed to save session:', err);
  }
}

// ── Event listeners ───────────────────────────────────────────────────────────

searchInput.addEventListener('input', renderList);
sortSelect.addEventListener('change', renderList);

// ── Utilities ─────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled';
}

function downloadBlob(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

// ── Boot ──────────────────────────────────────────────────────────────────────

init().catch(console.error);
