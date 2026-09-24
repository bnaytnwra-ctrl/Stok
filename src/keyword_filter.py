# -*- coding: utf-8 -*-
import re
from config import DOMAIN_KEYWORDS, NEGATIVE_KEYWORDS, POSITIVE_KEYWORDS, POSITIVE_SCORE_THRESHOLD, STRONG_CATALYST_KEYWORDS, UPCOMING_CATALYST_KEYWORDS


def _contains_keyword(text: str, keyword: str) -> bool:
    lowered = (text or '').lower()
    k = (keyword or '').strip().lower()
    if not k:
        return False
    return re.search(r'(?<![a-z0-9])' + re.escape(k) + r'(?![a-z0-9])', lowered) is not None


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

    hard_negative = any(_contains_keyword(text, k) for k in (
        'reverse split', 'reverse stock split', 'stock split',
        'public offering', 'registered direct offering', 'direct offering',
        'private placement', 'atm offering', 'at-the-market offering',
        'dilution', 'securities purchase agreement',
        'bankruptcy', 'chapter 11', 'delisting', 'going concern',
        'restatement', 'class action', 'securities class action',
        'securities litigation', 'shareholder lawsuit', 'investor lawsuit',
        'lead plaintiff', 'law firm', 'clinical trial failed',
        'failed primary endpoint',
    ))

    # خبر تشغيلي حقيقي: محفز قوي أو درجة كافية، مع ارتباط بقطاع الشركة.
    # لا نسمح لكلمات عامة مثل anticipated/next week بتمرير الخبر وحدها.
    catalyst_ok = (strong_ok or score >= POSITIVE_SCORE_THRESHOLD) and (domain_ok or strong_ok)

    # upcoming وحدها لا تكفي؛ يجب أن تكون مرتبطة بمحفز واضح مثل PDUFA/FDA/readout.
    if upcoming_ok and not strong_ok and score < POSITIVE_SCORE_THRESHOLD:
        catalyst_ok = False

    return catalyst_ok and not hard_negative, score, matched
