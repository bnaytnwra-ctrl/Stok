# -*- coding: utf-8 -*-
"""
نقطة التشغيل الرئيسية.

آلية العمل (تحل مشكلة تعارض الجدولة المذكورة بالمراجعة):
- GitHub Actions يشغّل هذا السكربت مرة واحدة فقط عند بداية كل نافذة
  (عبر cron مضبوط على بداية النافذة بالضبط، راجع alert.yml).
- السكربت نفسه يحسب "نهاية النافذة الحالية" بتوقيت UTC، ثم يدخل في حلقة
  داخلية تفحص الأخبار كل POLL_INTERVAL_SECONDS ثانية حتى تنتهي النافذة،
  وبعدها يخرج تلقائيًا وتنتهي التشغيلة (job) بشكل طبيعي.
- بما أن توقيت السعودية لا يتغير موسميًا (لا يوجد توقيت صيفي بالسعودية)،
  فإن نوافذ UTC المحددة في config.py ثابتة طوال السنة ولا تحتاج تعديل.
"""

import csv
import os
import sys
import time
import traceback
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(__file__))

from config import LOG_CSV_PATH, POLL_INTERVAL_SECONDS, WINDOWS_UTC, ENABLE_VOLUME_SPIKE_FILTER
from dedup import SeenNewsStore
from keyword_filter import passes_keyword_filter
from news_sources import fetch_all_news, fetch_sec_edgar
from price_filter import is_price_in_range
from telegram_bot import format_alert_message, send_error_alert, send_telegram_message
from ticker_extractor import extract_ticker
from volume_filter import has_volume_spike


def _current_window_end(now: datetime):
    """يحدد نهاية النافذة الحالية إذا كان الوقت الآن داخل إحدى النوافذ، وإلا None."""
    for window in WINDOWS_UTC:
        start_h, start_m = window["start"]
        end_h, end_m = window["end"]
        start = now.replace(hour=start_h, minute=start_m, second=0, microsecond=0)
        end = now.replace(hour=end_h, minute=end_m, second=0, microsecond=0)
        if start <= now <= end:
            return end, window["name"]
    return None, None


def _ensure_log_header():
    if not os.path.exists(LOG_CSV_PATH):
        os.makedirs(os.path.dirname(LOG_CSV_PATH), exist_ok=True)
        with open(LOG_CSV_PATH, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(
                ["timestamp_utc", "ticker", "title", "price", "source", "link", "score"]
            )


def _log_alert(ticker, title, price, source, link, score):
    _ensure_log_header()
    with open(LOG_CSV_PATH, "a", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(
            [datetime.now(timezone.utc).isoformat(), ticker, title, price, source, link, score]
        )


def process_one_pass(store: SeenNewsStore):
    """فحص واحد لكل المصادر، وإرسال تنبيهات للأخبار الجديدة المطابقة."""
    all_news = fetch_all_news() + fetch_sec_edgar()

    for item in all_news:
        news_id = item["id"]
        if not store.is_new(news_id):
            continue

        # نعتبر الخبر "مُعالَجًا" فور فحصه (سواء طابق الفلاتر أم لا) لتجنب إعادة فحصه
        store.mark_seen(news_id)

        full_text = f"{item['title']} {item['summary']}"

        passed_keywords, score, matched = passes_keyword_filter(full_text)
        if not passed_keywords:
            continue

        ticker = extract_ticker(full_text)
        if not ticker:
            continue

        in_range, price = is_price_in_range(ticker)
        if not in_range:
            continue

        if ENABLE_VOLUME_SPIKE_FILTER and not has_volume_spike(ticker):
            continue

        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        message = format_alert_message(ticker, item["title"], price, item["link"], timestamp)
        send_telegram_message(message)
        _log_alert(ticker, item["title"], price, item["source"], item["link"], score)
        print(f"[main] تم إرسال تنبيه: {ticker} - {item['title']} (نقاط: {score})")


def run():
    now = datetime.now(timezone.utc)
    window_end, window_name = _current_window_end(now)

    if window_end is None:
        print("[main] الوقت الحالي خارج نوافذ التشغيل المحددة - لا حاجة للتشغيل.")
        return

    print(f"[main] بدء المراقبة ضمن نافذة '{window_name}' حتى {window_end.isoformat()} UTC")

    store = SeenNewsStore()

    try:
        while datetime.now(timezone.utc) <= window_end:
            process_one_pass(store)
            time.sleep(POLL_INTERVAL_SECONDS)
    except Exception:  # noqa: BLE001 - نريد تسجيل أي خطأ غير متوقع وتبليغ المطور
        error_text = traceback.format_exc()
        print(f"[main] خطأ غير متوقع:\n{error_text}")
        send_error_alert(error_text[-500:])  # آخر 500 حرف كافية للتشخيص السريع
    finally:
        store.save()
        print("[main] انتهت النافذة أو توقف التشغيل، تم حفظ سجل الأخبار المُعالَجة.")


if __name__ == "__main__":
    run()
