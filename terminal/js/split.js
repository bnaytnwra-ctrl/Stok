/* =============================================================================
 * split.js — استراتيجية «التجزئة العكسية — ارتداد القاع» (منقولة من داشبورد المستخدم)
 * -----------------------------------------------------------------------------
 * تُطبّق قائمة شروط a2 على أي مصفوفة شموع [{t,o,h,l,c,v}] وتُرجع:
 *   { k: [checks], score, ready, st, cls, plan:{en,sl,tp,rr}, lines:[{y,l,c}], info:[[..]] }
 * تعمل على الإطار اليومي مع تأكيد 4س — هنا نكتفي بالإطار المعروض.
 * ========================================================================== */
(function (global) {
  'use strict';

  const CFG = { dropMin: .35, bounce: .15, neck: .35, dMin: 20, dMax: 50, rise: .2 };

  const ema = (a, n) => { const k = 2 / (n + 1); let e = a[0]; return a.map((x, i) => i ? e = x * k + e * (1 - k) : e); };
  function rsi(c, n = 14) {
    const o = Array(c.length).fill(50); let g = 0, l = 0;
    for (let i = 1; i < c.length; i++) {
      const d = c[i] - c[i - 1], u = Math.max(d, 0), v = Math.max(-d, 0);
      if (i <= n) { g += u; l += v; if (i == n) { g /= n; l /= n; o[i] = l ? 100 - 100 / (1 + g / l) : 100; } }
      else { g = (g * (n - 1) + u) / n; l = (l * (n - 1) + v) / n; o[i] = l ? 100 - 100 / (1 + g / l) : 100; }
    }
    return o;
  }
  function atr(c, n = 14) {
    const s = c.slice(-n - 1); let t = 0;
    for (let i = 1; i < s.length; i++) t += Math.max(s[i].h - s[i].l, Math.abs(s[i].h - s[i - 1].c), Math.abs(s[i].l - s[i - 1].c));
    return t / (s.length - 1 || 1);
  }
  function pivots(cs, k) {
    const H = [], L = [];
    for (let i = k; i < cs.length - k; i++) {
      let hi = 1, lo = 1;
      for (let j = 1; j <= k; j++) {
        if (cs[i].h <= cs[i - j].h || cs[i].h <= cs[i + j].h) hi = 0;
        if (cs[i].l >= cs[i - j].l || cs[i].l >= cs[i + j].l) lo = 0;
      }
      if (hi) H.push({ i, y: cs[i].h }); if (lo) L.push({ i, y: cs[i].l });
    }
    return { H, L };
  }

  const chk = (l, ok, v, req = 1, w = 10) => ({ l, ok: !!ok, v, req, w });
  const fin = (k, plan, x) => ({
    k, plan, ...x,
    score: Math.round(k.reduce((a, q) => a + (q.ok ? q.w : 0), 0) * 100 / k.reduce((a, q) => a + q.w, 0)),
    ready: k.filter(q => q.req).every(q => q.ok)
  });
  const mkPlan = (p, sl, tp) => ({ en: p, sl, tp, rr: (tp[1] - p) / (p - sl) });

  /* م: {date, float} اختياريان من واجهة المستخدم */
  function analyze(src, m) {
    m = m || {};
    const c = src.map(x => ({ t: (x.t != null ? x.t : x.time), o: x.o, h: x.h, l: x.l, c: x.c, v: x.v }));
    const cl = c.map(x => x.c);
    const e20 = ema(cl, 20), e30 = ema(cl, 30), e50 = ema(cl, 50), R = rsi(cl), A = atr(c);
    const n = c.length - 1, p = cl[n];
    const sd = m.date ? new Date(m.date).getTime() : 0;
    let s = sd ? c.findIndex(x => x.t >= sd) : -1; const known = s >= 0; if (!known) s = Math.max(0, n - 45);
    const days = sd ? Math.floor((Date.now() - sd) / 864e5) : null;
    const win = c.slice(s), hi = Math.max(...win.map(x => x.h)), iH = s + win.findIndex(x => x.h == hi);
    const lo = Math.min(...win.map(x => x.l)), iL = s + win.findIndex(x => x.l == lo);
    const rise = p / c[s].c - 1, drop = iL > iH ? 1 - lo / hi : 0, minR = Math.min(...R.slice(s));
    const Ls = pivots(win, 2).L.map(q => ({ i: q.i + s, y: q.y })).sort((x, y) => x.y - y.y);
    let A2 = Ls[0], B = null; for (const q of Ls.slice(1)) if (A2 && Math.abs(q.i - A2.i) >= 5) { B = q; break; }
    let a = A2, b = B; if (a && b && b.i < a.i) [a, b] = [b, a];
    let sweep = 0, higher = 0, neck = 0, bounce = 0, hold = 0;
    if (a && b) {
      higher = b.y > a.y && b.y / a.y - 1 < .15;
      sweep = b.y < a.y && c[b.i].c > a.y;
      hold = n - b.i >= 2 && Math.min(...c.slice(b.i).map(x => x.l)) >= Math.min(a.y, b.y) * .995;
      neck = Math.max(...c.slice(a.i, b.i + 1).map(x => x.h)); bounce = neck / a.y - 1;
    }
    const sup = lo, nearN = neck && neck / sup - 1 <= CFG.neck, bo = neck && p > neck;
    const under = c[iL].c < e20[iL] && c[iL].c < e30[iL] && c[iL].c < e50[iL];
    const rec = p >= e20[n] * .97;
    const j = c.findIndex((x, i) => i >= s && x.c < x.o);
    const fin3 = j >= 0 && c[j].h > p * 1.05 ? c[j].h : p * 1.6;
    const sl = Math.min(a ? a.y : lo, b ? b.y : lo) - .2 * A;
    const pl = mkPlan(p, sl < p ? sl : p * .9, [1, 2, 3].map(k => p + (fin3 - p) * k / 3));
    const k = [
      chk(CFG.dMin + '–' + CFG.dMax + ' يومًا منذ التجزئة', days != null && days >= CFG.dMin && days <= CFG.dMax, days == null ? 'أدخل تاريخ التجزئة' : days + ' يوم', 1, 10),
      chk('ارتفاع ≤ ' + CFG.rise * 100 + '% من إغلاق يوم التجزئة', known && rise <= CFG.rise, known ? (rise * 100).toFixed(1) + '%' : '—', 1, 10),
      chk('هبوط قوي ≥ ' + CFG.dropMin * 100 + '%', drop >= CFG.dropMin, (drop * 100).toFixed(0) + '%', 1, 10),
      chk('RSI لامس تشبع بيع (<30)', minR < 30, 'أدنى ' + minR.toFixed(1), 1, 12),
      chk('الدعم صامد 5 جلسات', n - iL >= 5, (n - iL) + ' جلسة', 1, 10),
      chk('ارتداد نحو المقاومة ≥ ' + CFG.bounce * 100 + '%', bounce >= CFG.bounce, (bounce * 100).toFixed(0) + '%', 1, 10),
      chk('إعادة اختبار الدعم + ثبات', (sweep || higher) && hold, sweep ? 'سحب سيولة' : higher ? 'قاع أعلى' : 'لم يحدث', 1, 14),
      chk('اختراق خط العنق وقربه من الدعم', bo && nearN, neck ? (bo ? 'اخترق ' : 'تحت ') + neck.toFixed(2) : '—', 1, 12),
      chk('تحت EMA بعد الهبوط ثم استرجاع', under && rec, rec ? 'مُسترجع' : 'لم يسترجع', 1, 12)
    ];
    const lines = [{ y: sup, l: 'دعم', c: '#f6465d' }]; if (neck) lines.push({ y: neck, l: 'خط العنق', c: '#d4b43a' });
    const r = fin(k, pl, {
      lines,
      info: [
        ['تاريخ التجزئة', m.date || 'غير مُدخل'],
        ['الأيام منذ التجزئة', days == null ? '—' : days],
        ['الفلوت', m.float ? m.float + 'M' : 'غير مُدخل'],
        ['أدنى RSI', minR.toFixed(1)],
        ['نسبة الهبوط', (drop * 100).toFixed(0) + '%']
      ]
    });
    r.st = r.ready ? 'جاهز فنيًا' : r.score >= 55 ? 'شبه جاهز' : 'متابعة';
    r.cls = r.ready ? 'go' : r.score >= 55 ? 'watch' : '';
    return r;
  }

  global.Split = { analyze: analyze, CFG: CFG };
})(typeof window !== 'undefined' ? window : this);
