/**
 * crawlpolicy.js — Ethical crawl compliance module for ArchiveLens
 *
 * PURPOSE: Govern all outbound HTTP behaviour to ensure the extension operates
 * within ethical and legal boundaries and does NOT trigger automated security
 * systems on target archival sites.
 *
 * IMPORTANT DESIGN PRINCIPLE:
 * The goal of this module is respectful, non-disruptive access to PUBLICLY
 * AVAILABLE documents only. It must never:
 *   - Access documents behind authentication walls
 *   - Submit forms or interact with login systems
 *   - Attempt to bypass or automate around CAPTCHAs
 *   - Lower rate limits below the enforced floors
 * It only retrieves content accessible via standard, unauthenticated HTTP GET.
 */

import { openDB, dbGet, dbPut, getSetting } from '../lib/db.js';

// ── Constants ────────────────────────────────────────────────────────────────

/** Default inter-request delay (ms) for non-government domains. */
const DEFAULT_DELAY_MS = 3000;

/**
 * Minimum delay (ms) enforced for .gov and .mil domains regardless of user
 * setting. This floor CANNOT be lowered by the user.
 */
const GOV_MIL_FLOOR_MS = 6000;

/** Minimum backoff after a 429 response (ms). */
const RATE_LIMIT_BACKOFF_MS = 60000;

/** Maximum number of retries for transient errors. */
const MAX_RETRIES = 3;

/** Common CAPTCHA indicator strings to scan for in response bodies. */
const CAPTCHA_INDICATORS = [
  'captcha',
  'recaptcha',
  'hcaptcha',
  'challenge-form',
  'robot check',
  'are you a robot',
  'verify you are human',
  'access denied',
  'ddos-guard',
  'cloudflare',
];

// ── Per-domain request queues ─────────────────────────────────────────────────

/**
 * Map<domain, { queue: Array<{resolve, reject, url, options}>, processing: boolean }>
 * Ensures at most one in-flight request per domain, with the configured delay
 * enforced between dequeues.
 */
const domainQueues = new Map();

// ── Robots.txt parsing ────────────────────────────────────────────────────────

/**
 * Parse a robots.txt body and return the set of disallowed path prefixes
 * applicable to all user agents ('*') or to 'archivelens'.
 *
 * @param {string} body - raw robots.txt text
 * @returns {string[]} array of disallowed path prefixes
 */
export function parseRobotsTxt(body) {
  const lines = body.split(/\r?\n/);
  const disallowed = [];
  let applicable = false; // are we inside a relevant User-agent block?

  for (const raw of lines) {
    const line = raw.trim();

    // Skip comments and blank lines
    if (!line || line.startsWith('#')) continue;

    const [directive, ...rest] = line.split(':');
    const key = directive.trim().toLowerCase();
    const value = rest.join(':').trim();

    if (key === 'user-agent') {
      // Match '*' (all agents) or our own agent name
      applicable = value === '*' || value.toLowerCase() === 'archivelens';
    } else if (key === 'disallow' && applicable && value) {
      disallowed.push(value);
    }
  }

  return disallowed;
}

/**
 * Fetch and cache the robots.txt for a domain.
 * Returns the list of disallowed path prefixes.
 *
 * @param {string} domain - e.g. 'www.cia.gov'
 * @returns {Promise<string[]>}
 */
async function fetchRobotsTxt(domain) {
  const db = await openDB();
  const cached = await dbGet(db, 'robotsCache', domain);

  // Cache is valid for the entire session (no TTL check needed within one run)
  if (cached) return cached.disallowedPaths;

  try {
    const url = `https://${domain}/robots.txt`;
    const resp = await fetch(url, {
      method: 'GET',
      headers: buildHeaders(),
      credentials: 'omit',
      redirect: 'follow',
    });

    let disallowedPaths = [];
    if (resp.ok) {
      const body = await resp.text();
      disallowedPaths = parseRobotsTxt(body);
    }
    // If robots.txt is missing or returns 404, treat as no restrictions

    await dbPut(db, 'robotsCache', {
      domain,
      disallowedPaths,
      fetchedAt: Date.now(),
    });

    return disallowedPaths;
  } catch {
    // Network error fetching robots.txt — fail open (allow crawl) but cache empty
    await dbPut(db, 'robotsCache', {
      domain,
      disallowedPaths: [],
      fetchedAt: Date.now(),
    });
    return [];
  }
}

