#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
bot.py
------
بوت تنبيهات أخبار أسهم البيوتك/FDA الرخيصة (Penny Biotech/FDA News Bot)
نظام "المسارين المزدوجين" (Dual-Mode):

  1) tقويم المحفزات المستقبلية (Catalyst Calendar) - يعمل مرة واحدة يوميًا.
  2) الأخبار العاجلة القوية (Real-Time Breakthrough News) - يعمل بشكل شبه
     مباشر (فحص كل بضع ثوانٍ) خلال نافذة تشغيل GitHub Actions.

الاعتماديات: feedparser, requests, beautifulsoup4, python-dateutil
متغيرات البيئة المطلوبة (GitHub Secrets):
    TELEGRAM_TOKEN     - توكن بوت تلجرام
    TELEGRAM_CHAT_ID   - معرّف المحادثة/القناة
    FINNHUB_API_KEY    - مفتاح Finnhub المجاني (لفلتر السعر)

تشغيل يدوي:
    python src/bot.py --mode calendar     # تقويم المحفزات فقط
    python src/bot.py --mode realtime     # الأخبار العاجلة فقط
    python src/bot.py --mode both         # كلاهما (افتراضي عند عدم التحديد)
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import html
import json
import logging
import os
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import feedparser
import requests
from bs4 import BeautifulSoup

try:
    from dateutil import parser as dateutil_parser
except ImportError:  # pragma: no cover
    dateutil_parser = None

# ============================================================================
# الإعدادات العامة (Config)
# ============================================================================

# --- متغيرات البيئة / الأسرار (يتم الحفاظ على نفس الأسماء الحالية) ---
TELEGRAM_TOKEN = os.environ.get("TELEGRAM_TOKEN") or os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")
FINNHUB_API_KEY = os.environ.get("FINNHUB_API_KEY", "")

# --- نطاق السعر المستهدف (Penny Stocks) ---
PRICE_MIN = float(os.environ.get("PRICE_MIN", "0.10"))
PRICE_MAX = float(os.environ.get("PRICE_MAX", "4.00"))

# --- إعدادات تقويم المحفزات ---
CALENDAR_WINDOW_DAYS_MIN = int(os.environ.get("CALENDAR_WINDOW_DAYS_MIN", "5"))
CALENDAR_WINDOW_DAYS_MAX = int(os.environ.get("CALENDAR_WINDOW_DAYS_MAX", "7"))
CALENDAR_LOOKBACK_DAYS = int(os.environ.get("CALENDAR_LOOKBACK_DAYS", "21"))  # عمق البحث في الأخبار المنشورة سابقاً

# --- إعدادات الفحص اللحظي ---
SCAN_INTERVAL_SECONDS = int(os.environ.get("SCAN_INTERVAL_SECONDS", "7"))
REALTIME_WINDOW_MINUTES = int(os.environ.get("REALTIME_WINDOW_MINUTES", "25"))

# --- الاحتفاظ بمعرّفات الأخبار المعالجة سابقاً ---
SEEN_IDS_RETENTION_DAYS = int(os.environ.get("SEEN_IDS_RETENTION_DAYS", "14"))

# --- مسارات الملفات ---
BASE_DIR = Path(__file__).resolve().parent.parent
LOG_DIR = BASE_DIR / "logs"
SEEN_IDS_PATH = LOG_DIR / "seen_ids.json"
ALERTS_LOG_PATH = LOG_DIR / "alerts_log.csv"

# --- تغذيات RSS (عدّل حسب توفر الروابط أو أضف مصادر أخرى) ---
FEEDS = {
    "PR Newswire - Biotech": "https://www.prnewswire.com/rss/health-latest-news/biotechnology-latest-news-list.rss",
    "GlobeNewswire - Biotechnology": "https://www.globenewswire.com/RssFeed/subjectcode/17-Biotechnology/feedTitle/GlobeNewswire%20-%20Biotechnology",
    "GlobeNewswire - Life Sciences": "https://www.globenewswire.com/RssFeed/industry/9573-Biotechnology/feedTitle/GlobeNewswire%20-%20Industry%20News%20on%20Biotechnology",
    "FDA - Press Releases": "https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/press-releases/rss.xml",
}

