import os
import re
import time
import json
import tempfile
import requests
import urllib.robotparser
from pathlib import Path
from pypdf import PdfReader
import pandas as pd
from openai import OpenAI
import pytesseract
from PIL import Image
import io

# ========================= CONFIG =========================
QUERY_PHRASES = ["your", "search", "phrases", "here"]

LLM_API_KEY = "sk-..."
LLM_BASE_URL = "https://api.openai.com/v1"
LLM_MODEL = "gpt-4o-mini"

REGISTRY_CSV = "search_registry.csv"
FULL_ARCHIVE_CSV = "full_22page_registry.csv"
CATALOG_FILE = "catalog.json"
DOWNLOAD_DIR = Path.home() / "CIA_Declassified"  # cross-platform default

WORDS_TO_SCAN = 400
MIN_CONFIDENCE = 60
CRAWL_DELAY = 10.0
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 "
    "PersonalResearchBot/1.0 (+https://yourdomain.com)"
)

ENABLE_OCR = False
STREAM_SCAN_BYTES = 524_288  # 512 KB — enough for 400-word scan in most PDFs
# =========================================================

session = requests.Session()
session.headers.update({"User-Agent": USER_AGENT})

# robots.txt cache: origin -> RobotFileParser
_robots_cache: dict[str, urllib.robotparser.RobotFileParser] = {}


def is_allowed_by_robots(url: str) -> bool:
    """Return True if USER_AGENT is permitted to fetch url per robots.txt."""
    from urllib.parse import urlparse
    parsed = urlparse(url)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    if origin not in _robots_cache:
        rp = urllib.robotparser.RobotFileParser()
        rp.set_url(f"{origin}/robots.txt")
        try:
            rp.read()
        except Exception:
            # If robots.txt is unreachable assume allowed (fail-open, log it)
            print(f"Warning: could not fetch robots.txt for {origin}; assuming allowed")
        _robots_cache[origin] = rp
    return _robots_cache[origin].can_fetch(USER_AGENT, url)


