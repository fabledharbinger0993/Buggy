export const DEFAULT_ARCHIVAL_SOURCES = {
  blackvault: {
    id: "blackvault",
    name: "The Black Vault",
    enabledByDefault: true,
    domain: "theblackvault.com",
    searchUrlPattern: "https://www.theblackvault.com/documentarchive/?s={query}",
    selectors: {
      resultLinks: "a[href*='/documentarchive/'], a[href*='/?s=']",
      documentTitle: "h1.entry-title, title",
      documentBody: "article, .entry-content, main"
    },
    parsingStrategy: "html-main-content",
    quirks: "Search pages can contain navigation duplicates; dedupe by normalized URL."
  },
  ciaCrest: {
    id: "ciaCrest",
    name: "CIA CREST Reading Room",
    enabledByDefault: true,
    domain: "cia.gov",
    searchUrlPattern: "https://www.cia.gov/readingroom/search/site/{query}",
    selectors: {
      resultLinks: "a[href*='/readingroom/document/']",
      documentTitle: "h1, title",
      documentBody: "main, .region-content, article"
    },
    parsingStrategy: "html-main-content",
    quirks: "Pagination can be server-rendered with sparse metadata on index pages."
  },
  wikileaks: {
    id: "wikileaks",
    name: "WikiLeaks",
    enabledByDefault: true,
    domain: "wikileaks.org",
    searchUrlPattern: "https://wikileaks.org/advanced.html?query={query}",
    selectors: {
      resultLinks: "a[href*='/plusd/'], a[href*='/wiki/'], a[href*='?q=']",
      documentTitle: "h1, title",
      documentBody: "article, #content, main"
    },
    parsingStrategy: "html-main-content",
    quirks: "Mirror variants and repeated links are common."
  },
  nsarchive: {
    id: "nsarchive",
    name: "National Security Archive",
    enabledByDefault: true,
    domain: "nsarchive.gwu.edu",
    searchUrlPattern: "https://nsarchive.gwu.edu/search?query={query}",
    selectors: {
      resultLinks: "a[href*='/document/'], a[href*='/briefing-book/']",
      documentTitle: "h1, title",
      documentBody: "article, .node__content, main"
    },
    parsingStrategy: "html-main-content",
    quirks: "Briefing books bundle many links that require depth control."
  },
  internetArchive: {
    id: "internetArchive",
    name: "Internet Archive",
    enabledByDefault: true,
    domain: "archive.org",
    searchUrlPattern: "https://archive.org/search?query={query}",
    selectors: {
      resultLinks: "a[href*='/details/'], a[href*='/download/']",
      documentTitle: "h1, title",
      documentBody: "main, #theatre-ia, .item-description"
    },
    parsingStrategy: "html-main-content",
    quirks: "Many records expose metadata-only pages and separate downloadable files."
  }
};

export function buildSearchUrl(source, query, contextCue = "") {
  const full = [query.trim(), contextCue.trim()].filter(Boolean).join(" ");
  const encoded = encodeURIComponent(full);
  return source.searchUrlPattern.replace("{query}", encoded);
}

export function mergeSourceConfig(defaults, userSources = {}) {
  return {
    ...defaults,
    ...userSources
  };
}
