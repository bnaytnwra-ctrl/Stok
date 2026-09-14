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

from config import RSS_FEEDS, SEC_EDGAR_RSS, SEC_USER_AGENT

REQUEST_TIMEOUT = 25


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
            }
        )
    return entries
