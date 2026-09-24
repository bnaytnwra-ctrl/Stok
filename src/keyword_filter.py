# -*- coding: utf-8 -*-
import re
from config import DOMAIN_KEYWORDS, NEGATIVE_KEYWORDS, POSITIVE_KEYWORDS, POSITIVE_SCORE_THRESHOLD, STRONG_CATALYST_KEYWORDS, UPCOMING_CATALYST_KEYWORDS

def _contains_keyword(text: str, keyword: str) -> bool:
    """
    مطابقة الكلمات كعبارات مستقلة لمنع أخطاء مثل:
    BLA داخل Blaize.
    """
    lowered = (text or '').lower()
    k = (keyword or '').strip().lower()
    if not k:
        return False
    pattern = r'(?<![a-z0-9])' + re.escape(k) + r'(?![a-z0-9])'
    return re.search(pattern, lowered) is not None

def score_news(text: str):
    score, matched = 0, []
    for keyword, weight in POSITIVE_KEYWORDS.items():
        if _contains_keyword(text, keyword):
            score += weight
            matched.append(f'+{weight} {keyword}')
    for keyword, weight in NEGATIVE_KEYWORDS.items():
        if _contains_keyword(text, keyword):
            score += weight
            matched.append(f'{weight} {keyword}')
    return score, matched

def passes_keyword_filter(text: str):
    score, matched = score_news(text)

    domain_ok = any(_contains_keyword(text, k) for k in DOMAIN_KEYWORDS)
    strong_ok = any(_contains_keyword(text, k) for k in STRONG_CATALYST_KEYWORDS)
    upcoming_ok = any(_contains_keyword(text, k) for k in UPCOMING_CATALYST_KEYWORDS)

    lowered = (text or '').lower()

    # أخبار الدعاوى وحقوق المستثمرين ليست محفزات تشغيلية للشركة.
    litigation_negative = any(_contains_keyword(text, k) for k in (
        'class action',
        'securities class action',
        'securities litigation',
        'shareholder lawsuit',
        'investor lawsuit',
        'lead plaintiff',
        'law firm',
    ))

    hard_negative = any(_contains_keyword(text, k) for k in (
        'bankruptcy',
        'chapter 11',
        'delisting',
        'clinical trial failed',
        'failed primary endpoint',
    ))

    # نستبعد أخبار التقاضي حتى لو احتوت بالصدفة على كلمات دوائية/تنظيمية.
    # لا نُشترط upcoming_ok حالياً حتى لا نُسقط البيانات الصحفية التي تعلن
    # المحفز بصياغة مستقبلية مختلفة. سنشدد على "المحفزات القادمة" بعد ثبات المسار.
    return (
        score >= POSITIVE_SCORE_THRESHOLD
        and (domain_ok or strong_ok)
        and not hard_negative
        and not litigation_negative
    ), score, matched
