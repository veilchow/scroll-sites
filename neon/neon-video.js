/* ==========================================================================
 * NEON DRIFT · 视频画面层（v3 视频优先架构，对齐 ASTRA v3 定稿模式）
 * neon/neon-video.js
 *
 * 规格（三段制）：
 *   - 进度 0–33% → seg1、33–66% → seg2、66–100% → seg3 的
 *     currentTime 0→duration（段界 = 章界 = 视频关键帧事件）。
 *     两个接缝处（33% / 66%）相邻段共享同一构图关键帧，短暂交叠
 *     交叉淡化：SEAM1=[0.315,0.345]、SEAM2=[0.645,0.675]，任意时刻
 *     三段权重互补和恒 1 —— 无黑帧、无跳变。
 *   - 三个 <video> absolute 铺满 100vw×100svh、object-fit:cover。
 *     z 序：#poster 海报(底) → vid1/2/3 → #fade/#flash/HUD(顶)。
 *   - scrub 恒 muted；currentTime 跟随外壳 rAF 的阻尼进度（按视频实际
 *     duration 归一化）；高频 seek 以半帧阈值（1/48s）节流，seeking 期间
 *     只记录 want、seeked 落帧后补差（合并）。
 *   - 加载：fetch → Blob URL；seg2 在 p>0.15、seg3 在 p>0.45 后预载
 *     （seg1 立即）；scrub 片段失败时重试普通压缩版（8s 总预算内）；
 *     最终失败 → 海报静态兜底：#poster 切到「当前覆盖段」的关键帧
 *     （seg1→k1 / seg2→k2 / seg3→k4），非覆盖段失败不提前切。
 *     无任何程序化渲染（隔离原则：视频 = 画面唯一来源）。
 *   - 自动漫游：三段 unmuted 顺序连播接管漫游节奏（视频时长即漫游时长），
 *     视频不可用时外壳回落 45s 匀速；漫游中断立即回 scrub + muted 并
 *     seek 到当前进度。全局静音（M）时漫游视频保持静音。
 *   - prefers-reduced-motion：模块禁用，静态模式由外壳直接用 #poster
 *     关键帧（k1/k2/k4）。移动端 playsinline。P1 反馈层（HUD/音床/
 *     穿越时刻，门控 33%/66%）与本层解耦、原样保留。
 *
 * 结构：logic = 纯函数集（Node 桩测试对象，无 DOM 依赖）；
 *       init/update/tourSync/onTourEnd = DOM 控制器（由 app.js 每帧喂参）。
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
  var SPANS = [[0, 0.33], [0.33, 0.66], [0.66, 1.0]];   /* 三段覆盖全程 0–100%，段界=章界 */
  var SEAM1 = [0.315, 0.345];      /* 33% 接缝交叉淡化窗（seg1 尾帧与 seg2 首帧同构图 k2） */
  var SEAM2 = [0.645, 0.675];      /* 66% 接缝交叉淡化窗（seg2 尾帧与 seg3 首帧同构图 k3） */
  var PRELOAD_AT = [0, 0.15, 0.45];/* seg1 立即；seg2 在 p>0.15、seg3 在 p>0.45 预载 */
  var SEEK_EPS = 1 / 48;           /* seek 节流阈值（24fps 的半帧） */
  var REVEAL_MS = 400;             /* 就绪后 海报→视频 显影交叉淡化时长 */
  var TIMEOUT_MS = 8000;           /* 单段加载总预算（含备用 URL 重试） */
  var SEGS_DEF = [
    { id: 'seg1', elId: 'vid1', urls: ['assets/seg1-scrub.mp4', 'assets/seg1.mp4'], span: SPANS[0], poster: 'assets/keys2/k1.png' },
    { id: 'seg2', elId: 'vid2', urls: ['assets/seg2-scrub.mp4', 'assets/seg2.mp4'], span: SPANS[1], poster: 'assets/keys2/k2.png' },
    { id: 'seg3', elId: 'vid3', urls: ['assets/seg3-scrub.mp4', 'assets/seg3.mp4'], span: SPANS[2], poster: 'assets/keys2/k4.png' }
  ];

  /* ================= 纯逻辑（Node 桩测试对象） ================= */
  var logic = {
    SPANS: SPANS, SEAM1: SEAM1, SEAM2: SEAM2, SEGS_DEF: SEGS_DEF,
    PRELOAD_AT: PRELOAD_AT, SEEK_EPS: SEEK_EPS, REVEAL_MS: REVEAL_MS, TIMEOUT_MS: TIMEOUT_MS,
    /* 进度 → 段内视频时间（按实际 duration 归一化，两端 clamp） */
    segTime: function (p, span, dur) {
      var f = clamp((p - span[0]) / (span[1] - span[0]), 0, 1);
      return f * dur;
    },
    /* seg1 权重：接缝 1 前恒 1，SEAM1 窗内 1→0 */
    w1: function (p) { return 1 - ss(SEAM1[0], SEAM1[1], p); },
    /* seg2 权重：SEAM1 窗内 0→1，SEAM2 窗内 1→0（两窗不相交） */
    w2: function (p) { return ss(SEAM1[0], SEAM1[1], p) * (1 - ss(SEAM2[0], SEAM2[1], p)); },
    /* seg3 权重：SEAM2 窗内 0→1，此后恒 1（播到终点停稳在尾帧 k4） */
    w3: function (p) { return ss(SEAM2[0], SEAM2[1], p); },
    base: function (i, p) { return i === 0 ? logic.w1(p) : (i === 1 ? logic.w2(p) : logic.w3(p)); },
    /* 接管权重 a 下的元素不透明度 */
    opFor: function (i, p, a) { return logic.base(i, p) * clamp(a, 0, 1); },
    /* 三段接缝权重和（SEAM1/SEAM2 不相交 ⇒ 恒等于 1，无黑帧） */
    seamSum: function (p) { return logic.w1(p) + logic.w2(p) + logic.w3(p); },
    /* 就绪显影：revealMs 内 0→1（海报 → 视频交叉淡化）；revealMs≤0 = 立即 */
    revealAt: function (ms, revealMs) {
      var rm = (revealMs === undefined || revealMs === null) ? REVEAL_MS : revealMs;
      return rm <= 0 ? 1 : clamp(ms / rm, 0, 1);
    },
    /* 漫游：视频时间 → 时间轴进度（三段连播接管漫游节奏） */
    tourP: function (span, dur, t) {
      return span[0] + (span[1] - span[0]) * clamp(dur > 0 ? t / dur : 1, 0, 1);
    },
    /* 当前进度落在哪个视频段（段界处归下一段：与 segTime 钳制一致） */
    coveringSeg: function (p) {
      if (p < SPANS[1][0]) return 0;
      if (p < SPANS[2][0]) return 1;
      return 2;
    }
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
    if (!hasDoc || opts.reduced) { st.disabled = true; return false; }  /* 静态模式不受影响 */
    var els = [];
    for (var i = 0; i < SEGS_DEF.length; i++) els.push(document.getElementById(SEGS_DEF[i].elId));
    for (i = 0; i < els.length; i++) if (!els[i]) { st.disabled = true; return false; }
    posterEl = document.getElementById('poster');
    segs = [];
    for (i = 0; i < SEGS_DEF.length; i++) {
      (function (def, el) {
        var seg = {
          id: def.id, urls: def.urls, span: def.span, el: el, poster: def.poster,
          status: 'idle', started: false, urlIdx: 0, blobUrl: null,
          dur: 0, reveal: 0, revealed: false, revealT0: 0,
          want: null, timer: 0, deadline: 0, playFail: false,
          a: 0, op: 0, primed: false
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
          if (seg.timer) { win.clearTimeout(seg.timer); seg.timer = 0; }
          trySeek(seg, logic.segTime(st.lastP, seg.span, seg.dur), true);  /* seeked 后开始显影 */
        });
        el.addEventListener('error', function () {
          if (seg.status === 'loading') failSeg(seg, 'decode');
        });
        el.addEventListener('seeked', function () {    /* seeking 合并：落帧后补差 */
          if (seg.want !== null && !el.seeking &&
              Math.abs(seg.want - el.currentTime) > SEEK_EPS) {
            try { el.currentTime = seg.want; } catch (e) {}
          }
          if (!seg.revealed && seg.status === 'ready') {
            seg.revealed = true;
            seg.revealT0 = nowMs();
          }
        });
        segs.push(seg);
      })(SEGS_DEF[i], els[i]);
    }
    st.ready = true;
    loadSeg(segs[0]);                   /* seg1 立即加载；seg2 待 p>0.15、seg3 待 p>0.45 */
    return true;
  }

  /* ---------------- 加载：fetch → Blob URL（失败链：scrub 版 → 普通压缩版 → 海报静态兜底） ---------------- */
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
    seg.status = 'failed';                            /* 海报静态兜底（隔离原则：不回程序渲染） */
    try { seg.el.removeAttribute('src'); seg.el.load(); } catch (e) {}
    seg.el.style.opacity = 0;
    seg.el.style.display = 'none';
    if (typeof console !== 'undefined' && console.info) {
      console.info('[NeonVideo] ' + seg.id + ' fallback to poster still (' + why + ').');
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

  /* ---------------- 每帧更新（由 app.js 喂阻尼进度） ---------------- */
  function update(env) {
    if (!st.ready) return;
    env = env || {};
    var p = clamp(env.p || 0, 0, 1);
    st.lastP = p;
    st.touring = !!env.touring;
    st.tourPaused = !!env.tourPaused;
    for (var j = 1; j < segs.length; j++) {           /* seg2/seg3 预载 */
      if (!segs[j].started && p > PRELOAD_AT[j]) loadSeg(segs[j]);
    }
    /* ---- 漫游接缝预热（消除切换顿挫）：当前段还剩 ≤1.2s 时，把下一段
     * 提前 display 进布局并 seek 到 0（透明、暂停）——接缝切换时 play()
     * 命中热的解码管线，不再出现冷启动的百毫秒级定格 ---- */
    if (st.touring && !st.tourPaused && st.engaged >= 0 && st.engaged + 1 < segs.length) {
      var cur = segs[st.engaged];
      var nx = segs[st.engaged + 1];
      if (cur.dur > 0 && cur.dur - cur.el.currentTime <= 1.2 &&
          nx.status === 'ready' && !nx.primed) {
        nx.primed = true;
        try { nx.el.currentTime = 0; } catch (e) {}
      }
    } else if (!st.touring) {                          /* 非漫游态解除预热标记（恢复节能 display:none） */
      for (var q = 0; q < segs.length; q++) segs[q].primed = false;
    }
    for (var i = 0; i < segs.length; i++) {
      var seg = segs[i];
      var base = logic.base(i, p);
      var a = 0;
      if (seg.status === 'ready') {
        if (seg.revealed) seg.reveal = logic.revealAt(nowMs() - seg.revealT0, O.revealMs);
        a = seg.reveal;
        var playing = st.touring && !st.tourPaused && st.engaged === i;
        if (!playing) {                              /* scrub 态：暂停 + 静音 + 跟随进度 */
          if (!seg.el.paused) { try { seg.el.pause(); } catch (e) {} }
          if (!seg.el.muted) seg.el.muted = true;
          trySeek(seg, logic.segTime(p, seg.span, seg.dur), false);
        }
      }
      seg.a = a;
      seg.op = base * a;
      var disp = (seg.op > 0.001 || seg.primed) ? '' : 'none';  /* 不可见段 display:none 停止解码（预热段除外） */
      if (seg.el._d !== disp) { seg.el._d = disp; seg.el.style.display = disp; }
      var o3 = Math.round(seg.op * 1000) / 1000;
      if (seg.el._o !== o3) { seg.el._o = o3; seg.el.style.opacity = o3; }
    }
    if (st.touring && st.tourPaused && st.engaged >= 0 && !segs[st.engaged].el.paused) {
      try { segs[st.engaged].el.pause(); } catch (e) {}   /* 漫游暂停：视频同步暂停（保持 unmuted） */
    }
    /* 海报兜底同步：仅当「当前覆盖段」失败时才把海报切到该段关键帧
     *（seg2 在前段区间预载失败时不提前切 k2，避免海报与所在区间不符） */
    if (posterEl) {
      var ci = logic.coveringSeg(p);
      var cseg = segs[ci];
      if (cseg.status === 'failed' && cseg.poster &&
          posterEl.src.indexOf(cseg.poster.slice(cseg.poster.lastIndexOf('/') + 1)) === -1) {
        posterEl.src = cseg.poster;
      }
    }
  }

  /* ---------------- 自动漫游：三段 unmuted 顺序连播接管漫游节奏 ---------------- */
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
      releaseEngaged();                               /* 段未就绪/失败 → 外壳回 45s 匀速漫游 */
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
      var pr = seg.el.play();
      if (pr && pr.catch) pr.catch(function () {
        seg.playFail = true;                          /* 自动播放被拒 → 回匀速漫游 */
        if (st.engaged === ci) releaseEngaged();
      });
    } else {
      seg.el.muted = st.muted;
      if (seg.el.paused && !seg.el.ended) {           /* 漫游恢复 / 页面切回前台 */
        var pr2 = seg.el.play();
        if (pr2 && pr2.catch) pr2.catch(function () { seg.playFail = true; });
      }
    }
    return logic.tourP(seg.span, seg.dur, seg.el.currentTime);
  }

  /* 漫游中断/结束：立即回 scrub + muted，并 seek 到当前进度 */
  function onTourEnd() {
    releaseEngaged();
    if (!st.ready) return;
    for (var i = 0; i < segs.length; i++) {
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
        if (segs[i].status === 'ready' && !segs[i].el.paused) {
          try { segs[i].el.pause(); } catch (e) {}
        }
      }
    });
  }

  /* ---------------- 导出 ---------------- */
  win.NEONVID = {
    logic: logic,
    init: init,
    update: update,
    tourSync: tourSync,
    onTourEnd: onTourEnd,
    setMuted: setMuted,
    coverage: function () {
      if (!segs) return { a1: 0, a2: 0, a3: 0, present1: false, present2: false, present3: false };
      return {
        a1: segs[0].a, a2: segs[1].a, a3: segs[2].a,
        present1: segs[0].op > 0.001, present2: segs[1].op > 0.001, present3: segs[2].op > 0.001
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
