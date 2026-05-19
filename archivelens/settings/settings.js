// ArchiveLens — Options page logic.
// Talks to the service worker via GET_SETTINGS / SAVE_SETTINGS messages.

const FIELDS = {
  ollamaEndpoint: "string",
  ollamaModel: "string",
  confidenceThreshold: "number",
  crawlDepth: "number",
  crawlDelaySeconds: "number",
  maxRetries: "number",
  contactEmail: "string",
  chunkTokenLimit: "number",
  chunkOverlapTokens: "number",
  chunkBatchSize: "number",
  ollamaConcurrency: "number",
  useGlobalSynthesis: "boolean",
  embeddingsServiceUrl: "string",
  useSemanticClustering: "boolean",
  tracingEnabled: "boolean",
  tracingEndpoint: "string",
  tracingServiceName: "string",
};

const DEFAULTS = {
  ollamaEndpoint: "http://localhost:11434/api/generate",
  ollamaModel: "llama3",
  confidenceThreshold: 0.6,
  crawlDepth: 2,
  crawlDelaySeconds: 3,
  maxRetries: 3,
  contactEmail: "researcher@example.com",
  chunkTokenLimit: 2000,
  chunkOverlapTokens: 200,
  chunkBatchSize: 5,
  ollamaConcurrency: 1,
  useGlobalSynthesis: true,
  embeddingsServiceUrl: "",
  useSemanticClustering: false,
  tracingEnabled: true,
  tracingEndpoint: "http://localhost:4318/v1/traces",
  tracingServiceName: "archivelens-extension",
};

const form = document.getElementById("settingsForm");
const statusEl = document.getElementById("status");

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response || response.ok === false) {
        reject(new Error(response?.error || "Unknown error"));
        return;
      }
      resolve(response.result);
    });
  });
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

function populateForm(settings) {
  for (const [key, type] of Object.entries(FIELDS)) {
    const el = document.getElementById(key);
    if (!el) continue;
    const value = settings[key];
    if (type === "boolean") {
      el.checked = Boolean(value);
    } else if (value === undefined || value === null) {
      el.value = "";
    } else {
      el.value = String(value);
    }
  }
}

function readForm() {
  const out = {};
  for (const [key, type] of Object.entries(FIELDS)) {
    const el = document.getElementById(key);
    if (!el) continue;
    if (type === "boolean") {
      out[key] = el.checked;
    } else if (type === "number") {
      const raw = el.value.trim();
      out[key] = raw === "" ? undefined : Number(raw);
    } else {
      out[key] = el.value.trim();
    }
  }
  return out;
}

async function load() {
  try {
    const settings = await sendMessage({ type: "GET_SETTINGS" });
    populateForm({ ...DEFAULTS, ...settings });
    setStatus("Loaded current settings.");
  } catch (err) {
    populateForm(DEFAULTS);
    setStatus(`Could not load settings: ${err.message}. Showing defaults.`, true);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = readForm();
  setStatus("Saving…");
  try {
    const saved = await sendMessage({ type: "SAVE_SETTINGS", payload });
    populateForm({ ...DEFAULTS, ...saved });
    setStatus("Saved.");
  } catch (err) {
    setStatus(`Save failed: ${err.message}`, true);
  }
});

document.getElementById("resetBtn").addEventListener("click", async () => {
  populateForm(DEFAULTS);
  setStatus("Defaults loaded — click Save to apply.");
});

load();
