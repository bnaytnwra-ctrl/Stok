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
from volume_filter import has_volume_spike

def _current_window_end(now):
    for w in WINDOWS_UTC:
        s=now.replace(hour=w['start'][0],minute=w['start'][1],second=0,microsecond=0)
        e=now.replace(hour=w['end'][0],minute=w['end'][1],second=0,microsecond=0)
        if s<=now<=e:
            return e,w['name']
    return None,None

def _log(ticker,title,price,source,link,score,published):
    os.makedirs(os.path.dirname(LOG_CSV_PATH),exist_ok=True)
    new=not os.path.exists(LOG_CSV_PATH)
    with open(LOG_CSV_PATH,'a',newline='',encoding='utf-8') as f:
        w=csv.writer(f)
        if new:
            w.writerow(['timestamp_utc','ticker','title_ar','price','source','link','score','published'])
        w.writerow([datetime.now(timezone.utc).isoformat(),ticker,title,price,source,link,score,published])

def process_one_pass(store,stats):
    items=fetch_all_news()+fetch_sec_edgar()
    stats['fetched']+=len(items)
    for item in items:
        if not store.is_new(item['id']):
            stats['duplicates']+=1
            continue

        text=(item.get('title','')+' '+item.get('summary','')).strip()
        ok,score,matched=passes_keyword_filter(text)
        if not ok:
            stats['keyword_rejected']+=1
            print('[FILTER] رفض | score='+str(score)+' | matched='+', '.join(matched)+' | '+item.get('title','')[:220])
            continue

        stats['keyword_pass']+=1
        ticker=extract_ticker(text)
        if not ticker:
            stats['ticker_rejected']+=1
            continue

        stats['ticker_pass']+=1
        in_range,price=is_price_in_range(ticker)
        if not in_range:
            stats['price_rejected']+=1
            print('[main] مرشح '+ticker+' مستبعد سعرياً: $'+str(price))
            store.mark_seen(item['id'])
            continue

        stats['price_pass']+=1
        print('[main] مرشح مؤهل: '+ticker+' $'+str(price)+' | score='+str(score))

        if ENABLE_VOLUME_SPIKE_FILTER and not has_volume_spike(ticker):
            stats['volume_rejected']+=1
            store.mark_seen(item['id'])
            continue

        # الترجمة معطلة مؤقتاً لاختبار وصول التنبيهات عبر Telegram.
        # نرسل العنوان والملخص الأصليين، وبعد ثبات الإرسال نعيد الترجمة العربية.
        original_title=item.get('title','')
        original_summary=item.get('summary','')
        msg=format_alert_message(
            ticker,
            original_title,
            original_summary,
            item.get('published',''),
            price,
            item.get('link',''),
            item.get('source',''),
            score
        )

        if send_telegram_message(msg):
            store.mark_seen(item['id'])
            _log(
                ticker,
                original_title,
                price,
                item.get('source',''),
                item.get('link',''),
                score,
                item.get('published','')
            )
            stats['alerts_sent']+=1
            print('[main] تم إرسال التنبيه: '+ticker)
        else:
            stats['telegram_failed']+=1
            print('[main] فشل إرسال Telegram للمرشح '+ticker+' - سيعاد في الفحص القادم')

def run():
    force_scan=os.environ.get('FORCE_SCAN','').lower()=='true'
    end,name=_current_window_end(datetime.now(timezone.utc))
    if end is None and not force_scan:
        print('[main] خارج نافذة التشغيل.')
        return

    store=SeenNewsStore()
    stats={
        'fetched':0,
        'new':0,
        'duplicates':0,
        'keyword_pass':0,
        'keyword_rejected':0,
        'ticker_pass':0,
        'ticker_rejected':0,
        'price_pass':0,
        'price_rejected':0,
        'volume_rejected':0,
        'alerts_sent':0,
        'telegram_failed':0
    }

    try:
        if force_scan:
            print('[main] فحص يدوي مباشر')
            process_one_pass(store,stats)
        else:
            while datetime.now(timezone.utc)<=end:
                process_one_pass(store,stats)
                time.sleep(POLL_INTERVAL_SECONDS)
    except Exception:
        err=traceback.format_exc()
        print(err)
        send_error_alert(err)
    finally:
        store.save()
        print('[main] ملخص:',stats)

if __name__=='__main__':
    run()
