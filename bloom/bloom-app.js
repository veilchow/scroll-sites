/* ============================================================
   BLOOM · 菌丝秘境 — v2 引擎与交互外壳
   ------------------------------------------------------------
   场景渲染已封装为统一后端接口（见 bloom-scenes.js）：
   本文件只负责 v1 保留的交互外壳 —— 滚动映射（滚动条即播放器，
   带阻尼）、导航跳章（= 跳到对应相机位）、45s 自动漫游 + 任何
   用户操作即中断、空格播放/暂停、H/Esc 口播模式、方向键、
   prefers-reduced-motion 静态模式（同一长图三个相机位的取景
   crop，章节间淡入淡出）、移动端触摸、DPR/resize 适配、
   visibilitychange 暂停、粒子按屏幕面积缩放（经 env 交给后端）。

   v2 场景模型：滚动进度 p 连续驱动相机（translateY+scale），
   主图 forest-well.png 一镜到底；章节只是 UI 标记：
   0–33% 地表 / 33–66% 伞下 / 66–100% 深处。

   P1 反馈层钩子（可选依赖 bloom-feedback.js，缺席时零影响）：
   frame→BLOOM_FEEDBACK.tick（HUD 计量/穿越/速度/待机）、
   setChapter→onChapter（HUD 组件切换 + 音床交叉淡化）、
   render 携带 speed（引擎侧孢子/萤火拉丝）、
   tourStep→notifyActivity（漫游视为持续输入）。
   ============================================================ */
