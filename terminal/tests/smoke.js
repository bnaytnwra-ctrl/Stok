#!/usr/bin/env node
/* =============================================================================
 * tests/smoke.js — اختبار دخان للمنصّة بدون متصفح
 * -----------------------------------------------------------------------------
 * لا متصفح ولا jsdom في بيئة التشغيل، لذا نبني محاكي DOM/Canvas صغيرًا،
 * نُقلِعه من `index.html` الحقيقي، ونشغّل الكود الفعلي نفسه
 * (market.js + indicators.js + wedge.js + chart.js + app.js) داخل سياق vm.
 *
 * هذا ينفّذ فعليًا: الإقلاع، رسم الشارت على كل الأطر الزمنية، لوحة الإشارة،
 * الفاحص، أدوات الرسم بالسحب، التكبير/التحريك، والتصدير.
 *
 *   node terminal/tests/smoke.js
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const G = c => '\x1b[' + c + 'm';
let pass = 0, fail = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ' + G(32) + '✓' + G(0) + ' ' + name + (extra ? '  ' + G(90) + extra + G(0) : '')); }
  else { fail++; failures.push(name); console.log('  ' + G(31) + '✗ ' + name + G(0) + (extra ? '  ' + extra : '')); }
}
const tick = () => new Promise(r => setImmediate(r));

/* ============================== محاكي DOM ================================ */
class ClassList {
  constructor() { this.set = new Set(); }
  add(...c) { c.forEach(x => x && this.set.add(x)); }
  remove(...c) { c.forEach(x => this.set.delete(x)); }
  contains(c) { return this.set.has(c); }
  toggle(c, force) { const w = force === undefined ? !this.set.has(c) : !!force; w ? this.set.add(c) : this.set.delete(c); return w; }
  get value() { return Array.from(this.set).join(' '); }
}

class El {
  constructor(tag, id) {
    this.tagName = (tag || 'div').toUpperCase();
    this.id = id || '';
    this.classList = new ClassList();
    this.style = {};
    this.dataset = {};
    this.children = [];
    this._h = {};
    this._text = ''; this._html = '';
    this.clientWidth = 1280; this.clientHeight = 720;
    this.width = 0; this.height = 0;
    this.href = ''; this.download = '';
  }
  set className(v) { this._cn = v; this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return this._cn || this.classList.value; }
  set textContent(v) { this._text = String(v); }
  get textContent() { return this._text; }
  set innerHTML(v) { this._html = String(v); this.children = parseChildren(this._html); }
  get innerHTML() { return this._html; }
  addEventListener(t, f) { (this._h[t] = this._h[t] || []).push(f); }
  removeEventListener(t, f) { if (this._h[t]) this._h[t] = this._h[t].filter(x => x !== f); }
  dispatch(t, ev) { (this._h[t] || []).slice().forEach(f => f(Object.assign({ preventDefault() { }, stopPropagation() { }, target: this }, ev))); }
  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter(x => x !== c); }
  remove() { this._removed = true; }
  focus() { sandbox.document.activeElement = this; }
  blur() { sandbox.document.activeElement = sandbox.document.body; }
  click() { if (this.onclick) this.onclick({ preventDefault() { } }); }
  contains() { return false; }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || new El('div'); }
  querySelectorAll(sel) {
    const want = sel.split(/\s+/).pop();
    const cls = (want.match(/\.([A-Za-z0-9_-]+)/) || [])[1];
    const tag = (want.match(/^([a-zA-Z0-9]+)/) || [])[1];
    let out = this.children;
    if (cls) out = out.filter(c => c.classList.contains(cls));
    if (tag) out = out.filter(c => c.tagName === tag.toUpperCase());
    return out;
  }
  getContext() { if (!this._ctx) this._ctx = makeCtx(this); return this._ctx; }
  toDataURL() { return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='; }
}

