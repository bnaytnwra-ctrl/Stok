/* =============================================================================
 * indicators.js — المؤشرات الفنية (EMA / SMA / RSI / MACD / ATR / Pivots)
 * كل الدوال خالصة (pure) وتأخذ مصفوفة شموع {time,o,h,l,c,v}
 * ========================================================================== */
(function (global) {
  'use strict';

  function sma(vals, period) {
    const out = new Array(vals.length).fill(null);
    let sum = 0;
    for (let i = 0; i < vals.length; i++) {
      sum += vals[i];
      if (i >= period) sum -= vals[i - period];
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }

  function ema(vals, period) {
    const out = new Array(vals.length).fill(null);
    if (!vals.length) return out;
    const k = 2 / (period + 1);
    let prev = vals[0];
    out[0] = prev;
    for (let i = 1; i < vals.length; i++) { prev = vals[i] * k + prev * (1 - k); out[i] = prev; }
    return out;
  }

  /** RSI بطريقة Wilder الأصلية (تنعيم 14) */
  function rsi(bars, period) {
    period = period || 14;
    const out = new Array(bars.length).fill(null);
    if (bars.length <= period) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) {
      const d = bars[i].c - bars[i - 1].c;
      if (d >= 0) gain += d; else loss -= d;
    }
    let ag = gain / period, al = loss / period;
    out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    for (let i = period + 1; i < bars.length; i++) {
      const d = bars[i].c - bars[i - 1].c;
      ag = (ag * (period - 1) + Math.max(d, 0)) / period;
      al = (al * (period - 1) + Math.max(-d, 0)) / period;
      out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }
    return out;
  }

  function macd(bars, fast, slow, signal) {
    fast = fast || 12; slow = slow || 26; signal = signal || 9;
    const c = bars.map(b => b.c);
    const ef = ema(c, fast), es = ema(c, slow);
    const line = c.map((_, i) => (ef[i] == null || es[i] == null) ? null : ef[i] - es[i]);
    const clean = line.map(v => v == null ? 0 : v);
    const sig = ema(clean, signal).map((v, i) => line[i] == null ? null : v);
    const hist = line.map((v, i) => (v == null || sig[i] == null) ? null : v - sig[i]);
    return { line: line, signal: sig, hist: hist };
  }

  /** ATR بطريقة Wilder */
  function atr(bars, period) {
    period = period || 14;
    const out = new Array(bars.length).fill(null);
    if (bars.length < 2) return out;
    const trs = [bars[0].h - bars[0].l];
    for (let i = 1; i < bars.length; i++) {
      trs.push(Math.max(bars[i].h - bars[i].l,
        Math.abs(bars[i].h - bars[i - 1].c),
        Math.abs(bars[i].l - bars[i - 1].c)));
    }
    let a = 0;
    for (let i = 0; i < period && i < trs.length; i++) a += trs[i];
    a /= Math.min(period, trs.length);
    out[Math.min(period, trs.length) - 1] = a;
    for (let i = period; i < trs.length; i++) { a = (a * (period - 1) + trs[i]) / period; out[i] = a; }
    return out;
  }

  function volumeMA(bars, period) { return sma(bars.map(b => b.v), period || 20); }

  /** انحراف معياري متحرك */
  function stdev(vals, period) {
    const out = new Array(vals.length).fill(null);
    for (let i = period - 1; i < vals.length; i++) {
      let m = 0;
      for (let j = i - period + 1; j <= i; j++) m += vals[j];
      m /= period;
      let s = 0;
      for (let j = i - period + 1; j <= i; j++) s += (vals[j] - m) ** 2;
      out[i] = Math.sqrt(s / period);
    }
    return out;
  }

  /* ----------------------- نقاط الارتكاز (Pivots) ------------------------ */
  /**
   * نقطة ارتكاز fractal: الشمعة أعلى/أقل من k شمعة على كل جانب.
   * @returns {{highs:number[], lows:number[]}} فهارس
   */
  function pivots(bars, k) {
    k = k || 3;
    const highs = [], lows = [];
    for (let i = k; i < bars.length - k; i++) {
      let isHi = true, isLo = true;
      for (let j = 1; j <= k; j++) {
        if (bars[i].h <= bars[i - j].h || bars[i].h <= bars[i + j].h) isHi = false;
        if (bars[i].l >= bars[i - j].l || bars[i].l >= bars[i + j].l) isLo = false;
        if (!isHi && !isLo) break;
      }
      if (isHi) highs.push(i);
      if (isLo) lows.push(i);
    }
    return { highs: highs, lows: lows };
  }

  /** أقل مربعات على نقاط (x=fهرس، y=سعر) -> {m, b, r2} */
  function linreg(pts) {
    const n = pts.length;
    if (n < 2) return null;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const p of pts) { sx += p[0]; sy += p[1]; sxx += p[0] * p[0]; sxy += p[0] * p[1]; }
    const den = n * sxx - sx * sx;
    if (Math.abs(den) < 1e-12) return null;
    const m = (n * sxy - sx * sy) / den;
    const b = (sy - m * sx) / n;
    let ssTot = 0, ssRes = 0;
    const my = sy / n;
    for (const p of pts) { ssTot += (p[1] - my) ** 2; ssRes += (p[1] - (m * p[0] + b)) ** 2; }
    const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
    return { m: m, b: b, r2: r2 };
  }

  global.TA = {
    sma: sma, ema: ema, rsi: rsi, macd: macd, atr: atr,
    volumeMA: volumeMA, stdev: stdev, pivots: pivots, linreg: linreg
  };
})(typeof window !== 'undefined' ? window : globalThis);