# --- كلمات مفتاحية: أخبار عاجلة قوية (يرفع السهم فوراً) ---
BREAKTHROUGH_KEYWORDS = [
    "fda approval", "fda approves", "fda grants approval", "fda clearance",
    "fda clears", "510(k) clearance", "emergency use authorization", "eua granted",
    "breakthrough therapy designation", "fast track designation",
    "orphan drug designation", "priority review",
    "positive phase 3", "positive phase iii", "positive phase 2", "positive phase ii",
    "met primary endpoint", "met its primary endpoint", "topline results positive",
    "positive topline data", "strategic partnership", "licensing agreement",
    "collaboration agreement", "exclusive license agreement", "acquisition agreement",
]

# --- كلمات مفتاحية: محفزات مستقبلية (تُستخدم مع تاريخ) ---
CATALYST_KEYWORDS = [
    "pdufa date", "pdufa target action date", "anticipated in", "scheduled for",
    "results expected in", "data expected in", "topline data expected",
    "phase 3 data", "phase iii data", "phase 2 data", "phase ii data",
    "adcom meeting", "advisory committee meeting", "clinical trial completion",
    "readout expected", "data readout anticipated", "expected to report",
]

# --- سياق للتأكد أن الخبر بيوتك/FDA فعلاً (طبقة أمان إضافية فوق مصدر التغذية) ---
BIOTECH_CONTEXT_KEYWORDS = [
    "fda", "clinical", "trial", "biotech", "pharmaceutical", "therapeutics",
    "phase 1", "phase 2", "phase 3", "phase i", "phase ii", "phase iii",
    "drug", "therapy", "oncology", "vaccine", "biopharmaceutical", "nda", "bla",
]

TICKER_PATTERN = re.compile(
    r"(?:\((?:NASDAQ|NYSE(?:\s+American)?|AMEX|OTCQB|OTCQX|OTC(?:\s+Pink)?)\s*[:\-]\s*|\b(?:NASDAQ|NYSE|AMEX|OTC|OTCQB|OTCQX)\s*[:\-]\s*|\b(?:Ticker|Symbol)\s*[:\-]\s*|\$)([A-Z]{1,6})\)?",
    re.IGNORECASE,
)

DATE_PATTERNS = [
    re.compile(r"[A-Z][a-z]+ \d{1,2},? \d{4}"),          # March 15, 2027
    re.compile(r"\d{1,2}/\d{1,2}/\d{4}"),                # 3/15/2027
    re.compile(r"Q[1-4]\s+\d{4}", re.IGNORECASE),        # Q1 2027
]

QUARTER_END = {"1": (3, 31), "2": (6, 30), "3": (9, 30), "4": (12, 31)}

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("stok-bot")

# ============================================================================
# أدوات مساعدة عامة
# ============================================================================


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def make_id(*parts: str) -> str:
    raw = "|".join(p or "" for p in parts)
    return hashlib.md5(raw.encode("utf-8", errors="ignore")).hexdigest()


def clean_text(raw_html: str) -> str:
    if not raw_html:
        return ""
    text = BeautifulSoup(raw_html, "html.parser").get_text(separator=" ")
    return re.sub(r"\s+", " ", text).strip()


