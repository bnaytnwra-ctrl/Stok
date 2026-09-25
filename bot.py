#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
bot.py
------
بوت تنبيهات أخبار أسهم البيوتك/FDA الرخيصة (Penny Biotech/FDA News Bot)
نظام "المسارين المزدوجين" (Dual-Mode):

  1) تقويم المحفزات المستقبلية (Catalyst Calendar) - يعمل مرة واحدة يوميًا.
  2) الأخبار العاجلة القوية (Real-Time Breakthrough News) - يعمل بشكل شبه
     مباشر (فحص كل بضع ثوانٍ) خلال نافذة تشغيل GitHub Actions.

متغيرات البيئة المطلوبة (GitHub Secrets):
    TELEGRAM_TOKEN أو TELEGRAM_BOT_TOKEN  - توكن بوت تلجرام (أي اسم منهما)
    TELEGRAM_CHAT_ID                      - معرّف المحادثة/القناة
    FINNHUB_API_KEY                       - مفتاح Finnhub المجاني (لفلتر السعر،
                                            مع بديل Yahoo تلقائي عند فشله)

تشغيل:
    python bot.py --mode test        # فحص شامل + رسالة اختبار (يُنصح به أولًا)
    python bot.py --mode calendar    # تقويم المحفزات فقط
    python bot.py --mode realtime    # الأخبار العاجلة فقط
    python bot.py --mode realtime --once   # فحص لحظي لمرة واحدة (للتجربة اليدوية)
    python bot.py --mode both        # كلاهما (وضع التشغيل المجدول)
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
import signal
import sys
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


def _env(name: str, default: str = "") -> str:
    """قراءة متغير بيئة مع إزالة المسافات/الأسطر الزائدة (سبب شائع لفشل الإرسال)."""
    return (os.environ.get(name, default) or "").strip()


# --- متغيرات البيئة / الأسرار (نقبل كلا الاسمين الشائعين للتوكن) ---
TELEGRAM_TOKEN = _env("TELEGRAM_TOKEN") or _env("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = _env("TELEGRAM_CHAT_ID")
FINNHUB_API_KEY = _env("FINNHUB_API_KEY")

# --- نطاق السعر المستهدف (Penny Stocks) ---
PRICE_MIN = float(_env("PRICE_MIN", "0.10") or 0.10)
PRICE_MAX = float(_env("PRICE_MAX", "4.00") or 4.00)

# --- إعدادات تقويم المحفزات ---
CALENDAR_WINDOW_DAYS_MAX = int(_env("CALENDAR_WINDOW_DAYS_MAX", "7") or 7)
CALENDAR_LOOKBACK_DAYS = int(_env("CALENDAR_LOOKBACK_DAYS", "21") or 21)
# إرسال ملخص قصير حتى عند عدم وجود محفزات (حتى يعرف المستخدم أن البوت يعمل)
CALENDAR_EMPTY_SUMMARY = _env("CALENDAR_EMPTY_SUMMARY", "true").lower() == "true"

# --- إعدادات الفحص اللحظي ---
SCAN_INTERVAL_SECONDS = int(_env("SCAN_INTERVAL_SECONDS", "7") or 7)
REALTIME_WINDOW_MINUTES = int(_env("REALTIME_WINDOW_MINUTES", "25") or 25)
REALTIME_SINGLE_PASS = _env("REALTIME_SINGLE_PASS", "false").lower() == "true"
# تجاهل الأخبار المنشورة قبل هذا العمر (حماية من تنبيهات قديمة عند أول تشغيل)
REALTIME_MAX_AGE_HOURS = int(_env("REALTIME_MAX_AGE_HOURS", "48") or 48)

# --- ترجمة العناوين للعربية في التنبيهات (اختياري، مع بديل تلقائي) ---
TRANSLATE_AR = _env("TRANSLATE_AR", "true").lower() == "true"

# --- الاحتفاظ بمعرّفات الأخبار المعالجة سابقاً ---
SEEN_IDS_RETENTION_DAYS = int(_env("SEEN_IDS_RETENTION_DAYS", "14") or 14)

# --- مسارات الملفات: اكتشاف جذر المستودع تلقائيًا ---
# (يعمل سواء كان bot.py في الجذر أو داخل src/)
def _find_repo_root() -> Path:
    here = Path(__file__).resolve().parent
    for candidate in (here, here.parent):
        if (candidate / ".github").exists() or (candidate / "requirements.txt").exists():
            return candidate
    return here


BASE_DIR = _find_repo_root()
LOG_DIR = BASE_DIR / "logs"
SEEN_IDS_PATH = LOG_DIR / "seen_ids.json"
ALERTS_LOG_PATH = LOG_DIR / "alerts_log.csv"

# --- تغذيات RSS ---
FEEDS = {
    "PR Newswire - Biotech": "https://www.prnewswire.com/rss/health-latest-news/biotechnology-latest-news-list.rss",
    "GlobeNewswire - Biotechnology": "https://www.globenewswire.com/RssFeed/subjectcode/17-Biotechnology/feedTitle/GlobeNewswire%20-%20Biotechnology",
    "GlobeNewswire - Life Sciences": "https://www.globenewswire.com/RssFeed/industry/9573-Biotechnology/feedTitle/GlobeNewswire%20-%20Industry%20News%20on%20Biotechnology",
    "FDA - Press Releases": "https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/press-releases/rss.xml",
}

HTTP_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; StockNewsBot/2.0)"}
FEED_TIMEOUT = 30
TELEGRAM_TIMEOUT = 20
TELEGRAM_MAX_LEN = 4000  # حد تلجرام 4096، نترك هامش أمان

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

