# -*- coding: utf-8 -*-
"""
منع إرسال نفس الخبر أكثر من مرة.
نحتفظ بملف JSON محلي (logs/seen_ids.json) فيه معرّف كل خبر تم إرسال تنبيه
له مسبقًا مع تاريخ الإرسال، ونحذف المعرّفات الأقدم من مدة الاحتفاظ المحددة
في config.py حتى لا يتضخم الملف بلا حدود.

مهم: بما أن GitHub Actions بيئة مؤقتة (ephemeral)، هذا الملف يُحفظ بشكل دائم
فقط لو الـ workflow يسوي commit + push له في نهاية كل تشغيلة (موضّح في
alert.yml وREADME).
"""

import json
import os
from datetime import datetime, timedelta, timezone

from config import SEEN_IDS_PATH, SEEN_IDS_RETENTION_DAYS


def _load_raw() -> dict:
    if not os.path.exists(SEEN_IDS_PATH):
        return {}
    try:
        with open(SEEN_IDS_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}


def _prune(seen: dict) -> dict:
    cutoff = datetime.now(timezone.utc) - timedelta(days=SEEN_IDS_RETENTION_DAYS)
    pruned = {}
    for news_id, timestamp_str in seen.items():
        try:
            ts = datetime.fromisoformat(timestamp_str)
        except ValueError:
            continue
        if ts >= cutoff:
            pruned[news_id] = timestamp_str
    return pruned


class SeenNewsStore:
    """يُحمَّل مرة واحدة في بداية التشغيلة ويُحفظ مرة واحدة في نهايتها."""

    def __init__(self):
        self._seen = _prune(_load_raw())

    def is_new(self, news_id: str) -> bool:
        return news_id not in self._seen

    def mark_seen(self, news_id: str):
        self._seen[news_id] = datetime.now(timezone.utc).isoformat()

    def save(self):
        os.makedirs(os.path.dirname(SEEN_IDS_PATH), exist_ok=True)
        with open(SEEN_IDS_PATH, "w", encoding="utf-8") as f:
            json.dump(self._seen, f, ensure_ascii=False, indent=2)