def load_catalog():
    if os.path.exists(CATALOG_FILE):
        with open(CATALOG_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_catalog(catalog):
    """Atomic write to avoid corruption on interrupt."""
    dir_ = os.path.dirname(os.path.abspath(CATALOG_FILE))
    with tempfile.NamedTemporaryFile("w", dir=dir_, delete=False,
                                     suffix=".tmp", encoding="utf-8") as tmp:
        json.dump(catalog, tmp, indent=2)
        tmp_path = tmp.name
    os.replace(tmp_path, CATALOG_FILE)


def extract_first_words(pdf_path: str, num_words: int = WORDS_TO_SCAN) -> str:
    """Extract text from PDF using layout mode; fallback to OCR if enabled."""
    try:
        with open(pdf_path, "rb") as f:
            reader = PdfReader(f)
            text = ""
            for page in reader.pages[:3]:
                # layout mode yields cleaner output for scanned/redacted docs
                text += page.extract_text(
                    extraction_mode="layout",
                    layout_mode_space_vertically=False
                ) or ""
                if len(text.split()) >= num_words:
                    break
            words = text.split()
            if words:
                return " ".join(words[:num_words])

            if ENABLE_OCR:
                text = ""
                for page in reader.pages[:2]:
                    resources = page.get("/Resources")
                    if resources and "/XObject" in resources:
                        for img in page.images:
                            try:
                                pil_img = Image.open(io.BytesIO(img.data))
                                text += pytesseract.image_to_string(pil_img) + " "
                            except Exception:
                                continue
                words = text.split()
                return " ".join(words[:num_words]) if words else "[NO_TEXT_OR_OCR_FAILED]"
            return "[NO_TEXT_LAYER_FOUND]"
    except Exception as e:
        return f"[ERROR_EXTRACTING: {str(e)}]"


def llm_evaluate_context(text_snippet: str) -> dict:
    """LLM context match + confidence score against QUERY_PHRASES."""
    if (not LLM_API_KEY or LLM_API_KEY == "sk-..."
            or not text_snippet or text_snippet.startswith("[")):
        return {"match": False, "confidence": 0, "reasoning": "No text or no API key"}

    client = OpenAI(api_key=LLM_API_KEY, base_url=LLM_BASE_URL)
    prompt = f"""You are evaluating a declassified CIA document snippet for relevance.
Query phrases: {', '.join(QUERY_PHRASES)}
First {WORDS_TO_SCAN} words:
{text_snippet[:8000]}

Does this document likely contain information related to the query (direct match, strong contextual relevance, or thematic connection)?
Respond in JSON only:
{{
  "match": true/false,
  "confidence": 0-100,
  "reasoning": "one sentence explanation"
}}"""

    try:
        response = client.chat.completions.create(
            model=LLM_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.0,
            max_tokens=300
        )
        raw = response.choices[0].message.content.strip()
        # Strip markdown code fences regardless of case (```json, ```JSON, etc.)
        raw = re.sub(r"^```[a-zA-Z]*\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
        return json.loads(raw.strip())
    except Exception as e:
        return {"match": False, "confidence": 0, "reasoning": f"LLM error: {str(e)}"}


def fetch_with_policy(url: str, *, stream: bool = False, timeout: int = 30):
    """
    Fetch url respecting robots.txt and HTTP status conventions that match
    the extension's crawlpolicy.js: back off 60 s on 429, hard-fail on 403.
    Raises on unrecoverable errors; returns the Response on success.
    """
    if not is_allowed_by_robots(url):
        raise PermissionError(f"Robots policy blocks URL: {url}")

    r = session.get(url, timeout=timeout, stream=stream)

    if r.status_code == 429:
        print(f"429 Too Many Requests for {url} — backing off 60 s")
        time.sleep(60)
        raise IOError(f"Rate-limited (429): {url}")

    if r.status_code == 403:
        raise PermissionError(f"Access denied (403): {url}")

    if r.status_code == 503:
        raise IOError(f"Service unavailable (503): {url}")

    r.raise_for_status()
    return r


def process_document(url: str, catalog: dict, is_search_hit: bool = False):
    """Stream-download, scan first N words, LLM-evaluate, catalog, keep if match."""
    filename = url.split("/")[-1]
    local_path = DOWNLOAD_DIR / filename

    if url in catalog:
        print(f"SKIP (already catalogued): {filename}")
        return

    print(f"Downloading for scan: {filename}")
    try:
        r = fetch_with_policy(url, stream=True, timeout=30)
        chunk = b""
        try:
            for c in r.iter_content(chunk_size=65536):
                chunk += c
                if len(chunk) >= STREAM_SCAN_BYTES:
                    break
        finally:
            r.close()  # release connection even when loop exits early
        with open(local_path, "wb") as f:
            f.write(chunk)
    except Exception as e:
        print(f"Download failed {filename}: {e}")
        catalog[url] = {"status": "download_failed", "error": str(e)}
        save_catalog(catalog)
        time.sleep(CRAWL_DELAY)  # still delay after failure to avoid hammering server
        return

    snippet = extract_first_words(str(local_path))
    eval_result = llm_evaluate_context(snippet)

    catalog[url] = {
        "filename": filename,
        "scanned_words": len(snippet.split()),
        "llm_match": eval_result["match"],
        "llm_confidence": eval_result["confidence"],
        "llm_reasoning": eval_result["reasoning"],
        "is_search_hit": is_search_hit,
        "full_downloaded": False
    }

    print(
        f"Scanned {filename} | Match: {eval_result['match']} "
        f"| Confidence: {eval_result['confidence']} "
        f"| Reason: {eval_result['reasoning']}"
    )

    if eval_result["match"] and eval_result["confidence"] >= MIN_CONFIDENCE:
        # Re-download full file (we only streamed partial bytes for scan)
        try:
            r_full = fetch_with_policy(url, timeout=60)
            with open(local_path, "wb") as f:
                f.write(r_full.content)
            catalog[url]["full_downloaded"] = True
            print(f"KEPT (full download): {filename}")
            time.sleep(CRAWL_DELAY)
        except Exception as e:
            print(f"Full download failed {filename}: {e}")
    else:
        local_path.unlink(missing_ok=True)  # Discard partial scan file
        print(f"Discarded (low relevance): {filename}")

    save_catalog(catalog)
    time.sleep(CRAWL_DELAY)


def main():
    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)  # deferred — not a module-level side effect
    catalog = load_catalog()

    if os.path.exists(REGISTRY_CSV):
        search_df = pd.read_csv(REGISTRY_CSV)
        print(f"Processing Step 1 registry: {len(search_df)} documents")
        for _, row in search_df.iterrows():
            process_document(row["url"], catalog, is_search_hit=True)

    if os.path.exists(FULL_ARCHIVE_CSV):
        archive_df = pd.read_csv(FULL_ARCHIVE_CSV)
        print(f"Processing Step 2 full registry: {len(archive_df)} documents")
        for _, row in archive_df.iterrows():
            process_document(row["url"], catalog, is_search_hit=False)

    print("\nFinished. Catalog saved to", CATALOG_FILE)
    print(f"Downloads in: {DOWNLOAD_DIR}")


if __name__ == "__main__":
    main()
