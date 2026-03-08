const statusEl = document.getElementById("status");
const sourcesEl = document.getElementById("sources");

init().catch((err) => {
  statusEl.textContent = `Failed to initialize: ${err.message}`;
});

async function init() {
  const settingsResp = await send({ type: "GET_SETTINGS" });
  const sourceResp = await send({ type: "GET_SOURCES" });

  const settings = settingsResp.result;
  const sources = sourceResp.result;

  document.getElementById("depth").value = settings.crawlDepth || 2;

  for (const source of Object.values(sources)) {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = source.id;
    checkbox.checked = source.enabledByDefault;

    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(source.name));
    sourcesEl.appendChild(label);
  }

  document.getElementById("startSearch").addEventListener("click", onStartSearch);
  document.getElementById("startDeepCrawl").addEventListener("click", onDeepCrawl);
  document.getElementById("openResults").addEventListener("click", openLatestResults);
  document.getElementById("openSessions").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("panel/sessions.html") });
  });
  document.getElementById("openSettings").addEventListener("click", () => chrome.runtime.openOptionsPage());
}

async function onStartSearch() {
  const payload = collectPayload();
  if (!payload.subject) {
    statusEl.textContent = "Primary subject is required.";
    return;
  }

  statusEl.textContent = "Starting archive search...";
  const res = await send({ type: "START_SEARCH", payload });
  statusEl.textContent = `Job started: ${res.result.jobId}`;

  chrome.tabs.create({
    url: chrome.runtime.getURL(`panel/results.html?session=${res.result.sessionId}`)
  });
}

async function onDeepCrawl() {
  const payload = collectPayload();
  statusEl.textContent = "Starting deep crawl...";
  const res = await send({ type: "START_DEEP_CRAWL", payload });
  statusEl.textContent = `Deep crawl started: ${res.result.jobId}`;

  chrome.tabs.create({
    url: chrome.runtime.getURL(`panel/results.html?session=${res.result.sessionId}`)
  });
}

async function openLatestResults() {
  const sessionsRes = await send({ type: "LIST_SESSIONS", query: "" });
  const sessions = sessionsRes.result || [];
  if (!sessions.length) {
    statusEl.textContent = "No sessions available yet.";
    return;
  }

  chrome.tabs.create({
    url: chrome.runtime.getURL(`panel/results.html?session=${sessions[0].id}`)
  });
}

function collectPayload() {
  const subject = document.getElementById("subject").value.trim();
  const contextCue = document.getElementById("contextCue").value.trim();
  const depth = Number(document.getElementById("depth").value || 2);
  const sources = Array.from(sourcesEl.querySelectorAll("input[type='checkbox']"))
    .filter((input) => input.checked)
    .map((input) => input.value);

  return { subject, contextCue, depth, sources };
}

function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Unknown runtime error"));
        return;
      }
      resolve(response);
    });
  });
}
