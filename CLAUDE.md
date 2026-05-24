# FungAI P.I. — Design System & Project Guide

## Project overview

FungAI P.I. is an adaptive investigative intelligence system. It maps hidden networks through
multi-phase AI analysis: spore casting (mapping), mycelium spread (deep research), and fruiting
body (synthesis). The name comes from the mycelium metaphor — a hidden, distributed network
connecting all nodes of information.

## Monorepo structure

```
packages/
  web/      Vite + React frontend (port 3000)
  service/  Node.js Express backend (port 5050)
CLAUDE.md
package.json  (workspace root)
```

## Running the project

```bash
# Install all dependencies (run from repo root)
npm install

# Start both web and service in dev mode
npm run dev

# Service only (requires ANTHROPIC_API_KEY)
ANTHROPIC_API_KEY=sk-ant-... npm run start:service

# Web only
npm run dev -w packages/web
```

### Required environment variables

| Variable           | Required | Default              | Purpose                          |
| ------------------ | -------- | -------------------- | -------------------------------- |
| ANTHROPIC_API_KEY  | Yes      | —                    | Claude API access for service    |
| BUGGY_PORT         | No       | 5050                 | Service listen port              |
| BUGGY_DATA_DIR     | No       | ~/.buggy-service     | SQLite database directory        |
| BUGGY_MODEL        | No       | claude-haiku-4-5-20251001 | Extraction model            |
| BUGGY_SYNTH_MODEL  | No       | claude-sonnet-4-6    | Synthesis model                  |

## Color palette

The FungAI P.I. palette is dark, organic, and bioluminescent. Map every color reference to
these exact hex values.

| Token      | Hex       | Usage                                      |
| ---------- | --------- | ------------------------------------------ |
| --bg-deep  | `#08080f` | Root background, deepest layer             |
| --bg-main  | `#0f0f1a` | Page background                            |
| --bg-card  | `#161624` | Card surfaces                              |
| --bg-panel | `#1e1e2a` | Panel / settings surfaces                  |
| --gold     | `#c9a84c` | Gold accent, timeline dates                |
| --violet   | `#9b72d8` | Active phase, primary accent               |
| --amber    | `#e8a23a` | Complete phase, highlights, pulse nodes    |
| --purple   | `#6b3fa0` | Eyebrow text, mycelium node color          |
| --cream    | `#e8e4d8` | Primary body text, wordmark               |
| --warm     | `#585450` | Subheads, muted text, warm grey            |
| --dim      | `#8884a0` | Disabled labels, secondary text            |
| --border   | `#2a2a3a` | Borders, dividers                          |
| --red      | `#d45a5a` | Errors, inconsistency flags                |

## Typography

Two fonts. Load both from Google Fonts.

```html
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Space+Mono:ital,wght@0,400;0,700;1,400&display=swap" />
```

| Font        | Usage                                                  |
| ----------- | ------------------------------------------------------ |
| Orbitron    | Wordmarks, phase labels, section headers, tags         |
| Space Mono  | Body text, inputs, status lines, subheadings, eyebrow  |

## Phase names

The three investigation phases map directly to the mycelium metaphor:

| Code phase     | Display label      | Description                              |
| -------------- | ------------------ | ---------------------------------------- |
| `mapping`      | `01 SPORE CAST`    | Map the investigation space              |
| `researching`  | `02 MYCELIUM SPREAD` | Deep archive research                  |
| `synthesizing` | `03 FRUITING BODY` | Synthesize findings into a brief         |

## Brand identity & copy

- **System name:** `FUNGA.I.` (replaces CARTOGRAPHER in all system prompts and UI copy)
- **Full product name:** `FUNGA.I. P.I.`
- **Wordmark:** `FUNGA.I. P.I.` — Orbitron, all-caps, 32px, `#e8e4d8`, letter-spacing 0.15em
- **Eyebrow:** `Adaptive Investigative Intelligence` — Space Mono, 9px, `#6b3fa0`, letter-spacing 0.3em
- **Subhead:** `Mycelium maps the hidden network. So do we.` — Space Mono italic, 12px, `#585450`
- **Investigate button:** `◉ Inoculate`
- **Reset button:** `↺ Clear Substrate`