# --- سياق للتأكد أن الخبر بيوتك/FDA فعلاً ---
BIOTECH_CONTEXT_KEYWORDS = [
    "fda", "clinical", "trial", "biotech", "pharmaceutical", "therapeutics",
    "phase 1", "phase 2", "phase 3", "phase i", "phase ii", "phase iii",
    "drug", "therapy", "oncology", "vaccine", "biopharmaceutical", "nda", "bla",
]

TICKER_PATTERN = re.compile(
    r"(?:\((?:NASDAQ|NYSE(?:\s+American)?|AMEX|TSX|TSXV|CSE|NEO|OTCQB|OTCQX|OTC(?:\s+Pink)?)\s*[:\-]\s*"
    r"|\b(?:NASDAQ|NYSE|AMEX|TSX|TSXV|CSE|OTC|OTCQB|OTCQX)\s*[:\-]\s*"
    r"|\b(?:Ticker|Symbol)\s*[:\-]\s*"
    r"|\$)([A-Z]{1,6})\)?",
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

# ترجمة أخطاء تلجرام الشائعة لرسائل عربية واضحة
TELEGRAM_ERROR_HINTS = {
    "unauthorized": "التوكن غير صحيح — تحقق من TELEGRAM_TOKEN في Secrets وأعد نسخه من BotFather.",
    "chat not found": "تعذّر العثور على المحادثة — تحقق من TELEGRAM_CHAT_ID، وتأكد أنك بدأت محادثة مع البوت (/start) أو أضفته للقناة كمشرف.",
    "bot was blocked by the user": "البوت محظور لديك — افتح المحادثة مع البوت واضغط Start ثم أعد الاختبار.",
    "bot was kicked": "البوت مطرود من المجموعة/القناة — أعد إضافته كمشرف.",
    "not enough rights": "صلاحيات ناقصة — اجعل البوت مشرفًا في القناة مع صلاحية النشر.",
    "can't parse entities": "خطأ تنسيق داخلي (أُعيدت المحاولة كنص عادي تلقائيًا).",
    "message is too long": "الرسالة أطول من حد تلجرام (يتم تقسيمها تلقائيًا).",
    "too many requests": "تم تجاوز حد الإرسال مؤقتًا — سيُعاد الإرسال في الفحص التالي.",
}


def _hint_for_telegram_error(description: str) -> str:
    desc = (description or "").lower()
    for key, hint in TELEGRAM_ERROR_HINTS.items():
        if key in desc:
            return hint
    return "راجع قيمة TELEGRAM_TOKEN و TELEGRAM_CHAT_ID في Secrets."


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


def escape_html(text: str) -> str:
    return html.escape(text or "", quote=False)


def load_seen_ids() -> dict:
    if not SEEN_IDS_PATH.exists():
        return {}
    try:
        with open(SEEN_IDS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        log.warning("تعذر قراءة seen_ids.json، سيتم البدء بقاموس فارغ")
        return {}


def save_seen_ids(seen: dict) -> None:
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        with open(SEEN_IDS_PATH, "w", encoding="utf-8") as f:
            json.dump(seen, f, ensure_ascii=False, indent=2)
    except OSError as exc:
        log.warning("تعذر حفظ seen_ids.json: %s", exc)


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


# حفظ تلقائي عند إيقاف GitHub Actions للعملية (timeout/cancel)
_seen_for_signal: Optional[dict] = None


def _handle_termination(signum, frame):  # noqa: ANN001, ANN202
    log.warning("استلام إشارة إيقاف (%s) — حفظ التقدم والخروج بسلام", signum)
    try:
        if _seen_for_signal is not None:
            save_seen_ids(prune_old_seen_ids(_seen_for_signal))
            log.info("تم حفظ seen_ids قبل الخروج")
    finally:
        sys.exit(143)


signal.signal(signal.SIGTERM, _handle_termination)
signal.signal(signal.SIGINT, _handle_termination)


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
        writer.writerow({k: row.get(k, "") for k in fieldnames})


def extract_ticker(text: str) -> Optional[str]:
    if not text:
        return None
    match = TICKER_PATTERN.search(text)
    if match:
        return match.group(1).upper()
    return None


def entry_published_dt(entry) -> Optional[datetime]:
    for attr in ("published_parsed", "updated_parsed"):
        parsed = getattr(entry, attr, None)
        if parsed:
            try:
                return datetime(*parsed[:6], tzinfo=timezone.utc)
            except (ValueError, TypeError):
                continue
    return None


# ============================================================================
# جلب الأسعار: Finnhub أولًا ثم Yahoo كبديل تلقائي
# ============================================================================

_last_price_call_ts = 0.0
_MIN_SECONDS_BETWEEN_PRICE_CALLS = 1.1  # احترام حد Finnhub المجاني (~60 طلب/دقيقة)


def _throttle_price_calls() -> None:
    global _last_price_call_ts
    elapsed = time.monotonic() - _last_price_call_ts
    if elapsed < _MIN_SECONDS_BETWEEN_PRICE_CALLS:
        time.sleep(_MIN_SECONDS_BETWEEN_PRICE_CALLS - elapsed)
    _last_price_call_ts = time.monotonic()


def _get_price_finnhub(ticker: str) -> Optional[float]:
    if not FINNHUB_API_KEY or not ticker:
        return None
    _throttle_price_calls()
    try:
        resp = requests.get(
            "https://finnhub.io/api/v1/quote",
            params={"symbol": ticker, "token": FINNHUB_API_KEY},
            timeout=10,
        )
        if resp.status_code == 401:
            log.warning("مفتاح Finnhub مرفوض (401) — تحقق من FINNHUB_API_KEY")
            return None
        if resp.status_code == 429:
            log.warning("تجاوز حد Finnhub المجاني (429) — سيُستخدم البديل")
            return None
        resp.raise_for_status()
        price = resp.json().get("c")
        if price in (None, 0):
            return None
        return float(price)
    except (requests.RequestException, ValueError) as exc:
        log.warning("تعذر جلب سعر %s من Finnhub: %s", ticker, exc)
        return None


def _get_price_yahoo(ticker: str) -> Optional[float]:
    """بديل مجاني بتغطية أوسع لأسهم OTC مقارنة بـ Finnhub المجاني."""
    if not ticker:
        return None
    # المحاولة 1: واجهة الرسم البياني v8
    try:
        resp = requests.get(
            f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}",
            params={"interval": "1d", "range": "5d"},
            headers=HTTP_HEADERS,
            timeout=10,
        )
        resp.raise_for_status()
        results = (resp.json().get("chart") or {}).get("result") or []
        if results:
            price = (results[0].get("meta") or {}).get("regularMarketPrice")
            if price not in (None, 0):
                return float(price)
    except (requests.RequestException, ValueError, KeyError) as exc:
        log.debug("Yahoo v8 فشل لـ %s: %s", ticker, exc)
    # المحاولة 2: واجهة الاقتباس v7
    try:
        resp = requests.get(
            "https://query1.finance.yahoo.com/v7/finance/quote",
            params={"symbols": ticker},
            headers=HTTP_HEADERS,
            timeout=10,
        )
        resp.raise_for_status()
        results = (resp.json().get("quoteResponse") or {}).get("result", [])
        if results:
            price = results[0].get("regularMarketPrice")
            if price not in (None, 0):
                return float(price)
    except (requests.RequestException, ValueError) as exc:
        log.debug("Yahoo v7 فشل لـ %s: %s", ticker, exc)
    return None


def get_price(ticker: str) -> tuple[Optional[float], str]:
    """يرجع (السعر، اسم المصدر) أو (None, 'none') عند الفشل."""
    if not ticker:
        return None, "none"
    price = _get_price_finnhub(ticker)
    if price is not None:
        return price, "finnhub"
    price = _get_price_yahoo(ticker)
    if price is not None:
        return price, "yahoo"
    log.warning("تعذّر تأكيد سعر %s من Finnhub ولا Yahoo — سيُتجاهل الخبر احترازيًا", ticker)
    return None, "none"


def verify_finnhub() -> bool:
    """فحص سريع لصلاحية مفتاح Finnhub (تحذير فقط، لوجود بديل Yahoo)."""
    if not FINNHUB_API_KEY:
        log.warning("FINNHUB_API_KEY غير مُعرّف — سيُستخدم Yahoo فقط لفلتر السعر")
        return False
    try:
        resp = requests.get(
            "https://finnhub.io/api/v1/quote",
            params={"symbol": "AAPL", "token": FINNHUB_API_KEY},
            timeout=10,
        )
        if resp.status_code == 401:
            log.warning("مفتاح Finnhub غير صالح (401) — سيُستخدم Yahoo فقط")
            return False
        resp.raise_for_status()
        log.info("فحص Finnhub: المفتاح يعمل ✅")
        return True
    except requests.RequestException as exc:
        log.warning("فحص Finnhub تعذّر (%s) — سيُستخدم Yahoo كبديل", exc)
        return False


# ============================================================================
# الترجمة (اختيارية، مع بديل تلقائي للنص الأصلي)
# ============================================================================

_translation_cache: dict[str, str] = {}


def translate_text_ar(text: str) -> str:
    text = clean_text(text)
    if not text or not TRANSLATE_AR:
        return text
    cache_key = make_id(text[:200])
    if cache_key in _translation_cache:
        return _translation_cache[cache_key]
    try:
        r = requests.get(
            "https://api.mymemory.translated.net/get",
            params={"q": text[:300], "langpair": "en|ar"},
            timeout=12,
        )
        translated = (r.json().get("responseData") or {}).get("translatedText") or ""
        translated = clean_text(translated)
        # تجاهل رسائل تجاوز الحصة
        if translated and "MYMEMORY WARNING" not in translated.upper() and "QUERY LENGTH LIMIT" not in translated.upper():
            _translation_cache[cache_key] = translated
            return translated
    except Exception as exc:  # noqa: BLE001
        log.debug("فشلت الترجمة، سيُستخدم النص الأصلي: %s", exc)
    return text


# ============================================================================
# تلجرام: إرسال موثوق + تشخيص واضح للأخطاء
# ============================================================================


def telegram_api(method: str, payload: dict, timeout: int = TELEGRAM_TIMEOUT) -> tuple[int, dict]:
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/{method}"
    resp = requests.post(url, json=payload, timeout=timeout)
    try:
        data = resp.json()
    except ValueError:
        data = {}
    return resp.status_code, data if isinstance(data, dict) else {}


def verify_telegram() -> tuple[bool, str]:
    """التحقق من التوكن والمحادثة قبل بدء العمل. يرجع (نجح؟، رسالة تشخيصية)."""
    if not TELEGRAM_TOKEN:
        return False, "TELEGRAM_TOKEN/TELEGRAM_BOT_TOKEN غير مُعرّف في Secrets."
    if not TELEGRAM_CHAT_ID:
        return False, "TELEGRAM_CHAT_ID غير مُعرّف في Secrets."
    try:
        status, data = telegram_api("getMe", {})
    except requests.RequestException as exc:
        return False, f"تعذّر الاتصال بـ Telegram API (شبكة؟): {exc}"
    if status == 401 or not data.get("ok"):
        desc = data.get("description", "Unauthorized")
        return False, f"التوكن مرفوض من تلجرام ({desc}). {_hint_for_telegram_error(desc)}"
    bot_user = (data.get("result") or {}).get("username", "?")
    log.info("فحص التوكن: البوت @%s ✅", bot_user)

    try:
        status, data = telegram_api("getChat", {"chat_id": TELEGRAM_CHAT_ID})
    except requests.RequestException as exc:
        return False, f"تعذّر التحقق من المحادثة (شبكة؟): {exc}"
    if status != 200 or not data.get("ok"):
        desc = data.get("description", "unknown error")
        return False, f"فشل الوصول للمحادثة ({desc}). {_hint_for_telegram_error(desc)}"
    result = data.get("result") or {}
    chat_label = result.get("title") or result.get("username") or result.get("first_name") or result.get("type")
    log.info("فحص المحادثة: %s (%s) ✅", chat_label, result.get("type"))
    return True, f"البوت @{bot_user} يصل للمحادثة: {chat_label}"


def _send_single_message(text: str, parse_mode: Optional[str] = "HTML") -> tuple[bool, str]:
    payload: dict = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": text,
        "disable_web_page_preview": False,
    }
    if parse_mode:
        payload["parse_mode"] = parse_mode
    try:
        status, data = telegram_api("sendMessage", payload)
    except requests.RequestException as exc:
        return False, f"خطأ شبكة أثناء الإرسال: {exc}"
    if status == 200 and data.get("ok"):
        return True, ""
    desc = data.get("description", f"HTTP {status}")
    # إعادة المحاولة كنص عادي عند فشل تنسيق HTML
    if parse_mode and status == 400 and "can't parse entities" in desc.lower():
        log.warning("فشل تنسيق HTML — إعادة المحاولة كنص عادي")
        plain = re.sub(r"<[^>]+>", "", text)
        return _send_single_message(plain, parse_mode=None)
    # انتظار بسيط عند تجاوز حد الإرسال ثم محاولة واحدة إضافية
    if status == 429:
        retry_after = int((data.get("parameters") or {}).get("retry_after", 5))
        log.warning("حد الإرسال (429) — انتظار %d ثانية ثم إعادة المحاولة", retry_after)
        time.sleep(min(retry_after, 60) + 1)
        try:
            status2, data2 = telegram_api("sendMessage", payload)
        except requests.RequestException as exc:
            return False, f"خطأ شبكة أثناء الإرسال: {exc}"
        if status2 == 200 and data2.get("ok"):
            return True, ""
        desc = data2.get("description", f"HTTP {status2}")
    return False, f"{desc} — {_hint_for_telegram_error(desc)}"


