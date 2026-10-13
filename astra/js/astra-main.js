/* ==========================================================================
 * ASTRA · 深空信标计划 —— 交互外壳（滚动时间轴 / rAF 主循环 / UI / 漫游 / 静态模式）
 * js/astra-main.js
 *
 * 核心模型（对齐原帖管线）：页面滚动进度(0–100%) -> 视频时间轴。
 *   画面 = 两段 AI 视频（js/astra-video.js scrub 0–100%）+ 海报兜底；
 *   本文件只负责交互外壳：阻尼进度、章节/HUD/声音反馈、漫游、导航。
 *   停止滚动 -> 视频暂停在当前帧（滚动条即播放器）。
 *   章节 = UI 标记：ch1 = 0–55%，ch2 = 55–75%，ch3 = 75–100%。
 * ========================================================================== */
(function () {
  'use strict';

  var win = window, doc = document;
  var stage = doc.getElementById('stage');
  if (!stage) return;
  var posterEl = doc.getElementById('poster');
  var POSTERS = ['assets/approach.png', 'assets/port.png', 'assets/core.png'];

  var track = doc.getElementById('scroll-track');
  var navBtns = Array.prototype.slice.call(doc.querySelectorAll('#chapter-nav .nav-btn'));
  var titles = Array.prototype.slice.call(doc.querySelectorAll('#titles .title'));
  var fillEl = doc.getElementById('progress-fill');
  var headEl = doc.getElementById('progress-head');
  var pctEl = doc.getElementById('progress-pct');
  var trackEl = doc.getElementById('progress-track');
  var hintEl = doc.getElementById('hint');
  var tourBtn = doc.getElementById('tour-btn');
  var tourIco = doc.getElementById('tour-ico');
  var tourLabel = doc.getElementById('tour-label');
  var fadeEl = doc.getElementById('fade');
  var dots = Array.prototype.slice.call(doc.querySelectorAll('#reduced-dots .dot'));
  var prevBtn = doc.getElementById('prev-ch');
  var nextBtn = doc.getElementById('next-ch');

  /* P1 反馈层（INTERACTION-DESIGN §2）：WebAudio 声音系统 + 计量 HUD。
   * 两个模块均自守卫（缺文件/禁 JS 特性时外壳照常运行）。 */
  var Aud = win.AstraAudio || null;
  var Hud = win.AstraHUD || null;
  /* P2 视频画面层（视频 scrub 优先 / 引擎兜底）：同样自守卫。 */
  var Vid = win.AstraVideo || null;
  var muteBtn = doc.getElementById('mute-btn');
  var muteIco = doc.getElementById('mute-ico');
  var muteTxt = doc.getElementById('mute-txt');

  /* v2 相机时间轴（CONTINUITY-SPEC §6）：ch1 = 0–55%（approach dolly），
   * ch2 = 55–75%（port 推进，~75% 光晕过渡），ch3 = 75–100%（舱内漂移） */
  var CH1_END = 0.55, CH2_END = 0.75;
  var NAV_LAND = [0.02, 0.645, 0.835];               /* 导航落点：越过两个光晕过渡后的稳定相机位 */
  var SCROLL_SCREENS = 7;                              /* 总滚动高度约 7 屏 */
  var TOUR_FULL_SEC = 45;                              /* 全程漫游 45 秒 */
  var REDUCED_KEYS = [0.0, 0.64, 0.86];                /* 静态模式三个相机位定格：approach/port/core 原图 */

  var st = {
    W: 0, H: 0, DPR: 1, minWH: 0, maxWH: 0, cx: 0, cy: 0,
    scrollable: 1,
    target: 0, current: 0, lastDrawnT: -1,
    speed: 0, clock: 0, lastTs: 0, raf: 0, running: false,
    tour: { on: false, paused: false, startT: 0, elapsed: 0, dur: 0, videoPaced: false },
    glide: { on: false, from: 0, to: 0, t0: 0, dur: 0, cb: null },
    lastCh: -1, lastPct: -1,
    reduced: win.matchMedia('(prefers-reduced-motion: reduce)').matches,
    reducedIdx: 0,
    world: null
  };

  function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
  function lerp(a, b, p) { return a + (b - a) * p; }
  function ss(a, b, x) {
    if (b === a) return x >= a ? 1 : 0;
    x = clamp((x - a) / (b - a), 0, 1);
    return x * x * (3 - 2 * x);
  }
  function easeCubic(p) { return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; }
  function tourEase(p) { return p - 0.08 * Math.sin(p * Math.PI * 2); }

  /* ================= 尺寸 ================= */
  function measure(keepProgress) {
    var oldScrollable = st.scrollable;
    var prog = clamp((win.scrollY || 0) / oldScrollable, 0, 1);
    var w = stage.clientWidth || win.innerWidth;
    var h = stage.clientHeight || win.innerHeight;
    st.W = w; st.H = h;
    if (!st.reduced) {
      var vh = win.innerHeight;
      track.style.height = Math.round(vh * SCROLL_SCREENS) + 'px';
      st.scrollable = Math.max(1, doc.documentElement.scrollHeight - vh);
      if (keepProgress) win.scrollTo(0, prog * st.scrollable);/* resize 保持时间轴位置 */
    }
  }


  /* ================= 移动端海报相机（替代视频 scrub） =================
   * 原理：高清关键帧（1672px）+ CSS transform 模拟镜头推进
   * 每章内：scale 1.0→1.28（缓动推进）+ 轻微纵移
   * 章界处：cross-fade 切换关键帧
   * 漫游时：隐藏海报，显示正在播放的视频 */
  var MC_POSTERS = ['assets/approach.png', 'assets/port.png', 'assets/core.png'];
  var MC_CH = [0, 0.55, 0.75, 1];
  var mcIdx = -1;

  function mobileCamera(mcP) {
    var posterEl = document.getElementById('poster');
    if (!posterEl || !window.__isMobileSite) return;

    /* 漫游中：隐藏海报（视频正在播） */
    if (typeof AstraVideo !== 'undefined' && AstraVideo && AstraVideo.evTourActive && AstraVideo.evTourActive()) {
      posterEl.style.opacity = 0;
      return;
    }
    posterEl.style.opacity = 1;

    /* 章节判定 */
    var idx = 0;
    for (var ci = 1; ci < 3; ci++) { if (mcP >= MC_CH[ci]) idx = ci; }

    /* 章界 cross-fade */
    if (idx !== mcIdx) {
      mcIdx = idx;
      var target = MC_POSTERS[idx];
      if (posterEl.src.indexOf(target.split('/').pop()) === -1) {
        posterEl.style.opacity = 0;
        setTimeout(function() {
          posterEl.src = target;
          posterEl.style.opacity = 1;
        }, 250);
      }
    }

    /* 章内 CSS 相机：缓动推进 + 纵移 */
    var chS = MC_CH[idx], chE = MC_CH[idx + 1];
    var lp = Math.max(0, Math.min(1, (mcP - chS) / (chE - chS)));
    var e = lp * lp * (3 - 2 * lp);  /* smoothstep */

    var scale = 1.02 + e * 0.26;
    var ty = (0.5 - e) * 4;
    posterEl.style.transform = 'scale(' + scale.toFixed(4) + ') translateY(' + ty.toFixed(2) + 'vh)';
    posterEl.style.willChange = 'transform, opacity';
    posterEl.style.transition = 'opacity .3s ease';
  }

  /* ================= rAF 主循环 ================= */
  var frameArmored = 0;
  function frame(ts) {
    if (!st.running) return;
    st.raf = win.requestAnimationFrame(frame);       /* 先排下一帧：循环体内任何异常都不再杀死主循环 */
    try { frameBody(ts); }
    catch (eAll) {
      frameArmored++;
      if (typeof window !== 'undefined') {
        window.__astraFrameErrs = window.__astraFrameErrs || [];
        if (window.__astraFrameErrs.length < 5) {
          window.__astraFrameErrs.push(String(eAll && eAll.stack || eAll).slice(0, 300));
        }
      }
    }
  }
  function frameBody(ts) {
    var dt = st.lastTs ? Math.max(0, Math.min(0.05, (ts - st.lastTs) / 1000)) : 0.016;
    st.lastTs = ts;

    /* 1) 轮询滚动 -> 目标时间轴 */
    var sy = win.scrollY || doc.documentElement.scrollTop || 0;
    st.target = clamp(sy / st.scrollable, 0, 1);

    /* 2) 自动漫游：视频段连播接管节奏（P2，unmuted 顺序播放），
     *    其余区间（或视频不可用时）以 45s 匀速推进真实滚动位置 */
    if (st.tour.on && !st.tour.paused) {
      st.tour.elapsed += dt;
      if (Vid && Vid.evTourActive && Vid.evTourActive()) {   /* 事件驱动：显示跟随（控制权在 ended 事件链） */
        var dvp = Vid.tourDisplayP();
        if (dvp !== null) {
          st.current = dvp;
          win.scrollTo(0, Math.round(dvp * st.scrollable));
          st.raf2 = 0;
        }
        /* 无需 else：切换与完成由 ended 事件回调 evEngage/endTour */
      }
      var vp = Vid ? Vid.tourSync(st.current) : null;    /* null = 该区间无视频接管 */
      if (vp !== null) {
        st.tour.videoPaced = true;
        /* 视频时钟直通（同 NEON 修复）：vp 直接作为当前进度，绕开接缝浮点地狱 */
        st.current = vp;
        win.scrollTo(0, Math.round(vp * st.scrollable));
        if (vp >= 0.9995) endTour();
      } else {
        if (st.tour.videoPaced) {                         /* 视频段播完 → 从当前进度重定节奏 */
          st.tour.videoPaced = false;
          st.tour.startT = clamp(st.current, 0, 0.999);
          st.tour.elapsed = 0;
          st.tour.dur = Math.max(6, (1 - st.tour.startT) * TOUR_FULL_SEC);
        }
        var tp = clamp(st.tour.elapsed / st.tour.dur, 0, 1);
        win.scrollTo(0, (st.tour.startT + (1 - st.tour.startT) * tourEase(tp)) * st.scrollable);
        if (tp >= 1) endTour();
      }
    }

    /* 3) 导航滑翔 */
    if (st.glide.on) {
      var gp = clamp((ts - st.glide.t0) / st.glide.dur, 0, 1);
      win.scrollTo(0, Math.round(lerp(st.glide.from, st.glide.to, easeCubic(gp))));
      if (gp >= 1) {
        st.glide.on = false;
        var cb = st.glide.cb; st.glide.cb = null;
        if (cb) cb();
      }
    }

    /* 3.5) 惯性滑行：输入给动量，页面带视频自动前进/后退；衰减停止后关键帧磁吸 */
    if (Math.abs(iner.v) > 0.0002 && !st.tour.on && !st.glide.on && !st.reduced) {
      iner.v *= Math.exp(-dt * 2.4);
      var np = clamp(st.target + iner.v * dt, 0, 1);
      if (np <= 0 || np >= 1) iner.v = 0;
      win.scrollTo(0, np * st.scrollable);
      if (Math.abs(iner.v) < 0.02) {
        iner.v = 0;
        var bestR = 0, bdR = 1;                      /* 末段磁吸：轻轻停靠最近章界 */
        for (var ri = 0; ri < REST.length; ri++) {
          var dd = Math.abs(st.target - REST[ri]);
          if (dd < bdR) { bdR = dd; bestR = REST[ri]; }
        }
        if (bdR > 0.0004 && bdR < 0.05) glideTo(bestR * st.scrollable, 420 + bdR * 2600);
      }
    }

    /* 4) 阻尼插值 + 运动时钟（停止滚动 -> 画面停止） */
    var prev = st.current;
    st.current += (st.target - st.current) * (1 - Math.exp(-dt * 3.4));
    if (Math.abs(st.target - st.current) < 0.000015) st.current = st.target;
    var inst = Math.abs(st.current - prev) / dt;
    st.speed = st.speed * 0.86 + inst * 0.14;
    st.clock += dt * clamp(st.speed * 42, 0, 1);

    /* 4.5) 视频画面层：喂阻尼进度 → 模块 scrub/seek 视频元素 */
    if (Vid) Vid.update({
      p: st.current, dt: dt,
      touring: st.tour.on && !st.tour.paused,
      tourPaused: st.tour.on && st.tour.paused
    });

    /* 5) UI/DOM 更新 */
    updateDOM();
    mobileCamera(st.current);

    /* 6) P1 反馈层：HUD / 穿越门控 / 待机提示 / 声音速度调制 */
    var spdN = clamp(st.speed / 0.22, 0, 1);           /* 归一化滚动速度 */
    try { if (Aud) Aud.setSpeed(spdN); } catch (eAud) {}
    try { if (Hud) Hud.update({
      p: st.current, speed: spdN, dt: dt, clock: st.clock,
      touring: st.tour.on && !st.tour.paused, gliding: st.glide.on,
      introDone: hintGone
    }); } catch (eHud) {}
    /* 速度响应：舞台微颤幅度随滚动速度（纯显示层平移；由运动时钟驱动 —— 停滚即停） */
    var jk = spdN;
    if (jk > 0.04) {
      stage.style.transform = 'translate(' +
        (Math.sin(st.clock * 37.7) * 0.9 * jk).toFixed(2) + 'px,' +
        (Math.cos(st.clock * 29.3) * 0.7 * jk).toFixed(2) + 'px)';
    } else if (stage.style.transform) {
      stage.style.transform = '';
    }

  }

  /* ================= DOM 更新（导航高亮 / 标题淡入淡出 / 进度条） ================= */
  var TITLE_WIN = [
    [0, 0, 0.285, 0.380],             /* ch1=首屏 hero：0% 即完整呈现，28.5–38% 淡出 */
    [0.610, 0.640, 0.655, 0.698],     /* ch2：接缝后进入，第三章前退场 */
    [0.795, 0.835, 3, 3]              /* ch3：后段进入，驻留到终点 */
  ];
  function updateDOM() {
    var t = st.current;
    var ch = t < CH1_END ? 0 : (t < CH2_END ? 1 : 2);
    if (ch !== st.lastCh) {
      st.lastCh = ch;
      for (var i = 0; i < navBtns.length; i++) navBtns[i].classList.toggle('active', i === ch);
      doc.body.setAttribute('data-chapter', String(ch + 1));
      if (Aud) Aud.setChapter(ch + 1);              /* 环境音床 800ms 交叉淡化 */
    }
    for (i = 0; i < 3; i++) {
      var wnd = TITLE_WIN[i];
      var fin = ss(wnd[0], wnd[1], t);
      var fout = ss(wnd[2], wnd[3], t);
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

  /* ================= 自动漫游 ================= */
  function setTourLabel() {
    if (st.tour.on && !st.tour.paused) { tourIco.textContent = '❚❚'; tourLabel.textContent = '暂停漫游 · 空格'; }
    else if (st.tour.on) { tourIco.textContent = '▶'; tourLabel.textContent = '继续漫游 · 空格'; }
    else { tourIco.textContent = '▶'; tourLabel.textContent = '自动漫游 · 45s'; }
  }
  function beginTour(fromT) {
    if (Vid && Vid.tourStartEv && Vid.tourStartEv(fromT)) {
      st.tour.videoPaced = true;              /* 事件驱动接管：ended→下一段 */
    }
    st.tour.on = true;
    st.tour.paused = false;
    st.tour.startT = fromT;
    st.tour.elapsed = 0;
    st.tour.dur = Math.max(6, (1 - fromT) * TOUR_FULL_SEC);  /* 全程节奏恒定：45s/全程 */
    setTourLabel();
    if (Aud) Aud.tourOn();                                  /* 漫游启动确认音 */
  }
  function startTour() {
    if (st.reduced) return;
    dismissHint();
    if (st.tour.on) { st.tour.paused = !st.tour.paused; setTourLabel(); return; }
    cancelGlide();
    var t0 = st.current;
    if (t0 > 0.985) glideTo(0, 1100, function () { beginTour(0); }); /* 已在终点则回到起点重新走全程 */
    else beginTour(t0);
  }
  function endTour() {
    if (Vid && Vid.tourStopEv) Vid.tourStopEv();
    st.tour.on = false;
    st.tour.paused = false;
    st.tour.videoPaced = false;
    setTourLabel();
    if (Aud) Aud.tourOff();                                 /* 漫游停止确认音 */
    if (Vid) Vid.onTourEnd();                               /* P2：立即回 scrub + muted + seek 当前进度 */
  }

  /* ================= 导航滑翔 ================= */
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
    var y = NAV_LAND[i] === 0 ? 0 : NAV_LAND[i] * st.scrollable;
    glideTo(y, 700 + Math.abs(y - (win.scrollY || 0)) / st.scrollable * 2600);
  }

  /* ================= P1：静音控制（M 键全局静音，UI 状态指示） ================= */
  function refreshMuteUI() {
    if (!muteBtn) return;
    var active = !!(Aud && Aud.isActive());
    var muted = !!(Aud && Aud.isMuted());
    muteBtn.classList.toggle('muted', muted);
    if (muteIco) muteIco.textContent = muted ? '○' : '◉';
    if (muteTxt) muteTxt.textContent = active ? (muted ? '静音 · M' : '声音 开 · M') : '声音 待命';
  }
  function toggleMute() {
    if (!Aud) return;
    if (!Aud.isActive()) Aud.unlock();              /* 点按钮本身即首次手势 */
    else Aud.toggleMute();
    if (Vid) Vid.setMuted(Aud.isMuted());           /* P2：漫游视频原声跟随全局静音 */
    refreshMuteUI();
  }
  if (muteBtn) muteBtn.addEventListener('click', function () { muteBtn.blur(); toggleMute(); });

  /* ================= 用户交互 ================= */
  var hintGone = false;
  function dismissHint() {
    if (hintGone) return;
    hintGone = true;
    hintEl.classList.add('gone');
  }
  function userAct() {                                       /* 任何直接滚动操作：收回控制权 */
    dismissHint();
    interruptTour();
    cancelGlide();
  }
  function interruptTour() { if (st.tour.on) endTour(); }

  /* ============ 惯性播放层：一次输入 → 自动滑行一段（解决"停止输入即冻结"） ============ */
  var REST = [0, CH1_END, CH2_END, 1];              /* 磁吸停靠点：章界关键帧 */
  var iner = { v: 0 };                              /* 时间轴速度（进度/秒） */
  win.addEventListener('wheel', function (e) {
    if (st.reduced) return;
    e.preventDefault();                             /* 滚动完全由惯性层接管（滚动条拖动不受影响） */
    userAct();
    var d = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 100 : 1);
    iner.v = clamp(iner.v + d * 0.00058, -0.24, 0.24);
  }, { passive: false });
  var tT = 0, tY = 0, tV = 0;                       /* 触摸惯性：末速度 → 动量 */
  win.addEventListener('touchstart', function (e) {
    userAct();
    iner.v = 0;
    tT = performance.now(); tY = e.touches[0].clientY; tV = 0;
  }, { passive: true });
  win.addEventListener('touchmove', function (e) {
    var t = performance.now(), y = e.touches[0].clientY;
    if (t > tT) tV = (tY - y) / (t - tT);           /* px/ms，向下为正 */
    tT = t; tY = y;
  }, { passive: true });
  win.addEventListener('touchend', function () {
    if (tV > 0.12) iner.v = clamp(iner.v + tV * 0.0012, -0.32, 0.32);
  }, { passive: true });

  win.addEventListener('keydown', function (e) {
    var key = e.key;
    if (key === ' ' || key === 'Spacebar') {
      if (e.target && e.target.tagName === 'BUTTON') return;  /* 交给按钮自身 */
      e.preventDefault();
      if (st.reduced) { setReducedChapter(st.reducedIdx + 1, true); return; }
      startTour();
      return;
    }
    if (key === 'h' || key === 'H' || key === 'Escape') {      /* 口播模式（HUD 隐藏，声音保留） */
      doc.body.classList.toggle('ui-hidden');
      return;
    }
    if (key === 'm' || key === 'M') {                           /* 全局静音 */
      toggleMute();
      return;
    }
    if (st.reduced) {
      if (key === 'ArrowRight' || key === 'ArrowDown' || key === 'PageDown') switchReduced(st.reducedIdx + 1);
      else if (key === 'ArrowLeft' || key === 'ArrowUp' || key === 'PageUp') switchReduced(st.reducedIdx - 1);
      return;
    }
    var step = 0;
    if (key === 'ArrowDown') step = 0.055;
    else if (key === 'ArrowUp') step = -0.055;
    else if (key === 'PageDown') step = 0.2;
    else if (key === 'PageUp') step = -0.2;
    else if (key === 'Home') { e.preventDefault(); userAct(); glideTo(0, 900); return; }
    else if (key === 'End') { e.preventDefault(); userAct(); glideTo(st.scrollable, 1400); return; }
    if (step !== 0) {
      e.preventDefault();
      userAct();
      iner.v = clamp(iner.v + step, -0.3, 0.3);     /* 键盘也给动量脉冲 */
    }
  });

  for (var nb = 0; nb < navBtns.length; nb++) {
    (function (i) {
      navBtns[i].addEventListener('click', function (e) {
        e.preventDefault();
        navBtns[i].blur();
        if (Aud) Aud.tick();                                  /* 导航跳章 tick */
        if (st.reduced) { switchReduced(i); return; }
        dismissHint();
        glideToChapter(i);
      });
    })(nb);
  }

  if (trackEl) trackEl.addEventListener('click', function (e) {   /* 点击进度条跳转 */
    var r = trackEl.getBoundingClientRect();
    var p = clamp((e.clientY - r.top) / r.height, 0, 1);
    userAct();
    if (Aud) Aud.tick();
    glideTo(p * st.scrollable, 700 + Math.abs(p * st.scrollable - (win.scrollY || 0)) * 0.5);
  });

  tourBtn.addEventListener('click', function () { tourBtn.blur(); startTour(); });

  /* ================= 页面不可见时暂停 rAF ================= */
  doc.addEventListener('visibilitychange', function () {
    if (st.reduced) return;
    if (doc.hidden) {
      if (st.raf) win.cancelAnimationFrame(st.raf);
      st.running = false;
    } else if (!st.running) {
      st.running = true;
      st.lastTs = 0;
      st.raf = win.requestAnimationFrame(frame);
    }
  });

  /* ================= resize 防抖重建 ================= */
  var rzTimer = 0, lastW = 0, lastH = 0;
  win.addEventListener('resize', function () {
    win.clearTimeout(rzTimer);
    rzTimer = win.setTimeout(function () {
      var w = win.innerWidth, h = win.innerHeight;
      var big = Math.abs(w - lastW) > 2 || Math.abs(h - lastH) > 140;  /* 忽略移动端地址栏微变 */
      if (!big && !st.reduced) return;
      lastW = w; lastH = h;
      measure(true);
      if (st.reduced) setReducedChapter(st.reducedIdx);
    }, 160);
  }, { passive: true });

  /* ================= 静态模式（prefers-reduced-motion） ================= */
  function setReducedChapter(i, noFade) {
    st.reducedIdx = clamp(i, 0, 2);
    for (var k = 0; k < titles.length; k++) {
      var el = titles[k];
      el.style.opacity = '';
      el.style.transform = '';
      el._o = null; el._ty = null;
      el.classList.toggle('active', k === st.reducedIdx);
    }
    for (k = 0; k < navBtns.length; k++) navBtns[k].classList.toggle('active', k === st.reducedIdx);
    for (k = 0; k < dots.length; k++) dots[k].classList.toggle('active', k === st.reducedIdx);
    st.current = REDUCED_KEYS[st.reducedIdx];
    st.clock = 1.7;
    st.speed = 0;
    st.target = st.current;
    if (posterEl) posterEl.src = POSTERS[st.reducedIdx];   /* 静态模式 = 关键帧海报 */
    /* P1 反馈层：静态模式下 HUD 显示对应章读数（无动画无 sting），音床跟随章切换 */
    if (Aud) Aud.setChapter(st.reducedIdx + 1);
    if (Hud) Hud.update({
      p: st.current, speed: 0, dt: 0, clock: st.clock,
      touring: false, gliding: false, introDone: true
    });
    void noFade;
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
    (function (i) {
      dots[i].addEventListener('click', function () { dots[i].blur(); switchReduced(i); });
    })(d);
  }
  if (prevBtn) prevBtn.addEventListener('click', function () { prevBtn.blur(); switchReduced(st.reducedIdx - 1); });
  if (nextBtn) nextBtn.addEventListener('click', function () { nextBtn.blur(); switchReduced(st.reducedIdx + 1); });

  /* ================= 启动 ================= */
  function init() {
    lastW = win.innerWidth;
    lastH = win.innerHeight;
    measure(false);
    /* 画面层：两段视频 scrub 覆盖 0–100%（js/astra-video.js）；
     * seg1 0–55%（approach→port）、seg2 55–100%（port→core，结尾停稳在尾帧）。
     * 海报 = 首屏第一印象 + 失败兜底 + 静态模式关键帧。 */
    if (Vid) Vid.init({ reduced: st.reduced,
      onTourDone: function () { if (st.tour.on) endTour(); },
      onTourBreak: function () { st.tour.videoPaced = false; st.tour.startT = clamp(st.current, 0, 0.999); st.tour.elapsed = 0; st.tour.dur = Math.max(6, (1 - st.tour.startT) * TOUR_FULL_SEC) * 1000; } });     /* reduced：模块禁用，静态模式用海报 */
    /* P1 反馈层初始化：HUD（reduced 标志决定穿越动效取舍）+ 声音系统状态回调。
     * AudioContext 由模块在首次用户手势时自行创建（INTERACTION-DESIGN §2.3）。 */
    if (Hud) Hud.init({ reduced: st.reduced });
    if (Aud) {
      Aud.onState = refreshMuteUI;
      Aud.setChapter(1);                          /* SEG1 真空床（首次手势后生效） */
    }
    refreshMuteUI();
    if (st.reduced) {
      doc.body.classList.add('reduced');
      st.scrollable = 1;
      setReducedChapter(0);
    } else {
      st.running = true;
      st.lastTs = 0;
    /* 心跳看门狗：任何原因（后台加载丢事件/异常/节流）导致循环停摆，
     * 页面可见时 1.5s 内自动复活——主循环永不永久死亡 */
    win.setInterval(function () {
      if (!st.reduced && !st.running && !doc.hidden) {
        st.running = true;
        st.lastTs = 0;
        st.raf = win.requestAnimationFrame(frame);
      }
    }, 1500);
    st.raf = win.requestAnimationFrame(frame);
    }
    var rm = win.matchMedia('(prefers-reduced-motion: reduce)');
    if (rm.addEventListener) rm.addEventListener('change', function () { win.location.reload(); });
  }
  init();
})();
