import { get, put } from "./db.js";

const domainQueues = new Map();
const domainNextAt = new Map();
const domainPaused = new Map();

export async function isAllowedByRobots(url, userAgent = "*") {
  const target = new URL(url);
  const key = `robots:${target.origin}`;
  let cached = await get("crawlCache", key);

  if (!cached) {
    const robotsUrl = `${target.origin}/robots.txt`;
    let body = "";
    try {
      const res = await fetch(robotsUrl, { method: "GET", credentials: "omit", cache: "no-store" });
      if (res.ok) {
        body = await res.text();
      }
    } catch (_err) {
      body = "";
    }

    cached = {
      key,
      parsed: parseRobotsTxt(body),
      fetchedAt: Date.now()
    };
    await put("crawlCache", cached);
  }

  const path = target.pathname || "/";
  const parsed = cached.parsed || {};
  return !isPathBlocked(path, parsed, userAgent);
}

export function parseRobotsTxt(text) {
  const rules = {};
  let currentAgents = ["*"];

  const lines = (text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  for (const line of lines) {
    const parts = line.split(":");
    if (parts.length < 2) {
      continue;
    }

    const directive = parts[0].trim().toLowerCase();
    const value = parts.slice(1).join(":").trim();

    if (directive === "user-agent") {
      const agent = value.toLowerCase() || "*";
      currentAgents = [agent];
      if (!rules[agent]) {
        rules[agent] = { allow: [], disallow: [] };
      }
      continue;
    }

    for (const agent of currentAgents) {
      if (!rules[agent]) {
        rules[agent] = { allow: [], disallow: [] };
      }
      if (directive === "allow") {
        rules[agent].allow.push(value);
      } else if (directive === "disallow") {
        rules[agent].disallow.push(value);
      }
    }
  }

  return rules;
}

function isPathBlocked(path, parsed, userAgent) {
  const normalizedAgent = (userAgent || "*").toLowerCase();
  const candidates = [normalizedAgent, "archivelens", "*"];

  for (const agent of candidates) {
    const rule = parsed[agent];
    if (!rule) {
      continue;
    }

    const allowed = longestMatch(path, rule.allow || []);
    const blocked = longestMatch(path, rule.disallow || []);

    if (blocked && (!allowed || blocked.length > allowed.length)) {
      return true;
    }
  }

  return false;
}

function longestMatch(path, patterns) {
  let best = "";
  for (const pattern of patterns) {
    if (!pattern) {
      continue;
    }
    const escaped = pattern
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\\\*/g, ".*");
    const re = new RegExp(`^${escaped}`);
    if (re.test(path) && pattern.length > best.length) {
      best = pattern;
    }
  }
  return best;
}

export async function policyFetch(url, options = {}, settings = {}) {
  const target = new URL(url);
  const domain = target.hostname;
  const minDelay = effectiveDelaySeconds(domain, settings.crawlDelaySeconds || 3) * 1000;

  if (domainPaused.get(domain)) {
    throw new Error(`Domain ${domain} is paused due to CAPTCHA challenge`);
  }

  const allowed = await isAllowedByRobots(url, "archivelens");
  if (!allowed) {
    throw new Error(`Robots policy blocks URL: ${url}`);
  }

  return enqueueDomainRequest(domain, async () => {
    await enforceDelay(domain, minDelay);

    const headers = new Headers(options.headers || {});
    const contact = settings.contactEmail || "unset@example.com";
    const ua = `ArchiveLens/1.0 (Research Extension; respectful crawl; contact: ${contact})`;

    // Browsers may ignore User-Agent overrides from extension fetch; we still declare policy intent.
    headers.set("User-Agent", ua);
    headers.set("Accept", headers.get("Accept") || "text/html,application/pdf,*/*");
    headers.delete("Referer");
    headers.delete("Cookie");

    const fetchOptions = {
      ...options,
      method: options.method || "GET",
      headers,
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: "follow",
      cache: "no-store"
    };

    const response = await fetch(url, fetchOptions);
    const status = response.status;

    if (status === 429) {
      await backoffDomain(domain, 60000);
      throw new RetryableHttpError("Too Many Requests", 429, 60000, 1);
    }

    if (status === 403) {
      throw new PermanentHttpError("Access denied", 403);
    }

    if (status === 503) {
      throw new RetryableHttpError("Service unavailable", 503, 2000, 3);
    }

    const clone = response.clone();
    const bodyText = await safeReadText(clone);
    if (containsCaptcha(bodyText)) {
      domainPaused.set(domain, true);
      throw new CaptchaDetectedError(`CAPTCHA detected for ${domain}`);
    }

    return response;
  });
}

export function resumeDomain(domain) {
  domainPaused.delete(domain);
}

function containsCaptcha(text) {
  if (!text) {
    return false;
  }
  const checks = [/captcha/i, /g-recaptcha/i, /hcaptcha/i, /i am not a robot/i];
  return checks.some((re) => re.test(text));
}

async function safeReadText(response) {
  try {
    const ctype = response.headers.get("content-type") || "";
    if (ctype.includes("text") || ctype.includes("html") || ctype.includes("json")) {
      return await response.text();
    }
  } catch (_err) {
    return "";
  }
  return "";
}

function effectiveDelaySeconds(domain, userSetting) {
  if (domain.endsWith(".gov") || domain.endsWith(".mil")) {
    return Math.max(6, userSetting || 3);
  }
  return Math.min(10, Math.max(1, userSetting || 3));
}

function enqueueDomainRequest(domain, fn) {
  if (!domainQueues.has(domain)) {
    domainQueues.set(domain, Promise.resolve());
  }

  const chain = domainQueues
    .get(domain)
    .then(fn)
    .catch((err) => {
      throw err;
    });

  domainQueues.set(domain, chain.catch(() => undefined));
  return chain;
}

async function enforceDelay(domain, minDelayMs) {
  const now = Date.now();
  const nextAt = domainNextAt.get(domain) || 0;
  if (now < nextAt) {
    await delay(nextAt - now);
  }
  domainNextAt.set(domain, Date.now() + minDelayMs);
}

async function backoffDomain(domain, delayMs) {
  const nextAt = domainNextAt.get(domain) || 0;
  domainNextAt.set(domain, Math.max(nextAt, Date.now() + delayMs));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RetryableHttpError extends Error {
  constructor(message, status, baseDelayMs, maxRetries) {
    super(message);
    this.name = "RetryableHttpError";
    this.status = status;
    this.baseDelayMs = baseDelayMs;
    this.maxRetries = maxRetries;
  }
}

export class PermanentHttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "PermanentHttpError";
    this.status = status;
  }
}

export class CaptchaDetectedError extends Error {
  constructor(message) {
    super(message);
    this.name = "CaptchaDetectedError";
  }
}
