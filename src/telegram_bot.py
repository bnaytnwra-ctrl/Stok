# -*- coding: utf-8 -*-
import html, requests
from config import TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID

def _safe(value): return html.escape(value or '', quote=False)

def send_telegram_message(text):
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        print('[telegram_bot] بيانات Telegram غير مكتملة.'); return False
    try:
        r=requests.post('https://api.telegram.org/bot'+TELEGRAM_BOT_TOKEN+'/sendMessage',json={'chat_id':TELEGRAM_CHAT_ID,'text':text,'parse_mode':'HTML','disable_web_page_preview':False},timeout=10)
        if not r.ok:
            print('[telegram_bot] HTTP', r.status_code, r.text[:1000])
            return False
        data=r.json()
        if not data.get('ok', False):
            print('[telegram_bot] API', data)
            return False
        return True
    except Exception as exc:
        print(f'[telegram_bot] فشل الإرسال: {exc}'); return False

def format_alert_message(ticker,title_ar,summary_ar,published,price,link,source,score):
    price_display=f'${price:.2f}' if price is not None else 'غير متوفر'
    return ('🚨 <b>محفز أخبار Biotech / FDA</b>\n━━━━━━━━━━━━━━\n'
            f'📌 <b>السهم:</b> {_safe(ticker)}\n📅 <b>تاريخ الخبر:</b> {_safe(published) or "غير متوفر"}\n'
            f'💰 <b>السعر:</b> {price_display}\n⭐ <b>درجة المطابقة:</b> {score}\n\n'
            f'📰 <b>العنوان:</b> {_safe(title_ar)}\n\n📝 <b>نص الخبر بالعربية:</b>\n'
            f'{_safe(summary_ar) or "راجع الخبر الأصلي."}\n\n🔗 <b>المصدر:</b> {_safe(source)}\n🔗 <b>الخبر الأصلي:</b> {_safe(link)}')

def send_error_alert(error_text): send_telegram_message('⚠️ <b>خطأ في بوت الأخبار</b>\n'+_safe(error_text[-500:]))
