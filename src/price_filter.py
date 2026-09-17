# -*- coding: utf-8 -*-
"""
التحقق من سعر السهم الحالي عبر Finnhub (النسخة المجانية).
حد Finnhub المجاني تقريبًا 60 طلب/دقيقة، لذلك نضيف تهدئة بسيطة (throttle)
لتجنب تجاوز الحد عند ورود عدة أخبار بنفس اللحظة.
"""

import time

import requests

from config import FINNHUB_API_KEY, MAX_PRICE, MIN_PRICE

REQUEST_TIMEOUT = 8
_MIN_SECONDS_BETWEEN_CALLS = 1.1  # ~54 طلب/دقيقة كحد أقصى، أقل من حد Finnhub بأمان
_last_call_ts = 0.0


def _throttle():
    global _last_call_ts
    elapsed = time.monotonic() - _last_call_ts
    if elapsed < _MIN_SECONDS_BETWEEN_CALLS:
        time.sleep(_MIN_SECONDS_BETWEEN_CALLS - elapsed)
    _last_call_ts = time.monotonic()


# -*- coding: utf-8 -*-
"""
التحقق من سعر السهم الحالي.
المصدر الأول: Finnhub (النسخة المجانية) - سريع وموثوق لكن تغطيته لأسهم
OTC/Pink Sheets (وهي غالب أسهمنا المستهدفة) ضعيفة أو معدومة أحيانًا.
المصدر الاحتياطي: Yahoo Finance (غير رسمي لكن مجاني) - تغطية أوسع لـ OTC،
يُستخدم فقط لو Finnhub رجع بدون نتيجة.
"""

import time

import requests

from config import FINNHUB_API_KEY, MAX_PRICE, MIN_PRICE

REQUEST_TIMEOUT = 8
_MIN_SECONDS_BETWEEN_CALLS = 1.1  # ~54 طلب/دقيقة كحد أقصى، أقل من حد Finnhub بأمان
_last_call_ts = 0.0


def _throttle():
    global _last_call_ts
    elapsed = time.monotonic() - _last_call_ts
    if elapsed < _MIN_SECONDS_BETWEEN_CALLS:
        time.sleep(_MIN_SECONDS_BETWEEN_CALLS - elapsed)
    _last_call_ts = time.monotonic()


def _get_price_finnhub(ticker: str) -> float | None:
    if not FINNHUB_API_KEY or not ticker:
        return None

    _throttle()
    try:
        response = requests.get(
            "https://finnhub.io/api/v1/quote",
            params={"symbol": ticker, "token": FINNHUB_API_KEY},
            timeout=REQUEST_TIMEOUT,
        )
        response.raise_for_status()
        data = response.json()
        price = data.get("c")  # current price
        if price in (None, 0):
            return None
        return float(price)
    except Exception as exc:  # noqa: BLE001
        print(f"[price_filter] Finnhub: تعذّر جلب سعر {ticker}: {exc}")
        return None


def _get_price_yahoo(ticker: str) -> float | None:
    """احتياطي مجاني (غير رسمي) - تغطية أوسع لأسهم OTC مقارنة بـ Finnhub المجاني."""
    if not ticker:
        return None
    try:
        response = requests.get(
            "https://query1.finance.yahoo.com/v7/finance/quote",
            params={"symbols": ticker},
            headers={"User-Agent": "Mozilla/5.0 (compatible; StockNewsBot/1.0)"},
            timeout=REQUEST_TIMEOUT,
        )
        response.raise_for_status()
        results = response.json().get("quoteResponse", {}).get("result", [])
        if not results:
            return None
        price = results[0].get("regularMarketPrice")
        if price in (None, 0):
            return None
        return float(price)
    except Exception as exc:  # noqa: BLE001
        print(f"[price_filter] Yahoo: تعذّر جلب سعر {ticker}: {exc}")
        return None


def get_current_price(ticker: str) -> tuple[float | None, str]:
    """يرجع (السعر, اسم المصدر اللي نجح) أو (None, 'none') لو فشل الاثنين."""
    price = _get_price_finnhub(ticker)
    if price is not None:
        return price, "finnhub"

    price = _get_price_yahoo(ticker)
    if price is not None:
        return price, "yahoo"

    return None, "none"


def is_price_in_range(ticker: str) -> tuple[bool, float | None]:
    """يرجع (هل السعر ضمن النطاق المستهدف؟, السعر الحالي)."""
    price, source = get_current_price(ticker)
    if price is None:
        # لا يمكن التأكد من السعر من أي مصدر -> لا نرسل تنبيهًا احتياطًا
        print(f"[price_filter] {ticker}: تعذّر تأكيد السعر من Finnhub ولا Yahoo.")
        return False, None
    print(f"[price_filter] {ticker}: السعر ${price} (المصدر: {source})")
    return MIN_PRICE <= price <= MAX_PRICE, price
