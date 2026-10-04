#!/usr/bin/env node
/* =============================================================================
 * tests/render.js — يصوّر الشارت إلى SVG/PNG للتحقّق البصري
 * -----------------------------------------------------------------------------
 * يستبدل سياق Canvas بمسجّل SVG، ثم يشغّل محرك الشارت نفسه (chart.js) على
 * بيانات حقيقية مع طبقة الوتد، ويخرج صورة يمكن معاينتها.
 *
 *   node terminal/tests/render.js NOMA 1D out.svg
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SYM = process.argv[2] || '2222';
const TF = process.argv[3] || '1D';
const OUT = process.argv[4] || path.join(ROOT, 'tests', SYM + '_' + TF + '.svg');
const W = 1180, H = 660;

/* ----------------------- سياق Canvas -> مسجّل SVG ------------------------ */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function col(c) {
  if (c && c.__grad) return 'url(#' + c.__grad + ')';
  return c || 'none';
}

/* أنماط الحالة تعيش على نفس الكائن الذي يستقبل الإسناد من الشارت */
function makeSvgCtx() {
  const out = [];
  const defs = [];
  let gradN = 0;
  const stack = [];
  let path = null;

  const base = {
    __out: out,
    canvas: { width: W, height: H },
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1,
    globalAlpha: 1, font: '11px monospace', textAlign: 'start', dash: '',

    measureText(t) { return { width: String(t).length * 6.0 }; },
    createLinearGradient(x0, y0, x1, y1) {
      const id = 'g' + (++gradN);
      const g = { id, x0, y0, x1, y1, stops: [], __grad: id };
      g.addColorStop = (o, c) => g.stops.push([o, c]);
      defs.push(g);
      return g;
    },
    createRadialGradient() { return this.createLinearGradient(0, 0, 0, 1); },
    save() { const s = {}; for (const k of STYLE_KEYS) s[k] = this[k]; stack.push(s); },
    restore() { if (stack.length) Object.assign(this, stack.pop()); },
    setLineDash(d) { this.dash = (d && d.length) ? d.join(',') : ''; },
    setTransform() { }, translate() { }, scale() { }, rotate() { }, clip() { },
    clearRect() { },
    beginPath() { path = { d: '' }; },
    moveTo(x, y) { if (!path) this.beginPath(); path.d += `M${r(x)} ${r(y)}`; },
    lineTo(x, y) { if (!path) this.beginPath(); path.d += `L${r(x)} ${r(y)}`; },
    quadraticCurveTo(cx, cy, x, y) { if (path) path.d += `Q${r(cx)} ${r(cy)} ${r(x)} ${r(y)}`; },
    bezierCurveTo(a, b, c, d, x, y) { if (path) path.d += `C${r(a)} ${r(b)} ${r(c)} ${r(d)} ${r(x)} ${r(y)}`; },
    arc(x, y, rad, a0, a1) {
      if (!path) this.beginPath();
      const x0 = x + rad * Math.cos(a0), y0 = y + rad * Math.sin(a0);
      const x1 = x + rad * Math.cos(a1), y1 = y + rad * Math.sin(a1);
      path.d += `M${r(x0)} ${r(y0)}A${r(rad)} ${r(rad)} 0 1 1 ${r(x1)} ${r(y1)}`;
    },
    closePath() { if (path) path.d += 'Z'; },
    stroke() {
      if (!path || !path.d) return;
      out.push(`<path d="${path.d}" fill="none" stroke="${col(this.strokeStyle)}" stroke-width="${this.lineWidth}"${this.dash ? ` stroke-dasharray="${this.dash}"` : ''} opacity="${(this.globalAlpha * alphaOf(this.strokeStyle)).toFixed(3)}"/>`);
    },
    fill() {
      if (!path || !path.d) return;
      out.push(`<path d="${path.d}" fill="${col(this.fillStyle)}" stroke="none" opacity="${(this.globalAlpha * alphaOf(this.fillStyle)).toFixed(3)}"/>`);
    },
    fillRect(x, y, w, h) {
      out.push(`<rect x="${r(x)}" y="${r(y)}" width="${r(Math.max(0, w))}" height="${r(Math.max(0, h))}" fill="${col(this.fillStyle)}" opacity="${(this.globalAlpha * alphaOf(this.fillStyle)).toFixed(3)}"/>`);
    },
    strokeRect(x, y, w, h) {
      out.push(`<rect x="${r(x)}" y="${r(y)}" width="${r(Math.max(0, w))}" height="${r(Math.max(0, h))}" fill="none" stroke="${col(this.strokeStyle)}" stroke-width="${this.lineWidth}"${this.dash ? ` stroke-dasharray="${this.dash}"` : ''} opacity="${this.globalAlpha}"/>`);
    },
    rect(x, y, w, h) { this.beginPath(); this.moveTo(x, y); this.lineTo(x + w, y); this.lineTo(x + w, y + h); this.lineTo(x, y + h); this.closePath(); },
    fillText(t, x, y) {
      const sz = (String(this.font).match(/(\d+(?:\.\d+)?)px/) || [, 11])[1];
      const bold = /\b(600|700|800|bold)\b/.test(this.font) ? ' font-weight="700"' : '';
      const anchor = this.textAlign === 'center' ? 'middle' : this.textAlign === 'end' || this.textAlign === 'right' ? 'end' : 'start';
      out.push(`<text x="${r(x)}" y="${r(y)}" fill="${col(this.fillStyle)}" font-size="${sz}" font-family="DejaVu Sans Mono, monospace" text-anchor="${anchor}"${bold} opacity="${this.globalAlpha}">${esc(t)}</text>`);
    },
    strokeText() { }
  };
  const alphaOf = c => { const m = /rgba\((?:[^,]+,){3}([\d.]+)\)/.exec(String(c).trim()); return m ? parseFloat(m[1]) : 1; };
  const STYLE_KEYS = ['fillStyle', 'strokeStyle', 'lineWidth', 'globalAlpha', 'font', 'textAlign', 'dash'];
  const api = new Proxy(base, {
    get(t, k) { return k in t ? t[k] : undefined; },
    set(t, k, v) { t[k] = v; return true; }
  });
  function r(n) { return Math.round(n * 100) / 100; }
  return { api, defs };
}