def send_telegram(message: str) -> bool:
    """إرسال رسالة (مع تقسيم تلقائي للرسائل الطويلة). يرجع True عند نجاح كل الأجزاء."""
    if not TELEGRAM_TOKEN or not TELEGRAM_CHAT_ID:
        log.error("TELEGRAM_TOKEN أو TELEGRAM_CHAT_ID غير مُعرّفين في متغيرات البيئة")
        return False
    # تقسيم الرسائل الطويلة على حدود الفقرات
    chunks: list[str] = []
    if len(message) <= TELEGRAM_MAX_LEN:
        chunks = [message]
    else:
        current = ""
        for para in message.split("\n\n"):
            if len(current) + len(para) + 2 <= TELEGRAM_MAX_LEN:
                current = f"{current}\n\n{para}" if current else para
            else:
                if current:
                    chunks.append(current)
                # فقرة واحدة أطول من الحد: قصّها
                while len(para) > TELEGRAM_MAX_LEN:
                    chunks.append(para[:TELEGRAM_MAX_LEN])
                    para = para[TELEGRAM_MAX_LEN:]
                current = para
        if current:
            chunks.append(current)
        log.info("تم تقسيم الرسالة الطويلة إلى %d أجزاء", len(chunks))

    all_ok = True
    for i, chunk in enumerate(chunks, 1):
        if len(chunks) > 1:
            chunk = f"({i}/{len(chunks)})\n{chunk}"
        ok, err = _send_single_message(chunk)
        if not ok:
            log.error("فشل إرسال رسالة تلجرام (جزء %d/%d): %s", i, len(chunks), err)
            all_ok = False
        elif len(chunks) > 1:
            time.sleep(1)
    return all_ok


