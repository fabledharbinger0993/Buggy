/**
 * popup.js — ArchiveLens extension popup controller
 *
 * Handles user interactions in the popup: tab switching, form submission,
 * archive selection, status updates, and session management shortcuts.
 */

// ── DOM refs ─────────────────────────────────────────────────────────────────

const tabs = document.querySelectorAll('.al-tab');
const panels = document.querySelectorAll('.al-panel');

const searchQuery = document.getElementById('search-query');
const contextCues = document.getElementById('context-cues');
const archiveList = document.getElementById('archive-list');
const crawlDepth = document.getElementById('crawl-depth');
const btnSearch = document.getElementById('btn-search');

const activeUrlEl = document.getElementById('active-url');
const deepCrawlDepth = document.getElementById('deep-crawl-depth');
const btnDeepCrawl = document.getElementById('btn-deep-crawl');

const statusEl = document.getElementById('al-status');
const statusText = document.getElementById('al-status-text');
const progressFill = document.getElementById('al-progress-fill');

const captchaWarning = document.getElementById('al-captcha-warning');
const captchaDomain = document.getElementById('captcha-domain');
const btnResumeCaptcha = document.getElementById('btn-resume-captcha');

const btnOpenResults = document.getElementById('btn-open-results');
const btnSessions = document.getElementById('btn-sessions');
const btnSettings = document.getElementById('btn-settings');

let currentSessionId = null;
let currentCaptchaDomain = null;

// ── Initialise ────────────────────────────────────────────────────────────────

async function init() {
  // Load archive sources for the checkbox list
  await loadArchiveSources();

  // Show the current active tab URL in deep-crawl mode
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) {
      activeUrlEl.textContent = tab.url;
    }
  } catch {
    activeUrlEl.textContent = 'Unable to read current URL';
  }
}

// ── Tab switching ─────────────────────────────────────────────────────────────

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    tabs.forEach((t) => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
    panels.forEach((p) => p.classList.remove('active'));

    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');

    const mode = tab.dataset.mode;
    const panel = document.getElementById(`panel-${mode}`);
    if (panel) panel.classList.add('active');
  });
});

// ── Archive source loading ────────────────────────────────────────────────────

async function loadArchiveSources() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getSources' });
    const sources = response.sources || [];

    archiveList.innerHTML = '';
    sources.forEach((source) => {
      const item = document.createElement('div');
      item.className = 'al-archive-item';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = `archive-${source.id}`;
      checkbox.value = source.id;
      checkbox.checked = source.enabled;

      const label = document.createElement('label');
      label.htmlFor = `archive-${source.id}`;
      label.textContent = source.name;

      item.appendChild(checkbox);
      item.appendChild(label);
      archiveList.appendChild(item);
    });
  } catch (err) {
    archiveList.innerHTML = `<span class="al-loading-text">Failed to load archives: ${err.message}</span>`;
  }
}

function getSelectedArchiveIds() {
  return Array.from(archiveList.querySelectorAll('input[type="checkbox"]:checked'))
    .map((cb) => cb.value);
}

// ── Search ────────────────────────────────────────────────────────────────────

btnSearch.addEventListener('click', async () => {
  const subject = searchQuery.value.trim();
  if (!subject) {
    searchQuery.focus();
    return;
  }

  const archiveIds = getSelectedArchiveIds();
  if (archiveIds.length === 0) {
    showStatus('Please select at least one archive.');
    return;
  }

  const depth = Number.isFinite(parseInt(crawlDepth.value, 10)) ? Math.max(1, parseInt(crawlDepth.value, 10)) : 2;

  setSearching(true);
  showStatus('Starting search…', true);

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'startSearch',
      payload: {
        subject,
        contextCues: contextCues.value.trim(),
        archiveIds,
        maxDepth: depth,
      },
    });

    if (response.error) {
      showStatus(`Error: ${response.error}`);
      setSearching(false);
      return;
    }

    currentSessionId = response.sessionId;
    showStatus('Crawling and extracting… this may take a few minutes.', true);
    btnOpenResults.classList.remove('hidden');
  } catch (err) {
    showStatus(`Error: ${err.message}`);
    setSearching(false);
  }
});

// ── Deep Crawl ────────────────────────────────────────────────────────────────

btnDeepCrawl.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) {
    showStatus('Cannot determine current page URL.');
    return;
  }

  const depth = Number.isFinite(parseInt(deepCrawlDepth.value, 10)) ? Math.max(1, parseInt(deepCrawlDepth.value, 10)) : 2;
  setSearching(true);
  showStatus('Starting deep crawl…', true);

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'deepCrawl',
      payload: { url: tab.url, maxDepth: depth },
    });

    if (response.error) {
      showStatus(`Error: ${response.error}`);
      setSearching(false);
      return;
    }

    currentSessionId = response.sessionId;
    showStatus('Deep crawling… this may take several minutes.', true);
    btnOpenResults.classList.remove('hidden');
  } catch (err) {
    showStatus(`Error: ${err.message}`);
    setSearching(false);
  }
});

// ── Results panel ─────────────────────────────────────────────────────────────

btnOpenResults.addEventListener('click', () => {
  if (!currentSessionId) return;
  const url = chrome.runtime.getURL(
    `panel/results.html?session=${encodeURIComponent(currentSessionId)}`
  );
  chrome.tabs.create({ url });
});

// ── Sessions panel ────────────────────────────────────────────────────────────

btnSessions.addEventListener('click', () => {
  const url = chrome.runtime.getURL('panel/sessions.html');
  chrome.tabs.create({ url });
});

// ── Settings ──────────────────────────────────────────────────────────────────

btnSettings.addEventListener('click', () => {
  const url = chrome.runtime.getURL('settings/settings.html');
  chrome.tabs.create({ url });
});

// ── CAPTCHA handling ──────────────────────────────────────────────────────────

btnResumeCaptcha.addEventListener('click', async () => {
  if (!currentCaptchaDomain) return;
  await chrome.runtime.sendMessage({ action: 'resumeDomain', payload: { domain: currentCaptchaDomain } });
  captchaWarning.classList.add('hidden');
  currentCaptchaDomain = null;
  showStatus('Resumed crawl. Retrying…', true);
});

// Listen for background messages
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'crawlComplete') {
    setSearching(false);
    showStatus(`✅ Crawl complete — ${message.payload?.summary?.docCount || 0} documents found.`);
  } else if (message.action === 'captchaDetected') {
    currentCaptchaDomain = message.payload.domain;
    captchaDomain.textContent = message.payload.domain;
    captchaWarning.classList.remove('hidden');
    showStatus('⚠️ CAPTCHA detected — crawl paused.');
  }
});

// ── UI helpers ────────────────────────────────────────────────────────────────

function setSearching(active) {
  btnSearch.disabled = active;
  btnDeepCrawl.disabled = active;
  progressFill.style.width = active ? '60%' : '100%';
}

function showStatus(text, indeterminate = false) {
  statusEl.classList.remove('hidden');
  statusText.textContent = text;
  progressFill.style.width = indeterminate ? '60%' : '100%';
}

// ── Boot ──────────────────────────────────────────────────────────────────────

init().catch(console.error);
