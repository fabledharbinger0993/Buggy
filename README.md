# ArchiveLens

**ArchiveLens** is a Chrome/Firefox browser extension that acts as an intelligent archival research assistant. It crawls publicly accessible declassified document repositories, performs entity extraction and relational mapping via a locally running [Ollama](https://ollama.com) model, and synthesises findings into structured research outputs — all without sending your data to external servers (except outbound HTTP to target archival sites).

---

## Table of Contents

1. [Features](#features)
2. [Installation](#installation)
3. [Ollama Setup](#ollama-setup)
4. [Extension Permissions Rationale](#extension-permissions-rationale)
5. [Supported Archives](#supported-archives)
6. [Adding Custom Archival Sources](#adding-custom-archival-sources)
7. [User-Agent Contact Field](#user-agent-contact-field)
8. [Robots.txt Compliance](#robotstxt-compliance)
9. [Session Export Formats](#session-export-formats)
10. [Confidence Score Disclaimer](#confidence-score-disclaimer)
11. [File Structure](#file-structure)

---

## Features

- **Search Engine Bar Integration** — Type a subject (name, operation, event) to query multiple configurable archives simultaneously with optional context cues.
- **Active Page Deep Crawl** — Crawl the current page and all linked documents up to a configurable depth (default: 2 levels).
- **Entity & Relationship Extraction** — All document text is chunked and sent to a local Ollama model for named entity extraction and relationship mapping.
- **Vein Diagram** — Interactive D3.js force-directed graph of entities and relationships, with corroboration status visualised on edges.
- **Citation Log** — Sortable, filterable table of every relevant source document, exportable to CSV and Markdown.
- **Subject Context Brief** — AI-generated narrative synthesis with timeline, cast of characters, secondary threads, and one-click follow-up search directives.
- **Fact-Checking Pipeline** — Cross-document corroboration scoring and entity consistency checking across sources.
- **Cross-Archive Entity Resolution** — Deterministic + probabilistic deduplication of the same real-world entity appearing under different names.
- **Session Management** — Save, restore, rename, archive, and export research sessions with full state restoration.
- **Ethical Crawl Compliance** — robots.txt respect, configurable rate limiting with government-domain floors, honest User-Agent, no Referer leakage, CAPTCHA detection with manual intervention.

---

## Installation

### Prerequisites

- Google Chrome 114+ or Firefox 115+ (Manifest V3 support required)
- [Ollama](https://ollama.com) running locally on `http://localhost:11434`
- A supported Ollama model pulled (see [Ollama Setup](#ollama-setup))

### Steps

1. **Download D3.js v7** — The graph renderer requires D3.js v7. Download the minified build:
   ```
   https://github.com/d3/d3/releases/latest
   ```
   Save the file as `archivelens/lib/d3.min.js` (replace the placeholder).

2. **Load the extension in Chrome:**
   - Navigate to `chrome://extensions/`
   - Enable **Developer mode** (top-right toggle)
   - Click **Load unpacked**
   - Select the `archivelens/` directory

3. **Load the extension in Firefox:**
   - Navigate to `about:debugging#/runtime/this-firefox`
   - Click **Load Temporary Add-on**
   - Select `archivelens/manifest.json`

4. **Open Settings** — Click the ArchiveLens icon → ⚙️ Settings. Configure your Ollama endpoint, model name, and **contact email** (see [User-Agent Contact Field](#user-agent-contact-field)).

---

## Ollama Setup

ArchiveLens sends all document text to a locally running Ollama instance. No text is sent to external AI services.

### Install Ollama

```bash
# macOS / Linux
curl -fsSL https://ollama.com/install.sh | sh

# Windows: download the installer from https://ollama.com/download
```

### Pull a recommended model

```bash
# Recommended for entity extraction and brief generation
ollama pull mistral

# Alternative (larger, potentially more accurate)
ollama pull llama3
```

### Start Ollama

```bash
ollama serve
```

Ollama listens on `http://localhost:11434` by default. Confirm by visiting that URL in your browser; you should see `Ollama is running`.

### Configure in ArchiveLens

In Settings:
- **Ollama endpoint URL**: `http://localhost:11434`
- **Model name**: `mistral` (or whichever model you pulled)

---

## Extension Permissions Rationale

| Permission | Reason |
|---|---|
| `storage` | Saving user settings |
| `tabs` | Reading the current tab's URL for deep crawl |
| `activeTab` | Triggering content script on the current page |
| `scripting` | Injecting the content script |
| `alarms` | Scheduling autosave during active crawls |
| `notifications` | Alerting the user to CAPTCHA detections |
| `host_permissions: <all_urls>` | Fetching documents from any configured archive domain; required for CORS-free direct fetch from the background service worker |
| `host_permissions: localhost:11434` | Communicating with the local Ollama instance |

**Privacy note:** The extension makes outbound HTTP requests only to:
- The archival sites you configure and search
- `http://localhost:11434` (your local Ollama instance)

No data is transmitted to the extension developer or any third party.

---

## Supported Archives

| Archive | Default search URL |
|---|---|
| The Black Vault | `https://www.theblackvault.com/documentarchive/?s={QUERY}` |
| CIA CREST Reading Room | `https://www.cia.gov/readingroom/search/site/{QUERY}` |
| WikiLeaks | `https://wikileaks.org/search?q={QUERY}` |
| National Security Archive | `https://nsarchive.gwu.edu/search?query={QUERY}` |
| Internet Archive | `https://archive.org/search?query={QUERY}` |

---

## Adding Custom Archival Sources

You can add new sources via **Settings → Archive Sources → + Add source** without modifying extension source code. Each source requires:

| Field | Description |
|---|---|
| **Name** | Human-readable label shown in the popup |
| **Search URL** | URL template with `{QUERY}` as the placeholder |
| **Link selector** | CSS selector matching `<a>` elements linking to individual documents on the search results page |
| **Content selector** | CSS selector matching the main text body on a document page |

Example for a custom archive:
```
Name:             My Archive
Search URL:       https://myarchive.org/search?q={QUERY}
Link selector:    .search-result h3 a
Content selector: .document-body
```

---

## User-Agent Contact Field

Every HTTP request made by ArchiveLens includes a `User-Agent` header that honestly identifies it as a research tool:

```
ArchiveLens/1.0 (Research Extension; respectful crawl; contact: you@example.com)
```

**You must enter a real, working contact email in Settings.** This allows site administrators of archival repositories (including government sites) to contact you if your crawl generates unexpected traffic. This is an ethical requirement for responsible research crawling.

Without a configured contact email, the User-Agent will include `contact: not-configured` — this still identifies the extension as a research tool, but lacks a contact path for site administrators.

---

## Robots.txt Compliance

Before crawling any domain for the first time in a session, ArchiveLens fetches and parses that domain's `robots.txt`. The results are cached for the duration of the session.

- Any path explicitly `Disallow`ed for `*` (all user agents) or for `archivelens` is skipped.
- If `robots.txt` is unreachable (404, network error), the extension fails **open** (allows the crawl) but logs the missing file.

**Rate limiting floors:**

| Domain type | Default delay | Minimum floor |
|---|---|---|
| Standard domains | 3 seconds (configurable 1–10 s) | 1 second |
| `.gov` and `.mil` domains | 6 seconds | **6 seconds (cannot be lowered)** |

**CAPTCHA handling:** If a CAPTCHA challenge is detected in a response body, ArchiveLens **immediately halts all further requests to that domain** and surfaces a notification asking you to resolve the CAPTCHA manually in your browser. The extension will never attempt to automate around or bypass a CAPTCHA. Click **Resume** in the notification after resolving the CAPTCHA manually.

---

## Session Export Formats

### JSON Export

A full session export containing all documents, entities, claims, and verification metadata. Can be imported into tools like Gephi (via the graph JSON) or used as a backup.

File: `archivelens-session-<id>.json`

### Graph JSON Export

The entity graph in a format compatible with Gephi and Obsidian Graph View.

File: `archivelens-graph.json`

### Graph PNG Export

A rasterised snapshot of the current Vein Diagram graph state.

File: `archivelens-graph.png`

### CSV Export

The Citation Log as a CSV file for spreadsheet analysis.

File: `archivelens-citations.csv`

Columns: Title, URL, Archive, Date, Relevance Score, Summary, Entities

### Markdown Export

The Citation Log as a formatted Markdown table, suitable for inclusion in research notes.

File: `archivelens-citations.md`

### Obsidian Vault Export

Exports the session as a folder of interlinked Markdown files:
- `entities/<entity-name>.md` — one file per canonical entity with `[[wikilink]]` cross-references to related entities and source documents
- `documents/<doc-title>.md` — one file per source document with `[[Entity Name]]` links
- `index.md` — session index with links to all entities and documents

To import into Obsidian: place the exported folder in your Obsidian vault directory and open it. All `[[wikilinks]]` will resolve automatically in Obsidian's graph view.

---

## Confidence Score Disclaimer

Relevance scores and relationship confidence values displayed throughout ArchiveLens are **model-estimated self-assessments** produced by the local Ollama model (a 0–1 float in the model's JSON output). They are **not** statistically calibrated probabilities.

The extension labels all such scores as "model-estimated relevance, not statistically calibrated" wherever they appear. Treat them as directional signals, not ground truth. Always verify claims against the source documents linked in the Citation Log.

---

## File Structure

```
archivelens/
├── manifest.json                  Manifest V3
├── background/
│   ├── service-worker.js          Crawl orchestration, Ollama calls, IndexedDB writes
│   ├── factcheck.js               Findings verification and fact-checking pipeline
│   ├── entityresolver.js          Cross-archive entity resolution
│   └── crawlpolicy.js             Ethical crawl compliance (robots.txt, rate limiting, User-Agent)
├── content/
│   └── content-script.js         DOM extraction on active archival pages
├── popup/
│   ├── popup.html                 Extension popup UI
│   ├── popup.js                   Popup controller
│   └── popup.css                  Popup styles
├── panel/
│   ├── results.html               Full results panel (opens as new tab)
│   ├── results.js                 Results panel controller
│   ├── graph.js                   D3.js force-directed graph rendering
│   ├── sessions.html              Research sessions panel
│   └── sessions.js                Sessions panel controller
├── lib/
│   ├── d3.min.js                  D3.js v7 (replace placeholder with actual build)
│   └── db.js                      IndexedDB schema and access module
├── settings/
│   ├── settings.html              Settings panel
│   └── settings.js                Settings controller
└── icons/
    ├── icon16.png                 (add your own icons)
    ├── icon48.png
    └── icon128.png
```

---

## Licence

MIT. See [LICENSE](LICENSE) for details.
