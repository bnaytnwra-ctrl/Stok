# -*- coding: utf-8 -*-
"""
الإعدادات العامة للبوت.
كل القيم القابلة للتعديل موجودة هنا حصرًا حتى يسهل تحسينها لاحقًا
بدون لمس باقي الكود.
"""

import os

# ---------------------------------------------------------------------------
# بيانات تلجرام (تُقرأ من GitHub Secrets عبر متغيرات البيئة، لا تُكتب هنا مباشرة)
# ---------------------------------------------------------------------------
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")

# مفتاح Finnhub المجاني (اختياري لكن مطلوب لتفعيل فلتر السعر بدقة)
FINNHUB_API_KEY = os.environ.get("FINNHUB_API_KEY", "")

# ---------------------------------------------------------------------------
# نطاق السعر المستهدف (Penny Stocks)
# ---------------------------------------------------------------------------
MIN_PRICE = 0.10
MAX_PRICE = 4.00

# ---------------------------------------------------------------------------
# نوافذ التشغيل (بتوقيت السعودية UTC+3 - ثابت طوال السنة لأن السعودية لا تطبّق
# التوقيت الصيفي، لذلك المعادل بتوقيت UTC ثابت هو الآخر ولا يحتاج تعديل موسمي)
# ---------------------------------------------------------------------------
# كل نافذة: (ساعة البداية UTC, دقيقة البداية, ساعة النهاية UTC, دقيقة النهاية)
WINDOWS_UTC = [
    {"name": "pre-market", "start": (10, 0), "end": (12, 30)},
    {"name": "after-hours", "start": (19, 30), "end": (20, 30)},
]

# مدة الانتظار بين كل فحص للأخبار (بالثواني)
POLL_INTERVAL_SECONDS = 7

# ---------------------------------------------------------------------------
# مصادر الأخبار (RSS مجانية)
# ---------------------------------------------------------------------------
RSS_FEEDS = {
    "globenewswire": "https://www.globenewswire.com/rss-feed/organization",
    "prnewswire": "https://www.prnewswire.com/rss/news-releases-list.rss",
    "businesswire": "https://feed.businesswire.com/rss/home/?rss=G1QFDERJXkJeEFpVAg==",
    "accesswire": "https://www.accesswire.com/rss/newsroom",
}

# SEC EDGAR يشترط User-Agent يحتوي على معلومات تواصل حقيقية (اسم/بريد)
# غيّر القيمة التالية لبريدك الفعلي قبل التشغيل، وإلا SEC قد يحظر الطلبات
SEC_USER_AGENT = "StockNewsBot admin@example.com"
SEC_EDGAR_RSS = (
    "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent"
    "&type=8-K&company=&dateb=&owner=include&count=100&output=atom"
)

# ---------------------------------------------------------------------------
# نظام تقييم الكلمات المفتاحية (Scoring) بدل الفلترة الثنائية الصارمة
# كل كلمة إيجابية تضيف نقاطها، كل كلمة سلبية تطرح نقاطها.
# يُعتبر الخبر مقبولاً إذا كان المجموع >= POSITIVE_SCORE_THRESHOLD
# ---------------------------------------------------------------------------
POSITIVE_KEYWORDS = {
    "contract": 3,
    "awarded": 3,
    "fda approval": 5,
    "fda clearance": 5,
    "acquisition": 4,
    "merger": 4,
    "partnership": 3,
    "breakthrough": 3,
    "record revenue": 4,
    "positive results": 3,
    "uplisting": 4,
    "strategic alliance": 3,
    "patent granted": 3,
    "definitive agreement": 3,
}

NEGATIVE_KEYWORDS = {
    "bankruptcy": -6,
    "chapter 11": -6,
    "delisting": -5,
    "dilution": -4,
    "going concern": -5,
    "offering": -3,
    "reverse split": -4,
    "restatement": -4,
    "investigation": -3,
    "lawsuit": -2,
}

POSITIVE_SCORE_THRESHOLD = 3

# ---------------------------------------------------------------------------
# فلتر ارتفاع حجم التداول (اختياري - قابل للتفعيل لاحقًا)
# ---------------------------------------------------------------------------
ENABLE_VOLUME_SPIKE_FILTER = False
VOLUME_SPIKE_MULTIPLIER = 3.0  # الحجم الحالي >= 3x متوسط الحجم

# ---------------------------------------------------------------------------
# ملفات السجلّ والتخزين المحلي
# ---------------------------------------------------------------------------
LOG_CSV_PATH = "logs/alerts_log.csv"
SEEN_IDS_PATH = "logs/seen_ids.json"

# أقصى عدد أيام تُحفظ فيها معرّفات الأخبار المكررة (لمنع تضخم الملف بلا حدود)
SEEN_IDS_RETENTION_DAYS = 14
