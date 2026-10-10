/* ============================================================
   BLOOM · 菌丝秘境 — v2 场景引擎（连续世界 · 一镜到底）
   ------------------------------------------------------------
   世界模型：assets/forest-well.png（729×2158 竖幅剖面全景，
   暮色地表 → 巨菇伞下 → 菌丝深处，一整张连续图）。
   滚动进度 p ∈ [0,1] 只驱动相机参数（位置/缩放），全程
   **无换图、无交叉淡化、无硬切**——CONTINUITY-SPEC v2。

   相机：
     · 主图 object-fit:cover 语义铺满视口（宽对齐，高度余量即行程）
     · 焦点 fy(p) 沿图高线性 0.5·v0 → 1−0.5·v1（p=0 图顶贴视口顶，
       p=1 图底贴视口底），叠加平滑 scale 1.0→1.12→1.04
     · 章节只是 UI 标记（ch1=0–33% ch2=33–66% ch3=66–100%）
     · p≈33% 穿越伞盖边缘：前景层 1.3× 天然更快的「掠过遮挡」
       剪影 + 轻微亮度波动（先暗后亮），不是切换

   视差三平面（程序绘制，全部随 p 连续）：
     · 远景 0.7×：远处菌柱群剪影 + 薄雾
     · 主图 1.0×：forest-well.png
     · 前景 1.3×：菌柄/垂帘/蕨叶/根须剪影（半透明 + 预烘焙模糊）

   氛围参数全部是 p 的平滑连续函数（见 atmosphere()），
   不随章节跳变；一切时间动画均为 time 的纯函数（可任意定格）。

   统一渲染接口（供 bloom-app.js 与未来视频层使用）：
     backend = BLOOM.createBackend({ image, segments, video })
       .ready : Promise   素材就绪（失败也 resolve → 程序化兜底）
       .resize(env)       {w,h,area,minDim} 尺寸/DPR 变化 → 重建层场
       .render(c, frame)  frame = {p, time, W, H, DPR} 整帧绘制
       .enterChapter(i, time)  UI 章节事件钩子（ch3 → 触发光传导波）
       .dispose()
   ============================================================ */
