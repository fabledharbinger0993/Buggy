/**
 * settings.js — ArchiveLens settings panel controller
 *
 * Loads, displays, and saves user configuration:
 *  - Ollama endpoint and model
 *  - Crawl delay and confidence threshold
 *  - Contact email (included in User-Agent)
 *  - Archive source configuration (user-extensible without code changes)
 */

// ── Default archive sources ───────────────────────────────────────────────────
// Mirrored here so the settings panel can display them even before any
// service worker settings are saved.

const DEFAULT_ARCHIVE_SOURCES = [
  {
    id: 'theblackvault',
    name: 'The Black Vault',
    domain: 'www.theblackvault.com',
    searchUrl: 'https://www.theblackvault.com/documentarchive/?s={QUERY}',
    linkSelector: 'h2.entry-title a',
    contentSelector: '.entry-content',
    followExternalPdfs: true,
    enabled: true,
  },
  {
    id: 'cia_crest',
    name: 'CIA CREST Reading Room',
    domain: 'www.cia.gov',
    searchUrl: 'https://www.cia.gov/readingroom/search/site/{QUERY}',
    linkSelector: '.views-field-title a',
    contentSelector: '.field-items',
    followExternalPdfs: false,
    enabled: true,
  },
  {
    id: 'wikileaks',
    name: 'WikiLeaks',
    domain: 'wikileaks.org',
    searchUrl: 'https://wikileaks.org/search?q={QUERY}',
    linkSelector: 'div.result h3 a',
    contentSelector: 'div.wiki-content, div.document-content',
    followExternalPdfs: false,
    enabled: true,
  },
  {
    id: 'nsarchive',
    name: 'National Security Archive',
    domain: 'nsarchive.gwu.edu',
    searchUrl: 'https://nsarchive.gwu.edu/search?query={QUERY}',
    linkSelector: '.view-content .views-row h3 a',
    contentSelector: '.field-type-text-with-summary',
    followExternalPdfs: true,
    enabled: true,
  },
  {
    id: 'internetarchive',
    name: 'Internet Archive',
    domain: 'archive.org',
    searchUrl: 'https://archive.org/search?query={QUERY}',
    linkSelector: 'div.results h3 a',
    contentSelector: '#descript',
    followExternalPdfs: true,
    enabled: true,
  },
];

// ── DOM refs ─────────────────────────────────────────────────────────────────

const ollamaEndpointInput = document.getElementById('ollama-endpoint');
const ollamaModelInput = document.getElementById('ollama-model');
const requestDelayInput = document.getElementById('request-delay');
const confidenceThresholdInput = document.getElementById('confidence-threshold');
const contactEmailInput = document.getElementById('contact-email');
const archiveTbody = document.getElementById('archive-tbody');
const btnAddSource = document.getElementById('btn-add-source');
const btnSave = document.getElementById('btn-save');
const saveNotice = document.getElementById('save-notice');

let archiveSources = [];

// ── Initialise ────────────────────────────────────────────────────────────────

async function init() {
  try {
    const [settingsResp, sourcesResp] = await Promise.all([
      chrome.runtime.sendMessage({ action: 'getSettings' }),
      chrome.runtime.sendMessage({ action: 'getSources' }),
    ]);

    const settings = settingsResp?.settings || {};
    archiveSources = sourcesResp?.sources || DEFAULT_ARCHIVE_SOURCES;

    ollamaEndpointInput.value = settings.ollamaEndpoint || 'http://localhost:11434';
    ollamaModelInput.value = settings.ollamaModel || 'mistral';
    requestDelayInput.value = settings.requestDelay ?? 3;
    confidenceThresholdInput.value = settings.confidenceThreshold ?? 0.6;
    contactEmailInput.value = settings.contactEmail || '';
  } catch {
    archiveSources = DEFAULT_ARCHIVE_SOURCES;
  }

  renderArchiveTable();
}

// ── Archive sources table ─────────────────────────────────────────────────────

