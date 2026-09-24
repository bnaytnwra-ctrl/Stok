# -*- coding: utf-8 -*-
import html, re, requests

def clean_text(value):
    value=html.unescape(value or '')
    value=re.sub(r'<[^>]+>',' ',value)
    return re.sub(r'\s+',' ',value).strip()

def translate_to_arabic(text):
    text=clean_text(text)
    if not text: return ''
    try:
        r=requests.get('https://translate.googleapis.com/translate_a/single',params={'client':'gtx','sl':'auto','tl':'ar','dt':'t','q':text[:5000]},timeout=20)
        r.raise_for_status(); data=r.json()
        return ''.join(p[0] for p in (data[0] if data else []) if p and p[0]).strip()
    except Exception as exc:
        print(f'[translator] تعذرت الترجمة: {exc}'); return ''

def translate_news(title, summary): return translate_to_arabic(title), translate_to_arabic(summary)