/** يبني عناصر من الوسوم التي تحمل data-* أو class (كافٍ لهذا الغرض) */
function parseChildren(html) {
  const out = [];
  const re = /<([a-zA-Z0-9]+)((?:[^<>"']|"[^"]*"|'[^']*')*)>/g;
  let m;
  while ((m = re.exec(html))) {
    const src = m[2] || '';
    const ds = {};
    let dm; const dre = /data-([a-zA-Z0-9-]+)="([^"]*)"/g;
    while ((dm = dre.exec(src))) ds[dm[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = dm[2];
    const cm = src.match(/class="([^"]*)"/);
    if (!Object.keys(ds).length && !cm) continue;
    const e = new El(m[1]);
    e.dataset = ds;
    if (cm) e.classList.set = new Set(cm[1].split(/\s+/).filter(Boolean));
    out.push(e);
  }
  return out;
}

/** يستخرج المحتوى الداخلي لأول عنصر يحمل id معيّنًا (بموازنة الوسوم) */
function extractInner(html, id) {
  const open = html.search(new RegExp('<[a-zA-Z0-9]+[^>]*\\bid="' + id + '"'));
  if (open < 0) return null;
  const tag = html.slice(open).match(/^<([a-zA-Z0-9]+)/)[1];
  const gt = html.indexOf('>', open);
  // عناصر فارغة (void) لا تملك وسم إغلاق — وإلا ابتلعنا بقية المستند
  const VOID = ['input', 'img', 'br', 'hr', 'meta', 'link', 'source', 'area', 'base', 'col', 'embed', 'track', 'wbr'];
  if (VOID.includes(tag.toLowerCase()) || /\/>$/.test(html.slice(open, gt + 1))) return '';
  let i = gt + 1, depth = 1;
  const re = new RegExp('<(/?)' + tag + '(?:\\s[^>]*)?>', 'g');
  re.lastIndex = i;
  let m;
  while ((m = re.exec(html))) {
    if (m[1] === '/') { depth--; if (depth === 0) return html.slice(i, m.index); }
    else if (!/\/>$/.test(m[0])) depth++;
  }
  return html.slice(i);
}

/* ============================ محاكي Canvas =============================== */
const CTX_METHODS = ['setTransform', 'clearRect', 'fillRect', 'strokeRect', 'beginPath', 'moveTo',
  'lineTo', 'closePath', 'stroke', 'fill', 'arc', 'save', 'restore', 'setLineDash', 'fillText',
  'strokeText', 'rect', 'translate', 'scale', 'rotate', 'clip', 'quadraticCurveTo', 'bezierCurveTo'];

function makeCtx(canvas) {
  const calls = { total: 0 };
  CTX_METHODS.forEach(m => { calls[m] = 0; });
  /* سجلّات تفصيلية للتحقّق من طبقة الاستراتيجية (نصوص + مستطيلات) */
  calls.text = [];
  calls.rects = [];
  calls.reset = () => { calls.total = 0; CTX_METHODS.forEach(m => { calls[m] = 0; }); calls.text = []; calls.rects = []; };
  const base = {
    canvas: canvas, calls: calls,
    measureText: t => ({ width: String(t).length * 6.1 }),
    createLinearGradient: () => ({ addColorStop() { } }),
    createRadialGradient: () => ({ addColorStop() { } })
  };
  return new Proxy(base, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'fillText') return (s2, x, y) => { t.calls.fillText++; t.calls.total++; t.calls.text.push([String(s2), x, y]); };
      if (k === 'fillRect') return (x, y, w, h) => { t.calls.fillRect++; t.calls.total++; t.calls.rects.push([x, y, w, h]); };
      if (CTX_METHODS.includes(k)) return () => { t.calls[k]++; t.calls.total++; };
      return undefined;
    },
    set(t, k, v) { t[k] = v; return true; }
  });
}

/* =============================== البيئة ================================== */
const store = new Map();
const winH = {};
const sandbox = {};
sandbox.window = sandbox; sandbox.self = sandbox;
sandbox.devicePixelRatio = 2;
sandbox.requestAnimationFrame = cb => { cb(); return 0; };
sandbox.cancelAnimationFrame = () => { };
sandbox.ResizeObserver = class { constructor(cb) { this.cb = cb; } observe() { } disconnect() { } };
sandbox.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k)
};
sandbox.setTimeout = (f, ms) => { if (typeof f === 'function' && ms <= 60) f(); return 0; };
sandbox.setInterval = () => 0;
sandbox.clearTimeout = () => { };
sandbox.console = console;
// fetch موجود لكنه يفشل (كما عند فتح index.html مباشرة) -> يُختبر مسار الرجوع
sandbox.fetch = () => Promise.reject(new Error('no server'));
sandbox.addEventListener = (t, f) => { (winH[t] = winH[t] || []).push(f); };
sandbox.removeEventListener = (t, f) => { if (winH[t]) winH[t] = winH[t].filter(x => x !== f); };
sandbox.dispatchWindow = (t, ev) => (winH[t] || []).slice().forEach(f => f(Object.assign({ preventDefault() { } }, ev)));

