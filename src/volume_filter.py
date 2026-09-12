# -*- coding: utf-8 -*-
"""
فلتر اختياري لتأكيد أن الخبر مصحوب بارتفاع فعلي في حجم التداول (volume spike).
معطّل افتراضيًا (ENABLE_VOLUME_SPIKE_FILTER = False في config.py) لأنه يحتاج
مصدر بيانات إضافي (مثل Finnhub candles أو yfinance)، وقد يبطئ الفلترة.
فعّله لاحقًا بعد التأكد من استقرار البوت بدونه.
"""

import requests

from config import FINNHUB_API_KEY, VOLUME_SPIKE_MULTIPLIER

REQUEST_TIMEOUT = 8


def has_volume_spike(ticker: str) -> bool:
    """
    مقارنة بسيطة: حجم آخر شمعة يومية مقابل متوسط آخر 10 أيام.
    تُرجع True لو الحجم الحالي >= VOLUME_SPIKE_MULTIPLIER × المتوسط.
    ملاحظة: نسخة Finnhub المجانية قد لا تدعم بيانات الحجم التاريخية لكل الأسهم
    الرخيصة (OTC خصوصًا) - اختبرها قبل الاعتماد عليها فعليًا.
    """
    if not FINNHUB_API_KEY or not ticker:
        return True  # لا نمنع التنبيه لو الفلتر غير قابل للتطبيق حاليًا

    try:
        response = requests.get(
            "https://finnhub.io/api/v1/stock/candle",
            params={
                "symbol": ticker,
                "resolution": "D",
                "count": 11,
                "token": FINNHUB_API_KEY,
            },
            timeout=REQUEST_TIMEOUT,
        )
        response.raise_for_status()
        data = response.json()
        volumes = data.get("v", [])
        if len(volumes) < 2:
            return True
        latest_volume = volumes[-1]
        avg_prior_volume = sum(volumes[:-1]) / len(volumes[:-1])
        if avg_prior_volume == 0:
            return True
        return latest_volume >= VOLUME_SPIKE_MULTIPLIER * avg_prior_volume
    except Exception as exc:  # noqa: BLE001
        print(f"[volume_filter] تعذّر التحقق من حجم {ticker}: {exc}")
        return True
