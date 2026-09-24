# -*- coding: utf-8 -*-
"""إعدادات بوت أخبار Biotech/FDA."""

import os

TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")
FINNHUB_API_KEY = os.environ.get("FINNHUB_API_KEY", "")

MIN_PRICE = 0.10
MAX_PRICE = 4.00

# مرتان يوميًا بتوقيت السعودية (UTC+3). لا نغيّر بنية GitHub Actions.
WINDOWS_UTC = [
    {"name": "الفحص الأول", "start": (10, 0), "end": (12, 30)},
    {"name": "الفحص الثاني", "start": (19, 30), "end": (20, 30)},
]
POLL_INTERVAL_SECONDS = 7

RSS_FEEDS = {
    "prnewswire": "https://www.prnewswire.com/rss/news-releases-list.rss",
    "businesswire": "https://feed.businesswire.com/rss/home/?rss=G1QFDERJXkJeEFpVAg==",
    "globenewswire": "https://www.globenewswire.com/RssFeed/orgclass/1/feedTitle/GlobeNewswire%20-%20News%20about%20Public%20Companies",
    "newsfile": "https://feeds.newsfilecorp.com/global/Last25Stories",
}
SEC_USER_AGENT = "StockNewsBot admin@example.com"
SEC_EDGAR_RSS = "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&company=&dateb=&owner=include&count=100&output=atom"

POSITIVE_KEYWORDS = {
    "fda approval": 7, "fda clearance": 7, "fda": 4, "pdufa": 7,
    "advisory committee": 7, "adcom": 7, "phase 3": 6, "phase 2": 5,
    "phase 1": 4, "clinical trial": 4, "clinical study": 4,
    "topline results": 6, "positive results": 6, "interim results": 5,
    "primary endpoint": 5, "endpoint": 3, "nda": 5, "bla": 5, "snda": 5,
    "new drug application": 5, "biologics license application": 5,
    "regulatory decision": 5, "regulatory milestone": 5,
    "clinical hold": 4, "clinical update": 4, "clinical milestone": 5, "clinical-stage": 4, "drug candidate": 4, "dosing": 4, "dose escalation": 5, "patient enrollment": 4, "patients enrolled": 4, "interim data": 5, "study data": 4, "clinical data": 5, "trial data": 5, "protocol amendment": 4, "partnership": 3, "licensing agreement": 4,
    "strategic collaboration": 3, "breakthrough therapy": 6,
    "fast track": 4, "orphan drug": 4, "patent": 2, "readout": 5, "data readout": 6, "data": 2, "patient dosed": 4, "first patient": 4, "enrollment": 3, "protocol": 3, "study completion": 4, "last patient": 4, "milestone": 3,
}
NEGATIVE_KEYWORDS = {
    "bankruptcy": -8, "chapter 11": -8, "delisting": -7, "dilution": -5,
    "public offering": -5, "offering": -4, "reverse split": -5,
    "going concern": -5, "restatement": -5, "investigation": -4,
    "lawsuit": -3, "clinical trial failed": -7, "failed primary endpoint": -7,
}
POSITIVE_SCORE_THRESHOLD = 4
DOMAIN_KEYWORDS = {
    "biotech", "biotechnology", "biopharma", "pharma", "pharmaceutical",
    "clinical", "fda", "pdufa", "drug", "therapy", "therapeutic",
    "oncology", "cancer", "rare disease", "gene therapy", "cell therapy",
    "medical", "healthcare", "biologics", "therapeutics", "therapeutics", "biosciences", "pharmaceuticals", "pharmaceutical", "clinical-stage", "drug candidate", "nda", "bla", "adcom",
}
UPCOMING_CATALYST_KEYWORDS = {
    "upcoming", "expected", "scheduled", "set for", "anticipated", "will announce",
    "data readout", "readout expected", "results expected", "results will be",
    "pdufa date", "action date", "decision date", "adcom date", "meeting date",
    "conference call", "presentation", "to present", "will present", "plans to present", "fourth quarter", "q4 2026", "q3 2026", "next week", "tomorrow", "this month"
}
STRONG_CATALYST_KEYWORDS = {
    "fda approval", "fda clearance", "pdufa", "advisory committee", "adcom",
    "phase 3", "phase 2", "topline results", "primary endpoint", "readout", "data readout", "topline results", "clinical data", "interim data", "trial data",
    "nda", "bla", "snda", "regulatory decision", "breakthrough therapy", "patient dosed", "study completion", "milestone",
}
ENABLE_VOLUME_SPIKE_FILTER = False
VOLUME_SPIKE_MULTIPLIER = 3.0
LOG_CSV_PATH = "logs/alerts_log.csv"
SEEN_IDS_PATH = "logs/seen_ids.json"
SEEN_IDS_RETENTION_DAYS = 30
SEC_RETEST_MARKER_PATH = "logs/sec_retest_v2.done"