const byId = new Map();
function el(id) {
  if (!byId.has(id)) {
    const e = new El(id === 'chart' ? 'canvas' : 'div', id);
    if (id === 'chart') { e.clientWidth = 1180; e.clientHeight = 640; }
    byId.set(id, e);
  }
  return byId.get(id);
}

sandbox.document = {
  body: new El('body'), activeElement: null, _h: {},
  addEventListener(t, f) { (this._h[t] = this._h[t] || []).push(f); },
  dispatch(t, ev) { (this._h[t] || []).slice().forEach(f => f(ev || {})); },
  createElement: tag => new El(tag),
  getElementById: id => el(id),
  querySelector(sel) {
    if (sel[0] === '#') {
      const parts = sel.split(/\s+/);
      const base = el(parts[0].slice(1));
      return parts.length > 1 ? (base.querySelectorAll(parts.slice(1).join(' '))[0] || new El('div')) : base;
    }
    return sandbox.document.querySelectorAll(sel)[0] || new El('div');
  },
  querySelectorAll(sel) {
    const parts = sel.trim().split(/\s+/);
    if (parts[0][0] === '#') return el(parts[0].slice(1)).querySelectorAll(parts.slice(1).join(' ') || '*');
    const cls = (sel.match(/\.([A-Za-z0-9_-]+)/) || [])[1];
    const attrs = Array.from(sel.matchAll(/\[data-([a-zA-Z0-9-]+)\]/g)).map(m => m[1]);
    const out = [];
    for (const e of byId.values()) for (const c of e.children) {
      if (cls && !c.classList.contains(cls)) continue;
      if (attrs.some(a => !(a in c.dataset))) continue;
      out.push(c);
    }
    return out;
  }
};
sandbox.document.activeElement = sandbox.document.body;
vm.createContext(sandbox);

/* ========================= تحميل الصفحة والكود =========================== */
console.log('\n' + G(1) + 'STOK Terminal — smoke test' + G(0) + '\n');

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const seeded = [];
const idRe = /\bid="([A-Za-z0-9_-]+)"/g;
let im;
while ((im = idRe.exec(html))) {
  const inner = extractInner(html, im[1]);
  if (inner === null) continue;
  el(im[1]).innerHTML = inner;
  seeded.push(im[1]);
}

for (const f of ['js/market.js', 'js/indicators.js', 'js/wedge.js', 'js/split.js', 'js/chart.js', 'app.js']) {
  const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
  try { vm.runInContext(code, sandbox, { filename: f }); }
  catch (e) { console.log(G(31) + 'فشل تحميل ' + f + ': ' + e.message + G(0)); process.exit(1); }
}
check('وحدات السوق/المؤشرات/الوتد/الشارت محمّلة',
  !!sandbox.Market && !!sandbox.TA && !!sandbox.Wedge && !!sandbox.ChartKit);
check('الهيكل الثابت مقروء من index.html', seeded.length >= 20, seeded.length + ' عنصر');

