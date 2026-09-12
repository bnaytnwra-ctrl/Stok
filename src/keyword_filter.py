# -*- coding: utf-8 -*-
"""
فلترة الأخبار بنظام تقييم بالنقاط (Scoring) بدل قبول/رفض ثنائي صارم.
كل كلمة إيجابية موجودة بالنص تضيف نقاطها، وكل كلمة سلبية تطرح نقاطها.
الخبر يُقبل فقط إذا كان المجموع الكلي >= الحد الأدنى المحدد في config.py.
"""

from config import NEGATIVE_KEYWORDS, POSITIVE_KEYWORDS, POSITIVE_SCORE_THRESHOLD


def score_news(text: str) -> tuple[int, list[str]]:
    """
    يحسب نقاط الخبر ويرجع (المجموع, قائمة الكلمات المطابقة) للمراجعة والتوثيق.
    """
    if not text:
        return 0, []

    lowered = text.lower()
    total_score = 0
    matched_keywords = []

    for keyword, weight in POSITIVE_KEYWORDS.items():
        if keyword.lower() in lowered:
            total_score += weight
            matched_keywords.append(f"+{weight} {keyword}")

    for keyword, weight in NEGATIVE_KEYWORDS.items():
        if keyword.lower() in lowered:
            total_score += weight  # القيمة نفسها سالبة أصلاً في config.py
            matched_keywords.append(f"{weight} {keyword}")

    return total_score, matched_keywords


def passes_keyword_filter(text: str) -> tuple[bool, int, list[str]]:
    """يرجع (هل يمر الخبر؟, النقاط, الكلمات المطابقة) دفعة واحدة."""
    score, matched = score_news(text)
    return score >= POSITIVE_SCORE_THRESHOLD, score, matched
