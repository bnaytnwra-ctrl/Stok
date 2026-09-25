# -*- coding: utf-8 -*-
"""وظائف تقويم محفزات Biotech/FDA مأخوذة من إضافة البوت الجديدة ومتكاملة مع النظام الأساسي."""
from __future__ import annotations

import json
import re
import html
from datetime import datetime, timedelta, timezone
from pathlib import Path

import feedparser
import requests
from bs4 import BeautifulSoup
try:
    from dateutil import parser as dateutil_parser
except ImportError:
    dateutil_parser = None

from config import CATALYST_FEEDS, CALENDAR_LOOKBACK_DAYS, CALENDAR_WINDOW_DAYS_MAX, CALENDAR_SEEN_PATH
from ticker_extractor import extract_ticker

HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; StockNewsBot/2.0)"}
REQUEST_TIMEOUT = 25

BIOTECH_CONTEXT = (
    "fda", "clinical", "trial", "biotech", "pharmaceutical", "therapeutics",
    "phase 1", "phase 2", "phase 3", "phase i", "phase ii", "phase iii",
    "drug", "therapy", "oncology", "vaccine", "biopharmaceutical",
    "nda", "bla", "biologics", "rare disease", "gene therapy", "cell therapy",
)

BREAKTHROUGH_KEYWORDS = (
    "fda approval", "fda approves", "fda grants approval", "fda clearance",
    "fda clears", "510(k) clearance", "emergency use authorization", "eua granted",
    "breakthrough therapy designation", "fast track designation",
    "orphan drug designation", "priority review", "positive phase 3",
    "positive phase iii", "positive phase 2", "positive phase ii",
    "met primary endpoint", "met its primary endpoint", "topline results positive",
    "positive topline data", "strategic partnership", "licensing agreement",
    "collaboration agreement", "exclusive license agreement", "acquisition agreement",
)

CATALYST_KEYWORDS = (
    "pdufa date", "pdufa target action date", "anticipated in", "scheduled for",
    "results expected in", "data expected in", "topline data expected",
    "phase 3 data", "phase iii data", "phase 2 data", "phase ii data",
    "adcom meeting", "advisory committee meeting", "clinical trial completion",
    "readout expected", "data readout anticipated", "expected to report",
    "action date", "decision date", "results will be", "will announce",
    "next week", "tomorrow", "this month",
)

NEGATIVE_TEXT = (
    "reverse split", "reverse stock split", "public offering",
    "registered direct offering", "direct offering", "private placement",
    "atm offering", "at-the-market offering", "dilution", "bankruptcy",
    "chapter 11", "delisting", "going concern", "class action",
    "securities litigation", "shareholder lawsuit", "investor lawsuit",
)

DATE_PATTERNS = (
    re.compile(r"[A-Z][a-z]+\s+\d{1,2},?\s+\d{4}"),
    re.compile(r"\d{1,2}/\d{1,2}/\d{4}"),
    re.compile(r"Q[1-4]\s+\d{4}", re.IGNORECASE),
)
QUARTER_END = {"1": (3, 31), "2": (6, 30), "3": (9, 30), "4": (12, 31)}

AR_LABELS = {
    "pdufa date": "موعد PDUFA (قرار FDA المتوقع)",
    "pdufa target action date": "موعد قرار FDA المتوقع (PDUFA)",
    "adcom meeting": "اجتماع اللجنة الاستشارية (AdCom)",
    "advisory committee meeting": "اجتماع اللجنة الاستشارية (AdCom)",
    "results expected in": "نتائج متوقعة قريبًا",
    "data expected in": "بيانات متوقعة قريبًا",
    "topline data expected": "بيانات أولية (Topline) متوقعة",
    "readout expected": "نتائج (Readout) متوقعة",
    "data readout anticipated": "نتائج (Readout) متوقعة",
    "expected to report": "إعلان نتائج متوقع",
    "phase 3 data": "بيانات المرحلة الثالثة",
    "phase iii data": "بيانات المرحلة الثالثة",
    "phase 2 data": "بيانات المرحلة الثانية",
    "phase ii data": "بيانات المرحلة الثانية",
    "clinical trial completion": "اكتمال تجربة سريرية",
    "scheduled for": "حدث مجدول",
    "action date": "موعد قرار تنظيمي",
    "decision date": "موعد قرار تنظيمي",
}