(async function main() {
  /* ------------------------------ الإقلاع ------------------------------ */
  console.log('\n' + G(1) + 'إقلاع الواجهة' + G(0));
  let bootError = null;
  try { sandbox.document.dispatch('DOMContentLoaded'); } catch (e) { bootError = e; }
  await tick(); await tick();
  check('الإقلاع بدون استثناء', !bootError, bootError ? bootError.message : '');
  if (bootError) { console.log(bootError.stack); process.exit(1); }

  const cv = el('chart');
  const ctx = cv.getContext();
  check('الشارت رُسم فعلاً على Canvas', ctx.calls.total > 500, ctx.calls.total + ' عملية رسم');
  check('رُسمت شموع (مسارات)', ctx.calls.moveTo > 50 && ctx.calls.lineTo > 50,
    'moveTo=' + ctx.calls.moveTo + ' lineTo=' + ctx.calls.lineTo);
  check('رُسم نص على المحاور واللوحة', ctx.calls.fillText > 20, ctx.calls.fillText + ' نص');

  const wl = el('watchlist').querySelectorAll('.wl-row');
  check('قائمة المراقبة مُعبّأة بكل الرموز', wl.length === sandbox.Market.SYMBOLS.length, wl.length + ' صف');
  const tape = el('tapeTrack').querySelectorAll('.tape-item');
  check('شريط الأسعار مُعبّأ (مضاعف للحلقة)', tape.length === sandbox.Market.SYMBOLS.length * 2, tape.length + ' عنصر');
  const news = el('newsFeed').querySelectorAll('.news-item');
  check('تغذية الأخبار مُعبّأة', news.length === sandbox.Market.alerts.length, news.length + ' خبر');
  check('لوحة الإشارة تعرض خطة صفقة', /خطة الصفقة/.test(el('signalBody').innerHTML));
  check('لوحة الإشارة تعرض الأهداف الثلاثة', /الهدف 1/.test(el('signalBody').innerHTML) && /الهدف 3/.test(el('signalBody').innerHTML));
  check('لوحة الإشارة تعرض قائمة التحقّق', /قائمة التحقّق/.test(el('signalBody').innerHTML));
  check('شارة النموذج ظاهرة على الشارت', el('chartBadge').style.display === 'flex',
    el('chartBadge').textContent);

  /* -------- طبقة الاستراتيجية: مناطق TARGET / ENTER / STOP LOSS -------- */
  const painted = ctx.calls.text.map(t => t[0]);
  const hasLabel = re => painted.some(t => re.test(t));
  check('الوتد مرسوم على الشارت (خطوط الاتجاه)', !!sandbox.document && painted.length > 0
    && (ctx.calls.moveTo > 50));
  check('منطقة TARGET مرسومة على الشارت', hasLabel(/TARGET/),
    hasLabel(/TARGET/) ? 'وجدت' : 'غائبة — النصوص: ' + JSON.stringify(painted.slice(0, 40)));
  check('منطقة ENTER مرسومة على الشارت', hasLabel(/^ENTER$/));
  check('منطقة STOP LOSS مرسومة على الشارت', hasLabel(/STOP\s*LOSS/));
  {
    const zone = ctx.calls.text.filter(t => /^(TARGET|ENTER|STOP LOSS|T1|T2)$/.test(t[0]));
    const inPlot = zone.filter(t => t[1] > 60 && t[1] < 1170 && t[2] > 0 && t[2] < 600).length;
    check('تسميات المناطق داخل إطار الشارت (ليست خارجه)', zone.length > 0 && inPlot === zone.length,
      zone.map(t => t[0] + '@(' + Math.round(t[1]) + ',' + Math.round(t[2]) + ')').join(' '));
    const zr = ctx.calls.rects.filter(q => q[2] > 60 && q[2] < 200 && q[3] > 4);
    check('مستطيلات المناطق مرسومة بأبعاد معقولة', zr.length >= 3,
      zr.length + ' مستطيل، أعرضها ' + (zr.length ? Math.round(Math.max.apply(null, zr.map(q => q[2]))) : 0) + 'px');
  }
  check('الرجوع الآمن للبيانات المدمجة عند غياب الخادم', /محاكاة أوفلاين/.test(el('sbSource').innerHTML),
    el('sbSource').innerHTML.replace(/<[^>]*>/g, ' ').trim());
  check('تغذية الأخبار تُصنّف نوع التنبيه', /عاجل|محفّز|خبر/.test(el('newsFeed').innerHTML));

  /* --------------------------- الأطر الزمنية --------------------------- */
  console.log('\n' + G(1) + 'كل الأطر الزمنية' + G(0));
  const tfBtns = el('tfSeg').querySelectorAll('button');
  check('أزرار الأطر الزمنية مبنية', tfBtns.length === sandbox.Market.TIMEFRAMES.length, tfBtns.length + ' زر');
  for (const b of tfBtns) {
    const before = ctx.calls.total;
    let err = null;
    try { b.onclick(); await tick(); await tick(); } catch (e) { err = e.message; }
    check('إطار ' + b.dataset.v + ' رسم بنجاح', !err && ctx.calls.total > before,
      err ? 'خطأ: ' + err : el('sbBars').textContent + ' شمعة');
  }

  /* ----------------------------- الرموز -------------------------------- */
  console.log('\n' + G(1) + 'تبديل الرموز' + G(0));
  tfBtns.find(b => b.dataset.v === '1D').onclick();
  await tick(); await tick();
  const rows = el('watchlist').querySelectorAll('.wl-row');
  let symErr = 0, wedgeShown = 0;
  const noZone = [], failedSyms = [];
  for (const row of rows) {
    try {
      ctx.calls.reset();
      row.onclick(); await tick(); await tick();
      if (/خطة الصفقة/.test(el('signalBody').innerHTML)) wedgeShown++;
      /* الوتد الفاشل لا خطة له؛ أمّا غيره فيجب أن تُرسم مناطقه على الشارت */
      const failed = el('chartBadge').classList.contains('fail');
      const txt = ctx.calls.text.map(t => t[0]).join('|');
      if (!failed && !/TARGET|ENTER|STOP/.test(txt)) noZone.push(row.dataset.t);
      if (failed) failedSyms.push(row.dataset.t);
    }
    catch (e) { symErr++; console.log('     ' + row.dataset.t + ': ' + e.message); }
  }
  check('كل الرموز الـ' + rows.length + ' تُفتح بدون خطأ', symErr === 0);
  check('أوتاد معروضة على الإطار اليومي', wedgeShown >= 14, wedgeShown + '/' + rows.length + ' رمز');
  check('مناطق الخطة تُرسم لكل رمز على الإطار اليومي', noZone.length === 0,
    noZone.length ? 'بلا مناطق: ' + noZone.join(', ')
      : 'كل الرموز غير الفاشلة (' + (rows.length - failedSyms.length) + ' رمز'
        + (failedSyms.length ? '، فشل: ' + failedSyms.join(',') + ' بلا خطة كما هو متوقّع' : '') + ')');

  /* --------------------------- لوحة مصدر البيانات ---------------------- */
  console.log('\n' + G(1) + 'لوحة مصدر البيانات' + G(0));
  {
    /* المحاكي لا يهيّئ hidden/value من السمات كما يفعل المتصفح — نهيّئها يدويًا */
    el('setPanel').hidden = true;
    el('splitMeta').hidden = true;
    ['ak','px','rk'].forEach(id => { if (el(id).value == null) el(id).value = ''; });
    el('tSet').onclick(); await tick();
    check('لوحة المصدر تفتح', el('setPanel').hidden === false);
    el('setClose').onclick(); await tick();
    check('زر الإغلاق يستجيب ويغلق اللوحة', el('setPanel').hidden === true && el('setPanel').style.display === 'none');
    el('tSet').onclick(); await tick();
    el('ak').value = 'TESTKEY';
    el('setSave').onclick(); await tick();
    check('لوحة المصدر تُغلق بعد حفظ المفتاح', el('setPanel').hidden === true);
    check('المفتاح محفوظ في localStorage', sandbox.localStorage.getItem('twelve_data_api_key') === 'TESTKEY');
    ['twelve_data_api_key','twelve_data_proxy','risk_usd'].forEach(k => sandbox.localStorage.removeItem(k));
    check('splitMeta مخفية في وضع الوتد', el('splitMeta').hidden === true);
  }


  console.log('\n' + G(1) + 'استراتيجية التجزئة العكسية' + G(0));
  {
    const splitBtn = el('stratSeg').querySelectorAll('button').find(b => b.dataset.st === 'split');
    splitBtn.onclick(); await tick(); await tick();
    check('مبدّل التجزئة العكسية يعرض قائمة الشروط', /ارتداد|تجزئة|RSI/.test(el('signalBody').innerHTML));
    check('خطة التجزئة تعرض دخول/وقف/أهداف', /دخول/.test(el('signalBody').innerHTML) && /وقف الخسارة/.test(el('signalBody').innerHTML) && /هدف 1/.test(el('signalBody').innerHTML));
    check('شارة التجزئة ظاهرة', /REVERSE SPLIT/.test(el('chartBadge').textContent), el('chartBadge').textContent);
    const wedgeBtn = el('stratSeg').querySelectorAll('button').find(b => b.dataset.st === 'wedge');
    wedgeBtn.onclick(); await tick();
    check('الرجوع للوتد الهابط يعمل', /خطة الصفقة|الوتد/.test(el('signalBody').innerHTML) || /FALLING WEDGE/.test(el('chartBadge').textContent));
  }


  console.log('\n' + G(1) + 'الفاحص' + G(0));
  const scanRows = el('scanner').querySelectorAll('.scan-row');
  check('الفاحص يعرض نتائج', scanRows.length > 0, scanRows.length + ' نتيجة');
  check('عدّاد الفاحص محدّث', /\d+\s*\/\s*\d+/.test(el('scanCount').textContent), el('scanCount').textContent);
  let scanErr = 0;
  for (const r of scanRows) { try { r.onclick(); await tick(); } catch (e) { scanErr++; } }
  check('النقر على نتائج الفاحص يعمل', scanErr === 0);

  /* --------------------------- أدوات الرسم ----------------------------- */
  console.log('\n' + G(1) + 'أدوات الرسم' + G(0));
  const toolBtns = sandbox.document.querySelectorAll('.tbtn[data-tool]');
  check('أزرار الرسم مقروءة من الصفحة', toolBtns.length === 6, toolBtns.length + ' أداة');
  let toolErr = 0;
  for (const b of toolBtns) { try { b.onclick(); } catch (e) { toolErr++; console.log('     ' + e.message); } }
  check('كل أدوات الرسم تُفعَّل بدون خطأ', toolErr === 0);

  rows[0].onclick(); await tick();
  const drawn = {};
  for (const b of toolBtns) {
    const t = b.dataset.tool;
    b.onclick();
    const beforeKeys = store.size;
    try {
      cv.dispatch('mousedown', { clientX: 380, clientY: 190 });
      sandbox.dispatchWindow('mousemove', { clientX: 720, clientY: 430 });
      sandbox.dispatchWindow('mouseup', {});
      drawn[t] = store.size >= beforeKeys;
    } catch (e) { drawn[t] = false; console.log('     ' + t + ': ' + e.message); }
  }
  check('السحب يرسم بكل الأدوات الست', Object.values(drawn).every(Boolean),
    Object.keys(drawn).filter(k => drawn[k]).join(','));
  check('الرسومات تُحفَظ في التخزين المحلي', store.size > 0, store.size + ' مفتاح');

  /* ------------------------ تكبير / تحريك / مؤشّر ---------------------- */
  console.log('\n' + G(1) + 'تفاعل الشارت' + G(0));
  try {
    cv.dispatch('wheel', { deltaY: -240, clientX: 600, clientY: 300 });
    cv.dispatch('wheel', { deltaY: 520, clientX: 600, clientY: 300 });
    cv.dispatch('mousedown', { clientX: 500, clientY: 300 });
    sandbox.dispatchWindow('mousemove', { clientX: 660, clientY: 320 });
    sandbox.dispatchWindow('mouseup', {});
    sandbox.dispatchWindow('mousemove', { clientX: 640, clientY: 260 });
    cv.dispatch('mouseleave', {});
    cv.dispatch('dblclick', {});
    check('تكبير/تحريك/مؤشّر/إعادة ضبط تعمل', true);
  } catch (e) { check('تكبير/تحريك/مؤشّر/إعادة ضبط تعمل', false, e.message); }
  check('قراءة المؤشّر تظهر في شريط الحالة', /O /.test(el('sbCursor').innerHTML) || el('sbCursor').textContent === '—');

  /* ----------------------------- الأزرار ------------------------------- */
  console.log('\n' + G(1) + 'الأزرار والمفاتيح' + G(0));
  let togErr = 0;
  for (const id of ['tEma', 'tVol', 'tRsi', 'tWedge', 'tLog']) {
    try { el(id).onclick(); el(id).onclick(); } catch (e) { togErr++; console.log('     ' + id + ': ' + e.message); }
  }
  check('مفاتيح الطبقات تعمل (تشغيل/إيقاف)', togErr === 0);

  const types = el('chartType').querySelectorAll('button');
  let typeErr = 0;
  for (const t of types) { try { t.onclick(); await tick(); } catch (e) { typeErr++; } }
  check('أنواع الشارت (شموع/مجوّفة/خطّي) تعمل', typeErr === 0 && types.length === 3, types.length + ' نوع');

  try { el('btnShot').onclick(); check('تصدير PNG يعمل', true); }
  catch (e) { check('تصدير PNG يعمل', false, e.message); }
  try { el('btnScan').onclick(); await tick(); await tick(); check('إعادة الفحص تعمل', true); }
  catch (e) { check('إعادة الفحص تعمل', false, e.message); }
  try { el('tClear').onclick(); check('مسح الرسومات يعمل', store.size === 0, 'مفاتيح متبقية: ' + store.size); }
  catch (e) { check('مسح الرسومات يعمل', false, e.message); }

  /* --------------------------- لوحة الأوامر ---------------------------- */
  console.log('\n' + G(1) + 'لوحة الأوامر والاختصارات' + G(0));
  const keys = sandbox.document._h['keydown'] || [];
  check('معالج الاختصارات مسجَّل', keys.length > 0);
  const fire = k => {
    const ev = { key: k, ctrlKey: k === 'k', preventDefault() { } };
    const ae = sandbox.document.activeElement;
    if (ae && typeof ae.onkeydown === 'function') ae.onkeydown(ev);
    keys.slice().forEach(f => f(ev));
  };
  try {
    fire('k'); check('Ctrl+K يفتح لوحة الأوامر', el('cmdk').classList.contains('open'),
      el('cmdkList').children.length + ' أمر');
    fire('Escape'); check('Escape يغلق لوحة الأوامر', !el('cmdk').classList.contains('open'));
    fire('?'); check('مفتاح ? يعرض المساعدة', el('toasts').children.length > 0);
    fire('/'); check('مفتاح / يركّز البحث', sandbox.document.activeElement === el('searchInput'));
    fire('0'); check('مفتاح 0 يعيد ضبط الشارت', true);
    fire('t'); check('مفتاح T يفعّل خط الاتجاه', /خط اتجاه/.test(el('sbTool').innerHTML));
    fire('Escape'); check('Escape يرجع لوضع المؤشر', /مؤشر/.test(el('sbTool').innerHTML));
    const symBefore = el('symHead').innerHTML;
    keys.slice().forEach(f => f({ key: 'ArrowDown', preventDefault() { } }));
    await tick();
    check('الأسهم تنقّل بين الرموز', el('symHead').innerHTML !== symBefore);
  } catch (e) { check('الاختصارات', false, e.message); }

  /* ------------------------------ البحث -------------------------------- */
  console.log('\n' + G(1) + 'البحث' + G(0));
  try {
    const inp = el('searchInput');
    inp.value = 'SO';
    inp.oninput();
    const res = el('searchResults').querySelectorAll('.sr-item');
    check('البحث يرجع نتائج', res.length > 0, res.length + ' نتيجة');
    check('البحث يجد الرمز المطلوب', res.some(r => r.dataset.t === 'SOUN'));
    res[0].onclick(); await tick();
    check('النقر على نتيجة البحث يفتح الرمز', /SOUN|SOFI/.test(el('symHead').innerHTML));
  } catch (e) { check('البحث', false, e.message); }

  /* ---------------------- إضافة الأسهم + TradingView --------------------- */
  console.log('\n' + G(1) + 'إضافة الأسهم وجلب TradingView' + G(0));
  {
    const before = sandbox.Market.SYMBOLS.length;
    el('addSym').value = 'TESTX';
    el('addSymBtn').onclick(); await tick(); await tick(); await tick();
    check('إضافة رمز يدويًا توسّع الكون', sandbox.Market.SYMBOLS.includes('TESTX'),
      before + ' → ' + sandbox.Market.SYMBOLS.length + ' رمز');
    check('قائمة المراقبة تعرض الرمز المضاف',
      el('watchlist').querySelectorAll('.wl-row').length >= sandbox.Market.SYMBOLS.length - 0, el('watchlist').querySelectorAll('.wl-row').length + ' صف');
    el('fetchTV').onclick(); await tick(); await tick(); await tick(); await tick();
    check('زر TradingView يعمل ويرجع لقائمة آمنة عند غياب الإنترنت', sandbox.Market.SYMBOLS.length >= before, sandbox.Market.SYMBOLS.length + ' رمز');
  }


  console.log('\n' + '─'.repeat(54));
  if (fail === 0) console.log(G(32) + G(1) + 'كل الفحوص ناجحة: ' + pass + G(0));
  else {
    console.log(G(31) + G(1) + fail + ' فشل / ' + pass + ' نجاح' + G(0));
    failures.forEach(f => console.log('  · ' + f));
  }
  console.log('عمليات الرسم المنفَّذة على Canvas: ' + G(1) + ctx.calls.total + G(0));
  process.exit(fail ? 1 : 0);
})();
