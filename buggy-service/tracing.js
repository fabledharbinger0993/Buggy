let tracingConfig = {
  enabled: true,
  endpoint: "http://localhost:4318/v1/traces",
  serviceName: "archivelens-extension",
  scopeName: "archivelens.background"
};

const pendingSpans = [];
let flushTimer = null;

export function initTracing(config = {}) {
  tracingConfig = {
    ...tracingConfig,
    ...config
  };

  if (!flushTimer && tracingConfig.enabled) {
    flushTimer = setInterval(() => {
      flushTraces().catch(() => undefined);
    }, 4000);
  }
}

export function startSpan(name, attributes = {}, parentSpan = null) {
  const startedAtMs = Date.now();
  const span = {
    name,
    traceId: parentSpan?.traceId || randomHex(16),
    spanId: randomHex(8),
    parentSpanId: parentSpan?.spanId || undefined,
    startedAtMs,
    endedAtMs: null,
    attributes: normalizeAttributes(attributes),
    events: [],
    statusCode: 1,
    statusMessage: ""
  };
  return span;
}

export function addSpanEvent(span, name, attributes = {}) {
  if (!span) {
    return;
  }
  span.events.push({
    name,
    timeMs: Date.now(),
    attributes: normalizeAttributes(attributes)
  });
}

export function setSpanAttribute(span, key, value) {
  if (!span) {
    return;
  }
  span.attributes[key] = safeValue(value);
}

export function recordException(span, error) {
  if (!span || !error) {
    return;
  }

  span.statusCode = 2;
  span.statusMessage = error.message || "Unhandled error";
  addSpanEvent(span, "exception", {
    "exception.type": error.name || "Error",
    "exception.message": error.message || "",
    "exception.stacktrace": error.stack || ""
  });
}

export function endSpan(span, options = {}) {
  if (!span || span.endedAtMs) {
    return;
  }

  span.endedAtMs = Date.now();
  if (options.error) {
    recordException(span, options.error);
  } else if (options.ok === false) {
    span.statusCode = 2;
    span.statusMessage = options.message || "Operation failed";
  }

  pendingSpans.push(span);
  if (pendingSpans.length >= 8) {
    flushTraces().catch(() => undefined);
  }
}

export async function traceAsync(name, fn, options = {}) {
  const span = startSpan(name, options.attributes || {}, options.parentSpan || null);
  try {
    const result = await fn(span);
    endSpan(span, { ok: true });
    return result;
  } catch (error) {
    endSpan(span, { error });
    throw error;
  }
}

export async function flushTraces() {
  if (!tracingConfig.enabled || !pendingSpans.length) {
    return;
  }

  const batch = pendingSpans.splice(0, pendingSpans.length);
  const payload = toOtlpPayload(batch, tracingConfig.serviceName, tracingConfig.scopeName);

  try {
    await fetch(tracingConfig.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      keepalive: true
    });
  } catch (_err) {
    // Swallow exporter failures and keep the extension resilient.
  }
}

function toOtlpPayload(spans, serviceName, scopeName) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            {
              key: "service.name",
              value: { stringValue: serviceName }
            }
          ]
        },
        scopeSpans: [
          {
            scope: {
              name: scopeName
            },
            spans: spans.map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId,
              parentSpanId: span.parentSpanId,
              name: span.name,
              kind: 1,
              startTimeUnixNano: msToNanos(span.startedAtMs),
              endTimeUnixNano: msToNanos(span.endedAtMs || Date.now()),
              attributes: otlpAttributes(span.attributes),
              events: span.events.map((event) => ({
                name: event.name,
                timeUnixNano: msToNanos(event.timeMs),
                attributes: otlpAttributes(event.attributes)
              })),
              status: {
                code: span.statusCode,
                message: span.statusMessage || ""
              }
            }))
          }
        ]
      }
    ]
  };
}

function normalizeAttributes(attributes) {
  const out = {};
  for (const [key, value] of Object.entries(attributes || {})) {
    out[key] = safeValue(value);
  }
  return out;
}

function safeValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return JSON.stringify(value);
}

function otlpAttributes(attributes) {
  return Object.entries(attributes || {}).map(([key, value]) => ({
    key,
    value: toAnyValue(value)
  }));
}

function toAnyValue(value) {
  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      return { intValue: String(value) };
    }
    return { doubleValue: value };
  }
  if (typeof value === "boolean") {
    return { boolValue: value };
  }
  return { stringValue: String(value) };
}

function msToNanos(ms) {
  return String(BigInt(Math.floor(ms)) * 1000000n);
}

function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}
