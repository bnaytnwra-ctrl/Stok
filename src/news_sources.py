# -*- coding: utf-8 -*-
"""جلب الأخبار من RSS + SEC EDGAR."""
import feedparser
import requests
import re
import html
from urllib.parse import urljoin
from config import RSS_FEEDS, SEC_EDGAR_RSS, SEC_USER_AGENT

REQUEST_TIMEOUT = 25
SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
SEC_DETAIL_MAX_CHARS = 60000
_SEC_TICKER_MAP = None
_SEC_DETAIL_CACHE = {}


def _load_sec_ticker_map():
    global _SEC_TICKER_MAP
    if _SEC_TICKER_MAP is not None:
        return _SEC_TICKER_MAP
    try:
        r = requests.get(SEC_TICKERS_URL, headers={"User-Agent": SEC_USER_AGENT}, timeout=REQUEST_TIMEOUT)
        r.raise_for_status()
        data = r.json()
        _SEC_TICKER_MAP = {str(v["cik_str"]).zfill(10): str(v["ticker"]).upper()
                           for v in data.values() if v.get("cik_str") and v.get("ticker")}
    except Exception as exc:
        print(f"[news_sources] SEC ticker map failed: {exc}")
        _SEC_TICKER_MAP = {}
    return _SEC_TICKER_MAP


def _sec_accession(entry):
    haystack = " ".join(str(entry.get(k, "") or "") for k in ("id", "link", "title", "summary"))
    m = re.search(r"([0-9]{10}-[0-9]{2}-[0-9]{6})", haystack)
    return m.group(1) if m else None


def _sec_cik(entry, accession):
    haystack = " ".join(str(entry.get(k, "") or "") for k in ("title", "summary", "link"))
    m = re.search(r"\((\d{7,10})\)", haystack)
    if m:
        return m.group(1).zfill(10)
    return accession.split("-")[0].zfill(10) if accession else None


def _ticker_from_sec_entry(entry):
    accession = _sec_accession(entry)
    cik = _sec_cik(entry, accession)
    if cik:
        return _load_sec_ticker_map().get(cik)
    return None


def _html_to_text(content):
    if not content:
        return ""
    content = re.sub(r"<(script|style|noscript)\b[^>]*>.*?</\1>", " ", content, flags=re.I | re.S)
    content = re.sub(r"<[^>]+>", " ", content)
    return re.sub(r"\s+", " ", html.unescape(content)).strip()


def _sec_text_score(text):
    t = (text or "").lower()
    keys = ("fda", "pdufa", "clinical trial", "clinical study", "clinical data",
            "topline", "data readout", "primary endpoint", "patient", "enrollment",
            "dose", "dosing", "phase 1", "phase 2", "phase 3", "regulatory",
            "advisory committee", "nda", "bla", "breakthrough therapy",
            "indication", "drug candidate", "therapeutic", "biologics")
    return sum(t.count(k) for k in keys)


def _sec_document_urls(index_html, index_url, accession_nodash):
    hrefs = re.findall(r'href=["\']([^"\']+)["\']', index_html, flags=re.I)
    urls, seen = [], set()
    for href in hrefs:
        full = urljoin(index_url, html.unescape(href))
        low = full.lower()
        if full in seen or accession_nodash not in low:
            continue
        if not low.endswith((".htm", ".html")):
            continue
        if any(x in low for x in ("-index.", "index-headers", "ixviewer", "xsl", "filingsummary")):
            continue
        seen.add(full)
        urls.append(full)
    return urls[:5]


def _fetch_sec_filing_text(entry):
    cache_key = entry.get("link", "") or entry.get("id", "")
    if cache_key in _SEC_DETAIL_CACHE:
        return _SEC_DETAIL_CACHE[cache_key]
    accession = _sec_accession(entry)
    cik = _sec_cik(entry, accession)
    if not accession or not cik:
        _SEC_DETAIL_CACHE[cache_key] = ""
        return ""
    accession_nodash = accession.replace("-", "")
    index_url = f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accession_nodash}/{accession}-index.html"
    try:
        response = requests.get(index_url, headers={"User-Agent": SEC_USER_AGENT}, timeout=REQUEST_TIMEOUT)
        response.raise_for_status()
        index_html = response.text
        parts = [_html_to_text(index_html)]
        for document_url in _sec_document_urls(index_html, index_url, accession_nodash):
            try:
                doc = requests.get(document_url, headers={"User-Agent": SEC_USER_AGENT}, timeout=REQUEST_TIMEOUT)
                doc.raise_for_status()
                parts.append(_html_to_text(doc.text))
            except Exception as exc:
                print(f"[news_sources] SEC document failed: {exc}")
        text = "\n".join(p for p in parts if p)[:SEC_DETAIL_MAX_CHARS]
        print(f"[news_sources] SEC text extracted | chars={len(text)} | score={_sec_text_score(text)} | accession={accession}")
        _SEC_DETAIL_CACHE[cache_key] = text
        return text
    except Exception as exc:
        print(f"[news_sources] SEC filing failed {accession}: {exc}")
        _SEC_DETAIL_CACHE[cache_key] = ""
        return ""


def _parse_feed_entries(feed_url: str, source_name: str) -> list[dict]:
    try:
        response = requests.get(feed_url, headers={"User-Agent": "Mozilla/5.0 (compatible; StockNewsBot/1.0)"}, timeout=REQUEST_TIMEOUT)
        response.raise_for_status()
        parsed = feedparser.parse(response.content)
    except Exception as exc:
        print(f"[news_sources] تعذّر جلب {source_name}: {exc}")
        return []
    entries = []
    for entry in parsed.entries:
        entry_id = entry.get("id") or entry.get("link")
        if entry_id:
            entries.append({"id": entry_id, "title": entry.get("title", ""), "summary": entry.get("summary", ""), "link": entry.get("link", ""), "source": source_name, "published": entry.get("published", "")})
    return entries


def fetch_all_news() -> list[dict]:
    all_entries = []
    for source_name, url in RSS_FEEDS.items():
        all_entries.extend(_parse_feed_entries(url, source_name))
    return all_entries


def fetch_sec_edgar() -> list[dict]:
    try:
        response = requests.get(SEC_EDGAR_RSS, headers={"User-Agent": SEC_USER_AGENT}, timeout=REQUEST_TIMEOUT)
        response.raise_for_status()
        parsed = feedparser.parse(response.content)
    except Exception as exc:
        print(f"[news_sources] تعذّر جلب SEC EDGAR: {exc}")
        return []
    entries = []
    for entry in parsed.entries:
        entry_id = entry.get("id") or entry.get("link")
        if not entry_id:
            continue
        entries.append({"id": entry_id, "title": entry.get("title", ""), "summary": entry.get("summary", ""), "link": entry.get("link", ""), "source": "sec_edgar", "published": entry.get("updated", entry.get("published", "")), "ticker": _ticker_from_sec_entry(entry), "sec_text": _fetch_sec_filing_text(entry)})
    return entries
