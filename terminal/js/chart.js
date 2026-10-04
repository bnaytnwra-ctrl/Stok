/* =============================================================================
 * chart.js — محرك الشارت (Canvas 2D، بلا أي مكتبات خارجية)
 * -----------------------------------------------------------------------------
 * شموع يابانية + حجم + RSI في ألواح متزامنة، مع:
 *   • تكبير/تصوير بالعجلة مرتكز على المؤشر + سحب للتحريك
 *   • مؤشّر تقاطع (crosshair) مع قراءة OHLCV
 *   • مقياس لوغاريتمي اختياري + مقياس سعر تلقائي بخطوات "نظيفة"
 *   • طبقة الوتد الهابط: الخطّان + التعبئة + القمّة + الأهداف + وقف الخسارة
 *   • طبقة رسم يدوي (خط اتجاه / أفقي / فيبوناتشي / منطقة / قياس)
 *   • علامات الأخبار وعلامات الاختراق وإعادة الاختبار
 * ========================================================================== */
(function (global) {
  'use strict';

  const C = {
    up: '#12c48b', down: '#f0455a',
    upFill: 'rgba(18,196,139,0.95)', downFill: 'rgba(240,69,90,0.95)',
    grid: 'rgba(255,255,255,0.045)',
    gridStrong: 'rgba(255,255,255,0.085)',
    axis: '#64748b', axisDim: '#3f4a5e',
    txt: '#cbd5e1', txtDim: '#64748b',
    cross: 'rgba(148,163,184,0.55)',
    ema9: '#f0b90b', ema21: '#3b82f6', ema50: '#a855f7', sma200: '#94a3b8',
    wedgeUp: '#e8edf4', wedgeLo: '#cfd8e3', wedgeFill: 'rgba(232,237,244,0.03)',
    entry: '#d4b43a', stop: '#f6465d', target: '#2ebd85',
    zoneT: 'rgba(23,116,97,0.42)', zoneE: 'rgba(148,124,34,0.50)', zoneS: 'rgba(138,45,58,0.46)',
    volUp: 'rgba(18,196,139,0.45)', volDown: 'rgba(240,69,90,0.45)', volMa: '#8b95a8',
    rsi: '#a78bfa', news: '#f5a623'
  };

  const FONT = '11px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
  const FONT_B = '600 11px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
  const FONT_S = '10px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';

  function niceStep(range, target) {
    const raw = range / target;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = norm >= 7.5 ? 10 : norm >= 3.5 ? 5 : norm >= 2.2 ? 2.5 : norm >= 1.4 ? 2 : 1;
    return step * mag;
  }

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  class Chart {
    constructor(canvas, opts) {
      this.cv = canvas;
      this.ctx = canvas.getContext('2d');
      this.o = Object.assign({
        showVolume: true, showRsi: true, showEma: true, log: false,
        volumeH: 74, rsiH: 104, axisW: 66, timeH: 24, padT: 14, padB: 6, padL: 2
      }, opts || {});
      this.bars = [];
      this.tf = '1D';
      this.symbol = '';
      this.chartType = 'candles';
      this.wedge = null;
      this.drawings = [];
      this.activeDrawing = null;
      this.tool = 'cursor';
      this.news = [];
      this.viewFrom = 0; this.viewTo = 100;
      this.mouse = null;
      this.hover = null;
      this.onPick = null;
      this.onCursor = null;
      this._dpr = 1;
      this._bindEvents();
    }

    /* ------------------------------ البيانات ----------------------------- */
    setData(bars, tf, symbol) {
      this.bars = bars || [];
      this.tf = tf; this.symbol = symbol;
      // إسقاط أي وتد/أخبار سابقة: فهارسها تخصّ مصفوفة الشموع القديمة
      this.wedge = null;
      this.news = [];
      this.mouse = null; this.hover = null;
      this.invalidateIndicators();
      const vis = Math.min(this.bars.length, tf === '1D' || tf === '1W' ? 150 : 180);
      this.viewTo = this.bars.length;
      this.viewFrom = Math.max(0, this.viewTo - vis);
      this.requestDraw();
    }
    setWedge(w) { this.wedge = w; this.requestDraw(); }
    setDrawings(d) { this.drawings = d || []; this.requestDraw(); }
    setNews(n) { this.news = n || []; this.requestDraw(); }
    setTool(t) { this.tool = t; this.cv.style.cursor = t === 'cursor' ? 'crosshair' : 'copy'; }

    /* ------------------------------ الهندسة ------------------------------ */
    _geom() {
      const w = this.cv.clientWidth, h = this.cv.clientHeight;
      const o = this.o;
      const plotW = Math.max(40, w - o.axisW - o.padL);
      const volH = o.showVolume ? o.volumeH : 0;
      const rsiH = o.showRsi ? o.rsiH : 0;
      const gaps = (o.showVolume ? 8 : 0) + (o.showRsi ? 8 : 0);
      const priceH = Math.max(60, h - o.timeH - o.padT - o.padB - volH - rsiH - gaps);
      const priceTop = o.padT;
      const volTop = priceTop + priceH + 8;
      const rsiTop = volTop + (o.showVolume ? volH + 8 : 0);
      return { w, h, plotW, priceH, priceTop, volH, volTop, rsiH, rsiTop, axisX: o.padL + plotW };
    }

    _range() {
      const i0 = Math.max(0, Math.floor(this.viewFrom));
      const i1 = Math.min(this.bars.length - 1, Math.ceil(this.viewTo));
      let hi = -Infinity, lo = Infinity;
      for (let i = i0; i <= i1; i++) { if (this.bars[i].h > hi) hi = this.bars[i].h; if (this.bars[i].l < lo) lo = this.bars[i].l; }
      // أهداف الوتد تدخل في المقياس إن كانت ضمن الأفق
      if (this.wedge) {
        const w = this.wedge;
        if (w.status !== 'failed') {
          hi = Math.max(hi, w.targets[2].price);
          lo = Math.min(lo, w.stop);
        }
      }
      if (hi === lo) { hi += 1; lo -= 1; }
      const pad = (hi - lo) * 0.08;
      return { hi: hi + pad, lo: Math.max(0, lo - pad) };
    }

    barW() { return this._geom().plotW / Math.max(1, this.viewTo - this.viewFrom); }
    xAt(i) { return this.o.padL + (i + 0.5 - this.viewFrom) * this.barW(); }
    iAt(x) { return this.viewFrom + (x - this.o.padL) / this.barW() - 0.5; }

    yAt(p, g, r) {
      if (this.o.log) {
        const a = Math.log(Math.max(r.lo, 1e-9)), b = Math.log(Math.max(r.hi, 1e-9));
        return g.priceTop + (b - Math.log(Math.max(p, 1e-9))) / Math.max(b - a, 1e-9) * g.priceH;
      }
      return g.priceTop + (r.hi - p) / (r.hi - r.lo) * g.priceH;
    }
    pAt(y, g, r) {
      if (this.o.log) {
        const a = Math.log(Math.max(r.lo, 1e-9)), b = Math.log(Math.max(r.hi, 1e-9));
        return Math.exp(b - (y - g.priceTop) / g.priceH * (b - a));
      }
      return r.hi - (y - g.priceTop) / g.priceH * (r.hi - r.lo);
    }

    /* ------------------------------ الأحداث ------------------------------ */
    _bindEvents() {
      const cv = this.cv;
      let drag = null;
      cv.addEventListener('wheel', e => {
        e.preventDefault();
        const rect = cv.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const anchor = this.iAt(x);
        const span = this.viewTo - this.viewFrom;
        const factor = Math.exp(e.deltaY * 0.0016);
        let ns = Math.max(12, Math.min(this.bars.length, span * factor));
        const ratio = (anchor - this.viewFrom) / span;
        this.viewFrom = anchor - ratio * ns;
        this.viewTo = this.viewFrom + ns;
        this._clamp();
        this.requestDraw();
      }, { passive: false });

      cv.addEventListener('mousedown', e => {
        const rect = cv.getBoundingClientRect();
        const x = e.clientX - rect.left, y = e.clientY - rect.top;
        if (this.tool !== 'cursor') {
          const idx = Math.round(this.iAt(x));
          const g = this._geom(), r = this._range();
          const price = this.pAt(y, g, r);
          const d = { type: this.tool, i0: idx, p0: price, i1: idx, p1: price, done: false };
          this.activeDrawing = d;
          this.drawings.push(d);
          this.requestDraw();
          return;
        }
        drag = { x: x, from: this.viewFrom, to: this.viewTo };
        cv.style.cursor = 'grabbing';
      });

      window.addEventListener('mousemove', e => {
        const rect = cv.getBoundingClientRect();
        const x = e.clientX - rect.left, y = e.clientY - rect.top;
        if (this.activeDrawing && !this.activeDrawing.done) {
          const g = this._geom(), r = this._range();
          this.activeDrawing.i1 = Math.round(this.iAt(x));
          this.activeDrawing.p1 = this.pAt(y, g, r);
          this.requestDraw();
          return;
        }
        if (drag) {
          const di = (x - drag.x) / this.barW();
          this.viewFrom = drag.from - di; this.viewTo = drag.to - di;
          this._clamp(); this.requestDraw();
          return;
        }
        if (x < 0 || y < 0 || x > rect.width || y > rect.height) { this.mouse = null; this.requestDraw(); return; }
        this.mouse = { x: x, y: y };
        const idx = Math.round(this.iAt(x));
        this.hover = (idx >= 0 && idx < this.bars.length) ? idx : null;
        if (this.onCursor) this.onCursor(this.hover);
        this.requestDraw();
      });

      window.addEventListener('mouseup', () => {
        drag = null; cv.style.cursor = this.tool === 'cursor' ? 'crosshair' : 'copy';
        if (this.activeDrawing) {
          if (Math.abs(this.activeDrawing.i1 - this.activeDrawing.i0) < 1 && this.activeDrawing.type !== 'hline') {
            this.drawings.pop();
          } else this.activeDrawing.done = true;
          this.activeDrawing = null;
          this.setTool('cursor');
          if (this.onDraw) this.onDraw(this.drawings);
          this.requestDraw();
        }
      });

      cv.addEventListener('mouseleave', () => { this.mouse = null; this.hover = null; if (this.onCursor) this.onCursor(null); this.requestDraw(); });
      cv.addEventListener('dblclick', () => { this.reset(); });
    }

    _clamp() {
      const span = this.viewTo - this.viewFrom;
      if (this.viewFrom < -span * 0.15) { this.viewFrom = -span * 0.15; this.viewTo = this.viewFrom + span; }
      if (this.viewTo > this.bars.length + span * 0.25) { this.viewTo = this.bars.length + span * 0.25; this.viewFrom = this.viewTo - span; }
    }

    reset() {
      const vis = Math.min(this.bars.length, this.tf === '1D' || this.tf === '1W' ? 150 : 180);
      this.viewTo = this.bars.length; this.viewFrom = Math.max(0, this.viewTo - vis);
      this.requestDraw();
    }

    requestDraw() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => { this._raf = null; this.draw(); });
    }

    /* -------------------------------- الرسم ------------------------------ */
    draw() {
      const cv = this.cv, ctx = this.ctx;
      const dpr = global.devicePixelRatio || 1;
      const w = cv.clientWidth, h = cv.clientHeight;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#070a10';
      ctx.fillRect(0, 0, w, h);
      if (!this.bars.length) return;

      const g = this._geom(), r = this._range();
      this._g = g; this._r = r;

      this._drawGrid(g, r);
      this._drawWedgeFill(g, r);
      this._drawCandles(g, r);
      this._drawEma(g, r);
      this._drawWedgeLines(g, r);
      this._drawLevels(g, r);
      this._drawDrawings(g, r);
      this._drawMarkers(g, r);
      this._drawLastPrice(g, r);
      this._drawWatermark(g, r);
      if (g.volH) this._drawVolume(g, r);
      if (g.rsiH) this._drawRsi(g, r);
      this._drawAxis(g, r);
      this._drawCrosshair(g, r);
      this._drawLegend(g, r);
    }

    _visRange() {
      return [Math.max(0, Math.floor(this.viewFrom) - 1), Math.min(this.bars.length - 1, Math.ceil(this.viewTo) + 1)];
    }

    _drawGrid(g, r) {
      const ctx = this.ctx;
      const step = niceStep(r.hi - r.lo, 7);
      ctx.lineWidth = 1;
      ctx.strokeStyle = C.grid;
      ctx.beginPath();
      const start = Math.ceil(r.lo / step) * step;
      for (let p = start; p <= r.hi; p += step) {
        const y = Math.round(this.yAt(p, g, r)) + 0.5;
        ctx.moveTo(this.o.padL, y); ctx.lineTo(g.axisX, y);
      }
      ctx.stroke();
      // فواصل زمنية
      const [i0, i1] = this._visRange();
      const spanDays = Math.max(1, Math.round((this.viewTo - this.viewFrom) / (this.tf === '1m' ? 390 : this.tf === '5m' ? 78 : this.tf === '15m' ? 26 : this.tf === '1H' ? 6.5 : this.tf === '4H' ? 1.6 : this.tf === '1W' ? 0.2 : 1)));
      const every = spanDays > 400 ? 60 : spanDays > 160 ? 20 : spanDays > 60 ? 10 : spanDays > 20 ? 5 : 1;
      ctx.strokeStyle = C.grid;
      ctx.beginPath();
      let lastDay = -1, count = 0;
      for (let i = i0; i <= i1; i++) {
        const d = new Date(this.bars[i].time);
        const day = Math.floor(this.bars[i].time / 86400000);
        if (day !== lastDay) {
          lastDay = day; count++;
          if (count % every === 0) {
            const x = Math.round(this.xAt(i - 0.5)) + 0.5;
            ctx.moveTo(x, g.priceTop); ctx.lineTo(x, g.priceTop + g.priceH);
          }
        }
      }
      ctx.stroke();
    }

    _drawCandles(g, r) {
      const ctx = this.ctx;
      const [i0, i1] = this._visRange();
      const bw = this.barW();
      const bodyW = Math.max(1, Math.min(bw * 0.72, 26));

      // النمط الخطّي: خط الإغلاقات + تعبئة متدرّجة
      if (this.chartType === 'line') {
        const grad = ctx.createLinearGradient(0, g.priceTop, 0, g.priceTop + g.priceH);
        grad.addColorStop(0, 'rgba(245,166,35,0.22)');
        grad.addColorStop(1, 'rgba(245,166,35,0.00)');
        ctx.beginPath();
        ctx.moveTo(this.xAt(i0), g.priceTop + g.priceH);
        for (let i = i0; i <= i1; i++) ctx.lineTo(this.xAt(i), this.yAt(this.bars[i].c, g, r));
        ctx.lineTo(this.xAt(i1), g.priceTop + g.priceH);
        ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
        ctx.beginPath();
        for (let i = i0; i <= i1; i++) {
          const x = this.xAt(i), y = this.yAt(this.bars[i].c, g, r);
          i === i0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.strokeStyle = C.wedgeUp; ctx.lineWidth = 1.6; ctx.stroke();
        return;
      }

      const hollow = this.chartType === 'hollow';
      for (let i = i0; i <= i1; i++) {
        const b = this.bars[i];
        const x = this.xAt(i);
        const up = b.c >= b.o;
        const col = up ? C.up : C.down;
        const yH = this.yAt(b.h, g, r), yL = this.yAt(b.l, g, r);
        const yO = this.yAt(b.o, g, r), yC = this.yAt(b.c, g, r);
        ctx.strokeStyle = col;
        ctx.fillStyle = hollow && up ? 'rgba(0,0,0,0)' : (up ? C.upFill : C.downFill);
        ctx.lineWidth = Math.max(1, Math.min(1.6, bw * 0.12));
        const xr = Math.round(x) + 0.5;
        ctx.beginPath(); ctx.moveTo(xr, yH); ctx.lineTo(xr, yL); ctx.stroke();
        const top = Math.min(yO, yC), hgt = Math.max(1, Math.abs(yC - yO));
        if (bodyW <= 2.2) {
          ctx.beginPath(); ctx.moveTo(xr, top); ctx.lineTo(xr, top + hgt); ctx.stroke();
        } else if (hollow) {
          ctx.lineWidth = 1.1;
          ctx.strokeRect(Math.round(x - bodyW / 2) + 0.5, Math.round(top) + 0.5, Math.round(bodyW), Math.max(1, Math.round(hgt)));
        } else {
          ctx.fillRect(Math.round(x - bodyW / 2), Math.round(top), Math.round(bodyW), Math.round(hgt));
        }
      }
    }

    _lineSeries(vals, g, r, color, width) {
      const ctx = this.ctx;
      const [i0, i1] = this._visRange();
      ctx.strokeStyle = color; ctx.lineWidth = width || 1.2;
      ctx.beginPath();
      let started = false;
      for (let i = i0; i <= i1; i++) {
        if (vals[i] == null) { started = false; continue; }
        const x = this.xAt(i), y = this.yAt(vals[i], g, r);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    _drawEma(g, r) {
      if (!this.o.showEma) return;
      if (!this._ema) {
        const cl = this.bars.map(b => b.c);
        this._ema = { e9: TA.ema(cl, 9), e21: TA.ema(cl, 21), e50: TA.ema(cl, 50), s200: TA.sma(cl, 200) };
      }
      this._lineSeries(this._ema.e9, g, r, C.ema9, 1.1);
      this._lineSeries(this._ema.e21, g, r, C.ema21, 1.1);
      this._lineSeries(this._ema.e50, g, r, C.ema50, 1.1);
      this._lineSeries(this._ema.s200, g, r, C.sma200, 1);
    }
    invalidateIndicators() { this._ema = null; this._rsi = null; this._vma = null; }

    /* ------------------------- طبقة الوتد الهابط ------------------------- */
    _drawWedgeFill(g, r) {
      const w = this.wedge; if (!w || this.o.showWedgeFill === false) return;
      const ctx = this.ctx;
      const apex = Math.min(w.apexX, this.viewTo + (this.viewTo - this.viewFrom) * 0.35);
      const grad = ctx.createLinearGradient(0, g.priceTop, 0, g.priceTop + g.priceH);
      grad.addColorStop(0, 'rgba(245,166,35,0.10)');
      grad.addColorStop(1, 'rgba(34,211,238,0.05)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      const N = 46;
      for (let k = 0; k <= N; k++) {
        const i = w.start + (apex - w.start) * k / N;
        const x = this.xAt(i), y = this.yAt(w.upAt(i), g, r);
        k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      for (let k = N; k >= 0; k--) {
        const i = w.start + (apex - w.start) * k / N;
        ctx.lineTo(this.xAt(i), this.yAt(w.loAt(i), g, r));
      }
      ctx.closePath(); ctx.fill();
    }

    _drawWedgeLines(g, r) {
      const w = this.wedge; if (!w) return;
      const ctx = this.ctx;
      const apex = Math.min(w.apexX, this.viewTo + (this.viewTo - this.viewFrom) * 0.3);

      const seg = (fn, from, to, color, dash, width) => {
        ctx.save();
        ctx.strokeStyle = color; ctx.lineWidth = width || 1.7; ctx.setLineDash(dash || []);
        ctx.beginPath();
        ctx.moveTo(this.xAt(from), this.yAt(fn(from), g, r));
        ctx.lineTo(this.xAt(to), this.yAt(fn(to), g, r));
        ctx.stroke(); ctx.restore();
      };

      // الخطّان حتى نهاية الوتد (متّصلان) ثم امتداد متقطّع نحو القمّة
      seg(w.upAt, w.start, w.end, C.wedgeUp, [], 1.9);
      seg(w.loAt, w.start, w.end, C.wedgeLo, [], 1.9);
      if (apex > w.end) {
        seg(w.upAt, w.end, apex, C.wedgeUp, [4, 4], 1.1);
        seg(w.loAt, w.end, apex, C.wedgeLo, [4, 4], 1.1);
      }

      // نقاط اللمس على الخطّين
      const dot = (i, p, color) => {
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(this.xAt(i), this.yAt(p, g, r), 2.6, 0, Math.PI * 2); ctx.fill();
      };
      for (const i of w.upper.touches) if (i <= w.end && this.bars[i]) dot(i, this.bars[i].h, C.wedgeUp);
      for (const i of w.lower.touches) if (i <= w.end && this.bars[i]) dot(i, this.bars[i].l, C.wedgeLo);

      // علامة القمّة (Apex)
      if (apex < this.viewTo + (this.viewTo - this.viewFrom)) {
        const ax = this.xAt(apex), ay = this.yAt(w.upAt(apex), g, r);
        ctx.save();
        ctx.strokeStyle = 'rgba(245,166,35,0.85)'; ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(ax - 5, ay - 5); ctx.lineTo(ax + 5, ay + 5);
        ctx.moveTo(ax + 5, ay - 5); ctx.lineTo(ax - 5, ay + 5);
        ctx.stroke();
        ctx.font = FONT_S; ctx.fillStyle = 'rgba(245,166,35,0.9)'; ctx.textAlign = 'center';
        ctx.fillText('APEX', ax, ay - 9);
        ctx.restore();
      }

      // تسمية النموذج داخل الوتد
      const midI = w.start + (w.end - w.start) * 0.42;
      const midP = (w.upAt(midI) + w.loAt(midI)) / 2;
      ctx.save();
      ctx.font = FONT_B; ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(245,166,35,0.85)';
      ctx.fillText('FALLING WEDGE  •  ' + w.grade + '  ' + w.confidence.toFixed(0) + '%',
        this.xAt(midI), this.yAt(midP, g, r));
      ctx.restore();
    }

    /* مناطق الخطة بأسلوب صور الاستراتيجية: TARGET / ENTER / STOP LOSS */
    _drawLevels(g, r) {
      const w = this.wedge; if (!w || w.status === 'failed') return;
      const ctx = this.ctx;
      /* صندوق المناطق يُثبَّت دائمًا داخل منطقة السعر بعرض ثابت بالبكسل.
         السبب: الوتد «قيد التكوّن» لا يملك شموعًا بعد نقطة الاختراق المتوقّعة،
         فكان الحساب القديم يُنتج عرضًا أقل من 30px فتخرج الدالة بلا أي رسم. */
      const span = this.viewTo - this.viewFrom;
      const brk = w.breakoutIdx >= 0 ? w.breakoutIdx : Math.min(w.end + 1, this.bars.length - 1);
      const bx = this.xAt(brk);
      const wantW = Math.max(82, Math.min(168, span * 0.17 * this.barW()));
      const rightEdge = g.axisX - 6;
      let zx0 = Math.min(bx, rightEdge - wantW);
      zx0 = Math.max(zx0, this.o.padL + 2);
      const zx1 = Math.min(zx0 + wantW, rightEdge);
      if (zx1 - zx0 < 40) return;
      const cx = (zx0 + zx1) / 2;

      const yT3 = this.yAt(w.targets[2].price, g, r);
      const yE = this.yAt(w.entry, g, r);
      const yS = this.yAt(w.stop, g, r);
      const band = Math.max(7, Math.min(30, (yS - yE) * 0.30));
      const yEnterTop = yE - band, yEnterBot = yE + band;

      /* خط وصل من نقطة الاختراق/القمة المتوقّعة إلى صندوق المناطق */
      if (bx > zx1 + 2 || bx < zx0 - 2) {
        ctx.save();
        ctx.strokeStyle = 'rgba(232,237,244,0.35)'; ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
        ctx.beginPath(); ctx.moveTo(Math.max(this.o.padL, Math.min(bx, g.axisX)), yE);
        ctx.lineTo(bx > zx1 ? zx1 : zx0, yE); ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = FONT_S; ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(232,237,244,0.55)';
        ctx.fillText('BREAK', Math.max(this.o.padL + 18, Math.min(bx, g.axisX - 18)), g.priceTop + g.priceH - 8);
        ctx.restore();
      }

      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const zone = (yTop, yBot, fill) => {
        if (yBot - yTop < 1) return;
        ctx.fillStyle = fill;
        ctx.fillRect(zx0, yTop, zx1 - zx0, yBot - yTop);
      };

      // TARGET (من أعلى الهدف الثالث حتى أعلى شريط الدخول)
      zone(Math.min(yT3, yEnterTop), yEnterTop, C.zoneT);
      // ENTER (شريط رفيع حول سعر الدخول)
      zone(yEnterTop, yEnterBot, C.zoneE);
      // STOP LOSS (من أسفل شريط الدخول حتى الوقف)
      zone(yEnterBot, Math.max(yS, yEnterBot), C.zoneS);

      // حدود متقطعة خارجية
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = C.target; ctx.setLineDash([6, 5]);
      ctx.beginPath(); ctx.moveTo(zx0, yT3); ctx.lineTo(zx1, yT3); ctx.stroke();
      ctx.strokeStyle = C.stop;
      ctx.beginPath(); ctx.moveTo(zx0, yS); ctx.lineTo(zx1, yS); ctx.stroke();
      ctx.setLineDash([]);
      // حدّا شريط الدخول
      ctx.strokeStyle = C.entry; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(zx0, yEnterTop); ctx.lineTo(zx1, yEnterTop); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(zx0, yEnterBot); ctx.lineTo(zx1, yEnterBot); ctx.stroke();

      // خطوط الأهداف الداخلية (T1/T2) خفيفة داخل منطقة الهدف
      ctx.setLineDash([3, 4]); ctx.lineWidth = 0.8; ctx.strokeStyle = 'rgba(46,189,133,0.55)';
      ctx.font = FONT_S;
      [w.targets[0], w.targets[1]].forEach((t, k) => {
        const y = this.yAt(t.price, g, r);
        if (y > yT3 && y < yEnterTop) {
          ctx.beginPath(); ctx.moveTo(zx0, y); ctx.lineTo(zx1, y); ctx.stroke();
          ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(46,189,133,0.8)';
          ctx.fillText('T' + (k + 1), zx0 + 4, y - 6);
          ctx.textAlign = 'center';
        }
      });
      ctx.setLineDash([]);

      // التسميات الكبرى
      /* الانتباه: الوسائط (txt, x, y, size) — كانت (txt, y, size) فتُستدعى بأربعة
         وسائط، فيقع cx في موضع y وتُطبع التسمية خارج الشارت بخط عملاق. */
      const label = (txt, x, y, size) => {
        ctx.font = '700 ' + size + 'px -apple-system,"Segoe UI",Roboto,sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 1;
        ctx.fillText(txt, x, y);
        ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      };
      const targetH = yEnterTop - yT3, stopH = yS - yEnterBot;
      if (targetH > 26) label('TARGET', cx, (yT3 + yEnterTop) / 2, 13);
      else if (targetH > 9) label('TARGET', cx, (yT3 + yEnterTop) / 2, 9);
      label('ENTER', cx, (yEnterTop + yEnterBot) / 2, Math.min(11, Math.max(8, band * 0.75)));
      if (stopH > 16) label('STOP LOSS', cx, (yEnterBot + yS) / 2, 12);
      else if (stopH > 8) label('STOP', cx, (yEnterBot + yS) / 2, 9);

      // سهم الدخول الأخضر عند الاختراق
      const ax = zx0 - 9, ay = yE;
      ctx.fillStyle = '#2ebd85';
      ctx.beginPath();
      ctx.moveTo(ax, ay - 8); ctx.lineTo(ax - 5.5, ay + 1); ctx.lineTo(ax - 2, ay + 1);
      ctx.lineTo(ax - 2, ay + 7); ctx.lineTo(ax + 2, ay + 7); ctx.lineTo(ax + 2, ay + 1);
      ctx.lineTo(ax + 5.5, ay + 1); ctx.closePath(); ctx.fill();

      // قيم صغيرة على يمين المناطق
      ctx.font = FONT_S; ctx.textAlign = 'left';
      ctx.fillStyle = '#2ebd85'; ctx.fillText(fmtP(w.targets[2].price), zx1 + 4, yT3);
      ctx.fillStyle = '#d4b43a'; ctx.fillText(fmtP(w.entry), zx1 + 4, yE);
      ctx.fillStyle = '#f6465d'; ctx.fillText(fmtP(w.stop), zx1 + 4, yS);

      ctx.restore();
    }

    /* ---------------------------- طبقة الرسم ----------------------------- */
    _drawDrawings(g, r) {
      const ctx = this.ctx;
      for (const d of this.drawings) {
        if (!d) continue;
        const x0 = this.xAt(d.i0), x1 = this.xAt(d.i1);
        const y0 = this.yAt(d.p0, g, r), y1 = this.yAt(d.p1, g, r);
        ctx.save();
        if (d.type === 'trendline' || d.type === 'ray') {
          ctx.strokeStyle = '#e2b400'; ctx.lineWidth = 1.6;
          ctx.beginPath(); ctx.moveTo(x0, y0);
          if (d.type === 'ray') {
            const dx = x1 - x0 || 1, dy = y1 - y0, k = 4;
            ctx.lineTo(x0 + dx * k, y0 + dy * k);
          } else ctx.lineTo(x1, y1);
          ctx.stroke();
          node(x0, y0); node(x1, y1);
        } else if (d.type === 'hline') {
          ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 1.3; ctx.setLineDash([6, 4]);
          ctx.beginPath(); ctx.moveTo(this.o.padL, y0); ctx.lineTo(g.axisX, y0); ctx.stroke();
          tag(g.axisX, y0, fmtP(d.p0), '#3b82f6');
        } else if (d.type === 'rect') {
          ctx.fillStyle = 'rgba(59,130,246,0.10)';
          ctx.strokeStyle = 'rgba(59,130,246,0.75)'; ctx.lineWidth = 1.2;
          ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
          ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
        } else if (d.type === 'fib') {
          const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
          const cols = ['#64748b', '#f0455a', '#f5a623', '#eab308', '#12c48b', '#22d3ee', '#64748b'];
          const lo = Math.min(d.p0, d.p1), hi = Math.max(d.p0, d.p1);
          ctx.font = FONT_S;
          levels.forEach((L, k) => {
            const p = hi - (hi - lo) * L;
            const y = this.yAt(p, g, r);
            ctx.strokeStyle = cols[k]; ctx.globalAlpha = 0.75; ctx.lineWidth = 1;
            ctx.setLineDash(L === 0 || L === 1 ? [] : [4, 4]);
            ctx.beginPath(); ctx.moveTo(Math.min(x0, x1), y); ctx.lineTo(Math.max(x0, x1), y); ctx.stroke();
            ctx.globalAlpha = 1; ctx.setLineDash([]);
            ctx.fillStyle = cols[k]; ctx.textAlign = 'left';
            ctx.fillText(L.toFixed(3) + '  ' + fmtP(p), Math.max(x0, x1) + 5, y + 3);
          });
        } else if (d.type === 'measure') {
          ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
          ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
          ctx.setLineDash([]);
          const pct = (d.p1 / d.p0 - 1) * 100;
          const lbl = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%   ' + fmtP(d.p0) + ' → ' + fmtP(d.p1)
            + '   (' + Math.abs(d.i1 - d.i0) + ' شمعة)';
          ctx.font = FONT_B; ctx.textAlign = 'left';
          const tw = ctx.measureText(lbl).width + 12;
          ctx.fillStyle = '#0f172a'; ctx.strokeStyle = '#334155';
          ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1) - 20, tw, 17);
          ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1) - 20, tw, 17);
          ctx.fillStyle = pct >= 0 ? C.up : C.down;
          ctx.fillText(lbl, Math.min(x0, x1) + 6, Math.min(y0, y1) - 8);
        }
        ctx.restore();
      }
      function node(x, y) {
        ctx.fillStyle = '#0b1220'; ctx.strokeStyle = '#e2b400'; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(x, y, 3.4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      function tag(x, y, text, color) {
        ctx.font = FONT_S;
        const w = ctx.measureText(text).width + 10;
        ctx.fillStyle = color; ctx.fillRect(x, y - 8, w, 16);
        ctx.fillStyle = '#05070b'; ctx.textAlign = 'left';
        ctx.fillText(text, x + 5, y + 4);
      }
    }

    /* --------------------------- العلامات والأخبار ------------------------ */
    _drawMarkers(g, r) {
      const w = this.wedge, ctx = this.ctx;
      const tri = (i, p, color, up, label) => {
        const x = this.xAt(i), y = this.yAt(p, g, r) + (up ? 12 : -12);
        ctx.save();
        ctx.fillStyle = color;
        ctx.beginPath();
        if (up) { ctx.moveTo(x, y - 6); ctx.lineTo(x - 5, y + 3); ctx.lineTo(x + 5, y + 3); }
        else { ctx.moveTo(x, y + 6); ctx.lineTo(x - 5, y - 3); ctx.lineTo(x + 5, y - 3); }
        ctx.closePath(); ctx.fill();
        if (label) {
          ctx.font = FONT_S; ctx.textAlign = 'center';
          ctx.fillStyle = color;
          ctx.fillText(label, x, up ? y + 14 : y - 8);
        }
        ctx.restore();
      };
      if (w) {
        if (w.breakoutIdx >= 0) tri(w.breakoutIdx, this.bars[w.breakoutIdx].l, C.target, true, 'BREAKOUT');
        if (w.retestIdx >= 0) tri(w.retestIdx, this.bars[w.retestIdx].l, C.entry, true, 'RETEST');
        if (w.failedIdx >= 0) tri(w.failedIdx, this.bars[w.failedIdx].h, C.down, false, 'FAILED');
      }
      // أخبار
      for (const nw of this.news) {
        if (nw.idx == null || nw.idx < this.viewFrom || nw.idx > this.viewTo) continue;
        const x = this.xAt(nw.idx);
        const y = this.yAt(this.bars[nw.idx].h, g, r) - 10;
        ctx.save();
        ctx.fillStyle = C.news;
        ctx.beginPath();
        ctx.moveTo(x, y - 4.5); ctx.lineTo(x + 4.5, y); ctx.lineTo(x, y + 4.5); ctx.lineTo(x - 4.5, y);
        ctx.closePath(); ctx.fill();
        ctx.restore();
      }
    }

    _drawLastPrice(g, r) {
      const b = this.bars[this.bars.length - 1]; if (!b) return;
      const ctx = this.ctx;
      const y = this.yAt(b.c, g, r);
      const up = b.c >= b.o;
      const col = up ? C.up : C.down;
      ctx.save();
      ctx.strokeStyle = col; ctx.globalAlpha = 0.7; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(this.o.padL, y); ctx.lineTo(g.axisX, y); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      ctx.fillStyle = col;
      ctx.fillRect(g.axisX, y - 9, this.o.axisW, 18);
      ctx.fillStyle = '#04070c'; ctx.font = FONT_B; ctx.textAlign = 'left';
      ctx.fillText(fmtP(b.c), g.axisX + 6, y + 4);
      ctx.restore();
    }

    _drawWatermark(g, r) {
      const ctx = this.ctx;
      ctx.save();
      ctx.font = '600 26px -apple-system,"Segoe UI",Roboto,sans-serif';
      ctx.fillStyle = 'rgba(148,163,184,0.07)';
      ctx.textAlign = 'left';
      ctx.fillText(this.symbol + ' · ' + this.tf, this.o.padL + 14, g.priceTop + g.priceH - 16);
      ctx.font = '600 12px ui-monospace,Menlo,Consolas,monospace';
      ctx.fillStyle = 'rgba(245,166,35,0.10)';
      ctx.fillText('FALLING WEDGE TERMINAL', this.o.padL + 15, g.priceTop + g.priceH - 36);
      ctx.restore();
    }

    _drawVolume(g, r) {
      const ctx = this.ctx;
      const [i0, i1] = this._visRange();
      let mx = 0;
      for (let i = i0; i <= i1; i++) if (this.bars[i].v > mx) mx = this.bars[i].v;
      if (!mx) return;
      const bw = this.barW(), bodyW = Math.max(1, Math.min(bw * 0.72, 26));
      ctx.save();
      ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(this.o.padL, g.volTop + 0.5); ctx.lineTo(g.axisX, g.volTop + 0.5); ctx.stroke();
      for (let i = i0; i <= i1; i++) {
        const b = this.bars[i];
        const h = (b.v / mx) * (g.volH - 12);
        ctx.fillStyle = b.c >= b.o ? C.volUp : C.volDown;
        ctx.fillRect(Math.round(this.xAt(i) - bodyW / 2), g.volTop + g.volH - h, Math.max(1, Math.round(bodyW)), h);
      }
      if (!this._vma) this._vma = TA.volumeMA(this.bars, 20);
      ctx.strokeStyle = C.volMa; ctx.lineWidth = 1; ctx.globalAlpha = 0.8;
      ctx.beginPath();
      for (let i = i0; i <= i1; i++) {
        if (this._vma[i] == null) continue;
        const x = this.xAt(i), y = g.volTop + g.volH - (this._vma[i] / mx) * (g.volH - 12);
        i === i0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.font = FONT_S; ctx.fillStyle = C.txtDim; ctx.textAlign = 'left';
      ctx.fillText('VOLUME', this.o.padL + 6, g.volTop + 11);
      ctx.restore();
    }

    _drawRsi(g, r) {
      const ctx = this.ctx;
      if (!this._rsi) this._rsi = TA.rsi(this.bars, 14);
      const [i0, i1] = this._visRange();
      const yFor = v => g.rsiTop + (100 - v) / 100 * g.rsiH;
      ctx.save();
      ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(this.o.padL, g.rsiTop + 0.5); ctx.lineTo(g.axisX, g.rsiTop + 0.5); ctx.stroke();
      // نطاقات
      ctx.fillStyle = 'rgba(240,69,90,0.05)';
      ctx.fillRect(this.o.padL, yFor(100), g.plotW, yFor(70) - yFor(100));
      ctx.fillStyle = 'rgba(18,196,139,0.05)';
      ctx.fillRect(this.o.padL, yFor(30), g.plotW, yFor(0) - yFor(30));
      ctx.strokeStyle = C.gridStrong; ctx.setLineDash([3, 4]);
      [30, 50, 70].forEach(v => {
        ctx.beginPath(); ctx.moveTo(this.o.padL, yFor(v)); ctx.lineTo(g.axisX, yFor(v)); ctx.stroke();
      });
      ctx.setLineDash([]);
      ctx.strokeStyle = C.rsi; ctx.lineWidth = 1.3;
      ctx.beginPath();
      let st = false;
      for (let i = i0; i <= i1; i++) {
        if (this._rsi[i] == null) { st = false; continue; }
        const x = this.xAt(i), y = yFor(this._rsi[i]);
        st ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), st = true);
      }
      ctx.stroke();
      ctx.font = FONT_S; ctx.fillStyle = C.txtDim; ctx.textAlign = 'left';
      ctx.fillText('RSI 14', this.o.padL + 6, g.rsiTop + 11);
      // تباعد صاعد داخل الوتد
      const w = this.wedge;
      if (w && w.divergence) {
        const d = w.divergence;
        ctx.strokeStyle = '#12c48b'; ctx.lineWidth = 1.4; ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(this.xAt(d.from), yFor(this._rsi[d.from]));
        ctx.lineTo(this.xAt(d.to), yFor(this._rsi[d.to]));
        ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = '#12c48b'; ctx.textAlign = 'center';
        ctx.fillText('BULL DIV', this.xAt((d.from + d.to) / 2), yFor(Math.max(this._rsi[d.from], this._rsi[d.to])) - 6);
      }
      ctx.restore();
    }

    _drawAxis(g, r) {
      const ctx = this.ctx;
      ctx.save();
      ctx.fillStyle = '#070a10';
      ctx.fillRect(g.axisX, 0, this.o.axisW, g.h);
      ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(g.axisX + 0.5, 0); ctx.lineTo(g.axisX + 0.5, g.h); ctx.stroke();
      const step = niceStep(r.hi - r.lo, 7);
      ctx.font = FONT; ctx.fillStyle = C.axis; ctx.textAlign = 'left';
      for (let p = Math.ceil(r.lo / step) * step; p <= r.hi; p += step) {
        const y = this.yAt(p, g, r);
        ctx.fillText(fmtP(p), g.axisX + 7, y + 3.5);
      }
      // محور الزمن
      const [i0, i1] = this._visRange();
      ctx.fillStyle = '#070a10';
      ctx.fillRect(0, g.h - this.o.timeH, g.w, this.o.timeH);
      ctx.strokeStyle = C.grid;
      ctx.beginPath(); ctx.moveTo(0, g.h - this.o.timeH + 0.5); ctx.lineTo(g.w, g.h - this.o.timeH + 0.5); ctx.stroke();
      const target = Math.max(3, Math.floor(g.plotW / 96));
      const count = Math.max(1, Math.round(this.viewTo - this.viewFrom));
      const stride = Math.max(1, Math.ceil(count / target));
      ctx.fillStyle = C.axis; ctx.textAlign = 'center';
      const intra = this.tf !== '1D' && this.tf !== '1W';
      for (let i = Math.max(0, Math.ceil(this.viewFrom)); i <= i1; i++) {
        if ((i - Math.ceil(this.viewFrom)) % stride !== 0) continue;
        const x = this.xAt(i);
        if (x < this.o.padL + 20 || x > g.axisX - 20) continue;
        ctx.fillText(timeLabel(this.bars[i].time, intra), x, g.h - this.o.timeH + 15);
      }
      ctx.restore();
    }

    _drawCrosshair(g, r) {
      if (!this.mouse) return;
      const ctx = this.ctx, m = this.mouse;
      if (m.x > g.axisX) return;
      ctx.save();
      ctx.strokeStyle = C.cross; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(Math.round(m.x) + 0.5, g.priceTop); ctx.lineTo(Math.round(m.x) + 0.5, g.h - this.o.timeH);
      if (m.y >= g.priceTop && m.y <= g.priceTop + g.priceH) {
        ctx.moveTo(this.o.padL, Math.round(m.y) + 0.5); ctx.lineTo(g.axisX, Math.round(m.y) + 0.5);
      }
      ctx.stroke(); ctx.setLineDash([]);
      // بطاقة السعر
      if (m.y >= g.priceTop && m.y <= g.priceTop + g.priceH) {
        const p = this.pAt(m.y, g, r);
        ctx.fillStyle = '#1e293b';
        ctx.fillRect(g.axisX, m.y - 9, this.o.axisW, 18);
        ctx.fillStyle = '#e2e8f0'; ctx.font = FONT_B; ctx.textAlign = 'left';
        ctx.fillText(fmtP(p), g.axisX + 6, m.y + 4);
      }
      // بطاقة الزمن
      const idx = Math.round(this.iAt(m.x));
      if (idx >= 0 && idx < this.bars.length) {
        const lbl = fullTimeLabel(this.bars[idx].time, this.tf);
        ctx.font = FONT;
        const tw = ctx.measureText(lbl).width + 14;
        let bx = Math.min(m.x - tw / 2, g.axisX - tw);
        bx = Math.max(this.o.padL, bx);
        ctx.fillStyle = '#1e293b'; ctx.fillRect(bx, g.h - this.o.timeH + 2, tw, 17);
        ctx.fillStyle = '#e2e8f0'; ctx.textAlign = 'left';
        ctx.fillText(lbl, bx + 7, g.h - this.o.timeH + 14);
      }
      ctx.restore();
    }

    _drawLegend(g, r) {
      const ctx = this.ctx;
      const i = this.hover != null ? this.hover : this.bars.length - 1;
      const b = this.bars[i]; if (!b) return;
      const up = b.c >= b.o;
      const pct = i > 0 ? (b.c / this.bars[i - 1].c - 1) * 100 : 0;
      const col = up ? C.up : C.down;
      ctx.save();
      ctx.font = FONT;
      let x = this.o.padL + 8, y = g.priceTop + 4;
      const item = (label, val, color) => {
        ctx.fillStyle = C.txtDim; ctx.textAlign = 'left';
        ctx.fillText(label, x, y + 10); x += ctx.measureText(label).width + 4;
        ctx.fillStyle = color || C.txt; ctx.font = FONT_B;
        ctx.fillText(val, x, y + 10); x += ctx.measureText(val).width + 11; ctx.font = FONT;
      };
      const pieces = [
        [this.symbol, '#e2e8f0', true], [this.tf, C.txtDim, false],
        ['O', C.txtDim, false], [fmtP(b.o), col, true],
        ['H', C.txtDim, false], [fmtP(b.h), col, true],
        ['L', C.txtDim, false], [fmtP(b.l), col, true],
        ['C', C.txtDim, false], [fmtP(b.c), col, true],
        [(pct >= 0 ? '+' : '') + pct.toFixed(2) + '%', col, true],
        ['V', C.txtDim, false], [fmtVol(b.v), C.txtDim, true]
      ];
      ctx.font = FONT;
      let total = 0;
      for (const pc of pieces) { ctx.font = pc[2] ? FONT_B : FONT; total += ctx.measureText(pc[0]).width + 9; }
      ctx.fillStyle = 'rgba(8,11,17,0.86)';
      ctx.fillRect(this.o.padL + 3, y, Math.min(g.plotW - 8, total + 8), 18);
      x = this.o.padL + 8;
      for (const pc of pieces) {
        ctx.font = pc[2] ? FONT_B : FONT;
        ctx.fillStyle = pc[1]; ctx.textAlign = 'left';
        ctx.fillText(pc[0], x, y + 10);
        x += ctx.measureText(pc[0]).width + 9;
      }
      ctx.restore();
    }

    /* ------------------------------ تصدير -------------------------------- */
    toPNG() { return this.cv.toDataURL('image/png'); }
  }

  /* ----------------------------- أدوات مساعدة ---------------------------- */
  function fmtP(p) {
    if (p == null || !isFinite(p)) return '—';
    if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (p >= 100) return p.toFixed(2);
    if (p >= 1) return p.toFixed(3);
    if (p >= 0.01) return p.toFixed(4);
    return p.toFixed(5);
  }
  function fmtVol(v) {
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return String(v);
  }
  function timeLabel(t, intra) {
    const d = new Date(t - 4 * 3600000);   // ET
    if (intra) {
      const h = d.getUTCHours(), m = d.getUTCMinutes();
      return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
    }
    return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate();
  }
  function fullTimeLabel(t, tf) {
    const d = new Date(t - 4 * 3600000);
    const base = MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear();
    if (tf === '1D' || tf === '1W') return base;
    return base + '  ' + String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0') + ' ET';
  }

  global.ChartKit = { Chart: Chart, C: C, fmtP: fmtP, fmtVol: fmtVol, niceStep: niceStep, timeLabel: timeLabel, fullTimeLabel: fullTimeLabel };
})(typeof window !== 'undefined' ? window : globalThis);