def load_seen_ids() -> dict:
    if not SEEN_IDS_PATH.exists():
        return {}
    try:
        with open(SEEN_IDS_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        log.warning("تعذر قراءة seen_ids.json، سيتم البدء بقاموس فارغ")
        return {}


def save_seen_ids(seen: dict) -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    with open(SEEN_IDS_PATH, "w", encoding="utf-8") as f:
        json.dump(seen, f, ensure_ascii=False, indent=2)


def prune_old_seen_ids(seen: dict) -> dict:
    cutoff = utcnow() - timedelta(days=SEEN_IDS_RETENTION_DAYS)
    pruned = {}
    for key, ts in seen.items():
        try:
            seen_dt = datetime.fromisoformat(ts)
        except (ValueError, TypeError):
            continue
        if seen_dt >= cutoff:
            pruned[key] = ts
    return pruned


def append_alert_log(row: dict) -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    file_exists = ALERTS_LOG_PATH.exists()
    fieldnames = [
        "timestamp_utc", "mode", "ticker", "price", "catalyst_type",
        "event_date", "title", "source", "url", "matched_keyword",
    ]
    with open(ALERTS_LOG_PATH, "a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        if not file_exists:
            writer.writeheader()
        writer.writerow(row)


def extract_ticker(text: str) -> Optional[str]:
    match = TICKER_PATTERN.search(text)
    if match:
        return match.group(1).upper()
    return None


def get_price(ticker: str) -> Optional[float]:
    if not ticker:
        return None
    try:
        resp = requests.get(
            "https://finnhub.io/api/v1/quote",
            params={"symbol": ticker, "token": FINNHUB_API_KEY},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        price = data.get("c")
        if price is None or price == 0:
            return None
        return float(price)
    except (requests.RequestException, ValueError, KeyError):
        log.warning("تعذر جلب سعر السهم %s من Finnhub", ticker)
        return None


def translate_text_ar(text: str) -> str:
    text = clean_text(text)
    if not text:
        return ""
    try:
        r = requests.get(
            "https://api.mymemory.translated.net/get",
            params={"q": text[:450], "langpair": "en|ar"},
            timeout=15,
        )
        translated = (r.json().get("responseData") or {}).get("translatedText") or ""
        if translated:
            return clean_text(translated)
    except Exception:
        pass
    return text


def is_biotech_context(text_lower: str) -> bool:
    return any(kw in text_lower for kw in BIOTECH_CONTEXT_KEYWORDS)


def find_breakthrough_keyword(text_lower: str) -> Optional[str]:
    for kw in BREAKTHROUGH_KEYWORDS:
        if kw in text_lower:
            return kw
    return None


def find_catalyst_keyword(text_lower: str) -> Optional[str]:
    for kw in CATALYST_KEYWORDS:
        if kw in text_lower:
            return kw
    return None


def extract_future_event_date(text: str, run_date: datetime) -> Optional[datetime]:
    """يحاول استخراج تاريخ مستقبلي قريب (خلال نافذة الأيام المحددة) من نص الخبر."""
    candidates = []
    for pattern in DATE_PATTERNS:
        candidates.extend(pattern.findall(text))

    for raw in candidates:
        parsed = None
        q_match = re.match(r"Q([1-4])\s+(\d{4})", raw, re.IGNORECASE)
        if q_match:
            month, day = QUARTER_END[q_match.group(1)]
            try:
                parsed = datetime(int(q_match.group(2)), month, day, tzinfo=timezone.utc)
            except ValueError:
                continue
        elif dateutil_parser is not None:
            try:
                parsed = dateutil_parser.parse(raw, fuzzy=True)
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
            except (ValueError, OverflowError):
                continue

        if parsed is None:
            continue

        delta_days = (parsed.date() - run_date.date()).days
        if 0 <= delta_days <= CALENDAR_WINDOW_DAYS_MAX:
            return parsed

    return None


# ترجمة/تلخيص مبسّط بالعربية لنوع المحفز (قالب ثابت وليس ترجمة آلية كاملة للنص)
BREAKTHROUGH_AR_LABELS = {
    "fda approval": "موافقة FDA رسمية على الدواء/المنتج",
    "fda approves": "موافقة FDA رسمية على الدواء/المنتج",
    "fda grants approval": "موافقة FDA رسمية على الدواء/المنتج",
    "fda clearance": "حصول المنتج على تصريح (Clearance) من FDA",
    "fda clears": "حصول المنتج على تصريح (Clearance) من FDA",
    "510(k) clearance": "تصريح FDA من نوع 510(k)",
    "emergency use authorization": "تصريح استخدام طارئ (EUA) من FDA",
    "eua granted": "تصريح استخدام طارئ (EUA) من FDA",
    "breakthrough therapy designation": "تصنيف FDA كـ Breakthrough Therapy",
    "fast track designation": "تصنيف FDA كـ Fast Track",
    "orphan drug designation": "تصنيف FDA كدواء نادر (Orphan Drug)",
    "priority review": "منح FDA مراجعة ذات أولوية (Priority Review)",
    "positive phase 3": "نتائج إيجابية لتجربة المرحلة الثالثة",
    "positive phase iii": "نتائج إيجابية لتجربة المرحلة الثالثة",
    "positive phase 2": "نتائج إيجابية لتجربة المرحلة الثانية",
    "positive phase ii": "نتائج إيجابية لتجربة المرحلة الثانية",
    "met primary endpoint": "التجربة السريرية حققت الهدف الأساسي (Primary Endpoint)",
    "met its primary endpoint": "التجربة السريرية حققت الهدف الأساسي (Primary Endpoint)",
    "topline results positive": "نتائج أولية (Topline) إيجابية",
    "positive topline data": "بيانات أولية (Topline) إيجابية",
    "strategic partnership": "عقد شراكة استراتيجية",
    "licensing agreement": "اتفاقية ترخيص",
    "collaboration agreement": "اتفاقية تعاون",
    "exclusive license agreement": "اتفاقية ترخيص حصرية",
    "acquisition agreement": "اتفاقية استحواذ",
}

CATALYST_AR_LABELS = {
    "pdufa date": "موعد PDUFA (قرار FDA المتوقع)",
    "pdufa target action date": "موعد PDUFA (قرار FDA المتوقع)",
    "anticipated in": "حدث متوقع خلال الفترة القادمة",
    "scheduled for": "حدث مجدول",
    "results expected in": "نتائج متوقعة قريباً",
    "data expected in": "بيانات متوقعة قريباً",
    "topline data expected": "بيانات أولية (Topline) متوقعة",
    "phase 3 data": "بيانات تجربة المرحلة الثالثة",
    "phase iii data": "بيانات تجربة المرحلة الثالثة",
    "phase 2 data": "بيانات تجربة المرحلة الثانية",
    "phase ii data": "بيانات تجربة المرحلة الثانية",
    "adcom meeting": "اجتماع لجنة استشارية FDA (AdCom)",
    "advisory committee meeting": "اجتماع لجنة استشارية FDA",
    "clinical trial completion": "اكتمال تجربة سريرية",
    "readout expected": "نتائج (Readout) متوقعة",
    "data readout anticipated": "نتائج (Readout) متوقعة",
    "expected to report": "من المتوقع الإعلان عن نتائج",
}


def escape_html(text: str) -> str:
    return html.escape(text or "", quote=False)


def send_telegram(message: str) -> bool:
    if not TELEGRAM_TOKEN or not TELEGRAM_CHAT_ID:
        log.error("TELEGRAM_TOKEN أو TELEGRAM_CHAT_ID غير مُعرّفين في متغيرات البيئة")
        return False
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": message,
        "parse_mode": "HTML",
        "disable_web_page_preview": False,
    }
    try:
        resp = requests.post(url, data=payload, timeout=15)
        resp.raise_for_status()
        return True
    except requests.RequestException as exc:
        log.error("فشل إرسال رسالة تلجرام: %s", exc)
        return False


# ============================================================================
# القسم الأول: تقويم المحفزات المستقبلية (Scheduled Catalyst Calendar)
# ============================================================================


def run_calendar_mode(seen: dict) -> dict:
    log.info("=== بدء فحص تقويم المحفزات القادمة ===")
    run_date = utcnow()
    cutoff_published = run_date - timedelta(days=CALENDAR_LOOKBACK_DAYS)
    found_events = []  # كل عنصر: dict(ticker, price, event_date, catalyst_ar, title, url)
    seen_tickers_dates = set()

    for source_name, feed_url in FEEDS.items():
        try:
            parsed_feed = feedparser.parse(feed_url)
        except Exception as exc:  # noqa: BLE001
            log.warning("تعذر تحميل تغذية %s: %s", source_name, exc)
            continue

        for entry in parsed_feed.entries:
            published_dt = None
            if getattr(entry, "published_parsed", None):
                published_dt = datetime(*entry.published_parsed[:6], tzinfo=timezone.utc)
            if published_dt and published_dt < cutoff_published:
                continue

            title = clean_text(getattr(entry, "title", ""))
            summary = clean_text(getattr(entry, "summary", ""))
            full_text = f"{title} {summary}"
            text_lower = full_text.lower()

            if not is_biotech_context(text_lower):
                continue

            catalyst_kw = find_catalyst_keyword(text_lower)
            if not catalyst_kw:
                continue

            event_date = extract_future_event_date(full_text, run_date)
            if event_date is None:
                continue

            ticker = extract_ticker(full_text)
            if not ticker:
                continue

            dedup_key = f"{ticker}:{event_date.date().isoformat()}"
            if dedup_key in seen_tickers_dates:
                continue
            seen_tickers_dates.add(dedup_key)

            price = get_price(ticker)
            if price is None or not (PRICE_MIN <= price <= PRICE_MAX):
                continue

            url = getattr(entry, "link", "")
            found_events.append({
                "ticker": ticker,
                "price": price,
                "event_date": event_date,
                "catalyst_type": CATALYST_AR_LABELS.get(catalyst_kw, catalyst_kw),
                "title": title,
                "url": url,
                "source": source_name,
                "matched_keyword": catalyst_kw,
            })

    if not found_events:
        log.info("لم يتم العثور على محفزات قادمة تطابق الشروط اليوم")
        return seen

    found_events.sort(key=lambda e: e["event_date"])

    lines = ["🗓️ <b>تقويم المحفزات القادمة للأيام الـ 7 المقبلة</b>", ""]
    for ev in found_events:
        lines.append(
            f"• <b>{escape_html(ev['ticker'])}</b> — ${ev['price']:.2f}\n"
            f"   📅 {ev['event_date'].strftime('%Y-%m-%d')} | {escape_html(ev['catalyst_type'])}\n"
            f"   {escape_html(ev['title'][:160])}\n"
            f"   🔗 {ev['url']}"
        )
        lines.append("")

    message = "\n".join(lines).strip()
    sent_ok = send_telegram(message)

    if sent_ok:
        for ev in found_events:
            append_alert_log({
                "timestamp_utc": run_date.isoformat(),
                "mode": "calendar",
                "ticker": ev["ticker"],
                "price": ev["price"],
                "catalyst_type": ev["catalyst_type"],
                "event_date": ev["event_date"].date().isoformat(),
                "title": ev["title"],
                "source": ev["source"],
                "url": ev["url"],
                "matched_keyword": ev["matched_keyword"],
            })
        log.info("تم إرسال تقويم المحفزات (%d محفز)", len(found_events))

    return seen


# ============================================================================
# القسم الثاني: الأخبار العاجلة القوية (Real-Time Breakthrough News)
# ============================================================================


def scan_feeds_once(seen: dict) -> dict:
    now = utcnow()
    for source_name, feed_url in FEEDS.items():
        try:
            parsed_feed = feedparser.parse(feed_url)
        except Exception as exc:  # noqa: BLE001
            log.warning("تعذر تحميل تغذية %s: %s", source_name, exc)
            continue

        for entry in parsed_feed.entries:
            entry_id_raw = getattr(entry, "id", None) or getattr(entry, "link", "")
            entry_id = make_id("news", source_name, entry_id_raw)
            if entry_id in seen:
                continue

            # نسجّل المعرّف فوراً لمنع إعادة المعالجة حتى لو لم يجتز الفلاتر
            seen[entry_id] = now.isoformat()

            title = clean_text(getattr(entry, "title", ""))
            summary = clean_text(getattr(entry, "summary", ""))
            full_text = f"{title} {summary}"
            text_lower = full_text.lower()

            if not is_biotech_context(text_lower):
                continue

            breakthrough_kw = find_breakthrough_keyword(text_lower)
            if not breakthrough_kw:
                continue

            ticker = extract_ticker(full_text)
            if not ticker:
                continue

            price = get_price(ticker)
            if price is None or not (PRICE_MIN <= price <= PRICE_MAX):
                continue

            url = getattr(entry, "link", "")
            catalyst_ar = BREAKTHROUGH_AR_LABELS.get(breakthrough_kw, breakthrough_kw)

            message = (
                "🚨 <b>خبر عاجل - محفز بيوتك مباشر</b>\n\n"
                f"🏷️ الرمز: <b>{escape_html(ticker)}</b>\n"
                f"💲 السعر الحالي: ${price:.2f}\n"
                f"⚡ نوع الخبر: {escape_html(catalyst_ar)}\n"
                f"📝 ملخص: {escape_html(title[:200])}\n"
                f"🔗 الرابط: {url}"
            )
            sent_ok = send_telegram(message)

            if sent_ok:
                append_alert_log({
                    "timestamp_utc": now.isoformat(),
                    "mode": "realtime",
                    "ticker": ticker,
                    "price": price,
                    "catalyst_type": catalyst_ar,
                    "event_date": now.date().isoformat(),
                    "title": title,
                    "source": source_name,
                    "url": url,
                    "matched_keyword": breakthrough_kw,
                })
                log.info("تم إرسال تنبيه عاجل: %s (%s)", ticker, breakthrough_kw)

    return seen


def run_realtime_mode(seen: dict) -> dict:
    log.info("=== بدء الفحص اللحظي للأخبار العاجلة (نافذة %d دقيقة) ===", REALTIME_WINDOW_MINUTES)
    window_end = utcnow() + timedelta(minutes=REALTIME_WINDOW_MINUTES)
    iteration = 0

    while utcnow() < window_end:
        iteration += 1
        try:
            seen = scan_feeds_once(seen)
        except Exception as exc:  # noqa: BLE001
            log.error("خطأ غير متوقع أثناء الفحص اللحظي: %s", exc)

        if iteration % 20 == 0:
            save_seen_ids(prune_old_seen_ids(seen))

        time.sleep(SCAN_INTERVAL_SECONDS)

    log.info("انتهت نافذة الفحص اللحظي")
    return seen


# ============================================================================
# نقطة الدخول الرئيسية
# ============================================================================


def main() -> None:
    parser = argparse.ArgumentParser(description="بوت تنبيهات أخبار البيوتك/FDA الرخيصة")
    parser.add_argument(
        "--mode",
        choices=["calendar", "realtime", "both"],
        default=os.environ.get("RUN_MODE", "both"),
        help="calendar: تقويم المحفزات فقط | realtime: الأخبار العاجلة فقط | both: كلاهما",
    )
    args = parser.parse_args()

    if not TELEGRAM_TOKEN or not TELEGRAM_CHAT_ID:
        log.error("يجب تعريف TELEGRAM_TOKEN و TELEGRAM_CHAT_ID كمتغيرات بيئة/أسرار قبل التشغيل")
        return

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    seen = prune_old_seen_ids(load_seen_ids())

    if args.mode in ("calendar", "both"):
        seen = run_calendar_mode(seen)
        save_seen_ids(seen)

    if args.mode in ("realtime", "both"):
        seen = run_realtime_mode(seen)
        save_seen_ids(seen)

    log.info("انتهى التشغيل بنجاح (mode=%s)", args.mode)


if __name__ == "__main__":
    main()