/**
 * Check whether a URL is allowed by robots.txt rules.
 *
 * @param {string} url
 * @returns {Promise<boolean>} true if crawling is allowed
 */
export async function isAllowedByRobots(url) {
  const parsed = new URL(url);
  const domain = parsed.hostname;
  const path = parsed.pathname;

  const disallowed = await fetchRobotsTxt(domain);
  for (const prefix of disallowed) {
    if (path.startsWith(prefix)) return false;
  }
  return true;
}

// ── Header hygiene ────────────────────────────────────────────────────────────

/**
 * Build fetch-safe headers for outbound archival requests.
 *
 * Rules enforced:
 *  - Honest, descriptive User-Agent identifying the extension
 *  - No Referer header sent to external domains
 *  - No cookies (credentials: 'omit' at call site)
 *  - No Accept-Language / fingerprinting headers beyond the minimum
 *
 * @returns {HeadersInit}
 */
export function buildHeaders(contactEmail = '') {
  const contact = contactEmail
    ? `contact: ${contactEmail}`
    : 'contact: not-configured';

  return {
    // Honest self-identification — not impersonating a browser
    'User-Agent': `ArchiveLens/1.0 (Research Extension; respectful crawl; ${contact})`,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    // Explicitly prevent Referer leakage
    'Referrer-Policy': 'no-referrer',
  };
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

/**
 * Determine the inter-request delay for a given URL.
 * Government domains enforce a 6-second floor that cannot be overridden.
 *
 * @param {string} url
 * @param {number} userConfiguredDelayMs - from user settings
 * @returns {number} milliseconds to wait between requests to this domain
 */
function delayForUrl(url, userConfiguredDelayMs) {
  const { hostname } = new URL(url);
  const isGov = hostname.endsWith('.gov') || hostname.endsWith('.mil');
  if (isGov) {
    // Government floor cannot be lowered by the user setting
    return Math.max(GOV_MIL_FLOOR_MS, userConfiguredDelayMs);
  }
  return Math.max(DEFAULT_DELAY_MS, userConfiguredDelayMs);
}

/** Sleep for `ms` milliseconds. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Process the per-domain request queue, enforcing the configured inter-request
 * delay between consecutive requests to the same domain.
 *
 * @param {string} domain
 * @param {number} delayMs
 */
async function processDomainQueue(domain, delayMs) {
  const state = domainQueues.get(domain);
  if (!state || state.processing) return;

  state.processing = true;

  while (state.queue.length > 0) {
    const { resolve, reject, url, options } = state.queue.shift();
    try {
      const result = await rawFetch(url, options);
      resolve(result);
    } catch (err) {
      reject(err);
    }
    if (state.queue.length > 0) {
      await sleep(delayMs);
    }
  }

  state.processing = false;
}

// ── Core fetch wrapper ────────────────────────────────────────────────────────

/** Tracks domain-level backoff expiry timestamps. Map<domain, number> */
const domainBackoffUntil = new Map();

/** Tracks permanently blocked URLs for this session. Set<string> */
const permanentlyBlocked = new Set();

/** Tracks domains awaiting CAPTCHA resolution. Set<string> */
const captchaBlocked = new Set();

/**
 * Perform the actual HTTP GET with retry logic and response-code handling.
 * This is the inner implementation called by the queue processor.
 *
 * @param {string} url
 * @param {object} options
 * @returns {Promise<{ok: boolean, status: number, body: string, url: string}>}
 */
async function rawFetch(url, options = {}) {
  const { contactEmail = '', retryCount = 0 } = options;
  const domain = new URL(url).hostname;

  // Check for CAPTCHA block on this domain
  if (captchaBlocked.has(domain)) {
    throw new Error(`CAPTCHA_BLOCKED:${domain}`);
  }

  // Check permanent block
  if (permanentlyBlocked.has(url)) {
    return { ok: false, status: 403, body: '', url, accessStatus: 'ACCESS_DENIED' };
  }

  // Check domain backoff
  const backoffUntil = domainBackoffUntil.get(domain) || 0;
  if (Date.now() < backoffUntil) {
    await sleep(backoffUntil - Date.now());
  }

  const headers = buildHeaders(contactEmail);

  let resp;
  try {
    resp = await fetch(url, {
      method: 'GET',
      headers,
      credentials: 'omit',    // Never send cookies to crawled sites
      redirect: 'follow',
      referrerPolicy: 'no-referrer',  // No Referer header to external domains
    });
  } catch (networkErr) {
    // Network-level failure — retry with exponential backoff
    if (retryCount < MAX_RETRIES) {
      const backoff = Math.pow(2, retryCount) * 1000;
      await sleep(backoff);
      return rawFetch(url, { ...options, retryCount: retryCount + 1 });
    }
    throw networkErr;
  }

  // ── Response code handling ──────────────────────────────────────────────

  if (resp.status === 429) {
    // Too Many Requests — mandatory minimum 60-second backoff, then one retry
    const retryAfterHeader = resp.headers.get('retry-after') || '0';
    // RFC 7231: retry-after may be an integer (seconds) or an HTTP-date.
    // We only support the integer form here; HTTP-date format falls back to the
    // minimum RATE_LIMIT_BACKOFF_MS floor which is always safer.
    const retryAfterSeconds = parseInt(retryAfterHeader, 10);
    const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? retryAfterSeconds * 1000
      : 0;
    const backoff = Math.max(RATE_LIMIT_BACKOFF_MS, retryAfterMs);
    domainBackoffUntil.set(domain, Date.now() + backoff);
    if (retryCount < 1) {
      await sleep(backoff);
      return rawFetch(url, { ...options, retryCount: retryCount + 1 });
    }
    return { ok: false, status: 429, body: '', url };
  }

  if (resp.status === 403) {
    // Permanent block for this URL in this session — no retry
    permanentlyBlocked.add(url);
    return { ok: false, status: 403, body: '', url, accessStatus: 'ACCESS_DENIED' };
  }

  if (resp.status === 503) {
    // Service Unavailable — standard exponential backoff
    if (retryCount < MAX_RETRIES) {
      const backoff = Math.pow(2, retryCount) * 1000;
      await sleep(backoff);
      return rawFetch(url, { ...options, retryCount: retryCount + 1 });
    }
    return { ok: false, status: 503, body: '', url };
  }

  if (!resp.ok) {
    return { ok: false, status: resp.status, body: '', url };
  }

  const body = await resp.text();

  // ── CAPTCHA detection ───────────────────────────────────────────────────
  // Scan the response body for CAPTCHA indicators. If found, halt all
  // further requests to this domain and notify the user.
  // We do NOT attempt to bypass CAPTCHAs — the crawl pauses for manual intervention.
  const bodyLower = body.toLowerCase();
  for (const indicator of CAPTCHA_INDICATORS) {
    if (bodyLower.includes(indicator)) {
      captchaBlocked.add(domain);
      // Notify the service worker / UI layer
      self.dispatchEvent(new CustomEvent('captchaDetected', { detail: { domain, url } }));
      throw new Error(`CAPTCHA_DETECTED:${domain}`);
    }
  }

  return { ok: true, status: resp.status, body, url };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Enqueue an HTTP GET request, respecting robots.txt, rate limits,
 * and all ethical crawl policies.
 *
 * @param {string} url - the URL to fetch
 * @param {object} [options]
 * @param {string} [options.contactEmail] - user's contact address for User-Agent
 * @param {number} [options.userDelayMs]  - user-configured base delay
 * @returns {Promise<{ok: boolean, status: number, body: string, url: string}>}
 */
export async function enqueueFetch(url, options = {}) {
  // 1. robots.txt check
  const allowed = await isAllowedByRobots(url);
  if (!allowed) {
    return { ok: false, status: 0, body: '', url, accessStatus: 'ROBOTS_DISALLOWED' };
  }

  const { hostname } = new URL(url);
  const userDelayMs = options.userDelayMs || DEFAULT_DELAY_MS;
  const delayMs = delayForUrl(url, userDelayMs);

  // 2. Add to per-domain queue
  return new Promise((resolve, reject) => {
    if (!domainQueues.has(hostname)) {
      domainQueues.set(hostname, { queue: [], processing: false });
    }
    const state = domainQueues.get(hostname);
    state.queue.push({ resolve, reject, url, options });

    // Kick off queue processing if not already running
    processDomainQueue(hostname, delayMs);
  });
}

/**
 * Check whether a domain is currently CAPTCHA-blocked.
 * @param {string} domain
 * @returns {boolean}
 */
export function isCaptchaBlocked(domain) {
  return captchaBlocked.has(domain);
}

/**
 * Resume crawling a domain after the user has manually resolved a CAPTCHA.
 * @param {string} domain
 */
export function resumeDomain(domain) {
  captchaBlocked.delete(domain);
}
