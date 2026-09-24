# -*- coding: utf-8 -*-
"""
استخراج رمز السهم (Ticker) من عنوان/نص الخبر.
البيانات الصحفية المجانية غالبًا تذكر السهم بصيغة:
  (NASDAQ: XYZ)  |  (NYSE American: XYZ)  |  (OTC: XYZ)  |  (OTCQB: XYZ)
  (TSX: XYZ)     |  (TSXV: XYZ)           |  (CSE: XYZ)
هذي الدالة تحاول التقاط أي صيغة من هذي.
"""

import re

# البورصات الشائعة لأسهم الـ penny stocks (أمريكية بشكل رئيسي)
EXCHANGE_PATTERN = re.compile(
    r"\((?:NASDAQ|NYSE(?:\s+American)?|OTC|OTCQB|OTCQX|OTC\s*Pink|TSX|TSXV|CSE|NEO)"
    r"\s*[:\-]\s*([A-Z]{1,6})\)",
    re.IGNORECASE,
)

# صيغة بديلة أحيانًا تُكتب بدون قوس: "NASDAQ: XYZ" أو "Ticker: XYZ"
FALLBACK_PATTERN = re.compile(
    r"\b(?:Ticker|Symbol)\s*[:\-]\s*([A-Z]{1,6})\b"
)


def extract_ticker(text: str) -> str | None:
    """يحاول إيجاد رمز السهم داخل النص. يرجع None إذا ما لقى شيء."""
    if not text:
        return None

    match = EXCHANGE_PATTERN.search(text)
    if match:
        return match.group(1).upper()

    loose = re.search(r'\b(?:NASDAQ|NYSE|AMEX|OTC)\s*[:\-]\s*([A-Z]{1,6})\b', text, re.I)
    if loose:
        return loose.group(1).upper()

    match = FALLBACK_PATTERN.search(text)
    if match:
        return match.group(1).upper()

    return None
