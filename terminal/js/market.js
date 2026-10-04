/* =============================================================================
 * market.js — محرك بيانات السوق (Market Data Engine)
 * -----------------------------------------------------------------------------
 * مصدر واحد على دقة الدقيقة (1-min) ثم تجميع لكل الأطر الزمنية
 * (1m/5m/15m/1H/4H/1D/1W) — كما تفعل منصات التداول الحقيقية.
 *
 * المحاكاة تعمل في فضاء log(price) بثلاثة أطوار:
 *   trend : مشي عشوائي مع تقلّب عائد للمتوسط (volatility clustering)
 *   wedge : وتد هابط منحات هندسيًا — مركز هابط بخط مستقيم + نصف عرض يتقلّص
 *           خطيًا + مذبذب جيبي مزدوج يلمس الحدّين -> خطّان حقيقيان
 *   break : اختراق صاعد بحجم مرتفع
 *
 * بلا أي تبعيات خارجية — يعمل أوفلاين بالكامل وبنتائج حتمية (deterministic).
 * ========================================================================== */
(function (global) {
  'use strict';

  /* ------------------------------ PRNG حتمي ------------------------------ */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function makeGauss(rand) {
    let spare = null;
    return function () {
      if (spare !== null) { const v = spare; spare = null; return v; }
      let u = 0, v = 0, s = 0;
      do { u = rand() * 2 - 1; v = rand() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
      const m = Math.sqrt(-2 * Math.log(s) / s);
      spare = v * m; return u * m;
    };
  }

  /* ------------------------------ الجلسات -------------------------------- */
  const MIN_PER_SESSION = 390;             // 09:30 -> 16:00 ET
  const SESSION_OPEN_MIN = 13 * 60 + 30;   // 13:30 UTC (EDT)
  const TRADING_DAYS = 300;
  const isWeekend = d => { const w = d.getUTCDay(); return w === 0 || w === 6; };

  function buildSessionStamps(days) {
    const out = [];
    const cur = new Date(Date.UTC(2026, 9, 2));      // 2026-10-02 (جمعة)
    cur.setUTCHours(0, 0, 0, 0);
    let taken = 0;
    while (taken < days) {
      if (!isWeekend(cur)) {
        const base = Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth(), cur.getUTCDate());
        for (let m = 0; m < MIN_PER_SESSION; m++) out.push(base + (SESSION_OPEN_MIN + m) * 60000);
        taken++;
      }
      cur.setUTCDate(cur.getUTCDate() - 1);
    }
    return out.reverse();
  }
  const STAMPS = buildSessionStamps(TRADING_DAYS);
  const TOTAL_MIN = STAMPS.length;

  /* ============================== الرموز ================================== */
  /**
   * T(days, mu, sigma, volMult)              طور اتجاه عادي
   * W(days, mu, sigma, volMult, contraction) طور وتد هابط (يُنحت هندسيًا)
   * B(days, mu, sigma, volMult)              طور اختراق صاعد
   * mu/sigma بوحدات log(price) لكل يوم تداول
   */
  const T = (d, mu, sg, vm) => ({ d, mode: 'trend', mu, sg, vm });
  const W = (d, mu, sg, vm, ct, jt) => ({ d, mode: 'wedge', mu, sg, vm, ct: ct == null ? 0.75 : ct, jt: jt == null ? 1.0 : jt });
  const B = (d, mu, sg, vm) => ({ d, mode: 'break', mu, sg, vm });

  const SYMBOLS = [
    { t: 'SOUN', name: 'ساوند هوك', sector: 'تقلبات عالية', base: 6.4,
      script: [T(50, -0.004, 0.052, 1.0), T(25, 0.008, 0.042, 0.9), T(35, -0.003, 0.048, 1.1),
               T(30, -0.020, 0.074, 1.3), W(160, -0.0024, 0.026, 0.55, 0.78, 1.9)],
      news: [0.20] },

    { t: 'BB', name: 'بي بي', sector: 'تقلبات عالية', base: 21.0,
      script: [T(60, -0.007, 0.058, 1.0), T(35, -0.022, 0.080, 1.35),
               W(175, -0.0026, 0.028, 0.58, 0.80), B(6, 0.028, 0.050, 2.7)],
      news: [0.16] },

    { t: 'PLTR', name: 'بالانتير', sector: 'تقلبات عالية', base: 27.5,
      script: [T(65, 0.003, 0.066, 1.0), T(30, -0.028, 0.094, 1.5),
               W(205, -0.0021, 0.030, 0.60, 0.76)],
      news: [0.11] },

    { t: 'MARA', name: 'مارا', sector: 'تقلبات عالية', base: 15.8,
      script: [T(40, 0.012, 0.050, 1.1), T(25, 0.028, 0.078, 1.7), T(35, -0.016, 0.060, 1.1),
               T(20, -0.022, 0.072, 1.3), W(180, -0.0023, 0.026, 0.54, 0.79, 1.2)],
      news: [0.10, 0.24] },

    { t: 'RIOT', name: 'رايوت', sector: 'تقلبات عالية', base: 10.9,
      script: [T(75, -0.005, 0.054, 1.0), T(30, -0.024, 0.088, 1.4),
               W(170, -0.0025, 0.028, 0.57, 0.78), B(20, 0.030, 0.052, 2.9)],
      news: [0.19] },

    { t: 'AMD', name: 'إيه إم دي', sector: 'تقلبات عالية', base: 152.0,
      script: [T(55, -0.011, 0.062, 1.1), T(35, 0.010, 0.048, 1.0), T(30, -0.018, 0.068, 1.2),
               W(180, -0.0022, 0.025, 0.55, 0.77, 2.3)],
      news: [0.42] },

    { t: 'NVDA', name: 'إنفيديا', sector: 'تقلبات عالية', base: 118.0,
      script: [T(30, 0.036, 0.090, 2.0), T(25, -0.030, 0.088, 1.5), T(20, -0.022, 0.074, 1.3),
               W(225, -0.0020, 0.027, 0.58, 0.80, 1.3)],
      news: [0.08] },

    { t: 'TSLA', name: 'تسلا', sector: 'تقلبات عالية', base: 244.0,
      script: [T(75, -0.006, 0.056, 1.1), T(20, -0.019, 0.070, 1.3),
               W(205, -0.0019, 0.024, 0.52, 0.75)],
      news: [0.21] },

    { t: 'MULN', name: 'مولين', sector: 'تجزئة عكسية', base: 3.1,
      script: [T(65, -0.014, 0.074, 1.2), T(30, -0.026, 0.094, 1.6),
               W(205, -0.0027, 0.030, 0.62, 0.80)],
      news: [0.30] },

    { t: 'BBBY', name: 'بيد باث', sector: 'تجزئة عكسية', base: 1.9,
      script: [T(60, 0.004, 0.044, 0.9), T(35, -0.011, 0.052, 1.0),
               W(205, -0.0016, 0.021, 0.50, 0.62, 1.5)],
      news: [0.14] },

    { t: 'CVNA', name: 'كارفانا', sector: 'تجزئة عكسية', base: 38.0,
      script: [T(95, 0.001, 0.030, 0.9), T(20, -0.009, 0.040, 1.1),
               W(185, -0.0012, 0.017, 0.46, 0.60, 1.4)],
      news: [0.27] },

    { t: 'UPST', name: 'أبستارت', sector: 'تجزئة عكسية', base: 26.0,
      script: [T(75, -0.008, 0.050, 1.0), T(25, -0.020, 0.066, 1.25),
               W(200, -0.0022, 0.026, 0.56, 0.77)],
      news: [0.18] },

    { t: 'SOFI', name: 'سوفي', sector: 'تقلبات عالية', base: 10.2,
      script: [T(50, 0.008, 0.054, 1.0), T(25, 0.022, 0.074, 1.5), T(35, -0.024, 0.084, 1.4),
               W(175, -0.0025, 0.027, 0.58, 0.79), B(2, 0.135, 0.055, 4.2)],
      news: [0.11, 0.25] },

    { t: 'PLUG', name: 'بلاغ باور', sector: 'تجزئة عكسية', base: 2.4,
      script: [T(60, -0.016, 0.080, 1.3), T(25, -0.028, 0.098, 1.6),
               W(215, -0.0028, 0.031, 0.63, 0.81)],
      news: [0.17] },

    { t: 'F', name: 'فورد', sector: 'تجزئة عكسية', base: 11.3,
      script: [T(70, 0.003, 0.050, 1.0), T(30, -0.017, 0.062, 1.2),
               W(200, -0.0021, 0.025, 0.54, 0.76, 1.7)],
      news: [0.22] },

    { t: 'GE', name: 'جنرال إلكتريك', sector: 'تجزئة عكسية', base: 64.0,
      script: [T(65, -0.011, 0.070, 1.2), T(30, 0.006, 0.054, 1.0), T(20, -0.021, 0.076, 1.3),
               W(160, -0.0023, 0.027, 0.57, 0.78, 1.1), T(25, -0.026, 0.062, 1.6)],
      news: [0.24] }
  ];

  /* ==================== محاكاة السلسلة على دقة الدقيقة ==================== */
  function genSymbol(sym) {
    const rand = mulberry32(hashStr(sym.t));
    const gauss = makeGauss(rand);

    // ---- ضبط الأطوار ليبلغ مجموعها عدد أيام التداول بالضبط ----
    // (يُمتصّ الفرق في طور الوتد حتى تبقى أطوار الاختراق/الفشل في موضعها الصحيح)
    const script = sym.script.map(p => Object.assign({}, p));
    const totalDays = script.reduce((a, p) => a + p.d, 0);
    if (totalDays !== TRADING_DAYS) {
      let k = script.findIndex(p => p.mode === 'wedge');
      if (k < 0) k = script.length - 1;
      script[k].d += (TRADING_DAYS - totalDays);
    }
    if (script.some(p => p.d <= 0)) throw new Error('bad script for ' + sym.t);

    // ---- توسيع الأطوار ----
    const mode = new Uint8Array(TOTAL_MIN);
    const drift = new Float64Array(TOTAL_MIN);
    const vol = new Float64Array(TOTAL_MIN);
    const volMult = new Float64Array(TOTAL_MIN);
    const phOf = new Int32Array(TOTAL_MIN);
    const PH_START = [];
    let idx = 0;
    script.forEach((ph, pi) => {
      PH_START[pi] = idx;
      const n = ph.d * MIN_PER_SESSION;
      for (let i = 0; i < n && idx < TOTAL_MIN; i++, idx++) {
        mode[idx] = ph.mode === 'wedge' ? 1 : ph.mode === 'break' ? 2 : 0;
        drift[idx] = ph.mu / MIN_PER_SESSION;
        vol[idx] = ph.sg / Math.sqrt(MIN_PER_SESSION);
        volMult[idx] = ph.vm;
        phOf[idx] = pi;
      }
    });
    while (idx < TOTAL_MIN) {
      const L = TOTAL_MIN - 1;
      mode[idx] = mode[L]; drift[idx] = drift[L]; vol[idx] = vol[L]; volMult[idx] = volMult[L]; phOf[idx] = phOf[L]; idx++;
    }

    // ---- قفزات الأخبار (خارج أطوار الوتد كي لا تشوّه الهندسة) ----
    const jumps = new Map();
    for (const f of (sym.news || [])) {
      const j = Math.floor(TOTAL_MIN * f);
      if (mode[j] === 1) continue;
      jumps.set(j, (rand() < 0.62 ? 1 : -1) * (0.05 + rand() * 0.14));
    }

    /* ---- مذبذب الوتد: جيبي مزدوج في [-1, 1] يلمس الحدّين بشكل متكرّر ---- */
    const OSC = {
      w1: 2 * Math.PI / ((4.5 + rand() * 4.0) * MIN_PER_SESSION),   // 4.5 – 8.5 يوم
      w2: 2 * Math.PI / ((11.0 + rand() * 6.0) * MIN_PER_SESSION),  // 11 – 17 يوم
      p1: rand() * Math.PI * 2, p2: rand() * Math.PI * 2,
      a1: 0.74, a2: 0.40                                            // المجموع > 1 -> قصّ = لمسات قويّة
    };
    const oscAt = i => {
      const v = OSC.a1 * Math.sin(OSC.w1 * i + OSC.p1) + OSC.a2 * Math.sin(OSC.w2 * i + OSC.p2);
      return Math.max(-1, Math.min(1, v));
    };

    // ---- المحاكاة ----
    const x = new Float64Array(TOTAL_MIN);
    x[0] = Math.log(sym.base * (1.8 + rand() * 0.8));
    const wedgeCtx = new Map();

    for (let i = 1; i < TOTAL_MIN; i++) {
      const pi = phOf[i];

      if (mode[i] === 1) {
        let ctx = wedgeCtx.get(pi);
        if (!ctx) {
          const ph = script[pi];
          const o0 = oscAt(i);
          // نصف العرض الابتدائي = نصف المدى الحقيقي لآخر 12 يومًا (مقيّد)
          const look = Math.min(i, 12 * MIN_PER_SESSION);
          let hi = -Infinity, lo = Infinity;
          for (let k = i - look; k < i; k++) { if (x[k] > hi) hi = x[k]; if (x[k] < lo) lo = x[k]; }
          const hw0 = Math.max(0.035, Math.min(0.19, (hi - lo) / 2));
          ctx = { center: x[i - 1] - hw0 * o0, hw0: hw0, ct: ph.ct, len: ph.d * MIN_PER_SESSION };
          wedgeCtx.set(pi, ctx);
        }
        const frac = Math.min(1, (i - PH_START[pi]) / ctx.len);
        const hw = ctx.hw0 * (1 - ctx.ct * frac);
        ctx.center += drift[i];
        // ضجيج خفيف داخل القناة لإضفاء واقعية على الفتائل
        x[i] = ctx.center + hw * oscAt(i) + vol[i] * (0.30 + 0.95 * (script[pi].jt || 1)) * gauss();
      } else if (mode[i] === 2) {
        x[i] = x[i - 1] + drift[i] * 1.4 + vol[i] * gauss() * 0.95;
      } else {
        x[i] = x[i - 1] + drift[i] + vol[i] * gauss();
      }

      if (jumps.has(i)) x[i] += jumps.get(i);
      if (x[i] < Math.log(0.012)) x[i] = Math.log(0.012);
    }

    // ---- بناء الشموع الدقيقة ----
    const minute = new Array(TOTAL_MIN);
    for (let i = 0; i < TOTAL_MIN; i++) {
      const o = i > 0 ? Math.exp(x[i - 1]) : Math.exp(x[i]);
      const c = Math.exp(x[i]);
      const body = Math.abs(c - o);
      const wick = c * vol[i] * Math.sqrt(MIN_PER_SESSION) * (mode[i] === 1 ? 0.16 : 0.30) * 0.4;
      const hi = Math.max(o, c) + body * 0.18 + Math.abs(gauss()) * wick;
      const lo = Math.min(o, c) - body * 0.18 - Math.abs(gauss()) * wick;
      const mIn = i % MIN_PER_SESSION;
      const u = mIn / (MIN_PER_SESSION - 1);
      const uShape = 0.55 + 1.25 * (4 * u * (1 - u)) * 0.0 + 1.05 * Math.pow(Math.abs(2 * u - 1), 1.7);
      // انحسار الحجم داخل الوتد (تأكيد فني كلاسيكي)
      let vmNow = volMult[i];
      if (mode[i] === 1) {
        const frac = Math.min(1, (i - PH_START[phOf[i]]) / (script[phOf[i]].d * MIN_PER_SESSION));
        vmNow *= (1 - 0.58 * frac);
      } else if (mode[i] === 2) vmNow *= 2.0;
      minute[i] = {
        time: STAMPS[i], o: o, h: hi, l: Math.max(lo, 0.0006), c: c,
        v: Math.round((65000 + 190000 * vmNow * uShape) * (0.74 + rand() * 0.62))
      };
    }
    for (const [j, mag] of jumps) {
      minute[j].v = Math.round(minute[j].v * (2.8 + Math.abs(mag) * 10));
      if (j + 1 < TOTAL_MIN) minute[j + 1].v = Math.round(minute[j + 1].v * 1.9);
    }
    return minute;
  }

  /* ============================== التجميع ================================= */
  const TF_MINUTES = { '1m': 1, '5m': 5, '15m': 15, '1H': 60, '4H': 240, '1D': 'day', '1W': 'week' };
  const TIMEFRAMES = ['1m', '5m', '15m', '1H', '4H', '1D', '1W'];
  const TF_LABEL = { '1m': 'دقيقة', '5m': '٥ دقائق', '15m': '١٥ دقيقة', '1H': 'ساعة', '4H': '٤ ساعات', '1D': 'يومي', '1W': 'أسبوعي' };

  function bucketKey(t, tf) {
    if (tf === '1D') return Math.floor(t / 86400000);
    if (tf === '1W') { const d = new Date(t); return Math.floor(t / 86400000) - ((d.getUTCDay() + 6) % 7); }
    const mins = TF_MINUTES[tf];
    const d = new Date(t);
    const mIn = d.getUTCHours() * 60 + d.getUTCMinutes() - SESSION_OPEN_MIN;
    return Math.floor(t / 86400000) * 1000000 + Math.floor(Math.max(0, mIn) / mins);
  }

  function aggregate(minute, tf) {
    if (tf === '1m') return minute;
    const out = [];
    let cur = null, key = null;
    for (let i = 0; i < minute.length; i++) {
      const b = minute[i], k = bucketKey(b.time, tf);
      if (k !== key) {
        if (cur) out.push(cur);
        key = k;
        cur = { time: b.time, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
      } else {
        cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l);
        cur.c = b.c; cur.v += b.v;
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  const _minuteCache = new Map(), _tfCache = new Map();
  function minuteSeries(sym) {
    if (!_minuteCache.has(sym.t)) _minuteCache.set(sym.t, genSymbol(sym));
    return _minuteCache.get(sym.t);
  }
  function series(ticker, tf) {
    const key = ticker + '|' + tf;
    if (_tfCache.has(key)) return _tfCache.get(key);
    const sym = SYMBOLS.find(s => s.t === ticker) || SYMBOLS[0];
    const out = aggregate(minuteSeries(sym), tf);
    _tfCache.set(key, out);
    return out;
  }
  const meta = ticker => SYMBOLS.find(s => s.t === ticker) || SYMBOLS[0];

  /* ====================== ملخّص الرمز (Watchlist) ========================= */
  function quote(ticker) {
    const d = series(ticker, '1D');
    const last = d[d.length - 1], prev = d[d.length - 2] || last;
    const chg = last.c - prev.c;
    let hi52 = -Infinity, lo52 = Infinity, volSum = 0;
    for (const b of d) { if (b.h > hi52) hi52 = b.h; if (b.l < lo52) lo52 = b.l; }
    for (const b of d.slice(-30)) volSum += b.v;
    return {
      t: ticker, name: meta(ticker).name, sector: meta(ticker).sector,
      price: last.c, chg: chg, chgPct: (chg / prev.c) * 100,
      open: last.o, high: last.h, low: last.l, prevClose: prev.c,
      volume: last.v, avgVol30: volSum / Math.min(30, d.length),
      hi52: hi52, lo52: lo52, spark: d.slice(-45).map(b => b.c)
    };
  }

  /* ================== تنبيهات المحفزات (من سجل البوت) ===================== */
  /* نفس بيانات logs/alerts_log.csv في المستودع */
  /* BEGIN-EMBEDDED-ALERTS */
  const ALERTS = [
    {"ts":"2026-10-01T13:16:34.754358+00:00","t":"BCDA","title":"BioCardia Files Revised De Novo Pre-Submission for FDA Approval of Helix™ Catheter","price":1.01,"src":"GlobeNewswire - Public Companies","kind":"عاجل","catalyst":"موافقة FDA رسمية على الدواء/المنتج","event_date":"2026-10-01","score":5},
    {"ts":"2026-09-30T11:10:37.070369+00:00","t":"OCGN","title":"Ocugen to Participate in Upcoming Scientific Conferences","price":1.09,"src":"GlobeNewswire - Public Companies","kind":"محفّز","catalyst":"عرض/تقديم نتائج علمية قادم","event_date":"2026-09-30","score":4},
    {"ts":"2026-09-29T17:05:27.680945+00:00","t":"BYSI","title":"BeyondSpring Announces FDA Fast Track Designation for Plinabulin in Post-ICI Non-Squamous NSCLC and Strategic Transaction to Advance Global Phase 3 DUBLIN-4 Trial Toward Planned Interim Analysis","price":0.623,"src":"GlobeNewswire - Clinical Study","kind":"عاجل","catalyst":"تصنيف FDA كـ Fast Track","event_date":"2026-09-29","score":5},
    {"ts":"2026-09-25T11:46:38.197891+00:00","t":"AIFF","title":"Firefly (NASDAQ: AIFF) and NeuroSigma Partner to Expand Access to First FDA-Cleared, Non-Drug Treatment for Pediatric ADHD","price":1.19,"src":"globenewswire","kind":"خبر","catalyst":"","event_date":"","score":5},
    {"ts":"2026-09-24T17:28:42.169413+00:00","t":"AGRZ","title":"AGROZ INC. ANNOUNCES ANTICIPATED REVERSE STOCK SPLIT","price":0.2251,"src":"prnewswire","kind":"خبر","catalyst":"","event_date":"","score":3},
    {"ts":"2026-09-24T16:22:12.656658+00:00","t":"BZAI","title":"BZAI DEADLINE: ROSEN, TRUSTED INVESTOR COUNSEL, Encourages Blaize Holdings, Inc. Investors with Losses in Excess of $100K to Secure Counsel Before Important Deadline in Securities Class Action First Filed by the Firm - BZAI","price":0.5375,"src":"newsfile","kind":"خبر","catalyst":"","event_date":"","score":5},
    {"ts":"2026-09-24T11:01:35.462338+00:00","t":"RAASY","title":"Cloopen Group Holding Limited Announces Shareholders' Approval of Merger Agreement","price":2.52,"src":"prnewswire","kind":"خبر","catalyst":"","event_date":"","score":4},
    {"ts":"2026-09-24T11:00:30.363490+00:00","t":"ORGN","title":"Origen to Proceed with the Acquisition of the Campo De Cima Project in Brazil","price":0.9501,"src":"newsfile","kind":"خبر","catalyst":"","event_date":"","score":4},
    {"ts":"2026-09-23T19:34:43.514490+00:00","t":"ZTG","title":"Zenta Group Company Limited Clarifies Shares Outstanding Following Recent Share Issuance","price":1.73,"src":"globenewswire","kind":"خبر","catalyst":"","event_date":"","score":4},
    {"ts":"2026-09-23T11:00:20.021860+00:00","t":"ZBAO","title":"Zhibao Technology Inc. Enters into Non-Binding Letter of Intent to Acquire On-Chain Trading Platform MeVX","price":0.109,"src":"newsfile","kind":"خبر","catalyst":"","event_date":"","score":4},
    {"ts":"2026-09-22T11:01:41.634742+00:00","t":"AMFN","title":"American Fusion Inc. (OTCQB: AMFN) Provides Corporate Update on Intellectual Property, Texatron™ Testing and National Exchange Uplisting","price":0.106,"src":"globenewswire","kind":"خبر","catalyst":"","event_date":"","score":4},
    {"ts":"2026-09-22T10:09:50.581152+00:00","t":"LODE","title":"Comstock Metals Commences 24/7 Operations for Solar Panel Recycling","price":2.62,"src":"globenewswire","kind":"خبر","catalyst":"","event_date":"","score":3},
    {"ts":"2026-09-21T10:08:49.543118+00:00","t":"KDK","title":"Kodiak Copper Announces Filing of TSXV Listing Application, Execution of Definitive Agreements, Closing of Subscription Receipt Financing and Leadership Appointments for Kay Copper","price":3.28,"src":"newsfile","kind":"خبر","catalyst":"","event_date":"","score":3},
    {"ts":"2026-09-18T11:30:27.672564+00:00","t":"MERC","title":"Mercado Minerals Signs LOI to Acquire La Franca within the Zamora Project and Samples 1.00 Metre of 1.53 kg/t Silver and 1.39 g/t Gold","price":0.3844,"src":"newsfile","kind":"خبر","catalyst":"","event_date":"","score":3},
    {"ts":"2026-09-16T12:02:15.471304+00:00","t":"DLXY","title":"Delixy Holdings Limited Signs Non-Binding Letter of Intent for Strategic Transaction Involving Up to 48% Interest in East Kazakhstan Sarybulak Oil Field","price":0.415,"src":"globenewswire","kind":"خبر","catalyst":"","event_date":"","score":5},
    {"ts":"2026-09-15T20:16:42.457573+00:00","t":"RC","title":"Ready Capital Corporation Declares Third Quarter 2026 Dividends","price":1.6,"src":"globenewswire","kind":"خبر","catalyst":"","event_date":"","score":3},
    {"ts":"2026-09-15T11:31:33.996521+00:00","t":"ZENA","title":"ZenaTech Closes 29th Drone as a Service Acquisition Adding Solar and Railroad Customers with Georgia-based U.S. Land Surveying Company Holding Licenses in 17 States","price":1.48,"src":"globenewswire","kind":"خبر","catalyst":"","event_date":"","score":4},
    {"ts":"2026-09-15T10:10:01.871192+00:00","t":"ZEFIF","title":"Zefiro Awarded Three Federally Funded Well Plugging Projects in Ohio and Pennsylvania","price":0.4685,"src":"newsfile","kind":"خبر","catalyst":"","event_date":"","score":3},
    {"ts":"2026-09-14T20:11:51.674198+00:00","t":"BMNM","title":"Richard Parry Joins Board of Directors of Bimini Capital Management","price":3.32,"src":"globenewswire","kind":"خبر","catalyst":"","event_date":"","score":4},
    {"ts":"2026-09-14T12:16:14.024816+00:00","t":"MYSZ","title":"MySize Announces Acquisition-Led Strategy Focused on Defense Technology","price":1.73,"src":"prnewswire","kind":"خبر","catalyst":"","event_date":"","score":4},
    {"ts":"2026-09-14T12:01:24.224300+00:00","t":"NOMA","title":"Nomadar Enters into Definitive Agreement to Acquire Majority Interest in Fox Soccer Academy","price":1.45,"src":"prnewswire","kind":"خبر","catalyst":"","event_date":"","score":3}
  ];
  /* END-EMBEDDED-ALERTS */

  const TICKERS = SYMBOLS.map(s => s.t);
  const META = Object.fromEntries(SYMBOLS.map(s => [s.t, s]));

  /* إضافة رمز ديناميكيًا (يدويًا أو من TradingView) ببيانات حتمية مشتقة من اسمه */
  function ensureSymbol(t, over) {
    t = String(t || '').trim().toUpperCase();
    if (!t) return null;
    if (META[t]) return META[t];
    const rand = mulberry32(hashStr(t));
    const base = +(1 + rand() * 240).toFixed(2);
    const script = [
      T(40 + Math.floor(rand() * 40), (rand() - .5) * .02, .05 + rand() * .04, 1 + rand() * .5),
      W(140 + Math.floor(rand() * 80), -.002 - rand() * .001, .024 + rand() * .006, .5 + rand() * .2, .72 + rand() * .12),
      (rand() < .4 ? B(8, .028, .05, 2.6) : T(20, -.004, .05, 1))
    ];
    const sym = { t: t, name: (over && over.name) || t, sector: (over && over.sector) || 'مضاف', base: base, script: script, news: [] };
    SYMBOLS.push(sym); TICKERS.push(t); META[t] = sym;
    return sym;
  }

  global.Market = {
    SYMBOLS: TICKERS,
    META: META,
    TIMEFRAMES: TIMEFRAMES, TF_LABEL: TF_LABEL,
    series: series, quote: quote, meta: meta, alerts: ALERTS,
    ensureSymbol: ensureSymbol,
    SESSION_OPEN_MIN: SESSION_OPEN_MIN, MIN_PER_SESSION: MIN_PER_SESSION
  };
})(typeof window !== 'undefined' ? window : globalThis);
