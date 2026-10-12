/* ==========================================================================
 * ASTRA · 视频画面层（对齐原帖管线：视频 = 画面唯一来源）
 * js/astra-video.js
 *
 * 规格：
 *   - 进度 0–55% → seg1-scrub.currentTime 0→duration；55–100% → seg2-scrub
 *     （结尾停稳在尾帧 core 构图上）。两段共享 port 构图，55% 接缝处
 *     短暂交叠交叉淡化（权重和恒 1），无黑帧无跳变。
 *   - 两个 <video> absolute 铺满 100vw×100svh、object-fit:cover。
 *     z 序：#poster 海报(底) → 视频 → fade/flash/HUD(顶)。
 *   - scrub 恒 muted；currentTime 跟随外壳 rAF 的阻尼进度（按视频实际
 *     duration 归一化）；高频 seek 以半帧阈值（1/48s）节流，seeking 期间
 *     只记录 want、seeked 落帧后补差（合并）。
 *   - 加载：fetch → Blob URL；seg2 在进度 > 35% 后预载；scrub 片段失败时
 *     重试普通压缩版（总预算内）；最终失败 → 海报静态兜底（#poster 换到
 *     对应段关键帧），无任何程序化渲染。
 *   - 自动漫游：两段 unmuted 顺序连播接管漫游节奏（视频时长即漫游时长，
 *     视频不可用时外壳回落 45s 匀速）；漫游中断立即回 scrub + muted 并
 *     seek 到当前进度。全局静音（M）时漫游视频保持静音。
 *   - prefers-reduced-motion：模块禁用，静态模式直接用 #poster 关键帧。
 *     移动端 playsinline。P1 反馈层（HUD/音床/穿越时刻）与本层解耦。
 *
 * 结构：logic = 纯函数集（Node 桩测试对象，无 DOM 依赖）；
 *       init/update/tourSync/onTourEnd = DOM 控制器（由 astra-main.js 每帧喂参）。
 * ========================================================================== */