# ============================================================================
# جلب التغذيات (مع User-Agent حقيقي + بدائل)
# ============================================================================


def fetch_feed(source_name: str, feed_url: str):
    """يجلب تغذية RSS ويعيد كائن feedparser. يرمي استثناءً عند الفشل الحقيقي."""
    last_err = None
    try:
        resp = requests.get(feed_url, headers=HTTP_HEADERS, timeout=FEED_TIMEOUT)
        resp.raise_for_status()
        parsed = feedparser.parse(resp.content)
        if parsed.entries:
            return parsed
        last_err = parsed.get("bozo_exception") or "empty feed via requests"
        log.debug("التغذية %s أعادت 0 خبر عبر requests — تجربة المباشر", source_name)
    except requests.RequestException as exc:
        last_err = exc
        log.debug("requests فشل لـ %s (%s) — تجربة feedparser المباشر", source_name, exc)
    # بديل: feedparser المباشر
    parsed = feedparser.parse(feed_url)
    if parsed.entries:
        return parsed
    raise RuntimeError(f"{source_name}: {last_err or parsed.get('bozo_exception') or 'empty feed'}")


# ============================================================================
# فلاتر الكلمات المفتاحية
# ============================================================================


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


# ترجمة/تلخيص مبسّط بالعربية لنوع المحفز
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