## MyceliumCanvas component

`packages/web/src/MyceliumCanvas.jsx` — animated canvas header background.

- 30 nodes with position/velocity, 70% purple (`#6b3fa0`), 30% amber (`#e8a23a`)
- Connections drawn between nodes within 140px: `rgba(232,162,58,0.15)`, stroke 0.5px
- Node radius: 3px filled circles
- Velocity: max ±0.3px/frame, bounce off edges
- `activeEntityCount` prop > 0: every 1.5s, pulse that many random nodes (3→7→3 radius,
  400ms, white `rgba(255,255,255,0.8)`)
- ResizeObserver keeps canvas sized to parent

## Frontend data flow

```
topic state
  → resetAndRun()
    → callClaude(SYS_MAP, prompt) [SPORE CAST]
    → safeJSON() → setMapData()
    → callBuggy(buggyUrl)         [archive context, optional]
    → callClaude(SYS_RESEARCH, prompt + archiveCtx) [MYCELIUM SPREAD]
    → safeJSON() → setResData()
    → callClaude(SYS_SYNTH, prompt) [FRUITING BODY]
    → safeJSON() → setSynthData()
```

Models used:
- Extraction (MAP + RESEARCH): `claude-haiku-4-5-20251001`
- Synthesis: `claude-sonnet-4-6`

## Service API (packages/service/server.js)

| Method | Route               | Body / Params                                    | Returns                          |
| ------ | ------------------- | ------------------------------------------------ | -------------------------------- |
| GET    | /health             | —                                                | `{ ok: true }`                   |
| POST   | /search             | `{ subject, sources[], contextCue?, depth? }`    | `{ ok, result: { jobId, ... } }` |
| POST   | /crawl              | `{ url, subject?, contextCue?, depth? }`         | `{ ok, result: { jobId, ... } }` |
| GET    | /jobs/:id           | —                                                | `{ status, progress, ... }`      |
| GET    | /sessions           | `?q=query`                                       | sessions array                   |
| GET    | /sessions/:id       | —                                                | full session bundle              |
| GET    | /sessions/:id/export| —                                                | JSON download                    |
| GET    | /settings           | —                                                | settings object                  |
| POST   | /settings           | partial settings                                 | merged settings                  |
| POST   | /embed              | `{ texts[], model? }`                            | vectors                          |
| POST   | /vector-cluster     | `{ chunks[], threshold? }`                       | clusters                         |
| POST   | /resume-domain      | `{ domain }`                                     | `{ resumed: true }`              |
| POST   | /congress/review    | `{ sessionId, subject, claimCount, ... }`        | `{ ok: true }`                   |

## Archival sources (packages/service/sources.js)

| ID              | Name                      | Domain              |
| --------------- | ------------------------- | ------------------- |
| blackvault      | The Black Vault           | theblackvault.com   |
| ciaCrest        | CIA CREST Reading Room    | cia.gov             |
| wikileaks       | WikiLeaks                 | wikileaks.org       |
| nsarchive       | National Security Archive | nsarchive.gwu.edu   |
| internetArchive | Internet Archive          | archive.org         |

## Example investigation topics

- MKUltra program key figures and documents
- Operation Paperclip scientist recruitment 1945–1955
- COINTELPRO targets and methods 1956–1971
- TWA Flight 800 investigation inconsistencies
- Missing scientists 2022–2026 pattern
- GEC-Marconi SDI scientist deaths 1982–1990
- COINTELPRO

## Out of scope (this session)

- Deployment config (render.yaml, railway.json)
- Connections graph visualization
- Auth, rate limiting, user accounts
- New backend routes

## Style object conventions

The `S` object in `App.jsx` holds all inline styles. Keys map directly to elements.
Function values (`S.confFill(pct, color)`) return style objects. Never use CSS classes
or CSS files — all styling is inline via the `S` object to keep the single-file ethos.
