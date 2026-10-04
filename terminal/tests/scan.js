#!/usr/bin/env node
/* =============================================================================
 * tests/scan.js — فحص كل الرموز على كل الأطر الزمنية باستخدام wedge.js نفسه
 * -----------------------------------------------------------------------------
 * يطبع أي رمز فيه وتد هابط مكتشف (الدرجة/الحالة/الدخول/الوقف/الأهداف).
 *
 *   node terminal/tests/scan.js            # كل الأطر
 *   node terminal/tests/scan.js 1D         # إطار واحد
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const ONLY_TF = process.argv[2] || null;

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
sandbox.document = {
  createElement: () => ({ style: {}, classList: { add() { }, remove() { }, toggle() { } }, appendChild() { }, remove() { }, set innerHTML(v) { }, get innerHTML() { return ''; } }),
  querySelector: () => ({ style: {}, classList: { add() { }, remove() { }, toggle() { }, contains: () => false }, set innerHTML(v) { }, get innerHTML() { return ''; }, set textContent(v) { }, get textContent() { return ''; }, addEventListener() { } }),
  querySelectorAll: () => [],
  addEventListener() { }, body: {}
};
vm.createContext(sandbox);
for (const f of ['js/market.js', 'js/indicators.js', 'js/wedge.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
}

const Market = sandbox.Market, Wedge = sandbox.Wedge;
const SYMBOLS = Market.SYMBOLS || Object.keys(Market.META || {});
const TFS = ONLY_TF ? [ONLY_TF] : (Market.TFS || ['5M', '15M', '1H', '4H', '1D', '1W']);

console.log('symbols:', SYMBOLS.length, '| timeframes:', TFS.join(','));
const rows = [];
for (const s of SYMBOLS) {
  for (const tf of TFS) {
    let bars;
    try { bars = Market.series(s, tf); } catch (e) { continue; }
    if (!bars || bars.length < 60) continue;
    const w = Wedge.detect(bars);
    if (w) rows.push({ s, tf, grade: w.grade, status: w.status, score: +(w.score || 0), w });
  }
}
rows.sort((a, b) => b.score - a.score);

console.log('\nsymbol  tf    grade  status     score   entry      stop       t1');
for (const r of rows) {
  const p = r.w.plan || {};
  console.log(
    r.s.padEnd(7), r.tf.padEnd(5), String(r.grade).padEnd(6),
    String(r.status).padEnd(10), String(r.score).padStart(5),
    String(p.entry != null ? (+p.entry).toFixed(2) : '-').padStart(10),
    String(p.stop != null ? (+p.stop).toFixed(2) : '-').padStart(10),
    String(p.targets && p.targets[0] != null ? (+p.targets[0]).toFixed(2) : '-').padStart(10)
  );
}
console.log('\nwedges found:', rows.length);
const byTf = {};
for (const r of rows) byTf[r.tf] = (byTf[r.tf] || 0) + 1;
console.log('per timeframe:', JSON.stringify(byTf));
const nomad = Wedge.detect(Market.series('2222', '1D'));
console.log('2222 أرامكو 1D ->', nomad ? ('WEDGE ' + nomad.grade + ' ' + nomad.status) : 'null (لا وتد)');
