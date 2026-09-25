# -*- coding: utf-8 -*-
"""إعدادات بوت أخبار Biotech/FDA."""
import os

TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")
FINNHUB_API_KEY = os.environ.get("FINNHUB_API_KEY", "")

MIN_PRICE = 0.10
MAX_PRICE = 4.00

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
    "prnewswire_biotech": "https://www.prnewswire.com/rss/health-latest-news/biotechnology-latest-news-list.rss",
    "globenewswire_biotech": "https://www.globenewswire.com/RssFeed/subjectcode/17-Biotechnology/feedTitle/GlobeNewswire%20-%20Biotechnology",
    "globenewswire_lifesciences": "https://www.globenewswire.com/RssFeed/industry/9573-Biotechnology/feedTitle/GlobeNewswire%20-%20Industry%20News%20on%20Biotechnology",
    "fda_press_releases": "https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/press-releases/rss.xml",
}

CATALYST_FEEDS = {
    "PR Newswire - Biotech": "https://www.prnewswire.com/rss/health-latest-news/biotechnology-latest-news-list.rss",
    "GlobeNewswire - Biotechnology": "https://www.globenewswire.com/RssFeed/subjectcode/17-Biotechnology/feedTitle/GlobeNewswire%20-%20Biotechnology",
    "GlobeNewswire - Life Sciences": "https://www.globenewswire.com/RssFeed/industry/9573-Biotechnology/feedTitle/GlobeNewswire%20-%20Industry%20News%20on%20Biotechnology",
    "FDA - Press Releases": "https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/press-releases/rss.xml",
}
CALENDAR_WINDOW_DAYS_MAX = 7
CALENDAR_LOOKBACK_DAYS = 21
CALENDAR_SEEN_PATH = "logs/catalyst_calendar_seen.json"

SEC_USER_AGENT = "StockNewsBot admin@example.com"
SEC_EDGAR_RSS = "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&owner=include&count=100&output=atom"
SEC_EDGAR_RSS_FALLBACK = "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&owner=include&count=40&output=atom"
SEC_REQUEST_TIMEOUT = 60

POSITIVE_KEYWORDS = {
    "fda approval": 7, "fda approves": 7, "fda clearance": 7, "fda": 4,
    "510(k) clearance": 7, "emergency use authorization": 7, "pdufa": 7,
    "advisory committee": 7, "adcom": 7, "breakthrough therapy designation": 7,
    "fast track designation": 6, "orphan drug designation": 6, "priority review": 6,
    "positive phase 3": 7, "positive phase iii": 7, "positive phase 2": 6,
    "positive phase ii": 6, "met primary endpoint": 7, "met its primary endpoint": 7,
    "topline results positive": 7, "positive topline data": 7, "phase 3": 6,
    "phase 2": 5, "phase 1": 4, "clinical trial": 4, "clinical study": 4,
    "topline results": 6, "positive results": 6, "interim results": 5,
    "primary endpoint": 5, "endpoint": 3, "nda": 5, "bla": 5, "snda": 5,
    "new drug application": 5, "biologics license application": 5,
    "regulatory decision": 5, "regulatory milestone": 5, "clinical hold": 4,
    "clinical update": 4, "clinical milestone": 5, "clinical-stage": 4,
    "drug candidate": 4, "dosing": 4, "dose escalation": 5, "patient enrollment": 4,
    "patients enrolled": 4, "interim data": 5, "study data": 4, "clinical data": 5,
    "trial data": 5, "readout": 5, "data readout": 6, "patient dosed": 5,
    "first patient": 4, "enrollment": 3, "study completion": 4, "last patient": 4,
    "milestone": 3, "licensing agreement": 4, "exclusive license agreement": 5,
    "strategic partnership": 3, "strategic collaboration": 3, "partnership": 3,
    "acquisition agreement": 5,
}
NEGATIVE_KEYWORDS = {
    "bankruptcy": -8, "chapter 11": -8, "delisting": -7, "dilution": -6,
    "public offering": -7, "registered direct offering": -7, "direct offering": -7,
    "private placement": -7, "atm offering": -7, "at-the-market offering": -7,
    "offering": -5, "reverse split": -8, "reverse stock split": -8,
    "going concern": -5, "restatement": -5, "investigation": -4, "lawsuit": -5,
    "class action": -6, "securities litigation": -6, "shareholder lawsuit": -6,
    "investor lawsuit": -6, "clinical trial failed": -8, "failed primary endpoint": -8,
}
POSITIVE_SCORE_THRESHOLD = 4

DOMAIN_KEYWORDS = {
    "biotech", "biotechnology", "biopharma", "pharma", "pharmaceutical", "clinical",
    "fda", "pdufa", "drug", "therapy", "therapeutic", "oncology", "cancer",
    "rare disease", "gene therapy", "cell therapy", "medical", "healthcare",
    "biologics", "therapeutics", "biosciences", "pharmaceuticals", "clinical-stage",
    "drug candidate", "nda", "bla", "adcom", "trial",
}
UPCOMING_CATALYST_KEYWORDS = {
    "upcoming", "expected", "scheduled", "set for", "anticipated", "will announce",
    "data readout", "readout expected", "results expected", "results will be",
    "pdufa date", "action date", "decision date", "adcom date", "meeting date",
    "conference call", "presentation", "to present", "will present", "plans to present",
    "next week", "tomorrow", "this month",
}
STRONG_CATALYST_KEYWORDS = {
    "fda approval", "fda approves", "fda clearance", "pdufa", "advisory committee",
    "adcom", "phase 3", "phase 2", "topline results", "primary endpoint", "readout",
    "data readout", "clinical data", "interim data", "trial data", "nda", "bla", "snda",
    "regulatory decision", "breakthrough therapy designation", "fast track designation",
    "orphan drug designation", "priority review", "510(k) clearance",
    "emergency use authorization", "patient dosed", "study completion", "milestone",
    "met primary endpoint", "positive topline data", "licensing agreement", "acquisition agreement",
}

ENABLE_VOLUME_SPIKE_FILTER = False
VOLUME_SPIKE_MULTIPLIER = 3.0
LOG_CSV_PATH = "logs/alerts_log.csv"
SEEN_IDS_PATH = "logs/seen_ids.json"
SEEN_IDS_RETENTION_DAYS = 30
SEC_RETEST_MARKER_PATH = "logs/sec_retest_v5.done"