function renderArchiveTable() {
  archiveTbody.innerHTML = '';

  for (let i = 0; i < archiveSources.length; i++) {
    archiveTbody.appendChild(buildArchiveRow(archiveSources[i], i));
  }
}

function buildArchiveRow(source, index) {
  const tr = document.createElement('tr');
  tr.dataset.index = index;

  tr.innerHTML = `
    <td><input type="checkbox" class="src-enabled" ${source.enabled ? 'checked' : ''} /></td>
    <td><input type="text" class="src-name" value="${escHtml(source.name)}" style="min-width:120px" /></td>
    <td><input type="url" class="src-searchurl" value="${escHtml(source.searchUrl)}" style="min-width:200px" placeholder="https://example.com/search?q={QUERY}" /></td>
    <td><input type="text" class="src-linkselector" value="${escHtml(source.linkSelector)}" placeholder="a.result-link" /></td>
    <td><input type="text" class="src-contentselector" value="${escHtml(source.contentSelector)}" placeholder=".content" /></td>
    <td><button class="btn btn-sm btn-danger btn-remove-source">✕</button></td>
  `;

  tr.querySelector('.btn-remove-source').addEventListener('click', () => {
    archiveSources.splice(index, 1);
    renderArchiveTable();
  });

  return tr;
}

function collectArchiveSources() {
  const rows = archiveTbody.querySelectorAll('tr');
  const sources = [];
  rows.forEach((tr, i) => {
    const orig = archiveSources[parseInt(tr.dataset.index, 10)] || {};
    sources.push({
      id: orig.id || `custom-${i}`,
      name: tr.querySelector('.src-name').value.trim(),
      domain: orig.domain || extractDomain(tr.querySelector('.src-searchurl').value),
      searchUrl: tr.querySelector('.src-searchurl').value.trim(),
      linkSelector: tr.querySelector('.src-linkselector').value.trim(),
      contentSelector: tr.querySelector('.src-contentselector').value.trim(),
      followExternalPdfs: orig.followExternalPdfs ?? false,
      enabled: tr.querySelector('.src-enabled').checked,
    });
  });
  return sources;
}

btnAddSource.addEventListener('click', () => {
  const newSource = {
    id: `custom-${Date.now()}`,
    name: 'New Source',
    domain: '',
    searchUrl: 'https://example.com/search?q={QUERY}',
    linkSelector: 'a',
    contentSelector: 'body',
    followExternalPdfs: false,
    enabled: true,
  };
  archiveSources.push(newSource);
  renderArchiveTable();
  // Scroll to new row
  archiveTbody.lastElementChild?.scrollIntoView({ behavior: 'smooth' });
});

// ── Save ──────────────────────────────────────────────────────────────────────

btnSave.addEventListener('click', async () => {
  const sources = collectArchiveSources();

  const settings = {
    ollamaEndpoint: ollamaEndpointInput.value.trim() || 'http://localhost:11434',
    ollamaModel: ollamaModelInput.value.trim() || 'mistral',
    requestDelay: Math.max(1, Math.min(10, Number.isFinite(parseInt(requestDelayInput.value, 10)) ? parseInt(requestDelayInput.value, 10) : 3)),
    confidenceThreshold: Math.max(0, Math.min(1, Number.isFinite(parseFloat(confidenceThresholdInput.value)) ? parseFloat(confidenceThresholdInput.value) : 0.6)),
    contactEmail: contactEmailInput.value.trim(),
  };

  try {
    await Promise.all([
      chrome.runtime.sendMessage({ action: 'saveSettings', payload: { settings } }),
      chrome.runtime.sendMessage({ action: 'saveSources', payload: { sources } }),
    ]);

    saveNotice.style.display = 'inline';
    setTimeout(() => { saveNotice.style.display = 'none'; }, 3000);
  } catch (err) {
    alert(`Failed to save settings: ${err.message}`);
  }
});

// ── Utilities ─────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function extractDomain(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

init().catch(console.error);
