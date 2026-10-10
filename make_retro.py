# -*- coding: utf-8 -*-
"""从现行 astra/index.html 派生 astra-procedural/index.html（程序化引擎档案版）"""
import re

SRC = 'astra/index.html'
DST = 'astra-procedural/index.html'
s = open(SRC, encoding='utf-8').read()

# 1) 舞台：海报+双视频 → 旧引擎 canvas
s = re.sub(
    r'<img id="poster".*?(?=<!-- 静态模式)',
    '<canvas id="scene" aria-hidden="true"></canvas>\n  <!-- 程序化引擎（v2 连续相机路径）：dolly-in + 光晕换图 + 星尘/薄雾/前景 -->\n  ',
    s, flags=re.S)
assert '<canvas id="scene"' in s, 'stage swap failed'
assert '<video' not in s.split('</head>')[1].split('<header')[0], 'videos still in stage'

# 2) 标题与品牌标注
s = s.replace('<title>ASTRA · 深空信标计划</title>',
              '<title>ASTRA · 深空信标计划 · 程序化引擎档案版</title>')
s = s.replace('<span class="sub">深空信标计划</span>',
              '<span class="sub">深空信标计划 · 程序化引擎档案</span>')
s = s.replace('hero-meta">三章旅程 · 航程',
              'hero-meta">程序化引擎版（无视频）· 三章旅程 · 航程')

# 3) 脚本：scene + audio + hud + 复古主循环（去掉 video/main）
s = s.replace('<script src="js/astra-audio.js"></script>',
              '<script src="js/astra-scene.js"></script>')
s = s.replace('<script src="js/astra-hud.js"></script>',
              '<script src="js/astra-audio.js"></script>\n<script src="js/astra-hud.js"></script>')
s = re.sub(r'<script src="js/astra-video\.js"></script>\s*', '', s)
s = re.sub(r'<script src="js/astra-main\.js"></script>\s*', '', s)

