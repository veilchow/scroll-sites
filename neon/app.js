/* ============================================================
 * NEON DRIFT / 雨夜漫游 — app.js
 * 滚动进度 → 镜头时间轴；rAF 单循环；阻尼缓动；
 * 自动漫游 / 键盘 / UI 同步 / reduced-motion 静态模式 / 性能守卫
 * ============================================================ */
(function () {
  'use strict';
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  var canvas = document.getElementById('cv');
  var stage = document.getElementById('stage');
  var navBtns = Array.prototype.slice.call(document.querySelectorAll('.nav-btn'));
  var titles = Array.prototype.slice.call(document.querySelectorAll('.ch-title'));
  var railFill = document.getElementById('rail-fill');
  var pctEl = document.getElementById('pct');
  var hint = document.getElementById('hint');
  var tourBtn = document.getElementById('tour-btn');

  var FP = [0.15, 0.50, 0.86];          // reduced-motion 三个相机位取景（同一长图的 crop）
  var CH_TOPS = [0, 1 / 3, 2 / 3];      // 章起点 = 图高 0/33%/66% 的相机位

  /* P1 反馈层（缺文件时静默降级，站点照常运行） */
  var FX = window.NEONFX || null;
  var SND = window.NEONSND || null;

  var rmMQ = window.matchMedia('(prefers-reduced-motion: reduce)');
  var rm = rmMQ.matches;

  var targetP = 0, curP = 0, maxScroll = 1;
  var timeLast = 0, rafId = 0;
  var tour = { on: false, paused: false, phase: 'fwd', acc: 0, from: 0 };
  var rmS = { idx: -1, prev: -1, fade: 1, dirty: false, drawn: false };
  var lastPct = -1, lastIdx = -1;
  var lastSpeedP = 0, speedSm = 0, lastMute = null;   // P1：速度平滑 / 静音状态指示

  /* ---------- 度量 / 进度 ---------- */
  function measure() {
    maxScroll = Math.max(1, (document.documentElement.scrollHeight - window.innerHeight) || 1);
  }
  function readTarget() {
    var sy = window.scrollY || document.documentElement.scrollTop || 0;
    targetP = clamp(sy / maxScroll, 0, 1);
  }
  /* 章节只是 UI 标记：ch1/ch2/ch3 = 图高的 0–33% / 33–66% / 66–100% 相机位区间
     （CONTINUITY-SPEC §6）；画面本身始终是同一长图的连续相机，不随章节切换 */
  function chapterOf(p) { return p < 1 / 3 ? 0 : p < 2 / 3 ? 1 : 2; }

  function dismissHint() { if (hint) hint.classList.add('hide'); }

  /* ============================================================
   * P1 反馈层：速度平滑 + 章界穿越 + HUD/声音/待机 每帧驱动
   * ============================================================ */
  var transitAt = FX && FX.core ? FX.core.makeTransitDetector([1 / 3, 2 / 3], 0.015) : null;
  if (FX && FX.init) {
    FX.init({
      rm: function () { return rm; },
      onSting: function (id) { if (SND && !rm) SND.sting(id); },   // RM：无 sting
      onFlick: function () { if (SND) SND.flick(); },
      onArrive: function () { if (SND) SND.arrive(); }
    });
  }

  function fxFrame(dt, p, isRM) {
    /* 速度：|进度/秒| 的指数平滑（跳章毛刺限幅），RM 静态模式恒 0 */
    var dP = Math.abs(p - lastSpeedP);
    lastSpeedP = p;
    var inst = isRM ? 0 : (dt > 0 ? dP / (dt / 1000) : 0);
    if (inst > 2.2) inst = 2.2;
    speedSm += (inst - speedSm) * (1 - Math.exp(-(dt / 1000) * 3.5));
    if (speedSm < 0.0005) speedSm = 0;
    var v = clamp(speedSm / 0.55, 0, 1);
    if (NEON.setSpeed) NEON.setSpeed(isRM ? 0 : v);
    if (SND) SND.update(p, isRM ? 0 : v, dt);
    /* 章界穿越：探测器去重（±1.5% 滞回），一次跨越只触发一次 */
    if (transitAt) {
      var hits = transitAt(p);
      for (var i = 0; i < hits.length; i++) {
        if (FX) FX.transit(hits[i]);               // RM 内部自动简化为 HUD 淡切
      }
    }
    if (FX) FX.update(dt, p, isRM ? 0 : speedSm, { rm: isRM, tour: tour.on });
    /* 静音状态指示（M 键 / 按钮共享） */
    if (SND) {
      var mu = SND.isMuted();
      if (mu !== lastMute) {
        lastMute = mu;
        syncMuteBtn();
      }
    }
  }

  var muteBtn = document.getElementById('mute-btn');
  var muteTxt = document.getElementById('mute-txt');
  function syncMuteBtn() {
    if (!muteBtn) return;
    var running = !!(SND && SND.hasContext());
    var mutedNow = lastMute === true;
    muteBtn.setAttribute('aria-pressed', running && !mutedNow ? 'true' : 'false');
    if (muteTxt) muteTxt.textContent = mutedNow ? '静音' : '音效';
    muteBtn.classList.toggle('muted', mutedNow);
  }

  /* 首次用户手势初始化 AudioContext（幂等；scroll 不算手势，不触发） */
  function soundKick() { if (SND) SND.ensure(); }
  function poke() { if (FX) FX.onActivity(); }

  /* ---------- UI 同步 ---------- */
  function syncUI(p) {
    var pct = Math.round(p * 100);
    if (pct !== lastPct) {
      lastPct = pct;
      if (pctEl) pctEl.textContent = pct + '%';
      if (railFill) railFill.style.height = pct + '%';
    }
    var idx = chapterOf(p);
    if (idx !== lastIdx) {
      lastIdx = idx;
      for (var i = 0; i < navBtns.length; i++) navBtns[i].classList.toggle('active', i === idx);
      for (var j = 0; j < titles.length; j++) titles[j].classList.toggle('active', j === idx);
    }
    if (p > 0.02) dismissHint();
  }

  /* ---------- 自动漫游（约 45s 走完全程，任何滚轮/触摸/方向键立即中断） ---------- */
  function setTourBtn() {
    if (rm) {
      tourBtn.disabled = true;
      tourBtn.classList.add('disabled');
      tourBtn.textContent = '自动漫游 · 静态模式';
      return;
    }
    tourBtn.disabled = false;
    tourBtn.classList.remove('disabled');
    tourBtn.textContent = !tour.on ? '▶ 自动漫游' : (tour.paused ? '▶ 继续漫游' : '⏸ 暂停漫游');
  }
  function startTour() {
    if (rm) return;
    tour.on = true;
    tour.paused = false;
    tour.acc = 0;
    if (targetP > 0.005) { tour.phase = 'rewind'; tour.from = targetP; }
    else { tour.phase = 'fwd'; }
    setTourBtn();
    dismissHint();
    if (SND) SND.blip(true);                 // P1：漫游启动确认音
  }
  function stopTour() { tour.on = false; setTourBtn(); if (SND) SND.blip(false); }
  function toggleTour() {
    if (rm) return;
    if (!tour.on) startTour();
    else { tour.paused = !tour.paused; setTourBtn(); }
  }
  function interruptTour() { if (tour.on) stopTour(); }
  function tourTick(dt) {
    if (!tour.on || tour.paused) return;
    tour.acc += dt;
    if (tour.phase === 'rewind') {
      var k = clamp(tour.acc / 1000, 0, 1);
      var e = k * k * (3 - 2 * k);
      window.scrollTo(0, tour.from * (1 - e) * maxScroll);
      if (k >= 1) { tour.phase = 'fwd'; tour.acc = 0; }
    } else {
      var k2 = clamp(tour.acc / 45000, 0, 1);
      window.scrollTo(0, k2 * maxScroll);
      if (k2 >= 1) stopTour();
    }
  }

  /* ---------- reduced-motion：同一长图三个相机位的取景 crop + 章节淡入淡出 ---------- */
  function rmFrame(dt) {
    var idx = chapterOf(targetP);
    if (idx !== rmS.idx) {
      rmS.prev = rmS.idx;
      rmS.idx = idx;
      rmS.fade = 0;
      rmS.dirty = true;
    }
    if (rmS.dirty || !rmS.drawn) {
      rmS.fade = clamp(rmS.fade + dt / 380, 0, 1);
      var a = rmS.fade;
      var cross = rmS.prev >= 0 && a < 1;
      if (cross) NEON.render(FP[rmS.prev], 1 - a, true);      // 旧相机位（不清屏）
      NEON.render(FP[idx], a, true, cross);                   // 新相机位叠加 → 真交叉溶解
      if (a >= 1) { rmS.dirty = false; rmS.drawn = true; }
    }
    syncUI(targetP);
  }

  /* ---------- 主循环（rAF 单循环） ---------- */
  function loop(now) {
    rafId = window.requestAnimationFrame(loop);
    var dt = now - timeLast;
    timeLast = now;
    if (!(dt > 0) || dt > 80) dt = 16.7;
    readTarget();
    tourTick(dt);
    if (!rm) {
      /* 轻微阻尼缓动：当前进度向目标插值，上滚回退、停滚即停 */
      var k = 1 - Math.exp(-(dt / 1000) * 4.5);
      curP += (targetP - curP) * k;
      if (Math.abs(targetP - curP) < 0.0004) curP = targetP;
      NEON.tick(dt / 1000, curP);
      NEON.render(curP, 1, false);
      syncUI(curP);
      fxFrame(dt, curP, false);
    } else {
      rmFrame(dt);
      fxFrame(dt, targetP, true);
    }
  }

  /* ---------- resize 防抖重建 ---------- */
  var resizeTimer = 0;
  function onResize() {
    var w = stage.clientWidth || window.innerWidth;
    var h = stage.clientHeight || window.innerHeight;
    NEON.resize(w, h, rm);
    measure();
    if (rm) { rmS.dirty = true; rmS.fade = 1; rmS.drawn = false; }
  }
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(onResize, 180);
  });

  /* ---------- 页面不可见暂停 rAF 与声音 ---------- */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (rafId) { window.cancelAnimationFrame(rafId); rafId = 0; }
      if (SND) SND.suspend();
    } else if (!rafId) {
      timeLast = performance.now();
      rafId = window.requestAnimationFrame(loop);
      if (SND) SND.resume();
    }
  });

  /* ---------- 事件（P1：全部输入驱动 待机提示重置 + 手势初始化声音） ---------- */
  window.addEventListener('scroll', function () {
    if ((window.scrollY || 0) > 30) dismissHint();
    poke();
  }, { passive: true });
  window.addEventListener('wheel', function () { interruptTour(); dismissHint(); soundKick(); poke(); }, { passive: true });
  window.addEventListener('touchstart', function () { interruptTour(); dismissHint(); soundKick(); poke(); }, { passive: true });
  window.addEventListener('pointerdown', function () { soundKick(); poke(); }, { passive: true });

  navBtns.forEach(function (b, i) {
    b.addEventListener('click', function () {
      interruptTour();
      dismissHint();
      soundKick();
      if (SND) SND.tick();                    // P1：导航跳章 tick 音
      poke();
      b.blur();
      window.scrollTo({ top: CH_TOPS[i] * maxScroll, behavior: rm ? 'auto' : 'smooth' });
    });
  });
  tourBtn.addEventListener('click', function () { tourBtn.blur(); toggleTour(); });
  if (muteBtn) {
    muteBtn.addEventListener('click', function () {   // P1：静音钮（点击即手势）
      muteBtn.blur();
      soundKick();
      if (SND && SND.hasContext()) { lastMute = SND.toggleMute(); }
      syncMuteBtn();
    });
  }

  window.addEventListener('keydown', function (e) {
    var t = e.target, tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    soundKick();
    poke();
    if (e.code === 'Space' || e.key === ' ') { e.preventDefault(); toggleTour(); return; }
    switch (e.key) {
      case 'ArrowDown':
      case 'PageDown':
        e.preventDefault(); interruptTour(); dismissHint();
        window.scrollBy({ top: window.innerHeight * (e.key === 'PageDown' ? 0.95 : 0.33), behavior: rm ? 'auto' : 'smooth' });
        break;
      case 'ArrowUp':
      case 'PageUp':
        e.preventDefault(); interruptTour(); dismissHint();
        window.scrollBy({ top: -window.innerHeight * (e.key === 'PageUp' ? 0.95 : 0.33), behavior: rm ? 'auto' : 'smooth' });
        break;
      case 'Home':
        e.preventDefault(); interruptTour();
        window.scrollTo({ top: 0, behavior: rm ? 'auto' : 'smooth' });
        break;
      case 'End':
        e.preventDefault(); interruptTour();
        window.scrollTo({ top: maxScroll, behavior: rm ? 'auto' : 'smooth' });
        break;
      case 'm':
      case 'M':                               /* P1：全局静音切换（有状态指示） */
        soundKick();
        if (SND && SND.hasContext()) { lastMute = SND.toggleMute(); }
        syncMuteBtn();
        break;
      case 'Escape':
      case 'h':
      case 'H':
        document.body.classList.toggle('ui-hidden');
        break;
    }
  });

  /* ---------- 模式切换 ---------- */
  function applyRM() {
    setTourBtn();
    if (rm) {
      stopTour();
      rmS.idx = -1; rmS.prev = -1; rmS.fade = 1; rmS.dirty = false; rmS.drawn = false;
    } else {
      curP = targetP;
    }
    onResize();
  }
  if (rmMQ.addEventListener) rmMQ.addEventListener('change', function (e) { rm = e.matches; applyRM(); });
  else if (rmMQ.addListener) rmMQ.addListener(function (e) { rm = e.matches; applyRM(); });

  /* ---------- 启动 ---------- */
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  window.scrollTo(0, 0);
  NEON.init(canvas, stage.clientWidth || window.innerWidth, stage.clientHeight || window.innerHeight, rm);
  measure();
  setTourBtn();
  syncMuteBtn();                              /* P1：静音钮初始状态 */
  window.addEventListener('load', measure);
  timeLast = performance.now();
  rafId = window.requestAnimationFrame(loop);
})();
