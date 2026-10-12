/* ============================================================
 * NEON DRIFT / 雨夜漫游 — app.js（v3 · 视频优先架构）
 * 滚动进度 → 视频时间轴（neon-video.js：三段 scrub 覆盖 0–100%）。
 * 本文件只做交互外壳，rAF 单循环 = 阻尼进度 + 视频模块喂参 +
 * UI/DOM 更新 + feedback/audio 喂参 + 舞台微颤（transform 到 #stage）。
 * 无 canvas、无程序渲染（隔离原则：视频 = 画面唯一来源，失败兜底 =
 * 海报关键帧；程序引擎存档于 ../neon-procedural/）。
 * feedback.js / audio.js 不改动：与画面解耦，穿越门控 33%/66%
 * 与视频接缝对齐。
 * ============================================================ */
(function () {
  'use strict';
  if (typeof window !== 'undefined' && !window.__rec) {
    window.__rec = function (ev, d) {
      try {
        var a = JSON.parse(sessionStorage.getItem('tourLog') || '[]');
        a.push(Object.assign({ t: Math.round(performance.now()), ev: ev }, d || {}));
        if (a.length > 500) a.splice(0, a.length - 500);
        sessionStorage.setItem('tourLog', JSON.stringify(a));
      } catch (e) {}
    };
  }

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function ss(a, b, x) {
    if (b === a) return x >= a ? 1 : 0;
    x = clamp((x - a) / (b - a), 0, 1);
    return x * x * (3 - 2 * x);
  }

  var stage = document.getElementById('stage');
  var posterEl = document.getElementById('poster');
  var fadeEl = document.getElementById('fade');
  var POSTERS = ['assets/keys/k1.png', 'assets/keys/k2.png', 'assets/keys/k4.png'];

  var navBtns = Array.prototype.slice.call(document.querySelectorAll('.nav-btn'));
  var titles = Array.prototype.slice.call(document.querySelectorAll('.ch-title'));
  var railFill = document.getElementById('rail-fill');
  var railTrack = document.querySelector('#rail .track');
  var pctEl = document.getElementById('pct');
  var hint = document.getElementById('hint');
  var tourBtn = document.getElementById('tour-btn');

  var NAV_LAND = [0.02, 0.36, 0.70];       // 导航落点：各章越过接缝后的稳定位
  var TITLE_WIN = [
    [0, 0, 0.16, 0.30],                    // ch1 hero：0% 即完整可见，16–30% 淡出
    [0.36, 0.44, 0.60, 0.66],              // ch2：0.36 落点后进入，第二接缝前退场
    [0.72, 0.80, 3, 3]                     // ch3：0.70 落点后进入，驻留到终点
  ];
  var TOUR_FULL_SEC = 45;                   // 匀速兜底节奏（视频可用时由视频时长接管）

  /* P1 反馈层 + 视频画面层（均自守卫，缺文件时外壳照常运行） */
  var FX = window.NEONFX || null;
  var SND = window.NEONSND || null;
  var Vid = window.NEONVID || null;

  var rmMQ = window.matchMedia('(prefers-reduced-motion: reduce)');
  var rm = rmMQ.matches;

  var targetP = 0, curP = 0, maxScroll = 1;
  var timeLast = 0, rafId = 0, clock = 0;
  var tour = { on: false, paused: false, phase: 'fwd', acc: 0, from: 0, startT: 0, elapsed: 0, dur: 0, videoPaced: false };
  var rmS = { idx: -1 };
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
  /* 章节只是 UI 标记：ch1/ch2/ch3 = 0–33% / 33–66% / 66–100%（与视频段界对齐） */
  function chapterOf(p) { return p < 1 / 3 ? 0 : p < 2 / 3 ? 1 : 2; }

  function dismissHint() { if (hint) hint.classList.add('hide'); }

  /* ============================================================
   * P1 反馈层：速度平滑 + 章界穿越 + HUD/声音/待机 每帧驱动（不改动）
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
  function applyMute() {
    if (SND && SND.hasContext()) { lastMute = SND.toggleMute(); }
    if (Vid) Vid.setMuted(!!(SND && SND.isMuted()));   // 漫游视频原声跟随全局静音
    syncMuteBtn();
  }

  /* 首次用户手势初始化 AudioContext（幂等；scroll 不算手势，不触发） */
  function soundKick() { if (SND) SND.ensure(); }
  function poke() { if (FX) FX.onActivity(); }

  /* ---------- UI 同步 ---------- */
  var titleO = [null, null, null], titleTy = [null, null, null];
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
      if (rm) for (var j = 0; j < titles.length; j++) titles[j].classList.toggle('active', j === idx);
    }
    if (!rm) {
      /* 标题淡入淡出窗口（hero 0% 即现 → 16–30% 淡出；ch2/ch3 对齐导航落点） */
      for (var k = 0; k < 3; k++) {
        var el = titles[k];
        if (!el) continue;
        var w = TITLE_WIN[k];
        var fin = ss(w[0], w[1], p), fout = ss(w[2], w[3], p);
        var o = Math.round(fin * (1 - fout) * 1000) / 1000;
        var ty = Math.round(((1 - fin) * 26 - fout * 26) * 10) / 10;
        if (titleO[k] !== o) { titleO[k] = o; el.style.opacity = o; }
        if (titleTy[k] !== ty) { titleTy[k] = ty; el.style.transform = ty ? 'translateY(' + ty + 'px)' : ''; }
      }
    }
    if (p > 0.02) dismissHint();
  }

  /* ---------- 自动漫游（视频三段连播接管节奏；任何滚轮/触摸/方向键立即中断；
     视频不可用（未就绪/失败）时回落 45s 匀速） ---------- */
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
    if (window.__rec) window.__rec('startTour', { p: +(curP || 0).toFixed(3) });
    if (rm) return;
    tour.on = true;
    tour.paused = false;
    tour.acc = 0;
    tour.elapsed = 0;
    tour.videoPaced = false;
    if (targetP > 0.005) { tour.phase = 'rewind'; tour.from = targetP; }
    else { tour.phase = 'fwd'; tour.startT = 0; tour.dur = TOUR_FULL_SEC * 1000; }
    setTourBtn();
    dismissHint();
    if (SND) SND.blip(true);                 // P1：漫游启动确认音
  }
  function stopTour() {
    if (window.__rec) window.__rec('stopTour', { p: +(curP || 0).toFixed(3) });
    tour.on = false;
    tour.paused = false;
    tour.videoPaced = false;
    setTourBtn();
    if (SND) SND.blip(false);
    if (Vid) Vid.onTourEnd();                // 立即回 scrub + muted + seek 当前进度
  }
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
      var k = clamp(tour.acc / 1000, 0, 1);       // 1s 回卷到起点（视频保持 scrub 态）
      var e = k * k * (3 - 2 * k);
      window.scrollTo(0, tour.from * (1 - e) * maxScroll);
      if (k >= 1) { tour.phase = 'fwd'; tour.acc = 0; tour.elapsed = 0; tour.startT = 0; tour.dur = TOUR_FULL_SEC * 1000; }
      return;
    }
    /* fwd：视频三段 unmuted 连播接管漫游节奏（视频时长即漫游时长） */
    var vp = Vid ? Vid.tourSync(curP) : null;
    if (vp !== null) {
      tour.videoPaced = true;
      /* 视频时钟直通：vp 直接作为当前进度（视频是漫游的权威时钟），
       * 不再经 scrollTo→scrollY/maxScroll 换算回读——那会在接缝处
       * 产生 0.65999… 的浮点地狱，段界判定永远跨不过去（卡 66% 事故） */
      curP = vp;
      window.scrollTo(0, Math.round(vp * maxScroll));
      if (vp >= 0.9995) stopTour();
      return;
    }
    if (tour.videoPaced) {                    // 视频段结束/不可用 → 从当前进度重定匀速节奏
      if (window.__rec) window.__rec('tour-fallback', { p: +curP.toFixed(4) });
      tour.videoPaced = false;
      tour.startT = clamp(curP, 0, 0.999);
      tour.elapsed = 0;
      tour.dur = Math.max(6, (1 - tour.startT) * TOUR_FULL_SEC) * 1000;
    }
    tour.elapsed += dt;
    var k2 = clamp(tour.elapsed / tour.dur, 0, 1);
    window.scrollTo(0, (tour.startT + (1 - tour.startT) * k2) * maxScroll);
    if (k2 >= 1) stopTour();
  }

  /* ---------- reduced-motion：静态模式 = 海报三关键帧（k1/k2/k4）+ 章节淡切 ---------- */
  function rmFrame() {
    var idx = chapterOf(targetP);
    if (idx !== rmS.idx) {
      var first = rmS.idx < 0;
      rmS.idx = idx;
      if (first) {
        if (posterEl) posterEl.src = POSTERS[idx];
      } else {
        fadeEl.classList.add('on');
        setTimeout(function () {
          if (posterEl) posterEl.src = POSTERS[idx];
          setTimeout(function () { fadeEl.classList.remove('on'); }, 60);
        }, 340);
      }
    }
    syncUI(targetP);
  }

  /* ---------- 主循环（rAF 单循环：无引擎渲染） ---------- */
  function loop(now) {
    rafId = window.requestAnimationFrame(loop);
    var dt = now - timeLast;
    timeLast = now;
    if (!(dt > 0) || dt > 80) dt = 16.7;
    readTarget();
    tourTick(dt);
    /* 惯性滑行：带视频自动前进/后退，衰减停止后关键帧磁吸 */
    if (Math.abs(iner.v) > 0.0002 && !tour.on && !rm) {
      iner.v *= Math.exp(-(dt / 1000) * 2.4);
      var np = clamp(targetP + iner.v * (dt / 1000), 0, 1);
      if (np <= 0 || np >= 1) iner.v = 0;
      window.scrollTo(0, np * maxScroll);
      if (Math.abs(iner.v) < 0.02) {
        iner.v = 0;
        var bestR = 0, bdR = 1;
        for (var ri = 0; ri < REST.length; ri++) {
          var dd = Math.abs(targetP - REST[ri]);
          if (dd < bdR) { bdR = dd; bestR = REST[ri]; }
        }
        if (bdR > 0.0004 && bdR < 0.05) {
          window.scrollTo({ top: bestR * maxScroll, behavior: 'smooth' });
        }
      }
    }
    if (!rm) {
      /* 轻微阻尼缓动：当前进度向目标插值，上滚回退、停滚即停 */
      var k = 1 - Math.exp(-(dt / 1000) * 4.5);
      curP += (targetP - curP) * k;
      if (Math.abs(targetP - curP) < 0.0004) curP = targetP;
      /* 视频画面层：喂阻尼进度 → 模块 scrub/seek 视频元素 */
      if (Vid) Vid.update({
        p: curP,
        touring: tour.on && !tour.paused,
        tourPaused: tour.on && tour.paused
      });
      syncUI(curP);
      fxFrame(dt, curP, false);
      /* 舞台微颤：幅度随滚动速度（纯显示层平移，作用于 #stage 整体；
         由平滑速度驱动 —— 停滚即停；与穿越 shake/neon-pulse 动画天然共存） */
      var v = clamp(speedSm / 0.55, 0, 1);
      if (v > 0.04) {
        clock += (dt / 1000) * v;
        stage.style.transform = 'translate(' +
          (Math.sin(clock * 37.7) * 0.9 * v).toFixed(2) + 'px,' +
          (Math.cos(clock * 29.3) * 0.7 * v).toFixed(2) + 'px)';
      } else if (stage.style.transform) {
        stage.style.transform = '';
      }
    } else {
      rmFrame();
      fxFrame(dt, targetP, true);
    }
  }

  /* ---------- resize 防抖 ---------- */
  var resizeTimer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(measure, 180);
  });

  /* ---------- 页面不可见暂停 rAF 与声音（视频模块自管暂停/恢复） ---------- */
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
  /* ---------- 惯性播放层：一次输入 → 自动滑行一段（衰减 + 关键帧磁吸） ---------- */
  var REST = [0, 1 / 3, 2 / 3, 1];                  /* 磁吸停靠点：章界关键帧 */
  var iner = { v: 0 };                              /* 时间轴速度（进度/秒） */
  window.addEventListener('wheel', function (e) {
    if (rm) return;
    e.preventDefault();                             /* 滚动由惯性层接管（滚动条拖动不受影响） */
    interruptTour(); dismissHint(); soundKick(); poke();
    var d = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 100 : 1);
    iner.v = clamp(iner.v + d * 0.00058, -0.24, 0.24);
  }, { passive: false });
  var tT = 0, tY = 0, tV = 0;
  window.addEventListener('touchstart', function (e0) {
    interruptTour(); dismissHint(); soundKick(); poke();
    iner.v = 0;
    tT = performance.now(); tY = e0.touches[0].clientY; tV = 0;
  }, { passive: true });
  window.addEventListener('touchmove', function (e0) {
    var t = performance.now(), y = e0.touches[0].clientY;
    if (t > tT) tV = (tY - y) / (t - tT);
    tT = t; tY = y;
  }, { passive: true });
  window.addEventListener('touchend', function () {
    if (tV > 0.12) iner.v = clamp(iner.v + tV * 0.0012, -0.32, 0.32);
  }, { passive: true });
  window.addEventListener('pointerdown', function () { soundKick(); poke(); }, { passive: true });

  navBtns.forEach(function (b, i) {
    b.addEventListener('click', function () {
      interruptTour();
      dismissHint();
      soundKick();
      if (SND) SND.tick();                    // P1：导航跳章 tick 音
      poke();
      b.blur();
      window.scrollTo({ top: NAV_LAND[i] * maxScroll, behavior: rm ? 'auto' : 'smooth' });
    });
  });
  tourBtn.addEventListener('click', function () { tourBtn.blur(); toggleTour(); });
  if (muteBtn) {
    muteBtn.addEventListener('click', function () {   // P1：静音钮（点击即手势）
      muteBtn.blur();
      soundKick();
      applyMute();
    });
  }
  if (railTrack) {
    railTrack.addEventListener('click', function (e) {   /* 点击进度条跳转 */
      var r = railTrack.getBoundingClientRect();
      var p = clamp((e.clientY - r.top) / r.height, 0, 1);
      interruptTour();
      dismissHint();
      soundKick();
      if (SND) SND.tick();
      poke();
      window.scrollTo({ top: p * maxScroll, behavior: rm ? 'auto' : 'smooth' });
    });
  }

  window.addEventListener('keydown', function (e) {
    var t = e.target, tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    soundKick();
    poke();
    if (e.code === 'Space' || e.key === ' ') {
      if (tag === 'BUTTON') return;             // 交给按钮自身
      e.preventDefault();
      toggleTour();
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
      case 'PageDown':
        e.preventDefault(); interruptTour(); dismissHint();
        iner.v = clamp(iner.v + (e.key === 'PageDown' ? 0.2 : 0.055), -0.3, 0.3);
        break;
      case 'ArrowUp':
      case 'PageUp':
        e.preventDefault(); interruptTour(); dismissHint();
        iner.v = clamp(iner.v - (e.key === 'PageUp' ? 0.2 : 0.055), -0.3, 0.3);
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
        applyMute();
        break;
      case 'Escape':
      case 'h':
      case 'H':
        document.body.classList.toggle('ui-hidden');
        break;
    }
  });

  /* ---------- 模式切换（reduced-motion：重载进静态模式，保证模块干净禁用） ---------- */
  if (rmMQ.addEventListener) rmMQ.addEventListener('change', function () { window.location.reload(); });
  else if (rmMQ.addListener) rmMQ.addListener(function () { window.location.reload(); });

  /* ---------- 启动 ---------- */
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  window.scrollTo(0, 0);
  measure();
  if (rm) document.body.classList.add('reduced');
  if (Vid) Vid.init({ reduced: rm });        /* reduced：模块禁用，静态模式用海报 */
  setTourBtn();
  syncMuteBtn();                              /* P1：静音钮初始状态 */
  window.addEventListener('load', measure);
  timeLast = performance.now();
  rafId = window.requestAnimationFrame(loop);

  /* 心跳看门狗：任何原因（后台加载丢 visibility 事件等）导致循环停摆，
   * 页面可见时 1.5s 内自动复活——主循环永不永久死亡 */
  setInterval(function () {
    if (!rm && !rafId && !document.hidden) {
      timeLast = performance.now();
      rafId = window.requestAnimationFrame(loop);
    }
  }, 1500);
})();
