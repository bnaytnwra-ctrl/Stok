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


def get_current_price(ticker: str) -> float | None:
    """يرجع السعر الحالي للسهم أو None إذا فشل الطلب أو المفتاح غير مفعّل."""
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
        print(f"[price_filter] تعذّر جلب سعر {ticker}: {exc}")
        return None


def is_price_in_range(ticker: str) -> tuple[bool, float | None]:
    """يرجع (هل السعر ضمن النطاق المستهدف؟, السعر الحالي)."""
    price = get_current_price(ticker)
    if price is None:
        # لا يمكن التأكد من السعر -> لا نرسل تنبيهًا احتياطًا من نتيجة خاطئة
        return False, None
    return MIN_PRICE <= price <= MAX_PRICE, price