# ============================================================================
# القسم الأول: تقويم المحفزات المستقبلية (Scheduled Catalyst Calendar)
# ============================================================================


def run_calendar_mode(seen: dict) -> dict:
    log.info("=== بدء فحص تقويم المحفزات القادمة ===")
    run_date = utcnow()
    cutoff_published = run_date - timedelta(days=CALENDAR_LOOKBACK_DAYS)
    found_events = []
    seen_tickers_dates = set()
    stats = {"feeds_ok": 0, "feeds_failed": 0, "entries": 0, "no_context": 0,
             "no_catalyst_kw": 0, "no_event_date": 0, "no_ticker": 0,
             "price_rejected": 0, "already_sent": 0}

    for source_name, feed_url in FEEDS.items():
        try:
            parsed_feed = fetch_feed(source_name, feed_url)
        except Exception as exc:  # noqa: BLE001
            stats["feeds_failed"] += 1
            log.warning("تعذر تحميل تغذية %s: %s", source_name, exc)
            continue
        stats["feeds_ok"] += 1
        log.info("التغذية %s: %d خبر", source_name, len(parsed_feed.entries))

        for entry in parsed_feed.entries:
            stats["entries"] += 1
            published_dt = entry_published_dt(entry)
            if published_dt and published_dt < cutoff_published:
                continue

            title = clean_text(getattr(entry, "title", ""))
            summary = clean_text(getattr(entry, "summary", ""))
            full_text = f"{title} {summary}"
            text_lower = full_text.lower()

            if not is_biotech_context(text_lower):
                stats["no_context"] += 1
                continue

            catalyst_kw = find_catalyst_keyword(text_lower)
            if not catalyst_kw:
                stats["no_catalyst_kw"] += 1
                continue

            event_date = extract_future_event_date(full_text, run_date)
            if event_date is None:
                stats["no_event_date"] += 1
                continue

            ticker = extract_ticker(full_text)
            if not ticker:
                stats["no_ticker"] += 1
                continue

            dedup_key = f"{ticker}:{event_date.date().isoformat()}"
            if dedup_key in seen_tickers_dates:
                continue
            seen_tickers_dates.add(dedup_key)

            # منع إعادة إرسال نفس المحفز في التشغيلات التالية
            cal_seen_key = make_id("calendar", dedup_key)
            if cal_seen_key in seen:
                stats["already_sent"] += 1
                continue

            price, price_source = get_price(ticker)
            if price is None or not (PRICE_MIN <= price <= PRICE_MAX):
                stats["price_rejected"] += 1
                log.info("التقويم: %s مرفوض سعريًا ($%s من %s)", ticker, price, price_source)
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
                "seen_key": cal_seen_key,
            })

    log.info("ملخص التقويم: %s", stats)

    if not found_events:
        log.info("لم يتم العثور على محفزات جديدة تطابق الشروط")
        if CALENDAR_EMPTY_SUMMARY:
            summary_msg = (
                "🗓️ <b>تقويم المحفزات — لا جديد</b>\n\n"
                f"تم فحص {stats['entries']} خبر من {stats['feeds_ok']} مصادر، "
                "ولا توجد محفزات جديدة ضمن النطاق السعري "
                f"(${PRICE_MIN:.2f}–${PRICE_MAX:.2f}).\n"
                f"🕒 آخر فحص: {run_date.strftime('%Y-%m-%d %H:%M')} UTC\n"
                "✅ البوت يعمل بشكل طبيعي."
            )
            send_telegram(summary_msg)
        return seen

    found_events.sort(key=lambda e: e["event_date"])

    lines = ["🗓️ <b>تقويم المحفزات القادمة</b>", ""]
    for ev in found_events:
        title_ar = translate_text_ar(ev["title"][:200])
        lines.append(
            f"• <b>{escape_html(ev['ticker'])}</b> — ${ev['price']:.2f}\n"
            f"   📅 {ev['event_date'].strftime('%Y-%m-%d')} | {escape_html(ev['catalyst_type'])}\n"
            f"   {escape_html(title_ar[:180])}\n"
            f"   🔗 {escape_html(ev['url'])}"
        )
        lines.append("")

    message = "\n".join(lines).strip()
    sent_ok = send_telegram(message)

    if sent_ok:
        for ev in found_events:
            seen[ev["seen_key"]] = run_date.isoformat()
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
        save_seen_ids(seen)
        log.info("تم إرسال تقويم المحفزات (%d محفز جديد)", len(found_events))
    else:
        log.error("فشل إرسال تقويم المحفزات — سيُعاد في التشغيل القادم")

    return seen