RETRO = r"""
<script>
/* 程序化引擎档案版主循环：滚动 → 引擎相机（无视频层） */
(function () {
  'use strict';
  var win = window, doc = document;
  var stage = doc.getElementById('stage');
  var canvas = doc.getElementById('scene');
  if (!stage || !canvas || !win.AstraEngine) return;
  var ctx = canvas.getContext('2d', { alpha: false });
  var Art = win.AstraEngine;
  var track = doc.getElementById('scroll-track');
  var navBtns = [].slice.call(doc.querySelectorAll('#chapter-nav .nav-btn'));
  var titles = [].slice.call(doc.querySelectorAll('#titles .title'));
  var fillEl = doc.getElementById('progress-fill');
  var headEl = doc.getElementById('progress-head');
  var pctEl = doc.getElementById('progress-pct');
  var trackEl = doc.getElementById('progress-track');
  var hintEl = doc.getElementById('hint');
  var tourBtn = doc.getElementById('tour-btn');
  var tourIco = doc.getElementById('tour-ico');
  var tourLabel = doc.getElementById('tour-label');
  var fadeEl = doc.getElementById('fade');
  var dots = [].slice.call(doc.querySelectorAll('#reduced-dots .dot'));
  var prevBtn = doc.getElementById('prev-ch'), nextBtn = doc.getElementById('next-ch');
  var Aud = win.AstraAudio || null, Hud = win.AstraHUD || null;
  var muteBtn = doc.getElementById('mute-btn'), muteIco = doc.getElementById('mute-ico'),
      muteTxt = doc.getElementById('mute-txt');

  var CH1 = 0.55, CH2 = 0.75, NAV = [0.02, 0.645, 0.835], SCREENS = 7, TOUR_FULL = 45;
  var TITLE_WIN = [[0, 0, 0.285, 0.380], [0.610, 0.640, 0.655, 0.698], [0.795, 0.835, 3, 3]];
  var REDUCED_KEYS = [0.0, 0.64, 0.86];
  var st = { W: 0, H: 0, DPR: 1, minWH: 0, maxWH: 0, cx: 0, cy: 0, scrollable: 1,
    target: 0, current: 0, speed: 0, clock: 0, lastTs: 0, raf: 0, running: false,
    tour: { on: false, paused: false, startT: 0, elapsed: 0, dur: TOUR_FULL },
    glide: { on: false, from: 0, to: 0, t0: 0, dur: 0, cb: null },
    lastCh: -1, lastPct: -1, world: null, hintGone: false,
    reduced: win.matchMedia('(prefers-reduced-motion: reduce)').matches, reducedIdx: 0 };

  function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
  function ss(a, b, x) { if (b === a) return x >= a ? 1 : 0; x = clamp((x - a) / (b - a), 0, 1); return x * x * (3 - 2 * x); }
  function lerp(a, b, p) { return a + (b - a) * p; }
  function easeCubic(p) { return p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; }
  function tourEase(p) { return p - 0.08 * Math.sin(p * Math.PI * 2); }

  function measure(kp) {
    var old = st.scrollable, prog = clamp((win.scrollY || 0) / old, 0, 1);
    var w = stage.clientWidth || win.innerWidth, h = stage.clientHeight || win.innerHeight;
    st.DPR = Math.min(win.devicePixelRatio || 1, 2);
    canvas.width = Math.max(2, Math.round(w * st.DPR));
    canvas.height = Math.max(2, Math.round(h * st.DPR));
    st.W = w; st.H = h; st.minWH = Math.min(w, h); st.maxWH = Math.max(w, h);
    st.cx = w / 2; st.cy = h / 2;
    if (!st.reduced) {
      var vh = win.innerHeight;
      track.style.height = Math.round(vh * SCREENS) + 'px';
      st.scrollable = Math.max(1, doc.documentElement.scrollHeight - vh);
      if (kp) win.scrollTo(0, prog * st.scrollable);
    }
  }
  function build() {
    st.world = Art.build({ W: st.W, H: st.H, minWH: st.minWH, maxWH: st.maxWH, area: st.W * st.H });
    renderOnce();
  }
  function renderOnce() {
    if (!st.world) return;
    ctx.setTransform(st.DPR, 0, 0, st.DPR, 0, 0);
    Art.render(ctx, st.world, { W: st.W, H: st.H, cx: st.cx, cy: st.cy,
      minWH: st.minWH, maxWH: st.maxWH, t: st.current, clock: st.clock, speed: st.speed });
  }
  function updateDOM() {
    var t = st.current;
    var ch = t < CH1 ? 0 : (t < CH2 ? 1 : 2);
    if (ch !== st.lastCh) {
      st.lastCh = ch;
      for (var i = 0; i < navBtns.length; i++) navBtns[i].classList.toggle('active', i === ch);
      doc.body.setAttribute('data-chapter', String(ch + 1));
      if (Aud) Aud.setChapter(ch + 1);
    }
    for (i = 0; i < 3; i++) {
      var wnd = TITLE_WIN[i];
      var fin = ss(wnd[0], wnd[1], t), fout = ss(wnd[2], wnd[3], t);
      var o = Math.round(fin * (1 - fout) * 1000) / 1000;
      var ty = Math.round(((1 - fin) * 18 - fout * 18) * 10) / 10;
      var el = titles[i];
      if (!el) continue;
      if (el._o !== o) { el._o = o; el.style.opacity = o; }
      if (el._ty !== ty) { el._ty = ty; el.style.transform = 'translateY(' + ty + 'px)'; }
    }
    var pct = Math.round(t * 100);
    if (pct !== st.lastPct) {
      st.lastPct = pct;
      fillEl.style.height = pct + '%';
      headEl.style.top = pct + '%';
      pctEl.textContent = (pct < 10 ? '00' : pct < 100 ? '0' : '') + pct;
    }
  }
  function setTourLabel() {
    if (st.tour.on && !st.tour.paused) { tourIco.textContent = '❚❚'; tourLabel.textContent = '暂停漫游 · 空格'; }
    else if (st.tour.on) { tourIco.textContent = '▶'; tourLabel.textContent = '继续漫游 · 空格'; }
    else { tourIco.textContent = '▶'; tourLabel.textContent = '自动漫游 · 45s'; }
  }
  function beginTour(fromT) {
    st.tour.on = true; st.tour.paused = false;
    st.tour.startT = clamp(fromT, 0, 0.999); st.tour.elapsed = 0;
    st.tour.dur = Math.max(6, (1 - st.tour.startT) * TOUR_FULL);
    setTourLabel();
    if (Aud) Aud.tourOn();
  }
  function startTour() {
    dismissHint();
    if (st.tour.on) { st.tour.paused = !st.tour.paused; setTourLabel(); return; }
    cancelGlide();
    var t0 = st.current;
    if (t0 > 0.985) glideTo(0, 1100, function () { beginTour(0); });
    else beginTour(t0);
  }
  function endTour() {
    st.tour.on = false; st.tour.paused = false;
    setTourLabel();
    if (Aud) Aud.tourOff();
  }
  function glideTo(y, dur, cb) {
    st.glide.on = true;
    st.glide.from = win.scrollY || 0;
    st.glide.to = clamp(y, 0, st.scrollable);
    st.glide.t0 = performance.now();
    st.glide.dur = dur || 900;
    st.glide.cb = cb || null;
  }
  function cancelGlide() { st.glide.on = false; st.glide.cb = null; }
  function glideToChapter(i) {
    interruptTour();
    var y = NAV[i] === 0 ? 0 : NAV[i] * st.scrollable;
    glideTo(y, 700 + Math.abs(y - (win.scrollY || 0)) / st.scrollable * 2600);
  }
  function refreshMuteUI() {
    if (!muteBtn) return;
    var active = !!(Aud && Aud.isActive()), muted = !!(Aud && Aud.isMuted());
    muteBtn.classList.toggle('muted', muted);
    if (muteIco) muteIco.textContent = muted ? '○' : '◉';
    if (muteTxt) muteTxt.textContent = active ? (muted ? '静音 · M' : '声音 开 · M') : '声音 待命';
  }
  function toggleMute() {
    if (!Aud) return;
    if (!Aud.isActive()) Aud.unlock(); else Aud.toggleMute();
    refreshMuteUI();
  }
  if (muteBtn) muteBtn.addEventListener('click', function () { muteBtn.blur(); toggleMute(); });

  function dismissHint() { if (st.hintGone) return; st.hintGone = true; hintEl.classList.add('gone'); }
  function userAct() { dismissHint(); if (st.tour.on) endTour(); cancelGlide(); }
  win.addEventListener('wheel', userAct, { passive: true });
  win.addEventListener('touchstart', userAct, { passive: true });
  win.addEventListener('keydown', function (e) {
    var key = e.key;
    if (key === ' ' || key === 'Spacebar') {
      if (e.target && e.target.tagName === 'BUTTON') return;
      e.preventDefault(); startTour(); return;
    }
    if (key === 'h' || key === 'H' || key === 'Escape') { doc.body.classList.toggle('ui-hidden'); return; }
    if (key === 'm' || key === 'M') { toggleMute(); return; }
    var step = 0;
    if (key === 'ArrowDown') step = 0.045;
    else if (key === 'ArrowUp') step = -0.045;
    else if (key === 'PageDown') step = 0.2;
    else if (key === 'PageUp') step = -0.2;
    else if (key === 'Home') { e.preventDefault(); userAct(); glideTo(0, 900); return; }
    else if (key === 'End') { e.preventDefault(); userAct(); glideTo(st.scrollable, 1400); return; }
    if (step !== 0) { e.preventDefault(); userAct(); win.scrollBy({ top: step * st.scrollable, behavior: 'smooth' }); }
  });
  for (var nb = 0; nb < navBtns.length; nb++) {
    (function (i) {
      navBtns[i].addEventListener('click', function (e) {
        e.preventDefault(); navBtns[i].blur();
        if (Aud) Aud.tick();
        dismissHint(); glideToChapter(i);
      });
    })(nb);
  }
  if (trackEl) trackEl.addEventListener('click', function (e) {
    var r = trackEl.getBoundingClientRect();
    var p = clamp((e.clientY - r.top) / r.height, 0, 1);
    userAct();
    if (Aud) Aud.tick();
    glideTo(p * st.scrollable, 700 + Math.abs(p * st.scrollable - (win.scrollY || 0)) * 0.5);
  });
  tourBtn.addEventListener('click', function () { tourBtn.blur(); startTour(); });
  var heroTour = doc.getElementById('hero-tour'), heroDown = doc.getElementById('hero-down');
  if (heroTour) heroTour.addEventListener('click', function () {
    heroTour.blur(); if (Aud) Aud.unlock(); startTour();
  });
  if (heroDown) heroDown.addEventListener('click', function () { heroDown.blur(); userAct(); glideToChapter(1); });

  doc.addEventListener('visibilitychange', function () {
    if (doc.hidden) { if (st.raf) win.cancelAnimationFrame(st.raf); st.running = false; }
    else if (!st.running) { st.running = true; st.lastTs = 0; st.raf = win.requestAnimationFrame(frame); }
  });
  var rzTimer = 0, lastW = 0, lastH = 0;
  win.addEventListener('resize', function () {
    win.clearTimeout(rzTimer);
    rzTimer = win.setTimeout(function () {
      var w = win.innerWidth, h = win.innerHeight;
      if (Math.abs(w - lastW) <= 2 && Math.abs(h - lastH) <= 140) return;
      lastW = w; lastH = h;
      measure(true); build();
    }, 160);
  }, { passive: true });

  function frame(ts) {
    if (!st.running) return;
    var dt = st.lastTs ? Math.max(0, Math.min(0.05, (ts - st.lastTs) / 1000)) : 0.016;
    st.lastTs = ts;
    var sy = win.scrollY || doc.documentElement.scrollTop || 0;
    st.target = clamp(sy / st.scrollable, 0, 1);
    if (st.tour.on && !st.tour.paused) {
      st.tour.elapsed += dt;
      var tp = clamp(st.tour.elapsed / st.tour.dur, 0, 1);
      win.scrollTo(0, (st.tour.startT + (1 - st.tour.startT) * tourEase(tp)) * st.scrollable);
      if (tp >= 1) endTour();
    }
    if (st.glide.on) {
      var gp = clamp((ts - st.glide.t0) / st.glide.dur, 0, 1);
      win.scrollTo(0, Math.round(lerp(st.glide.from, st.glide.to, easeCubic(gp))));
      if (gp >= 1) { st.glide.on = false; var cb = st.glide.cb; st.glide.cb = null; if (cb) cb(); }
    }
    var prev = st.current;
    st.current += (st.target - st.current) * (1 - Math.exp(-dt * 3.4));
    if (Math.abs(st.target - st.current) < 0.000015) st.current = st.target;
    var inst = Math.abs(st.current - prev) / dt;
    st.speed = st.speed * 0.86 + inst * 0.14;
    st.clock += dt * clamp(st.speed * 42, 0, 1);
    renderOnce();
    updateDOM();
    var spdN = clamp(st.speed / 0.22, 0, 1);
    if (Aud) Aud.setSpeed(spdN);
    if (Hud) Hud.update({ p: st.current, speed: spdN, dt: dt, clock: st.clock,
      touring: st.tour.on && !st.tour.paused, gliding: st.glide.on, introDone: st.hintGone });
    st.raf = win.requestAnimationFrame(frame);
  }

  function setReducedChapter(i) {
    st.reducedIdx = clamp(i, 0, 2);
    for (var k = 0; k < titles.length; k++) {
      var el = titles[k];
      el.style.opacity = ''; el.style.transform = ''; el._o = null; el._ty = null;
      el.classList.toggle('active', k === st.reducedIdx);
    }
    for (k = 0; k < navBtns.length; k++) navBtns[k].classList.toggle('active', k === st.reducedIdx);
    for (k = 0; k < dots.length; k++) dots[k].classList.toggle('active', k === st.reducedIdx);
    st.current = REDUCED_KEYS[st.reducedIdx];
    st.clock = 1.7; st.speed = 0; st.target = st.current;
    renderOnce();
    if (Aud) Aud.setChapter(st.reducedIdx + 1);
    if (Hud) Hud.update({ p: st.current, speed: 0, dt: 0, clock: st.clock,
      touring: false, gliding: false, introDone: true });
  }
  function switchReduced(i) {
    i = clamp(i, 0, 2);
    if (i === st.reducedIdx) return;
    fadeEl.classList.add('on');
    win.setTimeout(function () {
      setReducedChapter(i);
      win.setTimeout(function () { fadeEl.classList.remove('on'); }, 60);
    }, 340);
  }
  for (var d = 0; d < dots.length; d++) {
    (function (i) { dots[i].addEventListener('click', function () { dots[i].blur(); switchReduced(i); }); })(d);
  }
  if (prevBtn) prevBtn.addEventListener('click', function () { prevBtn.blur(); switchReduced(st.reducedIdx - 1); });
  if (nextBtn) nextBtn.addEventListener('click', function () { nextBtn.blur(); switchReduced(st.reducedIdx + 1); });

  (function init() {
    lastW = win.innerWidth; lastH = win.innerHeight;
    measure(false);
    Art.load();
    build();
    if (Hud) Hud.init({ reduced: st.reduced });
    if (Aud) { Aud.onState = refreshMuteUI; Aud.setChapter(1); }
    refreshMuteUI();
    if (st.reduced) {
      doc.body.classList.add('reduced');
      st.scrollable = 1;
      setReducedChapter(0);
    } else {
      st.running = true; st.lastTs = 0;
      st.raf = win.requestAnimationFrame(frame);
    }
  })();
})();
</script>
"""
s = s.replace('</body>', RETRO + '</body>')

open(DST, 'w', encoding='utf-8').write(s)
print('written', DST, len(s), 'chars')