(function () {
  'use strict';

  var TAU = Math.PI * 2;
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep(a, b, x) {
    var t = clamp01((x - a) / (b - a));
    return t * t * (3 - 2 * t);
  }
  function bell(x, c, w) {
    var d = (x - c) / w;
    return Math.exp(-(d * d) / 2);
  }
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  function wrap(v, min, max) {
    var r = max - min;
    return v - Math.floor((v - min) / r) * r;
  }
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hasDOM() { return typeof document !== 'undefined' && !!document.createElement; }
  function makeCanvas(w, h) {
    if (!hasDOM()) return null;
    var cv = document.createElement('canvas');
    cv.width = Math.max(2, Math.round(w));
    cv.height = Math.max(2, Math.round(h));
    return cv;
  }

  /* ---------- 发光贴图（径向渐变精灵，按颜色缓存；Node 桩下不触发） ---------- */
  var spriteCache = typeof Map === 'function' ? new Map() : null;
  var FILTER_OK = null; /* ctx.filter 可用性（延迟探测，仅浏览器） */
  function filterSupported() {
    if (FILTER_OK !== null) return FILTER_OK;
    var cv = makeCanvas(4, 4);
    if (!cv) { FILTER_OK = false; return false; }
    var x;
    try { x = cv.getContext('2d'); x.filter = 'blur(1px)'; FILTER_OK = (x.filter === 'blur(1px)'); }
    catch (e) { FILTER_OK = false; }
    return FILTER_OK;
  }
  function glowSprite(r, g, b) {
    var key = r + ',' + g + ',' + b;
    if (spriteCache) {
      var hit = spriteCache.get(key);
      if (hit) return hit;
    }
    var cv = makeCanvas(96, 96);
    if (!cv) return null;
    var s = 96;
    var x = cv.getContext('2d');
    var gr = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0.00, 'rgba(' + key + ',1)');
    gr.addColorStop(0.18, 'rgba(' + key + ',0.62)');
    gr.addColorStop(0.45, 'rgba(' + key + ',0.18)');
    gr.addColorStop(1.00, 'rgba(' + key + ',0)');
    x.fillStyle = gr;
    x.fillRect(0, 0, s, s);
    if (spriteCache) spriteCache.set(key, cv);
    return cv;
  }
  function glow(c, x, y, r, a, spr, stretchY) {
    if (!spr || a <= 0.004 || r <= 0.3) return;
    if (a > 1) a = 1;
    c.globalAlpha = a;
    if (!stretchY || stretchY <= 1) {
      c.drawImage(spr, x - r, y - r, r * 2, r * 2);
    } else {
      /* P1 速度响应：快滚时粒子纵向拉丝（头端在上，拖尾向下） */
      c.drawImage(spr, x - r, y - r, r * 2, r * 2 * stretchY);
    }
    c.globalAlpha = 1;
  }
  var TEAL = [96, 250, 210], WARM = [255, 218, 122], PALE = [212, 255, 232], WHITE = [238, 255, 246];

  /* ============================================================
     一、纯相机路径（无 DOM —— Node 桩环境可直接驱动做连续性断言）
     ============================================================ */
  var IMG = { w: 729, h: 2158 };        /* forest-well.png 自然尺寸（加载成功后被真实尺寸覆盖） */
  var CORE = { x: 0.510, y: 0.874 };    /* 母核在图内的锚点（暖光质心实测） */

  /* 缩放微曲线：1.0 →(p=0.5) 1.12 →(p=1) 1.04，C1 连续，全程 ≥1（cover 永不露边） */
  function scalePath(p) {
    p = clamp01(p);
    return 1 + 0.12 * smoothstep(0, 0.5, p) - 0.08 * smoothstep(0.5, 1, p);
  }

  /* 相机采样：返回主图绘制矩形与焦点（全部 p 的连续函数） */
  function cameraAt(p, W, H, iw, ih) {
    iw = iw || IMG.w; ih = ih || IMG.h;
    p = clamp01(p);
    var cover = Math.max(W / iw, H / ih);        /* object-fit: cover */
    var s = scalePath(p);
    var DW = iw * cover * s, DH = ih * cover * s;
    var v0 = H / (ih * cover);                   /* p=0 时可见窗高占图高比例 */
    var v1 = H / (ih * cover * scalePath(1));    /* p=1 时同上 */
    var fmin = v0 * 0.5, fmax = 1 - v1 * 0.5;
    /* 焦点沿图高线性移动；夹取到「当前可见窗」内 —— 保证零余量视口
       （图幅等比/高度受限）在 p→0⁺/p→1⁻ 也不露亚像素边，且保持单调 */
    var v = H / DH;
    var fy = Math.min(Math.max(fmin + (fmax - fmin) * p, v * 0.5), 1 - v * 0.5);
    return {
      p: p, cover: cover, scale: s,
      DW: DW, DH: DH, fy: fy,
      sx: (W - DW) / 2,                          /* 绘制原点：水平居中（宽受限时恰好铺满） */
      sy: H / 2 - fy * DH,                       /* 垂直：p=0 图顶贴视口顶，p=1 图底贴视口底 */
      shift: fy * DH - H / 2,                    /* 世界已滚过的深度（视差层的公共自变量） */
      shiftMax: ih * cover * scalePath(1) - H    /* shift(1)：视差层行程带上界 */
    };
  }
  /* 图内坐标(比例) → 屏幕坐标 */
  function imgToScreen(cam, fx, fy) {
    return { x: cam.sx + fx * cam.DW, y: cam.sy + fy * cam.DH };
  }

  /* ============================================================
     二、氛围参数：全部是 p 的平滑连续函数（无按章跳变）
     ============================================================ */
  function atmosphere(p) {
    p = clamp01(p);
    var surface = 1 - smoothstep(0.10, 0.34, p);                       /* 地表段权重 */
    var canopy = smoothstep(0.22, 0.38, p) * (1 - smoothstep(0.60, 0.80, p)); /* 伞下段 */
    var deep = smoothstep(0.62, 0.80, p);                              /* 深处段 */
    return {
      surface: surface,
      canopy: canopy,
      deep: deep,
      /* 萤火密度：地表 1.0 → 伞下 0.55 → 深处 0.35（且分布向母核聚拢） */
      fireflies: (1 - 0.45 * smoothstep(0.15, 0.40, p)) * (1 - 0.36 * smoothstep(0.62, 0.85, p)),
      /* 孢子漂浮：伞下最盛 */
      spores: 0.18 + 0.82 * canopy,
      /* 母核环绕尘埃（深处淡入） */
      motes: deep,
      /* 光色温：地表暮色暖 → 伞下青碧 → 深处青碧+暖黄母核（暖色粒子占比） */
      warmMix: clamp01(0.15 + 0.70 * surface + 0.35 * deep),
      /* 雾 */
      fog: 0.55 * surface + 0.30 * canopy + 0.16 * deep,
      /* 下潜土壤变暗（母核随后照亮） */
      dark: smoothstep(0.46, 0.66, p) * (1 - 0.55 * smoothstep(0.70, 0.92, p)),
      /* 暗角 */
      vignette: 0.55 + 0.25 * deep + 0.15 * smoothstep(0, 0.25, p),
      /* p≈33% 穿越伞盖边缘：掠过遮挡的暗 + 穿过后的亮响应 */
      crossing: bell(p, 1 / 3, 0.042),
      crossingLight: bell(p, 1 / 3 + 0.05, 0.05),
      /* 菌丝光传导波强度淡入（p>66% 进入深处段） */
      waveGate: smoothstep(0.655, 0.75, p),
      /* 色温分级叠层 */
      gradeWarm: 0.10 * surface,
      gradeTeal: 0.06 * canopy
    };
  }

  /* ============================================================
     三、程序化世界层（浏览器端构建；粒子/摆动均为 time 纯函数）
     ============================================================ */

  /* ---- 剪影精灵预烘焙（半透明 + 模糊 = 焦外景深） ---- */
  function bakeFernCluster(w, h, rnd) {
    var cv = makeCanvas(w, h), x = cv.getContext('2d');
    if (filterSupported()) x.filter = 'blur(' + Math.max(3, w * 0.012) + 'px)';
    x.strokeStyle = 'rgba(4,15,10,0.92)';
    var fronds = 7 + Math.floor(rnd() * 5);
    for (var i = 0; i < fronds; i++) {
      var a = -Math.PI / 2 + (rnd() - 0.5) * 1.7;
      var L = h * (0.5 + rnd() * 0.45);
      var x0 = w * (0.15 + rnd() * 0.7), y0 = h;
      var x1 = x0 + Math.cos(a) * L * 0.4, y1 = y0 + Math.sin(a) * L;
      var cx = (x0 + x1) / 2 + (rnd() - 0.5) * w * 0.2, cy = (y0 + y1) / 2;
      x.lineWidth = Math.max(1.5, L * 0.02);
      x.beginPath(); x.moveTo(x0, y0); x.quadraticCurveTo(cx, cy, x1, y1); x.stroke();
      for (var k = 1; k <= 6; k++) {
        var u = k / 7, iu = 1 - u;
        var px = iu * iu * x0 + 2 * iu * u * cx + u * u * x1;
        var py = iu * iu * y0 + 2 * iu * u * cy + u * u * y1;
        var pl = L * 0.22 * Math.sin(Math.PI * u);
        x.lineWidth = Math.max(1, pl * 0.10);
        x.beginPath();
        x.moveTo(px, py); x.lineTo(px - pl * 0.5, py - pl * 0.55);
        x.moveTo(px, py); x.lineTo(px + pl * 0.5, py - pl * 0.55);
        x.stroke();
      }
    }
    return cv;
  }
  function bakeVeilCluster(w, h, rnd) {
    /* 伞盖边缘垂帘：顶部弧缘 + 下垂菌褶条带 */
    var cv = makeCanvas(w, h), x = cv.getContext('2d');
    if (filterSupported()) x.filter = 'blur(' + Math.max(3, w * 0.010) + 'px)';
    x.fillStyle = 'rgba(5,18,14,0.88)';
    var top = h * 0.12, arcR = w * 0.62;
    x.beginPath();
    x.moveTo(-arcR, top + arcR);
    x.quadraticCurveTo(w * 0.5, top - arcR * 0.92, w + arcR, top + arcR);
    x.lineTo(w + arcR, h + 40); x.lineTo(-arcR, h + 40);
    x.closePath(); x.fill();
    x.strokeStyle = 'rgba(6,22,16,0.9)';
    var n = 9 + Math.floor(rnd() * 6);
    for (var i = 0; i < n; i++) {
      var sx = w * (0.05 + 0.9 * rnd());
      var len = h * (0.35 + rnd() * 0.6);
      var sway = (rnd() - 0.5) * w * 0.16;
      x.lineWidth = Math.max(3, w * (0.012 + rnd() * 0.03));
      x.beginPath();
      x.moveTo(sx, top + h * 0.10);
      x.quadraticCurveTo(sx + sway * 0.4, top + h * 0.10 + len * 0.55, sx + sway, top + h * 0.10 + len);
      x.stroke();
    }
    return cv;
  }
  function bakeStemCluster(w, h, rnd) {
    /* 近景菌柄（粗壮剪影，底端入画） */
    var cv = makeCanvas(w, h), x = cv.getContext('2d');
    if (filterSupported()) x.filter = 'blur(' + Math.max(4, w * 0.016) + 'px)';
    var cx = w * (0.3 + rnd() * 0.4), tw = w * (0.10 + rnd() * 0.14);
    var g = x.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(6,20,15,0.55)');
    g.addColorStop(1, 'rgba(4,14,10,0.95)');
    x.fillStyle = g;
    x.beginPath();
    x.moveTo(cx - tw * 0.4, 0);
    x.quadraticCurveTo(cx - tw * 1.5, h * 0.6, cx - tw * 2.0, h + 20);
    x.lineTo(cx + tw * 2.0, h + 20);
    x.quadraticCurveTo(cx + tw * 1.5, h * 0.6, cx + tw * 0.4, 0);
    x.closePath(); x.fill();
    if (rnd() < 0.6) { /* 伴生小柄 */
      var cx2 = cx + (rnd() < 0.5 ? -1 : 1) * w * (0.28 + rnd() * 0.2);
      x.globalAlpha = 0.8;
      x.beginPath();
      x.moveTo(cx2 - tw * 0.15, h * (0.35 + rnd() * 0.3));
      x.quadraticCurveTo(cx2 - tw * 0.4, h * 0.85, cx2 - tw * 0.6, h + 20);
      x.lineTo(cx2 + tw * 0.6, h + 20);
      x.quadraticCurveTo(cx2 + tw * 0.4, h * 0.85, cx2 + tw * 0.15, h * (0.35 + rnd() * 0.3));
      x.closePath(); x.fill();
      x.globalAlpha = 1;
    }
    return cv;
  }
  function bakeRootCluster(w, h, rnd) {
    /* 深处垂根/菌丝束（顶端入画，微光尖端在渲染层叠加） */
    var cv = makeCanvas(w, h), x = cv.getContext('2d');
    if (filterSupported()) x.filter = 'blur(' + Math.max(3, w * 0.010) + 'px)';
    x.strokeStyle = 'rgba(4,13,10,0.92)';
    var n = 6 + Math.floor(rnd() * 5);
    for (var i = 0; i < n; i++) {
      var sx = w * (0.08 + 0.84 * rnd());
      var len = h * (0.45 + rnd() * 0.55);
      var sway = (rnd() - 0.5) * w * 0.3;
      x.lineWidth = Math.max(2, w * (0.008 + rnd() * 0.02));
      x.beginPath();
      x.moveTo(sx, -10);
      x.quadraticCurveTo(sx + sway * 0.3, len * 0.5, sx + sway, len);
      x.stroke();
    }
    return cv;
  }
  function bakeColumnSprite() {
    /* 远景菌柱（一枚共享精灵，多实例不同尺度复用） */
    var w = 140, h = 420;
    var cv = makeCanvas(w, h), x = cv.getContext('2d');
    if (filterSupported()) x.filter = 'blur(7px)';
    var g = x.createLinearGradient(0, h * 0.1, 0, h);
    g.addColorStop(0, 'rgba(10,32,26,0)');
    g.addColorStop(0.35, 'rgba(8,26,22,0.55)');
    g.addColorStop(1, 'rgba(5,18,15,0.85)');
    x.fillStyle = g;
    x.beginPath();
    x.moveTo(w * 0.5 - w * 0.16, h * 0.30);
    x.quadraticCurveTo(w * 0.5 - w * 0.34, h * 0.62, w * 0.5 - w * 0.42, h);
    x.lineTo(w * 0.5 + w * 0.42, h);
    x.quadraticCurveTo(w * 0.5 + w * 0.34, h * 0.62, w * 0.5 + w * 0.16, h * 0.30);
    x.closePath(); x.fill();
    /* 伞帽剪影 */
    x.beginPath();
    x.ellipse(w * 0.5, h * 0.30, w * 0.46, w * 0.16, 0, Math.PI, TAU);
    x.closePath(); x.fill();
    return cv;
  }

  /* ---- 世界层构建（resize/DPR 变化后重建；数量按屏幕面积缩放） ---- */
  function buildWorld(env) {
    var W = env.w, H = env.h, area = env.area, minDim = env.minDim;
    var rnd = mulberry32(0x0BACC2);
    var cam1 = cameraAt(1, W, H);
    var shiftMax = cam1.fy * cam1.DH - H / 2;
    var st = { W: W, H: H, minDim: minDim, shiftMax: shiftMax };

    /* 远景 0.7×：菌柱群 + 薄雾带（行程带高度 = H + 0.7·shiftMax） */
    var farSpan = H + 0.7 * shiftMax + 160;
    var colN = clamp(Math.round(area / 150000) + 7, 7, 12);
    st.farCols = [];
    for (var i = 0; i < colN; i++) {
      st.farCols.push({
        x: rnd() * (W * 1.3) - W * 0.15,
        y: rnd() * farSpan,
        s: (0.55 + rnd() * 0.85) * (minDim / 800),
        a: 0.07 + rnd() * 0.09
      });
    }
    st.farMists = [];
    var mistN = clamp(Math.round(area / 200000) + 4, 4, 8);
    for (var m = 0; m < mistN; m++) {
      st.farMists.push({
        y: rnd() * farSpan,
        hh: H * (0.10 + rnd() * 0.14),
        sp: (rnd() < 0.5 ? -1 : 1) * (5 + rnd() * 9),
        al: 0.4 + rnd() * 0.6,
        ph: rnd() * 100
      });
    }
    st.colSprite = bakeColumnSprite();

    /* 前景 1.3×：剪影簇（行程带高度 = H + 1.3·shiftMax）
       kind 0 蕨叶(地表) / 1 垂帘+菌柄(伞下) / 2 根须(深处)，
       元素沿行程带分布 → 种类随旅程自然更替，无跳变 */
    var fgSpan = H + 1.3 * shiftMax + 160;
    var fgN = clamp(Math.round(area / 120000) + 9, 9, 15);
    st.fgs = [];
    for (var f = 0; f < fgN; f++) {
      var q = (f + 0.5) / fgN;
      var Y = 40 + q * (fgSpan - 80);
      var kind = q < 0.30 ? 0 : (q < 0.64 ? 1 : 2);
      if (kind === 1 && rnd() < 0.45) kind = 3; /* 菌柄混入伞下段 */
      var cw = clamp(W * (0.4 + rnd() * 0.6), 300, 1400);
      var ch = kind === 0 ? cw * (0.7 + rnd() * 0.4)
              : kind === 1 ? clamp(H * (0.35 + rnd() * 0.3), 220, 900)
              : kind === 3 ? clamp(H * (0.45 + rnd() * 0.35), 260, 1000)
              : clamp(H * (0.3 + rnd() * 0.3), 200, 800);
      var cv = kind === 0 ? bakeFernCluster(cw, ch, rnd)
             : kind === 1 ? bakeVeilCluster(cw, ch, rnd)
             : kind === 3 ? bakeStemCluster(cw, ch, rnd)
             : bakeRootCluster(cw, ch, rnd);
      /* 元素掠过屏幕的近似 p 中心（shift(p)≈shiftMax·p 足够平滑） */
      var pc = clamp01((Y - H * 0.4) / (1.3 * shiftMax));
      st.fgs.push({
        x: rnd() * (W * 1.16) - W * 0.08,
        y: Y, cv: cv, w: cw, h: ch,
        anchor: kind === 1 || kind === 2 ? 0 : 1,   /* 垂帘/根须顶端锚定，其余底端锚定 */
        aMax: (kind === 0 ? 0.5 : kind === 3 ? 0.62 : 0.55) * (0.75 + rnd() * 0.4),
        pc: pc,
        lo: clamp01(pc - 0.12), hi: clamp01(pc + 0.12)
      });
    }

    /* 萤火（time 纯函数；深处向母核聚拢由渲染时的 focus 收缩实现） */
    var flyN = clamp(Math.round(area / 21000), 18, 84);
    st.flies = [];
    for (var q2 = 0; q2 < flyN; q2++) {
      st.flies.push({
        x: rnd() * W * 1.3 - W * 0.15,
        y: rnd() * H * 1.2 - H * 0.1,
        vx: (rnd() - 0.5) * 14,
        wf: 0.12 + rnd() * 0.3, wa: 8 + rnd() * 26,
        ph: rnd() * TAU, ph2: rnd() * TAU,
        bs: 0.7 + rnd() * 1.8, r: 4 + rnd() * 5,
        warmSeed: rnd()
      });
    }

    /* 孢子星尘 */
    var sn = clamp(Math.round(area / 8500), 50, 240);
    st.spores = [];
    for (var s = 0; s < sn; s++) {
      st.spores.push({
        x: rnd() * W, y: rnd() * H, z: 0.2 + rnd() * 0.8,
        sp: 4 + rnd() * 10, tw: 0.5 + rnd() * 2.2,
        ph: rnd() * TAU, drift: (rnd() - 0.5) * 10,
        warmSeed: rnd()
      });
    }

    /* 深处菌丝节点场（围绕母核，图内坐标；光传导波的波前命中目标） */
    st.nodes = [];
    var nodeN = clamp(Math.round(area / 60000) + 14, 16, 30);
    for (var n2 = 0; n2 < nodeN; n2++) {
      var ang = rnd() * TAU;
      var rad = IMG.h * (0.045 + rnd() * 0.24);
      st.nodes.push({
        dx: Math.cos(ang) * rad * 0.6,
        dy: Math.sin(ang) * rad,
        size: 1.4 + rnd() * 2.4,
        ph: rnd() * TAU,
        warm: rnd() < 0.35
      });
    }

    /* 母核环绕尘埃 */
    st.motes = [];
    var moteN = clamp(Math.round(area / 60000) + 16, 18, 30);
    for (var m2 = 0; m2 < moteN; m2++) {
      st.motes.push({
        a0: rnd() * TAU,
        rr: 0.05 + rnd() * 0.16,
        sp: (0.08 + rnd() * 0.25) * (rnd() < 0.5 ? -1 : 1),
        tw: 0.5 + rnd() * 2, ph: rnd() * TAU,
        size: 0.8 + rnd() * 1.8,
        warm: rnd() < 0.45
      });
    }
    return st;
  }

  /* ============================================================
     四、逐层绘制（render 的内部顺序）
     ============================================================ */
  function drawBackdrop(c, W, H, p) {
    /* 兜底底色（素材缺失/解码前）：与长图三段色调一致的纵向连续渐变 */
    var g = c.createLinearGradient(0, 0, 0, H);
    var y0 = 0.0, y1 = 0.22, y2 = 0.5, y3 = 0.87, y4 = 1.0;
    function stop(u, col) { g.addColorStop(clamp01(u), col); }
    stop(y0, 'hsl(190,30%,14%)');
    stop(y1, 'hsl(170,32%,9%)');
    stop(y2, 'hsl(160,38%,6%)');
    stop(y3, 'hsl(165,40%,3%)');
    stop(y4, 'hsl(168,42%,2%)');
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);
  }

  function drawFar(c, st, shift, time, A) {
    var W = st.W, H = st.H;
    /* 远处菌柱群（0.7×：比主图更慢 → 纵深） */
    if (st.colSprite) {
      for (var i = 0; i < st.farCols.length; i++) {
        var fc = st.farCols[i];
        var sy = fc.y - 0.7 * shift;
        if (sy < -H * 0.8 || sy > H * 1.3) continue;
        var w = st.colSprite.width * fc.s, h = st.colSprite.height * fc.s;
        c.globalAlpha = fc.a;
        c.drawImage(st.colSprite, fc.x - w / 2, sy - h, w, h);
      }
      c.globalAlpha = 1;
    }
    /* 薄雾带 */
    for (var m = 0; m < st.farMists.length; m++) {
      var mi = st.farMists[m];
      var my = mi.y - 0.7 * shift;
      if (my < -H * 0.6 || my > H * 1.6) continue;
      var span = W + 400;
      for (var k = 0; k < 5; k++) {
        var mx = wrap(k * (span / 5) + time * mi.sp + mi.ph * 20, -200, W + 200);
        var yy = my + Math.sin(time * 0.1 + k * 1.7 + mi.ph) * mi.hh * 0.4;
        var r = mi.hh * (1.6 + 0.5 * Math.sin(k * 2.3 + mi.ph));
        var g = c.createRadialGradient(mx, yy, 0, mx, yy, r);
        g.addColorStop(0, 'hsla(170,45%,78%,' + 0.05 * mi.al * A.fog + ')');
        g.addColorStop(1, 'hsla(170,45%,78%,0)');
        c.fillStyle = g;
        c.beginPath(); c.arc(mx, yy, r, 0, TAU); c.fill();
      }
    }
  }

  function drawGrade(c, W, H, A) {
    /* 色温分级（连续）：地表暮色暖光 / 伞下青碧 / 下潜变暗 */
    if (A.gradeWarm > 0.004) {
      var g = c.createLinearGradient(0, 0, 0, H * 0.7);
      g.addColorStop(0, 'rgba(255,186,110,' + A.gradeWarm + ')');
      g.addColorStop(1, 'rgba(255,186,110,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, W, H * 0.7);
    }
    if (A.gradeTeal > 0.004) {
      c.fillStyle = 'rgba(80,225,195,' + A.gradeTeal + ')';
      c.fillRect(0, 0, W, H);
    }
    if (A.dark > 0.004) {
      var d = c.createLinearGradient(0, 0, 0, H);
      d.addColorStop(0, 'rgba(2,8,7,' + 0.34 * A.dark + ')');
      d.addColorStop(0.6, 'rgba(2,8,7,' + 0.48 * A.dark + ')');
      d.addColorStop(1, 'rgba(2,8,7,' + 0.60 * A.dark + ')');
      c.fillStyle = d;
      c.fillRect(0, 0, W, H);
    }
  }

  function drawCoreGlow(c, st, cam, time, A) {
    if (A.deep <= 0.004) return;
    var W = st.W, H = st.H;
    var pos = imgToScreen(cam, CORE.x, CORE.y);
    if (pos.y < -H * 0.6 || pos.y > H * 1.6) return;
    var breath = 0.85 + 0.15 * Math.sin(time * 1.05);
    glow(c, pos.x, pos.y, st.minDim * 0.42 * breath, 0.20 * A.deep, glowSprite(WARM[0], WARM[1], WARM[2]));
    glow(c, pos.x, pos.y, st.minDim * 0.16, 0.30 * A.deep * breath, glowSprite(WHITE[0], WHITE[1], WHITE[2]));
    /* 母核呼吸光环 */
    c.strokeStyle = 'rgba(150,255,225,' + 0.13 * A.deep + ')';
    c.lineWidth = 1.2;
    for (var i = 0; i < 2; i++) {
      var rr = st.minDim * (0.20 + i * 0.09);
      var a0 = time * (0.12 + i * 0.06) * (i % 2 ? -1 : 1) + i * 2;
      c.beginPath();
      c.arc(pos.x, pos.y, rr, a0, a0 + Math.PI * (1.1 + i * 0.2));
      c.stroke();
    }
  }

  function drawSpores(c, st, time, A, speedK) {
    var W = st.W, H = st.H, k = st.minDim / 820;
    var stK = 1 + 4.5 * (speedK || 0); /* 快滚拉丝系数 */
    var sprP = glowSprite(PALE[0], PALE[1], PALE[2]);
    var sprW = glowSprite(WARM[0], WARM[1], WARM[2]);
    for (var i = 0; i < st.spores.length; i++) {
      var sp = st.spores[i];
      var sx = wrap(sp.x + time * sp.drift + Math.sin(time * 0.25 + sp.ph) * 26, -16, W + 16);
      var sy = wrap(sp.y - time * sp.sp, -16, H + 16);
      var tw = 0.25 + 0.75 * Math.pow(0.5 + 0.5 * Math.sin(time * sp.tw + sp.ph), 2);
      var sa = tw * (0.25 + sp.z * 0.55) * A.spores;
      if (sa < 0.01) continue;
      /* 色温连续混合（暖占比随 p 平滑变化，无跳变） */
      var mix = smoothstep(sp.warmSeed - 0.2, sp.warmSeed + 0.2, A.warmMix);
      var rr = (0.6 + sp.z * 2.1) * k;
      if (mix < 0.996) glow(c, sx, sy, rr * 3, sa * (1 - mix), sprP, stK);
      if (mix > 0.004) glow(c, sx, sy, rr * 3, sa * mix, sprW, stK);
      if (sp.z > 0.55 && sa > 0.1) {
        c.globalAlpha = clamp01(sa);
        c.fillStyle = '#eafff6';
        c.beginPath(); c.arc(sx, sy, rr * 0.32, 0, TAU); c.fill();
        c.globalAlpha = 1;
      }
    }
  }

  function drawFireflies(c, st, cam, time, A, speedK) {
    var W = st.W, H = st.H;
    var stK = 1 + 3.5 * (speedK || 0); /* 快滚拉丝系数 */
    /* 聚焦盒：屏幕中心 → 深处向母核投影点收拢（萤火围绕母核）。
       收拢权重随母核离屏连续归零（无硬切换，聚焦点全程连续） */
    var core = imgToScreen(cam, CORE.x, CORE.y);
    var vis = smoothstep(1.35, 1.05, core.y / H) * smoothstep(-0.35, -0.05, core.y / H);
    var pull = 0.55 * A.deep * vis;
    var focusX = lerp(W * 0.5, core.x, pull);
    var focusY = lerp(H * 0.5, core.y, pull);
    var rx = 0.85 * W * (1 - 0.25 * A.deep);
    var ry = 0.85 * H * (1 - 0.30 * A.deep);
    var sprT = glowSprite(TEAL[0], TEAL[1], TEAL[2]);
    var sprW = glowSprite(WARM[0], WARM[1], WARM[2]);
    for (var i = 0; i < st.flies.length; i++) {
      var fl = st.flies[i];
      var dx = wrap(fl.x - focusX + Math.sin(time * fl.wf + fl.ph) * fl.wa + time * fl.vx * 0.3, -rx, rx);
      var dy = wrap(fl.y - focusY + Math.sin(time * fl.wf * 0.8 + fl.ph2) * fl.wa * 0.7, -ry, ry);
      var px = focusX + dx, py = focusY + dy;
      /* 盒边缘淡出（wrap 换向不突兀） */
      var edge = clamp01((rx - Math.abs(dx)) / (0.18 * rx)) * clamp01((ry - Math.abs(dy)) / (0.18 * ry));
      var bl = Math.pow(0.5 + 0.5 * Math.sin(time * fl.bs + fl.ph), 3);
      var a = (0.12 + 0.88 * bl) * A.fireflies * edge;
      if (a < 0.012) continue;
      var mix = smoothstep(fl.warmSeed - 0.2, fl.warmSeed + 0.2, A.warmMix);
      var r = fl.r * (2.6 + A.deep);
      if (mix < 0.996) glow(c, px, py, r, a * 0.85 * (1 - mix), sprT, stK);
      if (mix > 0.004) glow(c, px, py, r, a * 0.85 * mix, sprW, stK);
      c.globalAlpha = clamp01(a);
      c.fillStyle = mix > 0.5 ? '#fff6d8' : '#dcfff4';
      c.beginPath(); c.arc(px, py, Math.max(0.6, fl.r * 0.22), 0, TAU); c.fill();
      c.globalAlpha = 1;
    }
  }

  function drawMotes(c, st, cam, time, A) {
    if (A.motes <= 0.004) return;
    var core = imgToScreen(cam, CORE.x, CORE.y);
    var sprT = glowSprite(TEAL[0], TEAL[1], TEAL[2]);
    var sprW = glowSprite(WARM[0], WARM[1], WARM[2]);
    for (var i = 0; i < st.motes.length; i++) {
      var mo = st.motes[i];
      var aa = mo.a0 + time * mo.sp;
      var rr = st.minDim * mo.rr;
      var mx = core.x + Math.cos(aa) * rr, my = core.y + Math.sin(aa) * rr * 0.8;
      var tw = 0.4 + 0.6 * Math.pow(0.5 + 0.5 * Math.sin(time * mo.tw + mo.ph), 2);
      glow(c, mx, my, mo.size * 3, tw * 0.5 * A.motes, mo.warm ? sprW : sprT);
    }
  }

  function drawWave(c, st, cam, time, A, waveStart) {
    /* 菌丝光传导波：进入深处段由边缘向母核的一次光脉冲，
       强度 × waveGate 随 p 连续淡入；waveStart 为事件时间（上滚不撤销，可再次进入再次触发） */
    if (A.waveGate <= 0.004) return;
    var W = st.W, H = st.H;
    var core = imgToScreen(cam, CORE.x, CORE.y);
    var waveDur = 3.4;
    var waveK = clamp01((time - waveStart) / waveDur);
    var waveOn = waveStart > -1e8 && waveK < 1;
    var afterGlow = (waveStart > -1e8 && waveK >= 1)
      ? Math.max(0, 1 - (time - waveStart - waveDur) / 4) : 0;
    if (!waveOn && afterGlow <= 0) return;
    var R0 = Math.hypot(W, H) * 0.62;
    var waveR = R0 * (1 - easeOutCubic(waveK));
    var sigma = st.minDim * 0.09;
    /* 收敛亮环 */
    if (waveOn) {
      c.strokeStyle = 'rgba(170,255,230,' + 0.22 * (1 - waveK) * A.waveGate + ')';
      c.lineWidth = 1.6;
      c.beginPath(); c.arc(core.x, core.y, waveR, 0, TAU); c.stroke();
      glow(c, core.x, core.y, waveR, 0.05 * (1 - waveK) * A.waveGate, glowSprite(TEAL[0], TEAL[1], TEAL[2]));
    }
    /* 节点场：波前命中逐个提亮（图内锚定 → 随相机连续） */
    var sprT = glowSprite(TEAL[0], TEAL[1], TEAL[2]);
    var sprW = glowSprite(WARM[0], WARM[1], WARM[2]);
    for (var i = 0; i < st.nodes.length; i++) {
      var nd = st.nodes[i];
      var pos = imgToScreen(cam, CORE.x + nd.dx / IMG.w, CORE.y + nd.dy / IMG.h);
      if (pos.y < -40 || pos.y > H + 40) continue;
      var d = Math.hypot(pos.x - core.x, pos.y - core.y);
      var a = 0.16 + 0.2 * (0.5 + 0.5 * Math.sin(time * 1.7 + nd.ph * 7));
      if (waveOn) {
        var dn = d - waveR;
        a += Math.exp(-(dn * dn) / (2 * sigma * sigma)) * 0.9;
      }
      a += afterGlow * 0.25;
      a *= A.waveGate;
      if (a < 0.03) continue;
      glow(c, pos.x, pos.y, nd.size * 4.4, Math.min(1, a), nd.warm ? sprW : sprT);
    }
  }

  function drawForeground(c, st, shift, p, A) {
    /* 前景 1.3×：掠过的焦外剪影；元素沿行程带分布，种类随旅程连续更替 */
    for (var i = 0; i < st.fgs.length; i++) {
      var fg = st.fgs[i];
      var env2 = smoothstep(fg.lo, fg.lo + 0.08, p) * (1 - smoothstep(fg.hi - 0.08, fg.hi, p));
      if (env2 <= 0.01) continue;
      var sy = fg.y - 1.3 * shift;
      var dy = fg.anchor ? sy - fg.h : sy; /* anchor 1=顶端锚定(垂帘/根须)，0=底端锚定 */
      if (dy > st.H + 60 || dy + fg.h < -60) continue;
      c.globalAlpha = Math.min(1, env2 * fg.aMax);
      c.drawImage(fg.cv, fg.x - fg.w * 0.5, dy, fg.w, fg.h);
    }
    c.globalAlpha = 1;

    /* p≈33% 穿越伞盖边缘：一整片伞缘剪影以 1.3× 快速掠过前景 */
    if (A.crossing > 0.01) {
      var camShiftAtCross = st.shiftMax * (1 / 3); /* 近似 shift(1/3)（线性） */
      var yc = st.H * 0.44 + 1.3 * (camShiftAtCross - shift);
      var R = Math.max(st.W, st.H) * 1.5;
      c.globalAlpha = Math.min(1, A.crossing * 0.55);
      c.fillStyle = 'rgba(4,16,11,0.9)';
      c.beginPath();
      c.ellipse(st.W * 0.5, yc - R * 0.98, R, R, 0, 0, TAU);
      c.fill();
      /* 伞缘菌褶须 */
      c.strokeStyle = 'rgba(5,20,14,0.85)';
      c.lineWidth = 2.5;
      c.beginPath();
      for (var k = -6; k <= 6; k++) {
        var lx = st.W * 0.5 + k * st.W * 0.11;
        c.moveTo(lx, yc + R * 0.012);
        c.quadraticCurveTo(lx + k * 6, yc + 46, lx + k * 12, yc + 92);
      }
      c.stroke();
      /* 伞缘生物荧光描边（穿过时的一线青光） */
      c.globalAlpha = Math.min(1, A.crossing * 0.4);
      c.strokeStyle = 'hsla(155,90%,66%,0.8)';
      c.lineWidth = 2;
      c.beginPath();
      c.ellipse(st.W * 0.5, yc - R * 0.98, R, R, 0, 0.06 * Math.PI, 0.94 * Math.PI);
      c.stroke();
      c.globalAlpha = 1;
    }
  }

  function drawCrossingLight(c, W, H, A) {
    /* 穿越体感：先轻微变暗（遮挡投影），穿过后青碧微亮响应 */
    if (A.crossing > 0.01) {
      c.fillStyle = 'rgba(2,10,8,' + (0.26 * A.crossing) + ')';
      c.fillRect(0, 0, W, H);
    }
    if (A.crossingLight > 0.01) {
      var g = c.createRadialGradient(W * 0.5, H * 0.5, 0, W * 0.5, H * 0.5, Math.max(W, H) * 0.75);
      g.addColorStop(0, 'rgba(214,255,238,' + 0.26 * A.crossingLight + ')');
      g.addColorStop(0.6, 'rgba(120,255,205,' + 0.14 * A.crossingLight + ')');
      g.addColorStop(1, 'rgba(60,180,150,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, W, H);
    }
  }

  function drawFogVignette(c, st, time, A) {
    var W = st.W, H = st.H;
    /* 底部薄雾 */
    if (A.fog > 0.01) {
      var g = c.createLinearGradient(0, H, 0, H * 0.3);
      g.addColorStop(0, 'rgba(150,220,200,' + (0.04 + 0.16 * A.fog) + ')');
      g.addColorStop(1, 'rgba(150,220,200,0)');
      c.fillStyle = g;
      c.fillRect(0, H * 0.3, W, H * 0.7);
    }
    /* 暗角（强度随 p 连续） */
    var v = c.createRadialGradient(W * 0.5, H * 0.44, Math.min(W, H) * 0.36, W * 0.5, H * 0.44, Math.hypot(W, H) * 0.62);
    v.addColorStop(0, 'rgba(2,8,8,0)');
    v.addColorStop(1, 'rgba(2,8,8,' + 0.42 * A.vignette + ')');
    c.fillStyle = v;
    c.fillRect(0, 0, W, H);
  }

  /* ============================================================
     五、统一场景后端
     ============================================================ */

  /* —— 视频层预留（本期仅接口契约 + 探测，不实现 scrub） ——
     若 assets/segment-1.mp4 与 assets/segment-2.mp4 同时存在，
     未来版本 createBackend({video:true}) 将返回 videoScrubBackend：
       · p∈[0,0.5) → segment-1；p∈[0.5,1] → segment-2；
         ±0.02 重叠带内按 smoothstep 权重合成两段
       · 每帧将段内进度映射为 video.currentTime（scrub，不调用 play）
       · seek 未就绪 / 解码异常的任意帧 → 调用本 canvas 引擎的
         render() 在同一相机位兜底（永不露底色、永不硬切）
     本期：probeSegments 探测失败（或未开启 video）→ 直接返回
     canvasWorldBackend，行为与 v2 规格完全一致。 */
  function probeSegments(urls) {
    if (typeof fetch !== 'function') return Promise.resolve(false);
    return Promise.all(urls.map(function (u) {
      return fetch(u, { method: 'HEAD' }).then(function (r) { return r.ok; }).catch(function () { return false; });
    })).then(function (oks) { return oks.every(Boolean); }).catch(function () { return false; });
  }

  function loadImage(src) {
    return new Promise(function (resolve) {
      if (!hasDOM()) { resolve(null); return; }
      var im = new Image();
      var done = false;
      function ok() { if (done) return; done = true; resolve(im); }
      function fail() { if (done) return; done = true; resolve(null); }
      im.onload = ok;
      im.onerror = fail;
      im.src = src;
      if (im.decode) im.decode().then(ok, fail);
    });
  }

  function createCanvasWorldBackend(opts) {
    opts = opts || {};
    var imagePath = opts.image || 'assets/forest-well.png';
    var st = null;                 /* 世界层场（buildWorld 产物） */
    var imgEl = null;              /* 主图（一整张连续世界） */
    var iw = IMG.w, ih = IMG.h;
    var waveStart = -1e9;          /* 光传导波事件时间 */
    var readyResolve;
    var ready = new Promise(function (res) { readyResolve = res; });

    loadImage(imagePath).then(function (im) {
      imgEl = im;
      if (im && im.naturalWidth) { iw = im.naturalWidth; ih = im.naturalHeight; }
      else if (typeof console !== 'undefined' && console.warn) {
        console.warn('[BLOOM] 主图 ' + imagePath + ' 加载失败，使用程序化兜底背景');
      }
      readyResolve();
    });

    return {
      id: 'canvas-world',
      ready: ready,
      resize: function (env) { st = buildWorld({ w: env.w, h: env.h, area: env.area, minDim: env.minDim }); },
      render: function (c, fr) {
        var p = clamp01(fr.p), time = fr.time, W = fr.W, H = fr.H;
        if (!st) st = buildWorld({ w: W, h: H, area: W * H, minDim: Math.min(W, H) });
        var A = atmosphere(p);
        var cam = cameraAt(p, W, H, iw, ih);
        var speedK = clamp01(fr.speed || 0); /* P1 反馈层注入的滚动速度 → 粒子拉伸 */
        c.setTransform(fr.DPR, 0, 0, fr.DPR, 0, 0);
        c.globalAlpha = 1;
        drawBackdrop(c, W, H, p);
        /* ① 主图：一镜到底（无换图、无交叉淡化） */
        if (imgEl) {
          c.imageSmoothingEnabled = true;
          if ('imageSmoothingQuality' in c) c.imageSmoothingQuality = 'high';
          c.drawImage(imgEl, cam.sx, cam.sy, cam.DW, cam.DH);
        }
        /* ② 远景 0.7× */
        drawFar(c, st, cam.shift, time, A);
        /* ③ 色温分级 */
        drawGrade(c, W, H, A);
        /* ④ 母核氛围（深处） */
        drawCoreGlow(c, st, cam, time, A);
        /* ⑤ 粒子（密度/色温均为 p 的连续函数；speedK 为快滚拉丝） */
        drawSpores(c, st, time, A, speedK);
        drawFireflies(c, st, cam, time, A, speedK);
        drawMotes(c, st, cam, time, A);
        /* ⑥ 菌丝光传导波 */
        drawWave(c, st, cam, time, A, waveStart);
        /* ⑦ 前景 1.3× + 伞盖边缘掠过遮挡（p≈1/3） */
        drawForeground(c, st, cam.shift, p, A);
        /* ⑧ 穿越亮度波动 */
        drawCrossingLight(c, W, H, A);
        /* ⑨ 雾 + 暗角 */
        drawFogVignette(c, st, time, A);
      },
      enterChapter: function (i, time) {
        /* 进入第三章（深处）：触发一次由边缘向母核的光传导波 */
        if (i === 2 && typeof time === 'number') waveStart = time;
      },
      dispose: function () { st = null; imgEl = null; }
    };
  }

  function createBackend(opts) {
    opts = opts || {};
    var segments = opts.segments || ['assets/segment-1.mp4', 'assets/segment-2.mp4'];
    if (opts.video === true) {
      /* 未来视频 scrub 优先分支：本期探测到素材也仅记录并回退（见上方接口契约注释） */
      return probeSegments(segments).then(function (ok) {
        if (ok && typeof console !== 'undefined' && console.info) {
          console.info('[BLOOM] 检测到视频分段素材；视频 scrub 渲染层尚未实现，本期内回退 canvas 引擎');
        }
        return createCanvasWorldBackend(opts);
      });
    }
    return createCanvasWorldBackend(opts);
  }

  /* ---------- 导出（浏览器 window / Node 桩 require 均可） ---------- */
  var api = {
    version: '2.0',
    createBackend: createBackend,
    /* 纯函数导出：Node 桩环境驱动的连续性自查使用 */
    pure: {
      cameraAt: cameraAt,
      scalePath: scalePath,
      atmosphere: atmosphere,
      IMG: IMG,
      CORE: CORE
    }
  };
  if (typeof window !== 'undefined') window.BLOOM = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
