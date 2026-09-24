# -*- coding: utf-8 -*-
import csv, os, sys, time, traceback
from datetime import datetime, timezone
sys.path.insert(0, os.path.dirname(__file__))
from config import LOG_CSV_PATH,POLL_INTERVAL_SECONDS,WINDOWS_UTC,ENABLE_VOLUME_SPIKE_FILTER
from dedup import SeenNewsStore
from keyword_filter import passes_keyword_filter
from news_sources import fetch_all_news,fetch_sec_edgar
from price_filter import is_price_in_range
from telegram_bot import format_alert_message,send_error_alert,send_telegram_message
from ticker_extractor import extract_ticker
from translator import translate_news
from volume_filter import has_volume_spike

def _current_window_end(now):
    for w in WINDOWS_UTC:
        s=now.replace(hour=w['start'][0],minute=w['start'][1],second=0,microsecond=0); e=now.replace(hour=w['end'][0],minute=w['end'][1],second=0,microsecond=0)
        if s<=now<=e:return e,w['name']
    return None,None

def _log(ticker,title,price,source,link,score,published):
    os.makedirs(os.path.dirname(LOG_CSV_PATH),exist_ok=True); new=not os.path.exists(LOG_CSV_PATH)
    with open(LOG_CSV_PATH,'a',newline='',encoding='utf-8') as f:
        w=csv.writer(f)
        if new:w.writerow(['timestamp_utc','ticker','title_ar','price','source','link','score','published'])
        w.writerow([datetime.now(timezone.utc).isoformat(),ticker,title,price,source,link,score,published])

def process_one_pass(store,stats):
    for item in fetch_all_news()+fetch_sec_edgar():
        if not store.is_new(item['id']): continue
        store.mark_seen(item['id']); stats['new']+=1
        ok,score,_=passes_keyword_filter((item.get('title','')+' '+item.get('summary','')))
        if not ok: continue
        ticker=extract_ticker(item.get('title','')+' '+item.get('summary',''))
        if not ticker: continue
        in_range,price=is_price_in_range(ticker)
        if not in_range: continue
        if ENABLE_VOLUME_SPIKE_FILTER and not has_volume_spike(ticker): continue
        title_ar,summary_ar=translate_news(item.get('title',''),item.get('summary',''))
        if not summary_ar: continue
        msg=format_alert_message(ticker,title_ar or item.get('title',''),summary_ar,item.get('published',''),price,item.get('link',''),item.get('source',''),score)
        if send_telegram_message(msg):
            _log(ticker,title_ar or item.get('title',''),price,item.get('source',''),item.get('link',''),score,item.get('published','')); stats['alerts_sent']+=1

def run():
    end,name=_current_window_end(datetime.now(timezone.utc))
    if end is None: print('[main] خارج نافذة التشغيل.'); return
    store=SeenNewsStore(); stats={'new':0,'alerts_sent':0}
    try:
        while datetime.now(timezone.utc)<=end:
            process_one_pass(store,stats); time.sleep(POLL_INTERVAL_SECONDS)
    except Exception:
        err=traceback.format_exc(); print(err); send_error_alert(err)
    finally: store.save(); print('[main] ملخص:',stats)

if __name__=='__main__': run()
