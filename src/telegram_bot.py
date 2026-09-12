# -*- coding: utf-8 -*-
"""إرسال الرسائل إلى تلجرام عبر Bot API الرسمي."""

import requests

from config import TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID

REQUEST_TIMEOUT = 10


def send_telegram_message(text: str) -> bool:
    """يرسل رسالة نصية إلى القناة/المحادثة المحددة. يرجع True عند النجاح."""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        print("[telegram_bot] بيانات تلجرام غير مكتملة (تحقق من GitHub Secrets).")
        return False

    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": False,
    }
    try:
        response = requests.post(url, json=payload, timeout=REQUEST_TIMEOUT)
        response.raise_for_status()
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"[telegram_bot] فشل إرسال الرسالة: {exc}")
        return False


def format_alert_message(ticker: str, title: str, price, link: str, timestamp: str) -> str:
    price_display = f"${price:.2f}" if price is not None else "غير متوفر"
    return (
        f"🚨 <b>تنبيه سهم رخيص</b>\n"
        f"الرمز: <b>{ticker}</b>\n"
        f"الخبر: {title}\n"
        f"السعر التقريبي: {price_display}\n"
        f"الرابط: {link}\n"
        f"وقت الرصد: {timestamp} UTC"
    )


def send_error_alert(error_text: str):
    """تنبيه مختصر عند حدوث خطأ غير متوقع أثناء التشغيل، حتى ينتبه لها المطور."""
    send_telegram_message(f"⚠️ <b>خطأ في بوت التنبيهات</b>\n{error_text}")