(function () {
  'use strict';

  var win = (typeof window !== 'undefined') ? window : {};
  var hasDoc = (typeof document !== 'undefined');

  function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
  function ss(a, b, x) {
    if (b === a) return x >= a ? 1 : 0;
    x = clamp((x - a) / (b - a), 0, 1);
    return x * x * (3 - 2 * x);
  }
  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  /* ---------------- 常量 ---------------- */
  var SEAM1 = [0.525, 0.575];      /* 55% 接缝交叉淡化窗口（seg1 尾帧与 seg2 首帧同构图） */
  var SPANS = [[0, 0.55], [0.55, 1.0]];   /* 两段覆盖全程 0–100% */
  var PRELOAD_AT = 0.12;           /* seg2 预载进度阈值（漫游约 6.6s 到接缝，留足预载余量） */
  var SEEK_EPS = 1 / 48;           /* seek 节流阈值（24fps 的半帧） */
  var REVEAL_MS = 400;             /* 就绪后 海报→视频 显影交叉淡化时长 */
  var XFADE_S = 0.45;              /* 漫游接缝交叠：下一段提前 0.45s 起播，运动对运动交叉淡化 */
  var TIMEOUT_MS = 8000;           /* 单段加载总预算（含备用 URL 重试） */
  var SEGS_DEF = [
    { id: 'seg1', elId: 'vid1', urls: ['assets/seg1-scrub.mp4', 'assets/seg1.mp4'], span: SPANS[0], poster: 'assets/approach.png' },
    { id: 'seg2', elId: 'vid2', urls: ['assets/seg2-scrub.mp4', 'assets/seg2.mp4'], span: SPANS[1], poster: 'assets/core.png' }
  ];

  /* ================= 纯逻辑（Node 桩测试对象） ================= */
  var logic = {
    SEAM1: SEAM1, SPANS: SPANS,
    PRELOAD_AT: PRELOAD_AT, SEEK_EPS: SEEK_EPS, REVEAL_MS: REVEAL_MS, TIMEOUT_MS: TIMEOUT_MS,
    /* 进度 → 段内视频时间（按实际 duration 归一化，两端 clamp） */
    segTime: function (p, span, dur) {
      var f = clamp((p - span[0]) / (span[1] - span[0]), 0, 1);
      return f * dur;
    },
    /* seg1 元素基础不透明度：接缝前恒 1，窗口内 1→0 */
    base1: function (p) { return 1 - ss(SEAM1[0], SEAM1[1], p); },
    /* seg2 元素基础不透明度：接缝窗口内 0→1，此后恒 1（播到终点停稳在尾帧） */
    base2: function (p) { return ss(SEAM1[0], SEAM1[1], p); },
    /* 接管权重 a 下的元素不透明度 */
    opFor: function (i, p, a) { return (i === 0 ? logic.base1(p) : logic.base2(p)) * clamp(a, 0, 1); },
    /* 就绪显影：revealMs 内 0→1（海报 → 视频交叉淡化）；revealMs≤0 = 立即 */
    revealAt: function (ms, revealMs) {
      var rm = (revealMs === undefined || revealMs === null) ? REVEAL_MS : revealMs;
      return rm <= 0 ? 1 : clamp(ms / rm, 0, 1);
    },
    /* 漫游：视频时间 → 时间轴进度（视频连播接管漫游节奏） */
    tourP: function (span, dur, t) {
      return span[0] + (span[1] - span[0]) * clamp(dur > 0 ? t / dur : 1, 0, 1);
    },
    /* 当前进度落在哪个视频段（seg2 覆盖到 100%） */
    coveringSeg: function (p) { return p < SPANS[0][1] ? 0 : 1; }
  };

  /* ================= DOM 控制器 ================= */
  var segs = null;
  var posterEl = null;
  var st = {
    ready: false, disabled: false, lastP: 0,
    touring: false, tourPaused: false, muted: false, engaged: -1
  };
  var O = { revealMs: REVEAL_MS, timeoutMs: TIMEOUT_MS };

  function init(opts) {
    opts = opts || {};
    O.revealMs = opts.revealMs !== undefined ? opts.revealMs : REVEAL_MS;
    O.timeoutMs = opts.timeoutMs !== undefined ? opts.timeoutMs : TIMEOUT_MS;
    O.onTourDone = opts.onTourDone || null;
    O.onTourBreak = opts.onTourBreak || null;
    if (!hasDoc || opts.reduced) { st.disabled = true; return false; }  /* 静态模式不受影响 */
    var els = [document.getElementById(SEGS_DEF[0].elId), document.getElementById(SEGS_DEF[1].elId)];
    if (!els[0] || !els[1]) { st.disabled = true; return false; }
    posterEl = document.getElementById('poster');
    segs = [];
    for (var i = 0; i < SEGS_DEF.length; i++) {
      (function (def, el) {
        var seg = {
          id: def.id, urls: def.urls, span: def.span, el: el, poster: def.poster,
          status: 'idle', started: false, urlIdx: 0, blobUrl: null,
          dur: 0, reveal: 0, revealed: false, revealT0: 0,
          want: null, timer: 0, deadline: 0, playFail: false,
          a: 0, op: 0, primed: false, __idx: -1
        };
        el.playsInline = true;                        /* 移动端内联播放 */
        el.muted = true;                              /* scrub 恒静音 */
        el.preload = 'auto';
        if (el.setAttribute) {
          el.setAttribute('playsinline', '');
          el.setAttribute('webkit-playsinline', '');
        }
        el.style.opacity = 0;
        el.addEventListener('loadedmetadata', function () {
          if (seg.status !== 'loading') return;
          var d = el.duration;
          if (!(d > 0) || !isFinite(d)) { failSeg(seg, 'metadata'); return; }
          seg.dur = d;
        });
        el.addEventListener('loadeddata', function () {
          if (seg.status !== 'loading' || !(seg.dur > 0)) return;
          seg.status = 'ready';
          if (evTour.on && evTour.pending === seg.__idx) evEngage(evTour.pending);
          if (seg.timer) { win.clearTimeout(seg.timer); seg.timer = 0; }
          trySeek(seg, logic.segTime(st.lastP, seg.span, seg.dur), true);  /* seeked 后开始显影 */
        });
        el.addEventListener('error', function () {
          if (seg.status === 'loading') failSeg(seg, 'decode');
        });
        el.addEventListener('timeupdate', function () {   /* ~4Hz，后台照常触发：交叠推进对 rAF 冻结免疫 */
          if (evTour.on && !evTour.xfade && evTour.idx >= 0 && segs[evTour.idx] === seg &&
              seg.dur > 0 && !seg.el.paused && seg.dur - seg.el.currentTime <= XFADE_S &&
              evTour.idx + 1 < segs.length) {
            var nx = segs[evTour.idx + 1];
            if (nx.status === 'ready' && nx.dur > 0) {
              evTour.xfade = { from: evTour.idx, to: evTour.idx + 1 };
              evEngage(evTour.idx + 1, true);
            }
          }
        });
        el.addEventListener('ended', function () {
          if (evTour.xfade && segs[evTour.xfade.from] === seg) {
            evTour.xfade = null;
            try { seg.el.pause(); } catch (e) {}
            seg.el.muted = true;
            try { seg.el.volume = 1; } catch (e) {}
            return;
          }
          if (evTour.on && segs[evTour.idx] === seg) {
            if (evTour.idx + 1 < segs.length) evEngage(evTour.idx + 1);
            else { evTour.on = false; if (O.onTourDone) O.onTourDone(); }
          }
        });
        el.addEventListener('seeked', function () {    /* seeking 合并：落帧后补差 */
          if (seg.want !== null && !el.seeking &&
              Math.abs(seg.want - el.currentTime) > SEEK_EPS) {
            try { el.currentTime = seg.want; } catch (e) {}
          }
          if (!seg.revealed && seg.status === 'ready') {
            seg.revealed = true;
            seg.revealT0 = nowMs();
            var lb0 = document.getElementById('loading');
            if (lb0) lb0.classList.add('done');
          }
        });
        seg.__idx = segs.length;
        segs.push(seg);
      })(SEGS_DEF[i], els[i]);
    }
    st.ready = true;
    loadSeg(segs[0]);                                 /* seg1 立即加载；seg2 待 p>35% 预载 */
    return true;
  }

  /* ---------------- 加载：fetch → Blob URL（失败链：scrub 版 → 普通压缩版 → 引擎兜底） ---------------- */
  function loadSeg(seg) {
    if (seg.started || !st.ready) return;
    seg.started = true;
    seg.status = 'loading';
    var url = seg.urls[seg.urlIdx];
    if (seg.deadline <= 0) seg.deadline = nowMs() + O.timeoutMs;   /* 8s 总预算（含重试） */
    var left = seg.deadline - nowMs();
    seg.timer = win.setTimeout(function () { failSeg(seg, 'timeout'); }, Math.max(0, left));
    var P;
    if (typeof win.fetch === 'function') P = win.fetch(url);
    else P = Promise.reject(new Error('fetch unavailable'));
    P.then(function (r) {
      if (!r || !r.ok) throw new Error('http ' + (r && r.status));
      /* 加载状态（原帖明文要求）：流式读取字节数 → 百分比指示 */
      var len = +(r.headers.get('content-length') || 0);
      var lb = document.getElementById('loading');
      if (lb && len > 0 && r.body && r.body.getReader) {
        var reader = r.body.getReader(), got = 0, chunks = [];
        var pump = function () {
          return reader.read().then(function (res) {
            if (res.done) return chunks;
            got += res.value.length;
            chunks.push(res.value);
            lb.setAttribute('data-pct', Math.min(100, Math.round(got / len * 100)) + '%');
            return pump();
          });
        };
        return pump().then(function (cs) {
          return new Blob(cs, { type: r.headers.get('content-type') || 'video/mp4' });
        });
      }
      return r.blob();
    }).then(function (b) {
      if (seg.status !== 'loading') return;
      seg.blobUrl = (win.URL && win.URL.createObjectURL) ? win.URL.createObjectURL(b) : url;
      seg.el.src = seg.blobUrl;
      try { seg.el.load(); } catch (e) {}
    }).catch(function () { failSeg(seg, 'fetch'); });
  }

  function failSeg(seg, why) {
    if (seg.status !== 'loading') return;
    if (seg.timer) { win.clearTimeout(seg.timer); seg.timer = 0; }
    seg.urlIdx++;
    if (seg.urlIdx < seg.urls.length && nowMs() < seg.deadline) {  /* 预算内重试备用 URL */
      seg.started = false;
      loadSeg(seg);
      return;
    }
    seg.status = 'failed';                            /* 海报静态兜底（对齐原帖：图片=失败兜底） */
    try { seg.el.removeAttribute('src'); seg.el.load(); } catch (e) {}
    seg.el.style.opacity = 0;
    seg.el.style.display = 'none';
    if (typeof console !== 'undefined' && console.info) {
      console.info('[AstraVideo] ' + seg.id + ' fallback to poster still (' + why + ').');
    }
  }

  /* ---------------- seek 节流 / 合并 ---------------- */
  function trySeek(seg, t, force) {
    seg.want = t;
    var el = seg.el;
    if (el.seeking && !force) return;                 /* in-flight seek 期间只记录目标 */
    if (force || Math.abs(t - el.currentTime) > SEEK_EPS) {
      try { el.currentTime = t; } catch (e) {}
    }
  }

  /* ---------------- 每帧更新（由 astra-main 喂阻尼进度） ---------------- */
  function update(env) {
    if (!st.ready) return;
    env = env || {};
    var p = clamp(env.p || 0, 0, 1);
    st.lastP = p;
    st.touring = !!env.touring;
    st.tourPaused = !!env.tourPaused;
    if (!segs[1].started && p > PRELOAD_AT) loadSeg(segs[1]);      /* 第二段预载 */
    /* 漫游接缝预热（消除切换顿挫）：当前段还剩 ≤1.2s 时，把下一段提前
     * display 进布局并 seek 到 0（透明、暂停）——接缝切换时 play() 命中热管线 */
    if (st.touring && !st.tourPaused && st.engaged >= 0 && st.engaged + 1 < segs.length) {
      var cur = segs[st.engaged];
      var nx = segs[st.engaged + 1];
      if (cur.dur > 0 && cur.dur - cur.el.currentTime <= 1.2 &&
          nx.status === 'ready' && !nx.primed) {
        nx.primed = true;
        try { nx.el.currentTime = 0; } catch (e) {}
      }
    } else if (!st.touring) {
      for (var q = 0; q < segs.length; q++) segs[q].primed = false;
    }
    for (var i = 0; i < 2; i++) {
      var seg = segs[i];
      var base = i === 0 ? logic.base1(p) : logic.base2(p);
      var a = 0;
      if (seg.status === 'ready') {
        if (seg.revealed) seg.reveal = logic.revealAt(nowMs() - seg.revealT0, O.revealMs);
        a = seg.reveal;
        var playing = (st.touring && !st.tourPaused && st.engaged === i) ||
                      (evTour.on && evTour.idx === i) ||
                      (evTour.xfade && evTour.xfade.from === i);
        if (!playing) {                              /* scrub 态：暂停 + 静音 + 跟随进度 */
          if (!seg.el.paused) { try { seg.el.pause(); } catch (e) {} }
          if (!seg.el.muted) seg.el.muted = true;
          trySeek(seg, logic.segTime(p, seg.span, seg.dur), false);
        }
      }
      seg.a = a;
      seg.op = base * a;
      var disp = (seg.op > 0.001 || seg.primed) ? '' : 'none';  /* 不可见段 display:none（预热段除外） */
      if (seg.el._d !== disp) { seg.el._d = disp; seg.el.style.display = disp; }
      var o3 = Math.round(seg.op * 1000) / 1000;
      if (seg.el._o !== o3) { seg.el._o = o3; seg.el.style.opacity = o3; }
    }
    if (st.touring && st.tourPaused && st.engaged >= 0 && !segs[st.engaged].el.paused) {
      try { segs[st.engaged].el.pause(); } catch (e) {}   /* 漫游暂停：视频同步暂停（保持 unmuted） */
    }
    /* 漫游接缝交叠：时间驱动交叉淡化 + 音量斜坡（直接写样式，当帧生效） */
    if (evTour.xfade) {
      var fin = segs[evTour.xfade.to], fout = segs[evTour.xfade.from];
      if (fin && fout && fin.dur > 0) {
        var k = clamp(fin.el.currentTime / XFADE_S, 0, 1);
        var ke = k * k * (3 - 2 * k);
        var oOut = Math.round((1 - ke) * 1000) / 1000;
        var oIn = Math.round(Math.max(fin.op, ke) * 1000) / 1000;
        if (fout.el._o !== oOut) { fout.el._o = oOut; fout.el.style.opacity = oOut; }
        if (fin.el._o !== oIn) { fin.el._o = oIn; fin.el.style.opacity = oIn; }
        try { fout.el.volume = (1 - ke); fin.el.volume = Math.min(1, 0.55 + 0.45 * ke); } catch (e) {}
      }
    }
    /* 海报兜底同步：仅当"当前覆盖段"失败时才把海报切到该段关键帧
     *（seg2 在前半程预载失败时不提前切 core，避免海报与所在区间不符） */
    if (posterEl) {
      var ci = logic.coveringSeg(p);
      var cseg = segs[ci];
      if (cseg.status === 'failed' && cseg.poster &&
          posterEl.src.indexOf(cseg.poster.slice(cseg.poster.lastIndexOf('/') + 1)) === -1) {
        posterEl.src = cseg.poster;
      }
    }
  }

  /* ---------------- 自动漫游：视频连播接管漫游节奏 ---------------- */
  function releaseEngaged() {
    if (st.engaged < 0) return;
    var seg = segs[st.engaged];
    st.engaged = -1;
    try { seg.el.pause(); } catch (e) {}
    seg.el.muted = true;
  }

  function tourSync(p) {
    if (!st.ready) return null;
    p = clamp(p, 0, 1);
    var ci = logic.coveringSeg(p);
    var seg = ci >= 0 ? segs[ci] : null;
    if (!seg || seg.status !== 'ready' || seg.playFail || !(seg.dur > 0)) {
      releaseEngaged();                               /* 引擎 core 区间 / 段未就绪 → 匀速漫游 */
      return null;
    }
    if (st.engaged !== ci) {                          /* 播完一段接下一段（或中途接入） */
      releaseEngaged();
      st.engaged = ci;
      seg.el.muted = st.muted;                        /* 漫游放开原声（尊重全局静音） */
      var t0 = logic.segTime(p, seg.span, seg.dur);
      if (Math.abs(t0 - seg.el.currentTime) > 0.25) {
        try { seg.el.currentTime = t0; } catch (e) {}
        seg.want = t0;
      }
      tryPlay(seg, ci);                               /* 原声 play 被自动播放策略拒 → 降级 muted 重试，漫游不断 */
    } else {
      seg.el.muted = st.muted;
      if (seg.el.paused && !seg.el.ended) {           /* 漫游恢复 / 页面切回前台 */
        tryPlay(seg, ci);
      }
    }
    return logic.tourP(seg.span, seg.dur, seg.el.currentTime);
  }

  /* ================= 事件驱动漫游（v3，权威控制）：ended→下一段 ================= */
  var evTour = { on: false, idx: -1, pending: -1 };
  function evEngage(ci, keepPrev) {
    var seg = segs[ci];
    if (!seg || seg.status === 'failed' || seg.playFail) {
      evTour.on = false;
      releaseEngaged();
      if (O.onTourBreak) O.onTourBreak();
      return;
    }
    if (seg.status !== 'ready' || !(seg.dur > 0)) {
      evTour.pending = ci;
      if (!seg.started) loadSeg(seg);
      return;
    }
    evTour.pending = -1;
    if (!keepPrev) releaseEngaged();            /* 交叠模式：前段继续播到自然结束 */
    evTour.idx = ci;
    st.engaged = ci;
    seg.el.muted = st.muted;
    var t0 = logic.segTime(st.lastP, seg.span, seg.dur);
    if (seg.el.ended || Math.abs(t0 - seg.el.currentTime) > 0.25) {
      try { seg.el.currentTime = t0; } catch (e) {}
      seg.want = t0;
    }
    try { seg.el.volume = 0.55; } catch (e) {}
    tryPlay(seg, ci);
  }

  /* 漫游交叠推进：当前段剩 XFADE_S 秒时启动下一段 */
  function evAdvance() {
    if (!evTour.on || evTour.idx < 0 || evTour.xfade) return;
    var cur = segs[evTour.idx];
    if (!cur || cur.status !== 'ready' || !(cur.dur > 0) || cur.el.paused) return;
    if (cur.dur - cur.el.currentTime <= XFADE_S && evTour.idx + 1 < segs.length) {
      var nx = segs[evTour.idx + 1];
      if (nx.status === 'ready' && nx.dur > 0) {
        evTour.xfade = { from: evTour.idx, to: evTour.idx + 1 };
        evEngage(evTour.idx + 1, true);
      }
    }
  }
  function tourStartEv(fromP) {
    if (!st.ready) return false;
    st.lastP = clamp(fromP || 0, 0, 1);
    evTour.on = true;
    for (var li = 0; li < segs.length; li++) {          /* 漫游装载全部段（不依赖 rAF/p 预载） */
      if (!segs[li].started && segs[li].status === 'idle') loadSeg(segs[li]);
    }
    evEngage(logic.coveringSeg(st.lastP));
    return true;
  }
  function tourStopEv() {
    evTour.on = false;
    evTour.xfade = null;
    for (var vi = 0; vi < segs.length; vi++) { try { segs[vi].el.volume = 1; } catch (e) {} }
    releaseEngaged();
  }
  function tourDisplayP() {
    if (!evTour.on || evTour.idx < 0) return null;
    var seg = segs[evTour.idx];
    if (!(seg && seg.dur > 0)) return null;
    return logic.tourP(seg.span, seg.dur, seg.el.currentTime);
  }

  /* 播放与自动播放策略兜底：未挂用户手势时 unmuted play 可能被拒——
   * 降级 muted 重试（声音由 WebAudio 音床继续承担），两次都失败才回匀速漫游 */
  function tryPlay(seg, ci) {
    var pr = seg.el.play();
    if (pr && pr.catch) pr.catch(function () {
      if (!seg.el.muted) {
        seg.el.muted = true;
        var p2 = seg.el.play();
        if (p2 && p2.catch) p2.catch(function () {
          seg.playFail = true;
          if (st.engaged === ci) releaseEngaged();
        });
      } else {
        seg.playFail = true;
        if (st.engaged === ci) releaseEngaged();
      }
    });
  }

  /* 漫游中断/结束：立即回 scrub + muted，并 seek 到当前进度 */
  function onTourEnd() {
    releaseEngaged();
    if (!st.ready) return;
    for (var i = 0; i < 2; i++) {
      if (segs[i].status === 'ready') {
        trySeek(segs[i], logic.segTime(st.lastP, segs[i].span, segs[i].dur), true);
      }
    }
  }

  function setMuted(m) {                              /* 全局静音跟随（漫游原声） */
    st.muted = !!m;
    if (st.engaged >= 0 && segs) segs[st.engaged].el.muted = st.muted;
  }

  /* 页面不可见：暂停播放中的视频（恢复由 tourSync 下一帧接管） */
  if (hasDoc && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', function () {
      if (!st.ready || !document.hidden || !segs) return;
      for (var i = 0; i < segs.length; i++) {
        if (evTour.on && evTour.idx === i) continue;    /* 漫游中的当前段不暂停（ended 事件链不可断） */
        if (segs[i].status === 'ready' && !segs[i].el.paused) {
          try { segs[i].el.pause(); } catch (e) {}
        }
      }
    });
  }

  /* ---------------- 导出 ---------------- */
  win.AstraVideo = {
    tourStartEv: tourStartEv,
    tourStopEv: tourStopEv,
    tourDisplayP: tourDisplayP,
    evTourActive: function () { return evTour.on; },
    logic: logic,
    init: init,
    update: update,
    tourSync: tourSync,
    onTourEnd: onTourEnd,
    setMuted: setMuted,
    coverage: function () {
      if (!segs) return { a1: 0, a2: 0, present1: false, present2: false };
      return {
        a1: segs[0].a, a2: segs[1].a,
        present1: segs[0].op > 0.001, present2: segs[1].op > 0.001
      };
    },
    _state: function () {
      return {
        ready: st.ready, disabled: st.disabled, lastP: st.lastP,
        touring: st.touring, tourPaused: st.tourPaused, engaged: st.engaged, muted: st.muted,
        segs: segs ? segs.map(function (s) {
          return {
            id: s.id, status: s.status, dur: s.dur, reveal: s.reveal, a: s.a, op: s.op,
            currentTime: s.el ? s.el.currentTime : 0,
            elMuted: s.el ? s.el.muted : true,
            elPaused: s.el ? s.el.paused : true
          };
        }) : []
      };
    }
  };
})();
