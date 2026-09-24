# -*- coding: utf-8 -*-
"""
جلب الأخبار من كل المصادر المجانية (RSS + SEC EDGAR).
كل خبر يُرجَّع كقاموس موحّد الشكل بغض النظر عن مصدره:
    {
        "id": معرّف فريد (رابط أو guid),
        "title": العنوان,
        "summary": ملخص/نص الخبر (إن وجد),
        "link": رابط الخبر,
        "source": اسم المصدر,
        "published": وقت النشر (نص كما ورد),
    }
"""

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

def _ticker_from_sec_entry(entry):
    haystack = " ".join(str(entry.get(k, "") or "") for k in ("title", "summary", "link"))
    m = re.search(r"\((\d{7,10})\)", haystack)
    if not m:
        m = re.search(r"(?<!\d)(\d{7,10})(?!\d)", haystack)
    return _load_sec_ticker_map().get(m.group(1).zfill(10)) if m else None


def _html_to_text(content):
    content = re.sub(r"<(script|style|noscript)[^>]*>.*?</\\1>", " ", content, flags=re.I | re.S)
    content = re.sub(r"<[^>]+>", " ", content)
    return re.sub(r"\s+", " ", html.unescape(content)).strip()


def _fetch_sec_filing_text(entry):
    link = entry.get("link", "") or ""
    if not link:
        return ""
    if link in _SEC_DETAIL_CACHE:
        return _SEC_DETAIL_CACHE[link]
    try:
        response = requests.get(link, headers={"User-Agent": SEC_USER_AGENT}, timeout=REQUEST_TIMEOUT)
        response.raise_for_status()
        index_text = response.text
        candidates = []
        for href, anchor in re.findall(r'href=["\']([^"\']+\.html?)["\'][^>]*>(.*?)</a>', index_text, flags=re.I | re.S):
            full = urljoin(link, html.unescape(href))
            low = full.lower()
            if "-index." in low or "ixviewer" in low or "xsl" in low:
                continue
            score = 0
            anchor_text = _html_to_text(anchor).lower()
            if "8-k" in anchor_text or "current report" in anchor_text:
                score += 3
            if re.search(r"8-k", low):
                score += 2
            candidates.append((score, full))
        candidates.sort(reverse=True)
        document_url = candidates[0][1] if candidates else None
        if not document_url:
            _SEC_DETAIL_CACHE[link] = ""
            return ""
        doc = requests.get(document_url, headers={"User-Agent": SEC_USER_AGENT}, timeout=REQUEST_TIMEOUT)
        doc.raise_for_status()
        text = _html_to_text(doc.text)[:SEC_DETAIL_MAX_CHARS]
        _SEC_DETAIL_CACHE[link] = text
        return text
    except Exception as exc:
        print(f"[news_sources] تعذّر قراءة نص SEC للإيداع: {exc}")
        _SEC_DETAIL_CACHE[link] = ""
        return ""


def _parse_feed_entries(feed_url: str, source_name: str) -> list[dict]:
    """يجلب ويحلل رابط RSS واحد، مع تجاهل أي خطأ شبكة بصمت (يُسجَّل فقط)."""
    try:
        response = requests.get(
            feed_url,
            headers={"User-Agent": "Mozilla/5.0 (compatible; StockNewsBot/1.0)"},
            timeout=REQUEST_TIMEOUT,
        )
        response.raise_for_status()
        parsed = feedparser.parse(response.content)
    except Exception as exc:  # noqa: BLE001 - نريد الاستمرار حتى لو فشل مصدر واحد
        print(f"[news_sources] تعذّر جلب {source_name}: {exc}")
        return []

    entries = []
    for entry in parsed.entries:
        entry_id = entry.get("id") or entry.get("link")
        if not entry_id:
            continue
        entries.append(
            {
                "id": entry_id,
                "title": entry.get("title", ""),
                "summary": entry.get("summary", ""),
                "link": entry.get("link", ""),
                "source": source_name,
                "published": entry.get("published", ""),
            }
        )
    return entries


def fetch_all_news() -> list[dict]:
    """يجلب الأخبار من كل مصادر RSS المحددة في config.py."""
    all_entries: list[dict] = []
    for source_name, url in RSS_FEEDS.items():
        all_entries.extend(_parse_feed_entries(url, source_name))
    return all_entries


def fetch_sec_edgar() -> list[dict]:
    """
    يجلب آخر تقديمات SEC EDGAR (نموذج 8-K غالبًا يحتوي أخبار جوهرية).
    ملاحظة مهمة: SEC يشترط إرسال User-Agent صريح يحتوي بيانات تواصل حقيقية
    (راجع SEC_USER_AGENT في config.py) وإلا يرفض الطلب أو يحظر الـ IP.
    """
    try:
        response = requests.get(
            SEC_EDGAR_RSS,
            headers={"User-Agent": SEC_USER_AGENT},
            timeout=REQUEST_TIMEOUT,
        )
        response.raise_for_status()
        parsed = feedparser.parse(response.content)
    except Exception as exc:  # noqa: BLE001
        print(f"[news_sources] تعذّر جلب SEC EDGAR: {exc}")
        return []

    entries = []
    for entry in parsed.entries:
        entry_id = entry.get("id") or entry.get("link")
        if not entry_id:
            continue
        entries.append(
            {
                "id": entry_id,
                "title": entry.get("title", ""),
                "summary": entry.get("summary", ""),
                "link": entry.get("link", ""),
                "source": "sec_edgar",
                "published": entry.get("updated", entry.get("published", "")),
                "ticker": _ticker_from_sec_entry(entry),
                "sec_text": _fetch_sec_filing_text(entry),
            }
        )
    return entries