# ============================================================================
# القسم الثاني: الأخبار العاجلة القوية (Real-Time Breakthrough News)
# ============================================================================


def scan_feeds_once(seen: dict, stats: dict) -> dict:
    now = utcnow()
    max_age = timedelta(hours=REALTIME_MAX_AGE_HOURS)
    for source_name, feed_url in FEEDS.items():
        try:
            parsed_feed = fetch_feed(source_name, feed_url)
        except Exception as exc:  # noqa: BLE001
            log.warning("تعذر تحميل تغذية %s: %s", source_name, exc)
            continue

        for entry in parsed_feed.entries:
            stats["entries"] += 1
            entry_id_raw = getattr(entry, "id", None) or getattr(entry, "link", "")
            entry_id = make_id("news", source_name, entry_id_raw)
            if entry_id in seen:
                stats["duplicates"] += 1
                continue

            title = clean_text(getattr(entry, "title", ""))
            summary = clean_text(getattr(entry, "summary", ""))
            full_text = f"{title} {summary}"
            text_lower = full_text.lower()

            if not is_biotech_context(text_lower):
                stats["no_context"] += 1
                seen[entry_id] = now.isoformat()
                continue

            breakthrough_kw = find_breakthrough_keyword(text_lower)
            if not breakthrough_kw:
                stats["no_breakthrough_kw"] += 1
                seen[entry_id] = now.isoformat()
                continue

            # تجاهل الأخبار القديمة (أقدم من الحد) حتى لو مطابقة
            published_dt = entry_published_dt(entry)
            if published_dt and (now - published_dt) > max_age:
                stats["too_old"] += 1
                seen[entry_id] = now.isoformat()
                log.info("خبر قديم تم تجاهله (%s): %s", published_dt.date(), title[:100])
                continue

            ticker = extract_ticker(full_text)
            if not ticker:
                stats["no_ticker"] += 1
                seen[entry_id] = now.isoformat()
                log.info("خبر مطابق بلا رمز سهم (%s): %s", breakthrough_kw, title[:120])
                continue

            price, price_source = get_price(ticker)
            if price is None or not (PRICE_MIN <= price <= PRICE_MAX):
                stats["price_rejected"] += 1
                log.info("مرفوض سعريًا: %s ($%s من %s) | %s", ticker, price, price_source, title[:100])
                seen[entry_id] = now.isoformat()
                continue

            url = getattr(entry, "link", "")
            catalyst_ar = BREAKTHROUGH_AR_LABELS.get(breakthrough_kw, breakthrough_kw)
            title_ar = translate_text_ar(title[:200])

            message = (
                "🚨 <b>خبر عاجل - محفز بيوتك مباشر</b>\n\n"
                f"🏷️ الرمز: <b>{escape_html(ticker)}</b>\n"
                f"💲 السعر الحالي: ${price:.2f}\n"
                f"⚡ نوع الخبر: {escape_html(catalyst_ar)}\n"
                f"📝 الخبر: {escape_html(title_ar[:250])}\n"
                f"🔗 الرابط: {escape_html(url)}"
            )
            sent_ok = send_telegram(message)

            # نسجّل المعرّف فقط بعد محاولة الإرسال (لو فشل الإرسال يُعاد لاحقًا)
            if sent_ok:
                seen[entry_id] = now.isoformat()
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
                stats["alerts_sent"] += 1
                log.info("تم إرسال تنبيه عاجل: %s (%s)", ticker, breakthrough_kw)
            else:
                stats["telegram_failed"] += 1
                log.error("فشل إرسال تنبيه %s — سيُعاد في الفحص القادم", ticker)

    return seen


