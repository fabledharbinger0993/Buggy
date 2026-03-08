# Buggy
A web search agent: deep archive crawling, context focused high confidence pathways, can build cliff notes to fully sourced research.

## Tracing (AI Toolkit OTLP)

Tracing is now wired in the ArchiveLens service worker (`archivelens/background/service-worker.js`) and exports OTLP spans to:

- `http://localhost:4318/v1/traces` (default)

You can configure tracing through stored settings keys in IndexedDB defaults (`archivelens/background/db.js`):

- `tracingEnabled` (default `true`)
- `tracingEndpoint` (default `http://localhost:4318/v1/traces`)
- `tracingServiceName` (default `archivelens-extension`)

Instrumented operations include session start, crawl source execution, retry/fetch outcomes, Ollama calls, entity resolution, fact-checking, and context brief generation.
