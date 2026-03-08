/**
 * content-script.js — DOM extraction content script for ArchiveLens
 *
 * Runs on active archival pages. Extracts document text and metadata from the
 * current page's DOM and communicates results to the background service worker.
 *
 * NOTE: This script runs in the page context but cannot make direct network
 * requests to Ollama or other origins — all such calls go through the
 * background service worker via chrome.runtime.sendMessage.
 */

(function () {
  'use strict';

  // ── Avoid double-injection ────────────────────────────────────────────────
  if (window.__archiveLensInjected) return;
  window.__archiveLensInjected = true;

  // ── DOM text extraction ───────────────────────────────────────────────────

  /**
   * Extract the main readable text content from the current page.
   * Tries common content selectors before falling back to <body>.
   *
   * @returns {string}
   */
  function extractPageText() {
    const CONTENT_SELECTORS = [
      '.entry-content',
      '#article-body',
      '.document-content',
      '.wiki-content',
      '.field-items',
      'article',
      'main',
      '#content',
      '.content',
      'body',
    ];

    for (const selector of CONTENT_SELECTORS) {
      const el = document.querySelector(selector);
      if (el) {
        return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      }
    }

    return (document.body.innerText || document.body.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Collect all document links on the current page that look like
   * archival document references.
   *
   * @returns {string[]} absolute URLs
   */
  function extractDocumentLinks() {
    const base = new URL(document.location.href);
    const seen = new Set();
    const links = [];

    // PDF and document extension patterns
    const DOC_PATTERN = /\.(pdf|doc|docx|txt|htm|html)(\?|$)/i;

    for (const anchor of document.querySelectorAll('a[href]')) {
      try {
        const href = new URL(anchor.getAttribute('href'), base).href;
        if (!seen.has(href)) {
          seen.add(href);
          // Include same-origin links or links matching document patterns
          if (new URL(href).hostname === base.hostname || DOC_PATTERN.test(href)) {
            links.push(href);
          }
        }
      } catch {
        // Invalid URL — skip
      }
    }

    return links;
  }

  /**
   * Extract page metadata (title, date, description).
   *
   * @returns {object}
   */
  function extractMetadata() {
    const getMeta = (name) => {
      const el =
        document.querySelector(`meta[name="${name}"]`) ||
        document.querySelector(`meta[property="${name}"]`);
      return el ? el.getAttribute('content') || '' : '';
    };

    return {
      title: document.title || '',
      url: document.location.href,
      date:
        getMeta('date') ||
        getMeta('article:published_time') ||
        getMeta('DC.date') ||
        '',
      description: getMeta('description') || getMeta('og:description') || '',
    };
  }

  // ── Message listener ──────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'extractPage') {
      try {
        const text = extractPageText();
        const links = extractDocumentLinks();
        const metadata = extractMetadata();
        sendResponse({ ok: true, text, links, metadata });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    }
    return false; // synchronous response
  });

  // ── Auto-signal presence ──────────────────────────────────────────────────
  // Tell the background worker that a content script is ready on this tab.
  chrome.runtime.sendMessage({ action: 'contentScriptReady', payload: { url: document.location.href } })
    .catch(() => {}); // suppress errors if background is not listening

})();