def run_realtime_mode(seen: dict, single_pass: bool = False) -> dict:
    stats: dict = {"entries": 0, "duplicates": 0, "no_context": 0,
                   "no_breakthrough_kw": 0, "too_old": 0, "no_ticker": 0,
                   "price_rejected": 0, "alerts_sent": 0, "telegram_failed": 0}

    if single_pass:
        log.info("=== فحص لحظي لمرة واحدة (وضع التجربة) ===")
        try:
            seen = scan_feeds_once(seen, stats)
        except Exception as exc:  # noqa: BLE001
            log.error("خطأ غير متوقع أثناء الفحص: %s", exc)
        save_seen_ids(prune_old_seen_ids(seen))
        log.info("ملخص الفحص: %s", stats)
        return seen

    log.info("=== بدء الفحص اللحظي للأخبار العاجلة (نافذة %d دقيقة) ===", REALTIME_WINDOW_MINUTES)
    window_end = utcnow() + timedelta(minutes=REALTIME_WINDOW_MINUTES)

    while utcnow() < window_end:
        try:
            seen = scan_feeds_once(seen, stats)
        except Exception as exc:  # noqa: BLE001
            log.error("خطأ غير متوقع أثناء الفحص اللحظي: %s", exc)
        save_seen_ids(prune_old_seen_ids(seen))
        remaining = (window_end - utcnow()).total_seconds()
        if remaining <= 0:
            break
        time.sleep(min(SCAN_INTERVAL_SECONDS, remaining))

    save_seen_ids(prune_old_seen_ids(seen))
    log.info("انتهت نافذة الفحص اللحظي. الملخص: %s", stats)
    return seen


# ============================================================================
# وضع الاختبار: تشخيص شامل + رسالة تجربة
# ============================================================================


