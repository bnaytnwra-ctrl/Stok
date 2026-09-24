# -*- coding: utf-8 -*-
"""ترجمة الأخبار إلى العربية مع بدائل عند تعذر خدمة الترجمة."""

import html
import re
import time
import requests

TIMEOUT = 20
MAX_CHARS = 450

def clean_text(value):
    value = html.unescape(value or "")
    value = re.sub(r"<[^>]+>", " ", value)
    return re.sub(r"\s+", " ", value).strip()

def chunks(text):
    words = text.split()
    current, length = [], 0
    for word in words:
        extra = len(word) + (1 if current else 0)
        if current and length + extra > MAX_CHARS:
            yield " ".join(current)
            current, length = [word], len(word)
        else:
            current.append(word)
            length += extra
    if current:
        yield " ".join(current)

def _mymemory(chunk):
    r = requests.get(
        "https://api.mymemory.translated.net/get",
        params={"q": chunk, "langpair": "en|ar"},
        headers={"User-Agent": "StockNewsAlertBot/1.0"},
        timeout=TIMEOUT,
    )
    r.raise_for_status()
    data = r.json()
    text = (data.get("responseData") or {}).get("translatedText") or ""
    return clean_text(text)

def _google(chunk):
    r = requests.get(
        "https://translate.googleapis.com/translate_a/single",
        params={"client": "gtx", "sl": "auto", "tl": "ar", "dt": "t", "q": chunk},
        headers={"User-Agent": "Mozilla/5.0"},
        timeout=TIMEOUT,
    )
    r.raise_for_status()
    data = r.json()
    return "".join(p[0] for p in (data[0] if data else []) if p and p[0]).strip()

def translate_to_arabic(text):
    text = clean_text(text)
    if not text:
        return ""
    output = []
    for chunk in chunks(text):
        translated = ""
        for attempt in range(3):
            try:
                translated = _mymemory(chunk)
                if translated:
                    break
            except Exception as exc:
                print(f"[translator] MyMemory attempt {attempt+1}: {exc}")
                time.sleep(2 * (attempt + 1))
        if not translated:
            for attempt in range(2):
                try:
                    translated = _google(chunk)
                    if translated:
                        break
                except Exception as exc:
                    print(f"[translator] Google attempt {attempt+1}: {exc}")
                    time.sleep(2 * (attempt + 1))
        if not translated:
            return ""
        output.append(translated)
    return " ".join(output).strip()

def translate_news(title, summary):
    return translate_to_arabic(title), translate_to_arabic(summary)
