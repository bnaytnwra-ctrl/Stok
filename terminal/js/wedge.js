/* =============================================================================
 * wedge.js — استراتيجية الوتد الهابط (Falling Wedge Strategy)
 * -----------------------------------------------------------------------------
 * التعريف الفني المُطبَّق:
 *   خطّان هابطان متقاربان؛ خط المقاومة (القمم) أشدّ انحدارًا من خط الدعم
 *   (القيعان)، فينحصر السعر بينهما ويتقلّص المدى مع انحسار الحجم —
 *   نموذج استمرار هابط يتحوّل إلى انعكاس صاعد عند اختراق المقاومة.
 *
 * خطوات الاكتشاف:
 *   1) استخراج نقاط الارتكاز (fractal pivots) للقمم والقيعان.
 *   2) مسح نوافذ مرشّحة (بداية × نهاية) وملاءمة خطّين بأقلّ المربعات،
 *      ثم "التقاط" كل خط إلى الغلاف ليمسّ أقصى نقطة ارتكاز (كفعل المتداول).
 *   3) شروط الصلاحية: انحدار هابط للخطّين + تقارب + قمّة مستقبلية (apex)
 *      + انكماش المدى + احتواء السعر + انحدار كافٍ.
 *   4) حساب الاختراق والأهداف (قياس الحركة) ووقف الخسارة ونسبة العائد/المخاطرة.
 *   5) درجة ثقة 0-100 من اللمسات ودقّة الملاءمة والانكماش والحجم والنظافة والتباعد.
 * ========================================================================== */