def run_test_mode() -> int:
    """يفحص كل شيء (الأسرار، تلجرام، Finnhub، التغذيات) ويرسل رسالة اختبار."""
    log.info("=== وضع الاختبار الشامل ===")
    log.info("جذر المستودع المكتشف: %s", BASE_DIR)
    log.info("مسار السجلات: %s", LOG_DIR)
    log.info("النطاق السعري: $%.2f – $%.2f", PRICE_MIN, PRICE_MAX)
    log.info(
        "الأسرار: TELEGRAM_TOKEN=%s | TELEGRAM_CHAT_ID=%s | FINNHUB_API_KEY=%s",
        "موجود ✅" if TELEGRAM_TOKEN else "مفقود ❌",
        "موجود ✅" if TELEGRAM_CHAT_ID else "مفقود ❌",
        "موجود ✅" if FINNHUB_API_KEY else "مفقود ⚠️ (سيُستخدم Yahoo)",
    )

    ok_telegram, telegram_msg = verify_telegram()
    log.info("فحص تلجرام: %s — %s", "ناجح ✅" if ok_telegram else "فاشل ❌", telegram_msg)

    finnhub_ok = verify_finnhub()

    feeds_ok = 0
    for source_name, feed_url in FEEDS.items():
        try:
            parsed = fetch_feed(source_name, feed_url)
            log.info("التغذية %s: %d خبر ✅", source_name, len(parsed.entries))
            feeds_ok += 1
        except Exception as exc:  # noqa: BLE001
            log.warning("التغذية %s: فشلت ❌ (%s)", source_name, exc)

    if not ok_telegram:
        log.error("الاختبار فشل: أصلح إعدادات تلجرام أولًا. %s", telegram_msg)
        return 1

    test_msg = (
        "✅ <b>اختبار بوت تنبيهات البيوتك</b>\n\n"
        f"{escape_html(telegram_msg)}\n"
        f"📡 التغذيات العاملة: {feeds_ok}/{len(FEEDS)}\n"
        f"💲 Finnhub: {'يعمل ✅' if finnhub_ok else 'بديل Yahoo ⚠️'}\n"
        f"🕒 {utcnow().strftime('%Y-%m-%d %H:%M')} UTC\n\n"
        "إذا وصلكت هذه الرسالة فالتنبيهات ستصلك بشكل طبيعي 🎉"
    )
    if send_telegram(test_msg):
        log.info("تم إرسال رسالة الاختبار بنجاح ✅ — تحقق من تلجرام")
        return 0
    log.error("فشل إرسال رسالة الاختبار ❌")
    return 1


# ============================================================================
# نقطة الدخول الرئيسية
# ============================================================================


def main() -> int:
    parser = argparse.ArgumentParser(description="بوت تنبيهات أخبار البيوتك/FDA الرخيصة")
    parser.add_argument(
        "--mode",
        choices=["calendar", "realtime", "both", "test"],
        default=_env("RUN_MODE", "both") or "both",
        help="calendar: تقويم المحفزات | realtime: الأخبار العاجلة | both: كلاهما | test: اختبار شامل",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="فحص لحظي لمرة واحدة بدل النافذة الزمنية (للتجربة اليدوية)",
    )
    args = parser.parse_args()
    single_pass = args.once or REALTIME_SINGLE_PASS

    log.info("الإصدار: bot.py v2.1 | الوضع: %s | لمرة واحدة: %s", args.mode, single_pass)
    log.info("جذر المستودع: %s", BASE_DIR)

    if args.mode == "test":
        return run_test_mode()

    # فحص تلجرام أولًا: لا فائدة من الفحص إن كان الإرسال مستحيلًا
    ok_telegram, telegram_msg = verify_telegram()
    if not ok_telegram:
        log.error("إعدادات تلجرام غير صالحة — لن تصل أي تنبيهات! %s", telegram_msg)
        return 1
    log.info("تلجرام جاهز: %s", telegram_msg)
    verify_finnhub()

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    seen = prune_old_seen_ids(load_seen_ids())
    log.info("تم تحميل %d معرّفًا سابقًا (بعد التنظيف)", len(seen))

    global _seen_for_signal
    _seen_for_signal = seen

    try:
        if args.mode in ("calendar", "both"):
            seen = run_calendar_mode(seen)
            _seen_for_signal = seen
            save_seen_ids(seen)

        if args.mode in ("realtime", "both"):
            seen = run_realtime_mode(seen, single_pass=single_pass)
            _seen_for_signal = seen
            save_seen_ids(seen)
    finally:
        save_seen_ids(prune_old_seen_ids(seen))

    log.info("انتهى التشغيل بنجاح (mode=%s)", args.mode)
    return 0


if __name__ == "__main__":
    sys.exit(main())
