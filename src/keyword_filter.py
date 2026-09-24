# -*- coding: utf-8 -*-
from config import DOMAIN_KEYWORDS, NEGATIVE_KEYWORDS, POSITIVE_KEYWORDS, POSITIVE_SCORE_THRESHOLD, STRONG_CATALYST_KEYWORDS, UPCOMING_CATALYST_KEYWORDS

def score_news(text: str):
    lowered = (text or '').lower(); score, matched = 0, []
    for keyword, weight in POSITIVE_KEYWORDS.items():
        if keyword.lower() in lowered: score += weight; matched.append(f'+{weight} {keyword}')
    for keyword, weight in NEGATIVE_KEYWORDS.items():
        if keyword.lower() in lowered: score += weight; matched.append(f'{weight} {keyword}')
    return score, matched

def passes_keyword_filter(text: str):
    score, matched = score_news(text); lowered = (text or '').lower()
    domain_ok = any(k.lower() in lowered for k in DOMAIN_KEYWORDS)
    strong_ok = any(k.lower() in lowered for k in STRONG_CATALYST_KEYWORDS)
    upcoming_ok = any(k.lower() in lowered for k in UPCOMING_CATALYST_KEYWORDS)
    # نريد محفزاً قابلاً للمتابعة للأيام القادمة، وليس مجرد خبر نتيجة حدث اليوم.
    future_context = upcoming_ok or any(k.lower() in lowered for k in ('pdufa','adcom','action date','decision date','data readout','results expected'))
    return score >= POSITIVE_SCORE_THRESHOLD and (domain_ok or strong_ok) and future_context, score, matched