/* -------------------------------- البيئة -------------------------------- */
const sandbox = {};
sandbox.window = sandbox;
sandbox.devicePixelRatio = 1;
sandbox.requestAnimationFrame = cb => { cb(); return 0; };
sandbox.ResizeObserver = class { observe() { } };
sandbox.localStorage = { getItem: () => null, setItem() { }, removeItem() { } };
sandbox.setTimeout = f => { if (typeof f === 'function') f(); return 0; };
sandbox.setInterval = () => 0;
sandbox.console = console;
sandbox.addEventListener = () => { };
sandbox.removeEventListener = () => { };

const cv = {
  clientWidth: W, clientHeight: H, width: W, height: H,
  style: {}, dataset: {}, classList: { add() { }, remove() { }, toggle() { }, contains: () => false },
  addEventListener() { }, removeEventListener() { },
  getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }),
  toDataURL: () => ''
};
const svgCtx = makeSvgCtx();
cv.getContext = () => svgCtx.api;
sandbox.document = {
  createElement: () => ({ style: {}, classList: { add() { }, remove() { }, toggle() { } }, appendChild() { }, remove() { }, set innerHTML(v) { }, get innerHTML() { return ''; } }),
  querySelector: () => ({ style: {}, classList: { add() { }, remove() { }, toggle() { }, contains: () => false }, set innerHTML(v) { }, get innerHTML() { return ''; }, set textContent(v) { }, get textContent() { return ''; }, addEventListener() { } }),
  querySelectorAll: () => [],
  addEventListener() { }, body: {}
};
sandbox.__cv = cv;
vm.createContext(sandbox);

for (const f of ['js/market.js', 'js/indicators.js', 'js/wedge.js', 'js/chart.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
}

/* ------------------------------ التصيير --------------------------------- */
const bars = sandbox.Market.series(SYM, TF);
const wedge = process.argv.includes('--no-wedge') ? null : sandbox.Wedge.detect(bars);
const chart = new sandbox.ChartKit.Chart(cv, process.argv.includes('--no-wedgefill') ? { showWedgeFill: false } : {});
chart.setData(bars, TF, SYM);
chart.setWedge(wedge);
chart.draw();

function cssColor(c) {
  const m = /^rgba\(([^,]+),\s*([^,]+),\s*([^,]+),\s*([\d.]+)\)$/.exec(String(c).trim());
  if (m) return [`rgb(${m[1].trim()},${m[2].trim()},${m[3].trim()})`, m[4]];
  return [String(c).trim(), '1'];
}
const defsXml = svgCtx.defs.map(g => {
  const vert = Math.abs(g.x1 - g.x0) < 0.01;
  return `<linearGradient id="${g.id}" x1="0" y1="0" x2="${vert ? 0 : 1}" y2="${vert ? 1 : 0}">` +
    g.stops.map(s => {
      const [c, a] = cssColor(s[1]);
      return `<stop offset="${s[0]}" stop-color="${c}" stop-opacity="${a}"/>`;
    }).join('') +
    `</linearGradient>`;
}).join('');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>${defsXml}</defs>
<rect width="${W}" height="${H}" fill="#070a10"/>
${svgCtx.api.__out.join('\n')}
</svg>`;

fs.writeFileSync(OUT, svg);
console.log('symbol      :', SYM, TF, '·', bars.length, 'شمعة');
if (wedge) {
  console.log('wedge       :', wedge.grade, wedge.confidence.toFixed(1) + '%', wedge.status,
    '· len=' + wedge.bars, '· contr=' + (wedge.contraction * 100).toFixed(0) + '%',
    '· touches=' + wedge.upper.touches.length + '/' + wedge.lower.touches.length);
  console.log('trade       : E=' + wedge.entry.toFixed(4), 'S=' + wedge.stop.toFixed(4),
    'T1=' + wedge.targets[0].price.toFixed(4), 'T3=' + wedge.targets[2].price.toFixed(4),
    'RR3=' + wedge.targets[2].rr.toFixed(2));
} else console.log('wedge       : (none)');
console.log('svg         :', OUT, '(' + svg.length + ' bytes,', svgCtx.api.__out.length + ' عنصر)');