def _clean(raw: str) -> str:
    return re.sub(r"\s+", " ", BeautifulSoup(raw or "", "html.parser").get_text(" ")).strip()

def _contains(text: str, needle: str) -> bool:
    return needle.lower() in (text or "").lower()

def _extract_event_date(text: str, now: datetime) -> datetime | None:
    for pattern in DATE_PATTERNS:
        for raw in pattern.findall(text or ""):
            parsed = None
            q = re.fullmatch(r"Q([1-4])\s+(\d{4})", raw, re.I)
            if q:
                month, day = QUARTER_END[q.group(1)]
                parsed = datetime(int(q.group(2)), month, day, tzinfo=timezone.utc)
            elif dateutil_parser is not None:
                try:
                    parsed = dateutil_parser.parse(raw, fuzzy=True)
                    if parsed.tzinfo is None:
                        parsed = parsed.replace(tzinfo=timezone.utc)
                except (ValueError, OverflowError):
                    parsed = None
            if parsed is None:
                continue
            delta = (parsed.date() - now.date()).days
            if 0 <= delta <= CALENDAR_WINDOW_DAYS_MAX:
                return parsed
    return None

def _load_seen() -> dict:
    path = Path(CALENDAR_SEEN_PATH)
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}

def _save_seen(seen: dict) -> None:
    path = Path(CALENDAR_SEEN_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(seen, ensure_ascii=False, indent=2), encoding="utf-8")

def _prune_seen(seen: dict) -> dict:
    cutoff = datetime.now(timezone.utc) - timedelta(days=35)
    out = {}
    for key, value in seen.items():
        try:
            if datetime.fromisoformat(value) >= cutoff:
                out[key] = value
        except Exception:
            pass
    return out

def _fetch_feed(source: str, url: str) -> list[dict]:
    try:
        response = requests.get(url, headers=HEADERS, timeout=REQUEST_TIMEOUT)
        response.raise_for_status()
        parsed = feedparser.parse(response.content)
    except Exception as exc:
        print(f"[catalyst] تعذر جلب {source}: {exc}")
        return []
    items = []
    for entry in parsed.entries:
        title = _clean(entry.get("title", ""))
        summary = _clean(entry.get("summary", ""))
        link = entry.get("link", "")
        published = entry.get("published", entry.get("updated", ""))
        if not title and not summary:
            continue
        items.append({
            "title": title,
            "summary": summary,
            "link": link,
            "published": published,
            "source": source,
            "id": f"{source}|{link or title}",
        })
    return items

def find_upcoming_catalysts() -> list[dict]:
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=CALENDAR_LOOKBACK_DAYS)
    seen = _prune_seen(_load_seen())
    candidates = []
    local_keys = set()

    for source, url in CATALYST_FEEDS.items():
        for item in _fetch_feed(source, url):
            text = f"{item['title']} {item['summary']}"
            lower = text.lower()
            if any(term in lower for term in NEGATIVE_TEXT):
                continue
            if not any(term in lower for term in BIOTECH_CONTEXT):
                continue
            catalyst = next((kw for kw in CATALYST_KEYWORDS if kw in lower), None)
            if not catalyst:
                continue
            event_date = _extract_event_date(text, now)
            if event_date is None:
                continue

            pub = item["published"]
            if pub:
                try:
                    parsed_pub = feedparser._parse_date(pub)
                    if parsed_pub:
                        published_dt = datetime(*parsed_pub[:6], tzinfo=timezone.utc)
                        if published_dt < cutoff:
                            continue
                except Exception:
                    pass

            ticker = extract_ticker(text)
            if not ticker:
                continue

            key = f"{ticker}:{event_date.date().isoformat()}"
            if key in local_keys or key in seen:
                continue
            local_keys.add(key)
            candidates.append({
                **item,
                "ticker": ticker,
                "event_date": event_date,
                "catalyst_keyword": catalyst,
                "catalyst_ar": AR_LABELS.get(catalyst, catalyst),
                "calendar_key": key,
            })

    candidates.sort(key=lambda x: (x["event_date"], x["ticker"]))
    return candidates[:20]

def mark_calendar_sent(events: list[dict]) -> None:
    if not events:
        return
    seen = _prune_seen(_load_seen())
    stamp = datetime.now(timezone.utc).isoformat()
    for event in events:
        seen[event["calendar_key"]] = stamp
    _save_seen(seen)