(function (global) {
  'use strict';

  const TA = global.TA;

  const DEFAULTS = {
    minBars: 22,          // أقل طول للوتد
    maxBars: 260,         // أقصى طول
    pivotK: 3,            // نصف عرض نقطة الارتكاز
    minContraction: 0.28, // يجب أن ينكمش المدى 28% على الأقل
    minTouches: 2,        // أقل عدد لمسات لكل خط
    buffer: 0.004,        // هامش تأكيد الاختراق
    maxViolRate: 0.09,    // أقصى نسبة شموع مخترقة للخطّين
    volumeDecline: true
  };

  /* ---------------------- تباعد RSI الصاعد (Divergence) ------------------- */
  function bullishDivergence(bars, rsiVals, from, to) {
    const lows = [];
    for (let i = Math.max(from, 2); i <= to - 2; i++) {
      if (bars[i].l <= bars[i - 1].l && bars[i].l <= bars[i - 2].l &&
        bars[i].l <= bars[i + 1].l && bars[i].l <= bars[i + 2].l) lows.push(i);
    }
    if (lows.length < 2) return null;
    const a = lows[lows.length - 2], b = lows[lows.length - 1];
    if (rsiVals[a] == null || rsiVals[b] == null) return null;
    if (bars[b].l < bars[a].l && rsiVals[b] > rsiVals[a]) {
      return { from: a, to: b, strength: rsiVals[b] - rsiVals[a] };
    }
    return null;
  }

  /* =============================== المحلّل ================================ */
  /**
   * @param {Array} bars شموع {time,o,h,l,c,v}
   * @returns {object|null} كائن الوتد أو null
   */
  function detect(bars, opts) {
    opts = Object.assign({}, DEFAULTS, opts || {});
    const n = bars.length;
    if (n < opts.minBars + 8) return null;

    const rsiVals = TA.rsi(bars, 14);
    const volMA = TA.volumeMA(bars, 20);
    const floorIdx = Math.max(0, n - 1 - opts.maxBars);

    const pv = TA.pivots(bars, opts.pivotK);
    const highs = pv.highs.filter(i => i >= floorIdx);
    const lows = pv.lows.filter(i => i >= floorIdx);
    if (highs.length < opts.minTouches || lows.length < opts.minTouches) return null;

    // نهايات مرشّحة: الشمعة الأخيرة وما قبلها (لاكتشاف اختراق حديث)
    const endCandidates = [];
    for (let e = n - 1; e >= Math.max(n - 30, floorIdx + opts.minBars); e--) endCandidates.push(e);

    // بدايات مرشّحة: نقاط ارتكاز + شبكة منتظمة
    const startSet = new Set();
    for (const i of highs) startSet.add(i);
    for (const i of lows) startSet.add(i);
    for (let i = floorIdx; i < n - opts.minBars; i += 4) startSet.add(i);
    const starts = Array.from(startSet).sort((a, b) => a - b);

    let best = null;

    for (const end of endCandidates) {
      for (const start of starts) {
        const len = end - start;
        if (len < opts.minBars || len > opts.maxBars) continue;

        const wh = highs.filter(i => i >= start && i <= end);
        const wl = lows.filter(i => i >= start && i <= end);
        if (wh.length < opts.minTouches || wl.length < opts.minTouches) continue;

        const upFit = TA.linreg(wh.map(i => [i, bars[i].h]));
        const loFit = TA.linreg(wl.map(i => [i, bars[i].l]));
        if (!upFit || !loFit) continue;

        // (1) كلا الخطّين هابطان
        if (upFit.m >= 0 || loFit.m >= 0) continue;
        // (2) تقارب: خط الدعم أقل انحدارًا من خط المقاومة
        if (loFit.m <= upFit.m) continue;

        // (2ب) التقاط الميل إلى الغلاف: نزيح الخط ليمرّ بأقصى نقطة ارتكاز
        let bUp = -Infinity, bLo = Infinity;
        for (const i of wh) bUp = Math.max(bUp, bars[i].h - upFit.m * i);
        for (const i of wl) bLo = Math.min(bLo, bars[i].l - loFit.m * i);
        const up = { m: upFit.m, b: bUp, r2: upFit.r2 };
        const lo = { m: loFit.m, b: bLo, r2: loFit.r2 };

        // (3) القمّة (apex) في المستقبل — الوتد ما زال متكوّنًا عند نهايته
        const apexX = (lo.b - up.b) / (up.m - lo.m);
        if (!(apexX > end)) continue;

        // (4) انكماش المدى
        const wStart = (up.m * start + up.b) - (lo.m * start + lo.b);
        const wEnd = (up.m * end + up.b) - (lo.m * end + lo.b);
        if (wStart <= 0 || wEnd <= 0) continue;
        const contraction = 1 - wEnd / wStart;
        if (contraction < opts.minContraction) continue;

        // (5) الاحتواء: الفتائل قد تخترق قليلًا (واقعي)، فنتسامح مع نسبة
        //     صغيرة من الشموع المخترقة بشرط ألّا يكون الاختراق فاحشًا.
        let viol = 0, worstPierce = 0;
        for (let i = start; i <= end; i++) {
          const u = up.m * i + up.b, l = lo.m * i + lo.b;
          const localW = Math.max(u - l, wStart * 0.05);
          const tol = localW * 0.15 + bars[i].c * 0.006;
          const d = Math.max(bars[i].h - (u + tol), (l - tol) - bars[i].l);
          if (d > 0) { viol++; if (d > worstPierce) worstPierce = d; }
        }
        const violRate = viol / len;
        if (violRate > opts.maxViolRate) continue;
        if (worstPierce > wStart * 0.16) continue;

        // (6) انحدار واضح (نموذج حقيقي لا قناة مسطّحة)
        const steepness = Math.abs(up.m) * len / wStart;
        if (steepness < 0.15) continue;

        // (6ب) نهاية الوتد يجب أن تسبق أي اختراق: نرفض النوافذ التي تُغلق
        //      شموعها الأخيرة فوق خط المقاومة (تلك نوافذ ما بعد الاختراق)
        let brokeTail = false;
        for (let i = Math.max(start, end - 2); i <= end; i++) {
          if (bars[i].c > up.m * i + up.b) { brokeTail = true; break; }
        }
        if (brokeTail) continue;

        // (7) اتجاه الحجم داخل الوتد
        let volFirst = 0, volLast = 0, cn1 = 0, cn2 = 0;
        const half = Math.floor(len / 2);
        for (let i = start; i < start + half; i++) { volFirst += bars[i].v; cn1++; }
        for (let i = end - half; i <= end; i++) { volLast += bars[i].v; cn2++; }
        const volRatio = (cn1 && cn2 && volFirst > 0) ? (volLast / cn2) / (volFirst / cn1) : 1;

        /* ---------------------------- درجة الثقة --------------------------- */
        const touchScore = Math.min(1, (wh.length + wl.length - 2 * opts.minTouches) / 12) * 20 + 8;
        const fitScore = ((up.r2 + lo.r2) / 2) * 18;
        const contrScore = Math.min(1, contraction / 0.70) * 14;
        const volScore = opts.volumeDecline ? Math.max(0, Math.min(1, (1 - volRatio) / 0.50)) * 13 : 7;
        const durScore = Math.min(1, len / 100) * 11;
        const slopeScore = Math.min(1, steepness / 1.3) * 8;
        const cleanScore = (1 - violRate / opts.maxViolRate) * 4;
        const div = bullishDivergence(bars, rsiVals, start, end);
        const divScore = div ? Math.min(1, div.strength / 12) * 4 + 3 : 0;
        const score = touchScore + fitScore + contrScore + volScore + durScore + slopeScore + cleanScore + divScore;

        if (!best || score > best.score) {
          best = {
            start: start, end: end, apexX: apexX, upper: up, lower: lo,
            widthStart: wStart, widthEnd: wEnd, contraction: contraction,
            touchesHigh: wh, touchesLow: wl, volRatio: volRatio,
            divergence: div, violRate: violRate, score: score,
            _parts: { touchScore, fitScore, contrScore, volScore, durScore, slopeScore, cleanScore, divScore }
          };
        }
      }
    }

    return best ? finalize(bars, best, opts, rsiVals, volMA) : null;
  }

  /* ------------------- الاختراق والأهداف ووقف الخسارة -------------------- */
  function finalize(bars, w, opts, rsiVals, volMA) {
    const n = bars.length;
    const upAt = x => w.upper.m * x + w.upper.b;
    const loAt = x => w.lower.m * x + w.lower.b;
    const last = n - 1;

    let breakoutIdx = -1, failedIdx = -1;
    for (let i = w.end + 1; i < n; i++) {
      if (breakoutIdx < 0 && bars[i].c > upAt(i) * (1 + opts.buffer)) breakoutIdx = i;
      if (failedIdx < 0 && bars[i].c < loAt(i) * (1 - opts.buffer)) failedIdx = i;
    }

    let status = 'forming';
    if (breakoutIdx >= 0 && (failedIdx < 0 || breakoutIdx < failedIdx)) {
      const age = last - breakoutIdx;
      status = age <= 1 ? 'breakout' : age <= 6 ? 'running' : 'extended';
    } else if (failedIdx >= 0) status = 'failed';

    /* الأهداف: قياس الحركة (measured move) من أقصى عرض للوتد */
    const H = w.widthStart;
    const refIdx = breakoutIdx >= 0 ? breakoutIdx : Math.min(w.end + 1, last);
    const entry = breakoutIdx >= 0 ? bars[breakoutIdx].c : upAt(refIdx);
    let swingLow = Infinity;
    for (let i = Math.max(0, refIdx - 6); i <= refIdx; i++) if (bars[i].l < swingLow) swingLow = bars[i].l;
    const stop = Math.min(loAt(refIdx), swingLow) * 0.985;

    const risk = Math.max(entry - stop, entry * 0.001);
    const targets = [0.382, 0.618, 1.0].map(f => {
      const price = entry + H * f;
      return { pct: f, price: price, rr: (price - entry) / risk };
    });

    const avgVol = volMA[refIdx] || volMA[last] || 1;
    const volConfirm = breakoutIdx >= 0 ? bars[breakoutIdx].v / (avgVol || 1) : null;

    let retestIdx = -1;
    if (breakoutIdx >= 0) {
      for (let i = breakoutIdx + 1; i < n; i++) {
        const u = upAt(i);
        if (u > 0 && Math.abs(bars[i].l - u) / u < 0.022 && bars[i].c > u) { retestIdx = i; break; }
      }
    }

    let confidence = w.score;
    if (status === 'breakout') confidence += (volConfirm && volConfirm > 1.4) ? 6 : 1;
    else if (status === 'running' && volConfirm > 1.2) confidence += 3;
    if (status === 'failed') confidence *= 0.45;
    confidence = Math.max(0, Math.min(100, confidence));

    const grade = confidence >= 92 ? 'A+' : confidence >= 84 ? 'A' : confidence >= 74 ? 'B'
      : confidence >= 62 ? 'C' : 'D';

    return {
      pattern: 'falling-wedge', symbol: null, timeframe: null,
      start: w.start, end: w.end, bars: w.end - w.start,
      upper: { m: w.upper.m, b: w.upper.b, r2: w.upper.r2, touches: w.touchesHigh },
      lower: { m: w.lower.m, b: w.lower.b, r2: w.lower.r2, touches: w.touchesLow },
      apexX: w.apexX,
      widthStart: H, widthEnd: w.widthEnd, contraction: w.contraction,
      volRatio: w.volRatio, violRate: w.violRate, divergence: w.divergence,
      status: status, breakoutIdx: breakoutIdx, failedIdx: failedIdx, retestIdx: retestIdx,
      entry: entry, stop: stop, targets: targets, risk: risk,
      volConfirm: volConfirm, confidence: confidence, grade: grade, parts: w._parts,
      upAt: upAt, loAt: loAt,
      startTime: bars[w.start].time,
      endTime: bars[w.end].time,
      breakoutTime: breakoutIdx >= 0 ? bars[breakoutIdx].time : null,
      lastClose: bars[last].c
    };
  }

  /* ---------------------------- الفاحص الشامل ---------------------------- */
  function scan(tickers, tf, opts) {
    const out = [];
    for (const t of tickers) {
      const w = detect(global.Market.series(t, tf), opts);
      if (w) { w.symbol = t; w.timeframe = tf; out.push(w); }
    }
    return out.sort((a, b) => b.confidence - a.confidence);
  }

  global.Wedge = { detect: detect, scan: scan, DEFAULTS: DEFAULTS };
})(typeof window !== 'undefined' ? window : globalThis);