(function () {
  'use strict';

  var doc = document;
  var canvas = doc.getElementById('view');
  if (!canvas || !window.BLOOM) return;
  var ctx = canvas.getContext('2d');
  var stage = doc.getElementById('stage');
  var fadeC = doc.getElementById('fade');
  var fadeX = fadeC ? fadeC.getContext('2d') : null;
  var hint = doc.getElementById('hint');
  var tourBtn = doc.getElementById('tourBtn');
  var tourLabel = tourBtn ? tourBtn.querySelector('.tour-label') : null;
  var pctEl = doc.getElementById('pct');
  var railFill = doc.querySelector('.rail-fill');
  var railDot = doc.querySelector('.rail-dot');
  var chapBtns = Array.prototype.slice.call(doc.querySelectorAll('.chap'));
  var cards = Array.prototype.slice.call(doc.querySelectorAll('.title-card'));

  /* 统一场景后端：canvas 一镜到底引擎（本期）；视频 scrub 预留见 bloom-scenes.js */
  var backend = window.BLOOM.createBackend({
    image: 'assets/forest-well.png',
    segments: ['assets/segment-1.mp4', 'assets/segment-2.mp4']
  });

  var STATIC_P = [0.02, 0.5, 0.94]; /* 静态模式三个相机位：地表 / 伞下 / 母核取景 */
  var FIXED_TIME = 7.7;             /* 静态模式的定格时刻（一切动画为 time 纯函数） */
  var TOUR_MS = 45000;              /* 全程自动漫游时长 */

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }

  var W = 0, H = 0, DPR = 1;
  var running = false, rafId = 0, lastTime = 0;
  var targetP = 0, curP = 0;
  var chapterIdx = -1;
  var ready = false;
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* 始终从地表开始 */
  try { history.scrollRestoration = 'manual'; } catch (e) { /* noop */ }
  window.scrollTo(0, 0);

  function maxScroll() {
    return Math.max(1, doc.documentElement.scrollHeight - window.innerHeight);
  }
  function readScroll() {
    var sy = window.scrollY || window.pageYOffset || doc.documentElement.scrollTop || 0;
    targetP = clamp01(sy / maxScroll());
  }
  function chapterOf(p) { return p >= 2 / 3 ? 2 : p >= 1 / 3 ? 1 : 0; }

  /* ---------- 尺寸与重建 ---------- */
  function sizeCanvas() {
    var r = stage.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width || window.innerWidth));
    H = Math.max(1, Math.round(r.height || window.innerHeight));
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    var cv = [canvas, fadeC];
    for (var i = 0; i < cv.length; i++) {
      if (!cv[i]) continue;
      cv[i].width = Math.round(W * DPR);
      cv[i].height = Math.round(H * DPR);
    }
  }
  function rebuild() {
    if (backend.resize) backend.resize({ w: W, h: H, area: W * H, minDim: Math.min(W, H) });
  }

  /* ---------- 渲染：整帧交统一后端（一镜到底，无交叉淡化） ---------- */
  function render(p, time) {
    var fr = { p: p, time: time, W: W, H: H, DPR: DPR };
    if (window.BLOOM_FEEDBACK && window.BLOOM_FEEDBACK.getSpeed) {
      fr.speed = window.BLOOM_FEEDBACK.getSpeed(); /* 滚动速度 → 粒子拉伸 */
    }
    backend.render(ctx, fr);
  }

  /* ---------- UI ---------- */
  function setChapter(i) {
    if (i === chapterIdx) return;
    var prev = chapterIdx;
    chapterIdx = i;
    for (var k = 0; k < chapBtns.length; k++) chapBtns[k].classList.toggle('active', k === i);
    for (var c = 0; c < cards.length; c++) cards[c].classList.toggle('on', c === i);
    /* P1 反馈层：HUD 组件切换 + 音床交叉淡化（缺席时跳过） */
    if (window.BLOOM_FEEDBACK) window.BLOOM_FEEDBACK.onChapter(i);
    /* 滚动进入第三章（深处）：触发一次由边缘向母核的光传导波（强度随 p 连续淡入） */
    if (i === 2 && prev !== 2 && !reduced && backend.enterChapter) {
      backend.enterChapter(2, performance.now() / 1000);
    }
  }
  var lastPct = -1;
  function updateRail(p) {
    if (railFill) railFill.style.transform = 'scaleY(' + p.toFixed(4) + ')';
    if (railDot) railDot.style.top = (p * 100).toFixed(2) + '%';
    var pct = Math.round(p * 100);
    if (pct !== lastPct && pctEl) {
      lastPct = pct;
      pctEl.textContent = pct + '%';
    }
  }

  /* ---------- 主循环（单 rAF，含阻尼） ---------- */
  function frame(now) {
    rafId = requestAnimationFrame(frame);
    var time = now / 1000;
    var dt = time - lastTime;
    lastTime = time;
    if (dt > 0.1) dt = 0.1;
    if (dt < 0) dt = 0;
    if (tour.active && !tour.paused) tourStep(dt);
    curP += (targetP - curP) * (1 - Math.exp(-dt * 5.5));
    if (Math.abs(targetP - curP) < 0.0004) curP = targetP;
    setChapter(chapterOf(curP));
    updateRail(curP);
    /* P1 反馈层：HUD 计量 / 穿越时刻 / 速度 / 待机提示 */
    if (window.BLOOM_FEEDBACK) window.BLOOM_FEEDBACK.tick({ p: curP, dt: dt, chapter: chapterIdx });
    render(curP, time);
  }
  function startLoop() {
    if (running) return;
    running = true;
    lastTime = performance.now() / 1000;
    rafId = requestAnimationFrame(frame);
  }
  function stopLoop() {
    if (!running) return;
    running = false;
    cancelAnimationFrame(rafId);
  }

  /* ---------- 滚动提示 ---------- */
  var hintGone = false;
  function dismissHint() {
    if (hintGone) return;
    hintGone = true;
    if (hint) hint.classList.add('gone');
  }

  /* ---------- 自动漫游（约 45 秒走完全程，任何用户操作立即中断） ---------- */
  var tour = { active: false, paused: false, k: 0, from: 0, to: 1, durMs: 1 };
  function setTourLabel() {
    var txt;
    if (reduced) txt = chapterIdx >= 2 ? '回到地表' : '下一章';
    else if (!tour.active) txt = '自动漫游';
    else txt = tour.paused ? '继续漫游' : '暂停漫游';
    if (tourLabel) tourLabel.textContent = txt;
    if (tourBtn) tourBtn.setAttribute('aria-label', txt);
  }
  function tourStart() {
    if (reduced) { stepChapter(); return; }
    readScroll();
    if (targetP > 0.985) {
      window.scrollTo(0, 0);
      targetP = 0;
      curP = Math.min(curP, 0.02);
    }
    tour.active = true;
    tour.paused = false;
    tour.k = 0;
    tour.from = targetP;
    tour.to = 1;
    tour.durMs = Math.max(6000, TOUR_MS * (tour.to - tour.from));
    doc.body.classList.add('touring');
    setTourLabel();
    dismissHint();
  }
  function tourStop() {
    if (!tour.active && !tour.paused) { setTourLabel(); return; }
    tour.active = false;
    tour.paused = false;
    doc.body.classList.remove('touring');
    setTourLabel();
  }
  function tourTogglePause() {
    if (!tour.active) { tourStart(); return; }
    tour.paused = !tour.paused;
    setTourLabel();
  }
  function tourStep(dt) {
    if (window.BLOOM_FEEDBACK) window.BLOOM_FEEDBACK.notifyActivity(); /* 漫游中不出现待机提示 */
    tour.k += (dt * 1000) / tour.durMs;
    var k = Math.min(1, tour.k);
    var p = lerp(tour.from, tour.to, k);
    var sy = window.scrollY || 0;
    /* 用户拖动滚动条等外部滚动：立即中断交还控制 */
    if (Math.abs(sy / maxScroll() - lerp(tour.from, tour.to, Math.max(0, k - dt * 1000 / tour.durMs))) > 0.02) {
      tourStop();
      return;
    }
    window.scrollTo(0, p * maxScroll());
    targetP = p;
    if (k >= 1) tourStop();
  }

  /* ---------- 静态模式（prefers-reduced-motion）：同一长图三个相机位的取景 crop ---------- */
  function reducedRenderKeyframe() {
    var i = Math.max(0, chapterIdx);
    render(STATIC_P[i], FIXED_TIME);
  }
  function reducedApply() {
    readScroll();
    var i = chapterOf(targetP);
    updateRail(targetP);
    /* P1 反馈层：静态模式下随滚动事件驱动 HUD（淡切，无 sting/微震） */
    if (window.BLOOM_FEEDBACK) window.BLOOM_FEEDBACK.tick({ p: targetP });
    if (i === chapterIdx) return;
    /* 旧帧快照覆盖 → 新相机位取景 → CSS 淡出（取景同为连续长图，天然无跳变构图） */
    if (fadeX && chapterIdx >= 0) {
      fadeX.setTransform(1, 0, 0, 1, 0, 0);
      fadeX.clearRect(0, 0, fadeC.width, fadeC.height);
      fadeX.drawImage(canvas, 0, 0);
      fadeC.style.transition = 'none';
      fadeC.style.opacity = '1';
      void fadeC.offsetWidth;
      fadeC.style.transition = 'opacity 0.55s ease';
      fadeC.style.opacity = '0';
    }
    chapterIdx = -1;
    setChapter(i);
    reducedRenderKeyframe();
  }
  function stepChapter() {
    var next = chapterIdx >= 2 ? 0 : chapterIdx + 1;
    window.scrollTo(0, (next / 3 + 0.001) * maxScroll());
    reducedApply();
    setTourLabel();
  }

  /* ---------- 事件（v1 全量保留） ---------- */
  window.addEventListener('scroll', function () {
    readScroll();
    dismissHint();
    if (reduced) reducedApply();
  }, { passive: true });

  function onUserScroll() {
    if (tour.active) tourStop();
    dismissHint();
  }
  window.addEventListener('wheel', onUserScroll, { passive: true });
  window.addEventListener('touchstart', onUserScroll, { passive: true });

  window.addEventListener('keydown', function (e) {
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      dismissHint();
      if (reduced) stepChapter(); else tourTogglePause();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (tour.active) tourStop();
      dismissHint();
      var d = (e.key === 'ArrowDown' ? 1 : -1) * Math.max(240, H * 0.4);
      window.scrollBy({ top: d, behavior: reduced ? 'auto' : 'smooth' });
      return;
    }
    if (e.key === 'Escape' || e.key === 'h' || e.key === 'H') {
      doc.body.classList.toggle('ui-hidden');
      return;
    }
    if (e.key === 'PageDown' || e.key === 'PageUp' || e.key === 'Home' || e.key === 'End') {
      if (tour.active) tourStop();
      dismissHint();
    }
  });

  chapBtns.forEach(function (b) {
    b.addEventListener('click', function () {
      if (tour.active) tourStop();
      var i = parseInt(b.getAttribute('data-goto'), 10) || 0;
      window.scrollTo({ top: (i / 3 + 0.001) * maxScroll(), behavior: reduced ? 'auto' : 'smooth' });
    });
  });

  if (tourBtn) {
    tourBtn.addEventListener('click', function () {
      dismissHint();
      if (reduced) stepChapter(); else tourTogglePause();
    });
  }

  /* 页面不可见时暂停 rAF */
  doc.addEventListener('visibilitychange', function () {
    if (doc.hidden) stopLoop();
    else if (!reduced && ready && !running) startLoop();
  });

  /* resize 防抖重建 */
  var rsTimer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(rsTimer);
    rsTimer = setTimeout(function () {
      sizeCanvas();
      rebuild();
      if (reduced && ready) reducedRenderKeyframe();
    }, 160);
  });

  /* prefers-reduced-motion 模式切换 */
  function applyMode() {
    var r = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (r === reduced) return;
    reduced = r;
    doc.body.classList.toggle('reduced', reduced);
    if (fadeC) { fadeC.style.transition = 'none'; fadeC.style.opacity = '0'; }
    rebuild();
    tourStop();
    if (reduced) {
      stopLoop();
      chapterIdx = -1;
      reducedApply();
    } else {
      readScroll();
      setChapter(chapterOf(targetP));
      if (ready) startLoop();
    }
    setTourLabel();
  }
  try {
    var mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (mql.addEventListener) mql.addEventListener('change', applyMode);
    else if (mql.addListener) mql.addListener(applyMode);
  } catch (err) { /* noop */ }

  /* ---------- 启动：素材就绪后开始（loading 态 → 首帧渲染后再揭幕） ---------- */
  doc.body.classList.toggle('reduced', reduced);
  doc.body.classList.add('loading');
  sizeCanvas();
  readScroll();
  Promise.resolve(backend.ready).then(function () {
    ready = true;
    rebuild();
    if (reduced) {
      reducedApply();
    } else {
      render(curP, performance.now() / 1000); /* 先画首帧，再揭幕，避免空帧闪烁 */
      setChapter(chapterOf(targetP));
      updateRail(targetP);
      startLoop();
    }
    doc.body.classList.remove('loading');
    setTourLabel();
  });
})();
