/* =============================================================================
 * app.js — طبقة التطبيق: الواجهة، اللوحات، الاختصارات، ولوحة الأوامر
 * ========================================================================== */
(function () {
  'use strict';

  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const M = window.Market, TA = window.TA, Wedge = window.Wedge;
  const { Chart, fmtP, fmtVol } = window.ChartKit;

  /* ================================ الحالة ================================ */
  const state = {
    symbol: 'SOUN',
    tf: '1D',
    strategy: 'wedge',
    wedge: null,
    scans: new Map(),          // tf -> نتائج الفحص
    drawings: {},              // "SYM|TF" -> مصفوفة رسومات
    news: [],
    chartType: 'candles'
  };

  const chart = new Chart($('#chart'), {});
  chart.onDraw = ds => { if (state.wedgeKey) localStorage.setItem('fx.draw.' + state.wedgeKey, JSON.stringify(ds)); };
  chart.onCursor = i => {
    const el = $('#sbCursor');
    if (i == null || !chart.bars[i]) { el.textContent = '—'; return; }
    const b = chart.bars[i];
    el.innerHTML = `O <b>${fmtP(b.o)}</b> · H <b>${fmtP(b.h)}</b> · L <b>${fmtP(b.l)}</b> · C <b>${fmtP(b.c)}</b> · V <b>${fmtVol(b.v)}</b>`;
  };

  new ResizeObserver(() => chart.requestDraw()).observe($('#chart'));

  /* ============================== أدوات مساعدة ============================ */
  const key = () => state.symbol + '|' + state.tf;
  const clamp01 = v => Math.max(0, Math.min(1, v));
  const confColor = c => c >= 84 ? '#12c48b' : c >= 74 ? '#22d3ee' : c >= 62 ? '#f5a623' : '#f0455a';

  const STATUS_AR = {
    forming: 'قيد التكوّن', breakout: 'اختراق الآن', running: 'اختراق نشط',
    extended: 'اختراق ممتد', failed: 'فشل النموذج'
  };

  function toast(title, desc, kind) {
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.innerHTML = `<div class="t">${title}</div>` + (desc ? `<div class="d">${desc}</div>` : '');
    $('#toasts').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 3400);
    setTimeout(() => el.remove(), 3800);
  }

  function ago(ts) {
    const d = (Date.now() - new Date(ts).getTime()) / 1000;
    if (d < 3600) return Math.max(1, Math.round(d / 60)) + ' د';
    if (d < 86400) return Math.round(d / 3600) + ' س';
    return Math.round(d / 86400) + ' ي';
  }

  /* ============================== شريط الأسعار ============================ */
  function renderTape() {
    const items = M.SYMBOLS.map(t => {
      const q = M.quote(t);
      const up = q.chg >= 0;
      return `<div class="tape-item" data-t="${t}">
        <span class="s">${t}</span>
        <span class="p">${fmtP(q.price)}</span>
        <span class="c ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(q.chgPct).toFixed(2)}%</span>
      </div>`;
    }).join('');
    $('#tapeTrack').innerHTML = items + items;   // مضاعف للحلقة السلسة
    $$('#tapeTrack .tape-item').forEach(el => el.onclick = () => setSymbol(el.dataset.t));
  }

  /* ============================== قائمة المراقبة ========================== */
  function sparkPath(vals, w, h) {
    if (!vals.length) return '';
    const mn = Math.min(...vals), mx = Math.max(...vals), rg = (mx - mn) || 1;
    return vals.map((v, i) =>
      `${(i / (vals.length - 1) * w).toFixed(1)},${(h - (v - mn) / rg * h).toFixed(1)}`
    ).join(' ');
  }

  function renderWatchlist() {
    const box = $('#watchlist');
    const scan = state.scans.get('1D') || [];
    const bySym = Object.fromEntries(scan.map(w => [w.symbol, w]));
    box.innerHTML = M.SYMBOLS.map(t => {
      const q = M.quote(t);
      const up = q.chg >= 0;
      const w = bySym[t];
      const chip = w ? (w.status === 'failed' ? '<span class="chip f">فشل</span>'
        : (w.status === 'forming' ? '<span class="chip w">وتد</span>' : '<span class="chip b">اختراق</span>')) : '';
      const col = up ? '#12c48b' : '#f0455a';
      return `<div class="wl-row ${t === state.symbol ? 'active' : ''}" data-t="${t}">
        <div>
          <div class="wl-sym">${t} ${chip}</div>
          <div class="wl-name">${q.name}</div>
        </div>
        <div class="wl-price">${fmtP(q.price)}</div>
        <div class="wl-chg ${up ? 'up' : 'down'}">${up ? '+' : ''}${q.chgPct.toFixed(2)}%</div>
        <svg class="wl-spark" viewBox="0 0 100 16" preserveAspectRatio="none">
          <polyline points="${sparkPath(q.spark, 100, 16)}" fill="none" stroke="${col}" stroke-width="1.1" vector-effect="non-scaling-stroke"/>
        </svg>
      </div>`;
    }).join('');
    $$('#watchlist .wl-row').forEach(el => el.onclick = () => setSymbol(el.dataset.t));
    $('#wlCount').textContent = M.SYMBOLS.length;
  }

  /* ================================ الأخبار =============================== */
  const KIND_COLOR = { 'عاجل': '#12c48b', 'محفّز': '#22d3ee', 'خبر': '#98a5bb' };

  function renderNews() {
    const box = $('#newsFeed');
    box.innerHTML = M.alerts.map((a, i) => {
      const kc = KIND_COLOR[a.kind] || '#98a5bb';
      return `
      <div class="news-item" data-i="${i}">
        <div class="news-top">
          <span class="news-t" style="color:${a.score >= 4 ? '#f5a623' : '#98a5bb'}">${a.t}</span>
          <span class="chip" style="background:${kc}22;color:${kc}">${a.kind || 'خبر'}</span>
          <span class="dots">${[1, 2, 3, 4, 5].map(n => `<i class="${n <= a.score ? 'on' : ''}"></i>`).join('')}</span>
          <span class="news-ago">${ago(a.ts)}</span>
        </div>
        <div class="news-title" dir="auto">${a.title}</div>
        <div class="news-src" style="margin-top:3px" dir="auto">${a.catalyst ? a.catalyst + ' · ' : ''}${(a.src || '').slice(0, 34)}</div>
      </div>`;
    }).join('');
    $$('#newsFeed .news-item').forEach(el => el.onclick = () => {
      const a = M.alerts[+el.dataset.i];
      if (M.SYMBOLS.includes(a.t)) setSymbol(a.t);
      else toast('الرمز غير مُدرج', a.t + ' — ' + a.title.slice(0, 60));
    });
    $('#newsCount').textContent = M.alerts.length;
  }

  /* ============================== رأس الرمز =============================== */
  function renderSymHead() {
    const q = M.quote(state.symbol);
    const up = q.chg >= 0;
    const pos = q.hi52 > q.lo52 ? (q.price - q.lo52) / (q.hi52 - q.lo52) : 0.5;
    $('#symHead').innerHTML = `
      <div class="sym-id">
        <span class="sym-ticker">${q.t}</span>
        <span class="sym-name">${q.name} · ${q.sector}</span>
      </div>
      <div class="sym-price ${up ? 'up' : 'down'}">${fmtP(q.price)}</div>
      <div class="sym-chg ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(q.chg).toFixed(4)} (${up ? '+' : ''}${q.chgPct.toFixed(2)}%)</div>
      <div class="sym-stats">
        <div class="stat"><span class="k">افتتاح</span><span class="v">${fmtP(q.open)}</span></div>
        <div class="stat"><span class="k">أعلى</span><span class="v">${fmtP(q.high)}</span></div>
        <div class="stat"><span class="k">أدنى</span><span class="v">${fmtP(q.low)}</span></div>
        <div class="stat"><span class="k">إغلاق سابق</span><span class="v">${fmtP(q.prevClose)}</span></div>
        <div class="stat"><span class="k">الحجم</span><span class="v">${fmtVol(q.volume)}</span></div>
        <div class="stat"><span class="k">متوسط ٣٠ يوم</span><span class="v">${fmtVol(q.avgVol30)}</span></div>
        <div class="stat"><span class="k">قاع ٥٢ أسبوع</span><span class="v">${fmtP(q.lo52)}</span></div>
        <div class="stat"><span class="k">قمة ٥٢ أسبوع</span><span class="v">${fmtP(q.hi52)}</span></div>
        <div class="stat" style="min-width:96px">
          <span class="k">الموقع من المدى</span>
          <span class="v" style="margin-top:5px">
            <span style="display:block;height:4px;background:var(--bg-4);border-radius:2px;position:relative">
              <span style="position:absolute;inset-inline-start:0;top:0;bottom:0;width:${(pos * 100).toFixed(1)}%;background:linear-gradient(90deg,#f0455a,#f5a623,#12c48b);border-radius:2px"></span>
            </span>
            <span style="font-size:9px;color:var(--txt-3)">${(pos * 100).toFixed(0)}%</span>
          </span>
        </div>
      </div>`;
  }

  /* ============================= لوحة الإشارة ============================= */
  function renderSignal() {
    const box = $('#signalBody');
    const w = state.wedge;
    $('#sigTf').textContent = state.tf;
    if (state.strategy === 'split') { renderSplitBody(box); return; }
    $('#sigTitle').textContent = 'إشارة الوتد الهابط';
    if (!w) {
      box.innerHTML = `<div class="empty">لا يوجد وتد هابط صالح على إطار <b>${state.tf}</b> لهذا الرمز.<br>جرّب إطارًا آخر أو رمزًا من الفاحص.</div>`;
      const badge = $('#chartBadge');
      badge.style.display = 'none';
      return;
    }

    const badge = $('#chartBadge');
    badge.className = 'chart-badge' + (w.status === 'failed' ? ' fail' : (w.status === 'breakout' || w.status === 'running' ? ' brk' : ''));
    badge.textContent = 'FALLING WEDGE · ' + w.grade + ' · ' + w.confidence.toFixed(0) + '% · ' + STATUS_AR[w.status];
    badge.style.display = 'flex';

    const cc = confColor(w.confidence);
    const p = w.parts || {};
    const rows = [
      ['دقّة الخطّين (R²)', ((w.upper.r2 + w.lower.r2) / 2).toFixed(3), (p.fitScore || 0).toFixed(1) + '/18'],
      ['عدد اللمسات', w.upper.touches.length + ' / ' + w.lower.touches.length, (p.touchScore || 0).toFixed(1) + '/28'],
      ['انكماش المدى', (w.contraction * 100).toFixed(0) + '%', (p.contrScore || 0).toFixed(1) + '/14'],
      ['انحسار الحجم', w.volRatio.toFixed(2) + '×', (p.volScore || 0).toFixed(1) + '/13'],
      ['مدّة النموذج', w.bars + ' شمعة', (p.durScore || 0).toFixed(1) + '/11'],
      ['حدّة الانحدار', ((w.upper.m * w.bars) / w.widthStart).toFixed(2), (p.slopeScore || 0).toFixed(1) + '/8']
    ];

    const checks = [
      ['خطّا اتجاه هابطان', true],
      ['تقارب (المقاومة أشدّ انحدارًا)', w.lower.m > w.upper.m],
      ['القمّة (Apex) لم تُبلغ بعد', w.apexX > w.end],
      ['انكماش المدى ≥ 28%', w.contraction >= 0.28],
      ['انحسار الحجم داخل الوتد', w.volRatio < 0.85],
      ['تباعد RSI صاعد', !!w.divergence],
      ['اختراق مؤكَّد بالحجم', w.volConfirm != null && w.volConfirm > 1.4],
      ['العائد/المخاطرة ≥ 2 عند T3', w.targets[2].rr >= 2]
    ];

    const entry = w.breakoutIdx >= 0 ? 'تمّ عند ' + fmtP(w.entry) : 'عند الاختراق ' + fmtP(w.entry);
    const volTxt = w.volConfirm != null
      ? `<span class="${w.volConfirm > 1.4 ? 'up' : 'down'}">${w.volConfirm.toFixed(2)}× المتوسّط</span>`
      : '<span style="color:var(--txt-3)">لم يحدث بعد</span>';

    box.innerHTML = `
      <div class="signal-hero">
        <div class="signal-top">
          <div>
            <div class="signal-title">وتد هابط — ${STATUS_AR[w.status]}</div>
            <div class="signal-sub">${state.symbol} · ${state.tf} · ${w.bars} شمعة · ${(w.contraction * 100).toFixed(0)}% انكماش</div>
            <div style="margin-top:7px"><span class="status-pill status-${w.status}">${STATUS_AR[w.status]}</span></div>
          </div>
          <div class="grade ${w.grade[0] === 'A' ? 'A' : w.grade[0]}">${w.grade}</div>
        </div>
        <div class="gauge">
          <div class="gauge-row">
            <span class="lbl">درجة الثقة</span>
            <span class="gauge-val" style="color:${cc}">${w.confidence.toFixed(1)}<span style="font-size:10px;color:var(--txt-3)">/100</span></span>
          </div>
          <div class="gauge-bar"><div class="gauge-fill" style="width:${w.confidence}%;background:linear-gradient(90deg,${cc}55,${cc})"></div></div>
        </div>
      </div>

      <div class="sec">
        <div class="sec-title">خطة الصفقة</div>
        <div class="trade-grid">
          <div class="tcell entry"><div class="k">الدخول</div><div class="v" style="color:#93c5fd">${fmtP(w.entry)}</div><div class="s">${entry}</div></div>
          <div class="tcell stop"><div class="k">وقف الخسارة</div><div class="v" style="color:#f0455a">${fmtP(w.stop)}</div><div class="s">مخاطرة ${((w.risk / w.entry) * 100).toFixed(1)}%</div></div>
          ${w.targets.map((t, i) => `
            <div class="tcell t${i + 1}">
              <div class="k">الهدف ${i + 1} · ${(t.pct * 100).toFixed(1)}%</div>
              <div class="v" style="color:#12c48b">${fmtP(t.price)}</div>
              <div class="s">R:R ${t.rr.toFixed(2)} · +${((t.price / w.entry - 1) * 100).toFixed(1)}%</div>
            </div>`).join('')}
        </div>
      </div>

      <div class="sec">
        <div class="sec-title">قياسات النموذج</div>
        ${rows.map(r => `<div class="kv"><span class="k">${r[0]}</span><span class="v">${r[1]} <span style="color:var(--txt-3);font-size:9.5px">(${r[2]})</span></span></div>`).join('')}
        <div class="kv"><span class="k">تأكيد الحجم</span><span class="v">${volTxt}</span></div>
        <div class="kv"><span class="k">القمة المتوقّعة</span><span class="v">بعد ${Math.max(0, Math.round(w.apexX - w.end))} شمعة</span></div>
        <div class="kv"><span class="k">أقصى عرض للوتد</span><span class="v">${fmtP(w.widthStart)} (${((w.widthStart / w.entry) * 100).toFixed(1)}%)</span></div>
        ${w.retestIdx >= 0 ? '<div class="kv"><span class="k">إعادة الاختبار</span><span class="v up">مؤكّدة ✓</span></div>' : ''}
      </div>

      <div class="sec">
        <div class="sec-title">قائمة التحقّق</div>
        <div class="checklist">
          ${checks.map(c => `<div class="chk ${c[1] ? 'ok' : 'no'}"><span class="box">${c[1] ? '✓' : '✕'}</span><span>${c[0]}</span></div>`).join('')}
        </div>
      </div>`;
  }

  /* ================================ الفاحص ================================ */
  function renderScanner() {
    const box = $('#scanner');
    const scan = state.scans.get(state.tf);
    if (!scan) {
      box.innerHTML = '<div class="empty"><span class="spin"></span> جارٍ الفحص…</div>';
      return;
    }
    $('#scanCount').textContent = scan.length + '/' + M.SYMBOLS.length;
    if (!scan.length) { box.innerHTML = '<div class="empty">لا توجد أوتاد على هذا الإطار.</div>'; return; }
    box.innerHTML = scan.map(w => {
      const c = confColor(w.confidence);
      const dot = w.status === 'failed' ? '#f0455a' : w.status === 'forming' ? '#f5a623' : '#12c48b';
      return `<div class="scan-row" data-t="${w.symbol}">
        <div>
          <div class="scan-sym" style="display:flex;align-items:center;gap:6px">
            <span style="width:5px;height:5px;border-radius:50%;background:${dot};flex:0 0 auto"></span>${w.symbol}
          </div>
          <div class="scan-meta"><span>${STATUS_AR[w.status]}</span><span>·</span><span>${w.bars} شمعة</span><span>·</span><span>R:R ${w.targets[2].rr.toFixed(1)}</span></div>
        </div>
        <div class="conf-bar"><i style="width:${w.confidence}%;background:${c}"></i></div>
        <div class="conf-num" style="color:${c}">${w.confidence.toFixed(0)}</div>
      </div>`;
    }).join('');
    $$('#scanner .scan-row').forEach(el => el.onclick = () => setSymbol(el.dataset.t));
  }

  function runScan(tf) {
    if (state.scans.has(tf)) return Promise.resolve(state.scans.get(tf));
    $('#scanSpin').style.display = 'inline-block';
    return new Promise(res => setTimeout(() => {
      const r = Wedge.scan(M.SYMBOLS, tf);
      state.scans.set(tf, r);
      $('#scanSpin').style.display = 'none';
      res(r);
    }, 20));
  }

  /* =============================== التحميل ================================ */
  function load() {
    const bars = M.series(state.symbol, state.tf);
    chart.setWedge(null);          // قبل تغيير البيانات (فهارس الوتد تخصّ المصفوفة القديمة)
    chart.setData(bars, state.tf, state.symbol);

    // ربط الأخبار بالشموع
    state.news = M.alerts
      .filter(a => a.t === state.symbol)
      .map(a => {
        const t = new Date(a.ts).getTime();
        let best = -1, bd = Infinity;
        for (let i = 0; i < bars.length; i++) {
          const d = Math.abs(bars[i].time - t);
          if (d < bd) { bd = d; best = i; }
        }
        return { idx: best, title: a.title };
      });
    chart.setNews(state.news);

    state.wedgeKey = key();
    let ds = [];
    try { ds = JSON.parse(localStorage.getItem('fx.draw.' + state.wedgeKey) || '[]'); } catch (e) { ds = []; }
    chart.setDrawings(ds);

    const w = Wedge.detect(bars);
    state.wedge = w;
    if (w) { w.symbol = state.symbol; w.timeframe = state.tf; }
    chart.setWedge(w);

    renderSymHead();
    renderSignal();
    updateStatusbar(bars);
    $('#sbRange').textContent = `${fmtP(Math.min(...bars.map(b => b.l)))} – ${fmtP(Math.max(...bars.map(b => b.h)))}`;
  }

  function updateStatusbar(bars) {
    $('#sbBars').textContent = bars.length;
  }

  function setSymbol(t) {
    if (!M.SYMBOLS.includes(t)) return;
    state.symbol = t;
    load();
    renderWatchlist();
  }

  function setTf(tf) {
    state.tf = tf;
    $$('#tfSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === tf));
    load();
    $('#scanSpin').style.display = 'inline-block';
    runScan(tf).then(() => { $('#scanSpin').style.display = 'none'; renderScanner(); renderWatchlist(); });
  }

  /* =========================== الإطار الزمني ============================== */
  function buildTfSeg() {
    $('#tfSeg').innerHTML = M.TIMEFRAMES.map(tf =>
      `<button data-v="${tf}" class="${tf === state.tf ? 'on' : ''}">${tf}</button>`).join('');
    $$('#tfSeg button').forEach(b => b.onclick = () => setTf(b.dataset.v));
  }

  /* =============================== البحث ================================= */
  function buildSearch() {
    const inp = $('#searchInput'), res = $('#searchResults');
    const run = () => {
      const q = inp.value.trim().toUpperCase();
      const list = M.SYMBOLS
        .filter(t => !q || t.includes(q) || M.META[t].name.toUpperCase().includes(q) || M.META[t].sector.toUpperCase().includes(q))
        .slice(0, 8);
      if (!list.length) { res.classList.remove('open'); return; }
      res.innerHTML = list.map(t => {
        const qq = M.quote(t);
        return `<div class="sr-item" data-t="${t}"><div><div class="t">${t}</div><div class="n">${qq.name}</div></div>
          <div class="num ${qq.chg >= 0 ? 'up' : 'down'}" style="font-size:11px">${fmtP(qq.price)}</div></div>`;
      }).join('');
      res.classList.add('open');
      $$('#searchResults .sr-item').forEach(el => el.onclick = () => { setSymbol(el.dataset.t); res.classList.remove('open'); inp.value = ''; inp.blur(); });
    };
    inp.oninput = run;
    inp.onfocus = run;
    inp.onkeydown = e => { if (e.key === 'Enter') { const f = res.querySelector('.sr-item'); if (f) f.click(); } if (e.key === 'Escape') { inp.blur(); res.classList.remove('open'); } };
    document.addEventListener('click', e => { if (!$('#searchBox').contains(e.target)) res.classList.remove('open'); });
  }

  /* ============================ لوحة الأوامر ============================= */
  const COMMANDS = [
    { ic: '⇅', tx: 'إعادة ضبط الشارت', hint: '0', run: () => chart.reset() },
    { ic: '✎', tx: 'أداة: خط اتجاه', hint: 'T', run: () => pickTool('trendline') },
    { ic: '↔', tx: 'أداة: خط أفقي', hint: 'H', run: () => pickTool('hline') },
    { ic: 'φ', tx: 'أداة: فيبوناتشي', hint: 'F', run: () => pickTool('fib') },
    { ic: '▭', tx: 'أداة: منطقة', hint: 'E', run: () => pickTool('rect') },
    { ic: '↕', tx: 'أداة: قياس', hint: 'M', run: () => pickTool('measure') },
    { ic: '∿', tx: 'تبديل EMA', run: () => $('#tEma').click() },
    { ic: '▤', tx: 'تبديل الحجم', run: () => $('#tVol').click() },
    { ic: '≋', tx: 'تبديل RSI', run: () => $('#tRsi').click() },
    { ic: '▽', tx: 'تبديل طبقة الوتد', run: () => $('#tWedge').click() },
    { ic: '㏒', tx: 'تبديل المقياس اللوغاريتمي', run: () => $('#tLog').click() },
    { ic: '⌫', tx: 'مسح كل الرسومات', run: () => $('#tClear').click() },
    { ic: '⟳', tx: 'إعادة فحص كل الرموز', hint: 'R', run: () => rescan() },
    { ic: '⤓', tx: 'تصدير الشارت PNG', run: () => exportPNG() },
    { ic: '?', tx: 'عرض الاختصارات', run: () => showHelp() }
  ];

  function buildCmdk() {
    const box = $('#cmdk'), inp = $('#cmdkInput'), list = $('#cmdkList');
    let sel = 0, items = [];

    const render = () => {
      const q = inp.value.trim().toUpperCase();
      const cmds = COMMANDS.filter(c => !q || c.tx.includes(inp.value.trim()));
      const syms = M.SYMBOLS.filter(t => !q || t.includes(q)).map(t => ({
        ic: '◆', tx: t + ' — ' + M.META[t].name, hint: 'رمز', run: () => setSymbol(t)
      }));
      items = [...syms.slice(0, 6), ...cmds];
      if (!items.length) { list.innerHTML = '<div class="empty">لا نتائج</div>'; return; }
      sel = Math.min(sel, items.length - 1);
      list.innerHTML = items.map((c, i) =>
        `<div class="cmdk-item ${i === sel ? 'sel' : ''}" data-i="${i}">
          <span class="ic">${c.ic}</span><span class="tx">${c.tx}</span><span class="hint">${c.hint || ''}</span></div>`).join('');
      $$('#cmdkList .cmdk-item').forEach(el => el.onclick = () => { close(); items[+el.dataset.i].run(); });
    };

    const open = () => { box.classList.add('open'); inp.value = ''; sel = 0; render(); setTimeout(() => inp.focus(), 10); };
    const close = () => box.classList.remove('open');

    inp.oninput = () => { sel = 0; render(); };
    inp.onkeydown = e => {
      if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); render(); e.preventDefault(); }
      else if (e.key === 'Enter') { if (items[sel]) { close(); items[sel].run(); } }
      else if (e.key === 'Escape') close();
    };
    box.onclick = e => { if (e.target === box) close(); };
    window.__cmdk = { open, close };
  }

  function showHelp() {
    toast('اختصارات لوحة المفاتيح',
      '/ بحث · Ctrl+K أوامر · T/H/F/E/M/M أدوات رسم · 0 إعادة ضبط · R فحص · ↑↓ تنقّل بين الرموز');
  }

  function pickTool(t) {
    chart.setTool(t);
    $$('.tbtn[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
    const names = { trendline: 'خط اتجاه', ray: 'شعاع', hline: 'خط أفقي', fib: 'فيبوناتشي', rect: 'منطقة', measure: 'قياس' };
    $('#sbTool').innerHTML = 'الوضع: <b>' + (names[t] || 'مؤشر') + '</b>';
    if (t !== 'cursor') toast('أداة الرسم: ' + names[t], 'اسحب على الشارت لتحديد الشكل — Esc للإلغاء');
  }

  function rescan() {
    state.scans.clear();
    $('#scanSpin').style.display = 'inline-block';
    runScan(state.tf).then(() => { $('#scanSpin').style.display = 'none'; renderScanner(); renderWatchlist(); toast('تمّ الفحص', state.scans.get(state.tf).length + ' وتد على إطار ' + state.tf, 'ok'); });
  }

  function exportPNG() {
    const a = document.createElement('a');
    a.href = chart.toPNG();
    a.download = `${state.symbol}_${state.tf}_falling-wedge.png`;
    a.click();
    toast('تمّ التصدير', a.download, 'ok');
  }

  /* ============================ الأدوات والأزرار ========================== */
  function bindTools() {
    $$('.tbtn[data-tool]').forEach(b => b.onclick = () => pickTool(b.dataset.tool));
    $('#tClear').onclick = () => {
      chart.setDrawings([]);
      localStorage.removeItem('fx.draw.' + state.wedgeKey);
      toast('تمّ مسح الرسومات');
    };
    $('#tReset').onclick = () => chart.reset();
    const toggle = (id, fn) => {
      const el = $(id);
      el.onclick = () => { el.classList.toggle('on'); fn(el.classList.contains('on')); };
    };
    toggle('#tEma', v => { chart.o.showEma = v; chart.requestDraw(); });
    toggle('#tVol', v => { chart.o.showVolume = v; chart.requestDraw(); });
    toggle('#tRsi', v => { chart.o.showRsi = v; chart.requestDraw(); });
    toggle('#tWedge', v => { chart.setWedge(v ? state.wedge : null); });
    toggle('#tLog', v => { chart.o.log = v; chart.requestDraw(); });
    chart.o.showEma = $('#tEma').classList.contains('on');

    $$('#chartType button').forEach(b => b.onclick = () => {
      $$('#chartType button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      state.chartType = b.dataset.v;
      chart.chartType = state.chartType;
      chart.requestDraw();
    });

    $('#btnScan').onclick = rescan;
    $('#btnShot').onclick = exportPNG;
    $('#btnHelp').onclick = showHelp;
    if ($('#btnDl')) $('#btnDl').onclick = () => {
      const a = document.createElement('a');
      a.href = 'download'; a.download = 'stok-terminal.html';
      document.body.appendChild(a); a.click(); a.remove();
    };
  }

  /* ============================== الاختصارات ============================= */
  function bindKeys() {
    document.addEventListener('keydown', e => {
      const typing = /INPUT|TEXTAREA/.test(document.activeElement.tagName);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); window.__cmdk.open(); return; }
      if (typing) {
        if (e.key === 'Escape') document.activeElement.blur();
        return;
      }
      if (e.key === '/') { e.preventDefault(); $('#searchInput').focus(); return; }
      if (e.key === '?') { showHelp(); return; }
      const k = e.key.toLowerCase();
      const map = { t: 'trendline', y: 'ray', h: 'hline', f: 'fib', e: 'rect', m: 'measure' };
      if (map[k]) { pickTool(map[k]); return; }
      if (k === 'escape') { pickTool('cursor'); $$('.tbtn[data-tool]').forEach(b => b.classList.remove('on')); $('#sbTool').innerHTML = 'الوضع: <b>مؤشر</b>'; return; }
      if (k === '0') { chart.reset(); return; }
      if (k === 'r') { rescan(); return; }
      if (k === 'l') { $('#tLog').click(); return; }
      if (k === 'v') { $('#tVol').click(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const i = M.SYMBOLS.indexOf(state.symbol);
        const n = (i + (e.key === 'ArrowDown' ? 1 : M.SYMBOLS.length - 1)) % M.SYMBOLS.length;
        setSymbol(M.SYMBOLS[n]);
      }
    });
  }

  /* ========================== الساعة وحالة السوق ========================== */
  function tickClock() {
    const now = new Date();
    const fmt = (tz, o) => new Intl.DateTimeFormat('en-GB', Object.assign({ timeZone: tz, hour12: false }, o)).format(now);
    $('#clock').innerHTML =
      `<b>${fmt('Asia/Riyadh', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</b> <span>الرياض</span><br>` +
      `<b>${fmt('America/New_York', { hour: '2-digit', minute: '2-digit' })}</b> <span>نيويورك · ${fmt('America/New_York', { weekday: 'short' })}</span>`;

    const ny = new Date(fmt('America/New_York', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', ''));
    const parts = fmt('America/New_York', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
    const m = parts.match(/(\d{2})\/(\d{2})\/(\d{4}),?\s*(\d{2}):(\d{2})/);
    const wd = now.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
    let open = false, label = 'مغلق';
    if (m) {
      const mins = (+m[4]) * 60 + (+m[5]);
      const isWeekday = !['Sat', 'Sun'].includes(wd);
      if (isWeekday && mins >= 570 && mins < 960) { open = true; label = 'السوق مفتوح'; }
      else if (isWeekday && mins >= 240 && mins < 570) label = 'ما قبل الافتتاح';
      else if (isWeekday && mins >= 960 && mins < 1200) label = 'ما بعد الإغلاق';
      else label = ['Sat', 'Sun'].includes(wd) ? 'عطلة أسبوعية' : 'مغلق';
    }
    $('#mktDot').className = 'pulse' + (open ? '' : ' off');
    $('#mktText').textContent = label;
  }

  /* =============================== الإقلاع =============================== */
  /** يفضّل `/api/alerts` (يقرأ logs/alerts_log.csv مباشرة)، ويرجع للمدمج عند الفشل */
  function loadLiveAlerts() {
    if (typeof fetch !== 'function') {
      $('#sbSource').innerHTML = 'الأسعار: محاكاة أوفلاين · الأخبار: مدمجة <b>' + M.alerts.length + ' تنبيه</b>';
      return Promise.resolve();
    }
    return fetch('api/alerts', { cache: 'no-store' })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(d => {
        if (!d || !Array.isArray(d.alerts) || !d.alerts.length) throw new Error('empty');
        M.alerts.length = 0;
        Array.prototype.push.apply(M.alerts, d.alerts);
        renderNews();
        load();
        $('#sbSource').innerHTML = 'الأسعار: محاكاة أوفلاين · الأخبار: API محلي (CSV)';
      })
      .catch(() => { $('#sbSource').innerHTML = 'الأسعار: محاكاة أوفلاين · الأخبار: CSV <b>' + M.alerts.length + ' تنبيه</b>'; });
  }

  /* --------------------- استراتيجية التجزئة العكسية --------------------- */
  function renderSplitBody(box) {
    $('#sigTitle').textContent = 'التجزئة العكسية — ارتداد القاع';
    const bars = M.series(state.symbol, state.tf);
    const m = { date: ($('#splitDate') && $('#splitDate').value) || '', float: ($('#splitFloat') && $('#splitFloat').value) || '' };
    const r = Split.analyze(bars, m);
    const badge = $('#chartBadge');
    badge.className = 'chart-badge' + (r.cls === 'go' ? ' brk' : '');
    badge.textContent = 'REVERSE SPLIT · ' + r.score + '% · ' + r.st;
    badge.style.display = 'flex';
    const fx = n => (n == null || isNaN(n)) ? '—' : (+n).toFixed(n < 1 ? 4 : 2);
    const rows = r.k.map(q => '<div class="ck-row ' + (q.ok ? 'ok' : 'bad') + '"><span>' + q.l + '</span><b>' + q.v + '</b></div>').join('');
    const info = r.info.map(x => '<div class="ck-row"><span>' + x[0] + '</span><b>' + x[1] + '</b></div>').join('');
    box.innerHTML =
      '<div class="ck-row ' + (r.ready ? 'ok' : 'bad') + '"><span>النتيجة / الحالة</span><b>' + r.score + '% · ' + r.st + '</b></div>' +
      rows +
      '<h3 style="margin:10px 0 6px;font-size:12px">خطة التداول</h3>' +
      '<div class="ck-row"><span>دخول</span><b>' + fx(r.plan.en) + '</b></div>' +
      '<div class="ck-row bad"><span>وقف الخسارة</span><b>' + fx(r.plan.sl) + '</b></div>' +
      r.plan.tp.map((t, i) => '<div class="ck-row ok"><span>هدف ' + (i + 1) + '</span><b>' + fx(t) + '</b></div>').join('') +
      '<div class="ck-row"><span>R:R (هدف 2)</span><b>' + (isFinite(r.plan.rr) ? r.plan.rr.toFixed(2) : '—') + '</b></div>' +
      '<h3 style="margin:10px 0 6px;font-size:12px">بيانات إضافية</h3>' + info;
  }

  function initStrategy() {
    $$('#stratSeg button').forEach(b => b.onclick = () => {
      $$('#stratSeg button').forEach(x => x.classList.toggle('on', x === b));
      state.strategy = b.dataset.st;
      $('#splitMeta').hidden = state.strategy !== 'split';
      renderSignal();
    });
    const re = () => { if (state.strategy === 'split') renderSignal(); };
    $('#splitDate').onchange = re;
    $('#splitFloat').oninput = re;
  }

  /* -------------------- مصدر البيانات (ربط احتياطي آمن) --------------------
     ملاحظة: يستخدم «فتح دائمًا / إغلاق دائمًا» بدل التبديل حتى لا يتعارض مع
     السكربت المضمّن المستقل في index.html عند تشغيلهما معًا في المتصفح. */
  function initSource() {
    const show = v => { const p = $('#setPanel'); p.hidden = !v; p.style.display = v ? 'flex' : 'none'; };
    const fill = () => {
      $('#ak').value = localStorage.getItem('twelve_data_api_key') || '';
      $('#px').value = localStorage.getItem('twelve_data_proxy') || '';
      $('#rk').value = localStorage.getItem('risk_usd') || 50;
    };
    if ($('#tSet')) $('#tSet').onclick = () => { show(true); fill(); };
    ['#setClose', '#setCloseTop'].forEach(id => { const b = $(id); if (b) b.onclick = () => show(false); });
    if ($('#setSave')) $('#setSave').onclick = () => {
      localStorage.setItem('twelve_data_api_key', $('#ak').value.trim());
      localStorage.setItem('twelve_data_proxy', $('#px').value.trim());
      localStorage.setItem('risk_usd', $('#rk').value || 50);
      show(false);
      toast('تم حفظ مصدر البيانات', $('#ak').value.trim() ? 'Twelve Data (حيّ في متصفّحك)' : 'محاكاة أوفلاين', 'ok');
    };
  }

  /* --------------------- إضافة الأسهم + جلب TradingView ------------------ */
  const TV_PRESET = {
    wedge: ['SOUN', 'BB', 'PLTR', 'MARA', 'RIOT', 'AMD', 'NVDA', 'TSLA'],
    split: ['MULN', 'BBBY', 'CVNA', 'UPST', 'PLUG', 'F', 'GE']
  };

  function rebuildUniverse() {
    renderWatchlist(); renderTape();
    return runScan(state.tf).then(() => { renderScanner(); });
  }

  function initAdd() {
    const doAdd = () => {
      const t = ($('#addSym').value || '').trim().toUpperCase();
      if (!t) return;
      M.ensureSymbol(t);
      $('#addSym').value = '';
      rebuildUniverse().then(() => setSymbol(t));
      toast('أُضيف الرمز', t + ' — بيانات حتمية (محاكاة)', 'ok');
    };
    $('#addSymBtn').onclick = doAdd;
    $('#addSym').onkeydown = e => { if (e.key === 'Enter') doAdd(); };
    $('#fetchTV').onclick = fetchTV;
  }

  function fetchTV() {
    const sys = state.strategy === 'split' ? 'split' : 'wedge';
    $('#scanSpin').style.display = 'inline-block';
    const done = (list, live) => {
      list.forEach(t => M.ensureSymbol(t));
      rebuildUniverse().then(() => { $('#scanSpin').style.display = 'none'; });
      toast(live ? 'جلب حيّ من TradingView' : 'قائمة افتراضية للنظام',
        list.length + ' رمزًا لنظام ' + (sys === 'split' ? 'التجزئة العكسية' : 'التقلبات العالية'), live ? 'ok' : 'warn');
    };
    const fallback = why => done(TV_PRESET[sys], false);
    try {
      const body = sys === 'wedge'
        ? { columns: ['name', 'close', 'Volatility.D'], range: [0, 20],
            options: { sort: { sortBy: 'Volatility.D', sortOrder: 'desc' } },
            filter: [{ left: 'exchange', operation: 'inRange', right: ['NASDAQ', 'NYSE'] }, { left: 'close', operation: 'greater', right: 1 }] }
        : { columns: ['name', 'close', 'Volatility.D'], range: [0, 20],
            options: { sort: { sortBy: 'Volatility.D', sortOrder: 'desc' } },
            filter: [{ left: 'close', operation: 'smaller', right: 10 }, { left: 'Volatility.D', operation: 'greater', right: 3 }] };
      fetch('https://scanner.tradingview.com/america/scan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      })
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(j => {
          const list = (j.data || []).map(d => String(d.s || '').split(':')[1]).filter(Boolean);
          if (!list.length) throw new Error('empty');
          $('#scanSpin').style.display = 'none';
          done(list, true);
        })
        .catch(e => { $('#scanSpin').style.display = 'none'; fallback(e.message); });
    } catch (e) { $('#scanSpin').style.display = 'none'; fallback(e.message); }
  }

  function boot() {
    buildTfSeg();
    buildSearch();
    buildCmdk();
    bindTools();
    bindKeys();
    initStrategy();
    initSource();
    initAdd();
    renderTape();
    renderWatchlist();
    renderNews();
    load();
    loadLiveAlerts();
    tickClock();
    setInterval(tickClock, 1000);
    $('#scanSpin').style.display = 'inline-block';
    runScan(state.tf).then(() => { $('#scanSpin').style.display = 'none'; renderScanner(); });
    setTimeout(() => toast('STOK Terminal جاهز', '١٦ رمزًا · استراتيجية الوتد الهابط · رسم يدوي كامل', 'ok'), 500);
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
