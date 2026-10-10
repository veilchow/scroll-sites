/* ==========================================================================
 * ASTRA · 深空信标计划 —— 场景引擎 v2（CONTINUITY-SPEC 连续性重构）
 * js/astra-scene.js
 *
 * 模型：一个连续世界 + 一条相机路径。
 *   滚动进度 p ∈ [0,1] 是唯一驱动源；相机参数（scale / 放大中心 / 微平移）
 *   与氛围参数（光色温 / 星尘密度流速 / 薄雾 / 前景剪影 / 暗角）全部是 p 的
 *   连续平滑函数 —— 章节只是 UI 标记，画面参数不随章节跳变。
 *
 *   全站仅两处换图（approach→port @T1=0.55、port→core @T2=0.75），且都是
 *   "有动机的光晕过渡"：换图前对接港辉光自然增强，交叉加权严格发生在
 *   亮度峰值的平台期内（切点藏在光里），随后光晕衰减显影下一张剧照。
 *
 * 三平面视差（纵深的关键）：
 *   前景 1.22–1.42×（掠过的桁架梁 / 舱体结构剪影，软边半透明 = 焦外）
 *   主图 1.0×（三张 1672×941 同轴剧照，object-fit: cover 语义）
 *   远景 0.7×（星云薄雾粒子）
 *
 * 统一源接口 + P2 视频画面层（已接入，js/astra-video.js）：
 *   AstraEngine.setSceneSource({ kind:'video', segments:[...] }) 登记视频段后，
 *   AstraVideo 负责加载（fetch→Blob）与 scrub 映射，并每帧经
 *   AstraEngine.setVideoState({a1,a2,present1,present2}) 注入各段覆盖率：
 *   render() 据此把被视频接管的主图权重让位（canvas 只绘星尘/薄雾/前景/
 *   光晕等反馈层，视频元素位于 canvas 之下）；任一段加载/解码失败或超时 →
 *   覆盖率归零 → 本 stills 引擎路径照常兜底（v2 连续相机路径即兜底）。
 * ========================================================================== */
(function () {
  'use strict';

  var TAU = Math.PI * 2;

  /* ---------------- 基础工具（纯函数） ---------------- */
  function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
  function lerp(a, b, p) { return a + (b - a) * p; }
  function ss(a, b, x) {                   /* smoothstep，支持 a>b 反向 */
    if (b === a) return x >= a ? 1 : 0;
    x = clamp((x - a) / (b - a), 0, 1);
    return x * x * (3 - 2 * x);
  }
  function easeInOutCubic(p) { return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; }
  function smoother(p) { return p * p * p * (p * (p * 6 - 15) + 10); }  /* C¹ 平滑，两端零斜率 */
  function fract(x) { return x - Math.floor(x); }
  function mulberry32(seed) {              /* 确定性伪随机，resize 后布局一致 */
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function mix(c1, c2, p) {
    return [
      Math.round(lerp(c1[0], c2[0], p)),
      Math.round(lerp(c1[1], c2[1], p)),
      Math.round(lerp(c1[2], c2[2], p))
    ];
  }
  function rgba(c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
  function rr(g, x, y, w, h, r) {          /* 圆角矩形路径（兼容写法） */
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  /* ---------------- 调色：冷青（深空段）→ 暖青白（核心段） ---------------- */
  var PAL = {
    bgTop: [4, 6, 14], bgBot: [10, 16, 38],
    star: [207, 232, 255],
    cold: [130, 215, 255],       /* 冷青：approach 段星尘 / 光晕①基调 */
    warm: [255, 246, 232],       /* 暖青白：core 段晶体环境光 */
    glowCore: [235, 250, 255],   /* 光晕峰值芯色 */
    beam: [3, 5, 12]             /* 前景剪影 */
  };

  /* ================= 相机时间轴（唯一权威参数表） =================
   * p        阶段                    scale           放大中心(归一化图内坐标)
   * 0.000    approach 远景           1.00            对接港 (0.500, 0.477)
   * 0→0.545  approach 连续 dolly-in  1.00 → 3.00     同上（easeInOutCubic）
   * 0.455–0.540  光晕①自然增强（进近对接港，辉光长大）
   * 0.540    光晕①到达峰值平台
   * 0.545–0.555  换图①窗口：approach→port 交叉加权（藏于满辉光，约 0.45s@45s 漫游）
   * 0.555–0.625  光晕①衰减，port 以匹配 framing 显影（scale≈1.00）
   * 0.55→0.75    port 连续推进       1.00 → 1.40     闸门中心 (0.502, 0.472)
   * 0.700–0.740  光晕②（青白）增强：闸门充满画面
   * 0.745–0.755  换图②窗口：port→core（藏于满屏青白辉光）
   * 0.755–0.830  光晕②衰减，core 显影
   * 0.75→1.00    core 舱内漂移逼近    1.05 → 1.25     晶体 (0.500, 0.390)
   *              + 极轻微平移 panX +0.010→−0.008, panY −0.006→+0.010（屏宽/高比例）
   *
   * 锚点坐标经读图确认（1672×941）：approach 对接港 (836,449)；
   * port 闸门中心 (839,443)，闸门直径约 70% 画幅；core 晶体 (836,353)-(836,380)。
   */
  var TL = {
    T1: 0.55, T2: 0.75,
    SWAP1: [0.545, 0.555],                  /* approach → port（藏在光晕①峰值里）*/
    SWAP2: [0.745, 0.755],                  /* port → core（藏在光晕②峰值里）*/
    G1R: [0.455, 0.540], G1F: [0.555, 0.625],  /* 光晕① 升 / 降 */
    G2R: [0.700, 0.740], G2F: [0.755, 0.830],  /* 光晕② 升 / 降 */
    A_S: [1.00, 3.00],                      /* approach dolly 区间 */
    P_S: [1.00, 1.40],                      /* port 推进区间 */
    C_S: [1.05, 1.25]                       /* core 漂移区间 */
  };
  var ANCHOR = {
    approach: [0.500, 0.477],
    port: [0.502, 0.472],
    core: [0.500, 0.390]
  };

  /* ================= camera(p)：相机 + 氛围的纯函数（可逆、连续） ================= */
  function camera(p) {
    p = clamp(p, 0, 1);
    var x1 = ss(TL.SWAP1[0], TL.SWAP1[1], p);        /* 换图①交叉权重 */
    var x2 = ss(TL.SWAP2[0], TL.SWAP2[1], p);        /* 换图②交叉权重 */
    var glow1 = ss(TL.G1R[0], TL.G1R[1], p) * (1 - ss(TL.G1F[0], TL.G1F[1], p));
    var glow2 = ss(TL.G2R[0], TL.G2R[1], p) * (1 - ss(TL.G2F[0], TL.G2F[1], p));

    var eA = easeInOutCubic(clamp(p / TL.T1, 0, 1));
    var sA = lerp(TL.A_S[0], TL.A_S[1], eA);

    var eP = easeInOutCubic(clamp((p - TL.T1) / (TL.T2 - TL.T1), 0, 1));
    var sP = lerp(TL.P_S[0], TL.P_S[1], eP);

    var eC = smoother(clamp((p - TL.T2) / (1 - TL.T2), 0, 1));
    var sC = lerp(TL.C_S[0], TL.C_S[1], eC);
    var panX = lerp(0.010, -0.008, eC);              /* core 段极轻微平移（屏比例）*/
    var panY = lerp(-0.006, 0.010, eC);

    var zc = 1 + 2.6 * smoother(p);                  /* 相机推进深度代理：连续单调，驱动视差层 */

    return {
      p: p, x1: x1, x2: x2, glow1: glow1, glow2: glow2, zc: zc,
      temp: ss(0.55, 0.92, p),                                    /* 光色温：冷青→暖青白 */
      mistA: 0.55 * (1 - ss(0.50, 0.62, p)) + 0.10 * ss(0.78, 0.88, p),
      fgA: 0.55 * (1 - ss(0.58, 0.72, p)) * ss(0.006, 0.05, p),
      dustDensity: clamp(0.9 + 0.5 * ss(0.40, 0.58, p) - 0.55 * ss(0.78, 0.92, p), 0.3, 1.4),
      flow: clamp(0.35 + 0.75 * ss(0.30, 0.55, p) - 0.90 * ss(0.78, 0.90, p), 0.12, 1.10),
      inside: ss(0.755, 0.86, p),                                 /* 舱内权重（星尘换漂浮态）*/
      vinA: 0.50 + 0.16 * ss(0.74, 0.90, p),
      bloom: 0.10 + 0.25 * ss(0.80, 0.97, p),                     /* 核心段晶体环境辉光 */
      plates: [
        { id: 'approach', alpha: 1 - x1, scale: sA, ax: ANCHOR.approach[0], ay: ANCHOR.approach[1], panX: 0, panY: 0 },
        { id: 'port', alpha: x1 * (1 - x2), scale: sP, ax: ANCHOR.port[0], ay: ANCHOR.port[1], panX: 0, panY: 0 },
        { id: 'core', alpha: x2, scale: sC, ax: ANCHOR.core[0], ay: ANCHOR.core[1], panX: panX, panY: panY }
      ]
    };
  }

  /* ================= 场景源：stills（本期）/ video（预留） ================= */
  var PLATE_FILES = {
    approach: 'assets/approach.png',
    port: 'assets/port.png',
    core: 'assets/core.png'
  };
  var plateImgs = { approach: null, port: null, core: null };
  var plateWall = { approach: 0, port: 0, core: 0 };  /* 各剧照就绪墙钟（载入淡入用）*/
  var loadPromise = null;

  var sourceState = { kind: 'stills', video: { requested: false, active: false, segments: [] } };

  /* P2 视频覆盖率（由 js/astra-video.js 每帧注入）。a1/a2 为对应段视频的
   * "接管权重"：主图按 (1-a) 让位、视频元素透明度按 a 显影，两者互补和恒 1；
   * present* 表示该帧视频元素正在显影（此时不得绘制不透明兜底底图）。 */
  var videoState = { a1: 0, a2: 0, present1: false, present2: false };
  var VS_ZERO = { a1: 0, a2: 0, present1: false, present2: false };

  function setVideoState(vs) {
    vs = vs || {};
    videoState.a1 = clamp(vs.a1 || 0, 0, 1);
    videoState.a2 = clamp(vs.a2 || 0, 0, 1);
    videoState.present1 = !!vs.present1;
    videoState.present2 = !!vs.present2;
    sourceState.video.active = videoState.a1 > 0 || videoState.a2 > 0;
    return videoState;
  }

  /* 主图有效权重（纯函数，render 与测试共用）：被视频接管的 plate 让位 */
  function plateWeights(cam, vs) {
    var a1 = clamp((vs && vs.a1) || 0, 0, 1);
    var a2 = clamp((vs && vs.a2) || 0, 0, 1);
    return [
      cam.plates[0].alpha * (1 - a1),   /* approach ← seg1 */
      cam.plates[1].alpha * (1 - a2),   /* port ← seg2 */
      cam.plates[2].alpha               /* core：75–100% 恒引擎渲染 */
    ];
  }

  function setSceneSource(source) {
    if (!source || source.kind !== 'video') {
      sourceState = { kind: 'stills', video: { requested: false, active: false, segments: [] } };
      return sourceState;
    }
    /* P2（已实现，见 js/astra-video.js）：
     *   AstraEngine.setSceneSource({ kind:'video', segments: [
     *     { url:'assets/seg1-scrub.mp4', span:[0,   0.55] },   // approach 段
     *     { url:'assets/seg2-scrub.mp4', span:[0.55,0.75] }    // port→core 段
     *   ]});
     * 登记后由 AstraVideo 加载并每帧 setVideoState() 注入覆盖率：滚动进度映射
     * video.currentTime（scrub 优先），两段在 T1/T2 两个 motivated 过渡点接力
     * （过渡仍藏在本引擎光晕遮罩峰值里）；加载/解码失败或超时的段覆盖率归零，
     * render() 自动回退本 stills 路径（引擎即兜底）。 */
    var segs = [];
    if (source.segments) {
      for (var i = 0; i < source.segments.length; i++) {
        var s = source.segments[i];
        if (s && typeof s.url === 'string') segs.push({ url: s.url, span: s.span || null });
      }
    }
    sourceState = { kind: 'video', video: { requested: true, active: false, segments: segs } };
    return sourceState;
  }

  function probeVideoSegments() {
    /* P2 起由 js/astra-video.js 以 fetch 探测/加载；本函数保留接口兼容，恒 null。 */
    return null;
  }

  function load() {                                   /* 加载三张剧照；缺失时静默降级 */
    if (typeof document === 'undefined' || typeof Image === 'undefined') {
      return Promise.resolve({ ready: [], missing: Object.keys(PLATE_FILES) });
    }
    if (loadPromise) return loadPromise;
    var ids = Object.keys(PLATE_FILES);
    loadPromise = new Promise(function (resolve) {
      var left = ids.length, ready = [], missing = [];
      function settle() { if (--left === 0) resolve({ ready: ready, missing: missing }); }
      ids.forEach(function (id) {
        var im = new Image();
        im.onload = function () {
          plateImgs[id] = im;
          plateWall[id] = (typeof Date !== 'undefined') ? Date.now() : 1;
          ready.push(id); settle();
        };
        im.onerror = function () { missing.push(id); settle(); };
        im.src = PLATE_FILES[id];
      });
    });
    return loadPromise;
  }

  function plateFade(id, now) {                       /* 就绪后 0.45s 一次性淡入（非时间轴特效）*/
    var w0 = plateWall[id];
    if (!w0) return 0;
    return clamp((now - w0) / 450, 0, 1);
  }

  /* ================= 世界构建（resize 时重建；确定性种子） ================= */
  function buildStarTile(seed, count) {               /* 剧照未就绪时的深空兜底星场 */
    var S = 512, c = document.createElement('canvas');
    c.width = S; c.height = S;
    var g = c.getContext('2d');
    var rand = mulberry32(seed);
    for (var i = 0; i < count; i++) {
      var b = rand();
      g.fillStyle = rgba(PAL.star, 0.25 + rand() * 0.6);
      g.beginPath();
      g.arc(rand() * S, rand() * S, b > 0.96 ? 1.3 : 0.4 + rand() * 0.8, 0, TAU);
      g.fill();
    }
    return c;
  }

  function build(env) {
    var rand = mulberry32(20261009);
    var w = {
      area: env.area,
      grads: {},
      starTile: buildStarTile(4242, clamp(Math.round(env.area / 9000), 60, 420)),
      dust: [], beams: [], mists: []
    };
    /* 星尘：数量随屏幕面积缩放 */
    var nd = clamp(Math.round(env.area / 15000), 40, 160);
    for (var i = 0; i < nd; i++) {
      w.dust.push({ a: rand() * TAU, r0: rand(), z: 0.3 + rand() * 0.7, ph: rand() * TAU, mx: rand(), my: rand() });
    }
    /* 前景剪影：掠过的桁架梁 / 舱体结构（1.22–1.42× 视差） */
    for (i = 0; i < 9; i++) {
      w.beams.push({
        a: rand() * TAU,
        k: 1.22 + rand() * 0.20,
        w0: 0.020 + rand() * 0.050,
        len: 0.5 + rand() * 0.9,
        s0: rand(),
        tilt: (rand() - 0.5) * 1.5
      });
    }
    /* 远景薄雾：星云雾团（0.7× 视差） */
    for (i = 0; i < 11; i++) {
      w.mists.push({ a: rand() * TAU, r0: rand(), z: 0.55 + rand() * 0.35, s: 0.28 + rand() * 0.40, ph: rand() * TAU });
    }
    return w;
  }

  /* ================= 主渲染入口（单一世界的连续参数化绘制） ================= */
  function render(g, world, S) {
    var cam = camera(S.t);
    var now = (typeof Date !== 'undefined') ? Date.now() : 0;

    /* P2 视频层 seam：视频 scrub 激活时（AstraVideo 每帧注入覆盖率），
     * 被接管的主图权重让位给位于 canvas 之下的 <video> 元素，canvas 只绘
     * 星尘/薄雾/前景/光晕等反馈层；任一段失败 → 覆盖率 0 → stills 照常。 */
    var vs = sourceState.kind === 'video' ? videoState : VS_ZERO;
    var wgt = plateWeights(cam, vs);
    var presenting = vs.present1 || vs.present2;

    /* 1) 剧照覆盖度不足时（载入中/缺失），先画程序化深空兜底；
     *    视频正在显影时跳过（不透明底填充会盖住下方的视频） */
    var cover = 0, i, pl, fade;
    for (i = 0; i < 3; i++) {
      pl = cam.plates[i];
      if (plateImgs[pl.id]) cover += wgt[i] * plateFade(pl.id, now);
    }
    if (!presenting && cover < 0.999) drawFallback(g, world, S);

    /* 2) 主图：三张同轴剧照按相机路径绘制；视频接管处权重让位（互补和恒 1），
     *    交叉加权只在两个 motivated 窗口内 */
    for (i = 0; i < 3; i++) {
      pl = cam.plates[i];
      if (!plateImgs[pl.id] || wgt[i] <= 0.001) continue;
      fade = plateFade(pl.id, now);
      if (fade <= 0.001) continue;
      drawPlate(g, plateImgs[pl.id], pl, S, wgt[i] * fade);
    }

    var tint = mix(PAL.cold, PAL.warm, cam.temp);

    /* 3) 远景薄雾（0.7×） 4) 星尘（全程连续） 5) 前景剪影（1.3×）
     * 视频呈现期间（P2）：薄雾与前景剪影属于程序化场景的舞台装置，
     * 与视频画面无关，叠上去会成为悬在实拍画面上的杂物——让位，
     * 只保留星尘（滚动速度反馈）与光晕/暗角。 */
    var vidCover = Math.max(vs.a1, vs.a2);
    if (cam.mistA > 0.01 && vidCover < 0.98) drawMist(g, world, S, cam, tint);
    drawDust(g, world, S, cam, tint);
    if (cam.fgA > 0.01 && vidCover < 0.98) drawBeams(g, world, S, cam, tint);

    /* 6) 两次 motivated 光晕：换图切点藏在这里（光晕峰值平台 ⊃ 换图窗口） */
    if (cam.glow1 > 0.002) drawGlow(g, S, cam.glow1, mix(PAL.cold, PAL.glowCore, 0.35), 0.90);
    if (cam.glow2 > 0.002) drawGlow(g, S, cam.glow2, mix(tint, PAL.glowCore, 0.50), 1.05);

    /* 7) 核心段环境辉光 + 左侧文字压暗幕 + 暗角（全部为 p 的连续函数） */
    if (cam.bloom > 0.01) drawBloom(g, S, cam.bloom, tint);
    drawScrim(g, world, S);
    drawVignette(g, world, S, cam.vinA);
  }

  /* ---------------- 剧照（object-fit: cover + 相机变换） ---------------- */
  function drawPlate(g, img, pl, S, alpha) {
    var base = Math.max(S.W / img.width, S.H / img.height);   /* cover 基准缩放 */
    g.save();
    g.globalAlpha = alpha;
    if (g.imageSmoothingEnabled !== undefined) g.imageSmoothingQuality = 'high';
    g.translate(S.cx + pl.panX * S.W, S.cy + pl.panY * S.H);  /* core 段极轻微漂移 */
    var s = base * pl.scale;
    g.scale(s, s);
    g.translate(-pl.ax * img.width, -pl.ay * img.height);     /* 放大中心 = 锚点（对接港/晶体）*/
    g.drawImage(img, 0, 0);
    g.restore();
  }

  /* ---------------- 程序化深空兜底（剧照未就绪 / 视频失败时的最终兜底） ---------------- */
  function drawFallback(g, world, S) {
    var gr = world.grads.fb;
    if (!gr) {
      gr = g.createLinearGradient(0, 0, 0, S.H);
      gr.addColorStop(0, rgba(PAL.bgTop, 1));
      gr.addColorStop(1, rgba(PAL.bgBot, 1));
      world.grads.fb = gr;
    }
    g.fillStyle = gr;
    g.fillRect(0, 0, S.W, S.H);
    var t = 512, img = world.starTile;
    for (var x = 0; x < S.W; x += t) {
      for (var y = 0; y < S.H; y += t) g.drawImage(img, x, y);
    }
  }

  /* ---------------- 远景薄雾（0.7× 视差，screen 叠加） ---------------- */
  function drawMist(g, world, S, cam, tint) {
    var travel = (cam.zc - 1) * 0.7;                         /* 远景 0.7× 速度 */
    var maxR = S.maxWH * 0.85;
    g.save();
    g.globalCompositeOperation = 'screen';
    for (var i = 0; i < world.mists.length; i++) {
      var m = world.mists[i];
      var rp = fract(m.r0 + travel * m.z * 0.42 + Math.sin(S.clock * 0.11 + m.ph) * 0.015);
      var d = rp * rp * maxR * 1.15;
      var a = cam.mistA * m.z * 0.16 * ss(0.03, 0.18, rp) * (1 - ss(0.72, 0.98, rp));
      if (a < 0.004) continue;
      var x = S.cx + Math.cos(m.a) * d;
      var y = S.cy + Math.sin(m.a) * d * 0.8;
      var r = m.s * S.minWH * (0.55 + rp * 0.8);
      var gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, rgba(tint, a));
      gr.addColorStop(1, rgba(tint, 0));
      g.fillStyle = gr;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    g.restore();
  }

  /* ---------------- 星尘：径向流迹（舱外）⇄ 漂浮微尘（舱内），连续混合 ---------------- */
  function drawDust(g, world, S, cam, tint) {
    var maxR = S.maxWH * 0.95;
    var speedLen = clamp(S.speed * 2400, 0, 60);             /* 滚动速度加成（停滚即停）*/
    var inside = cam.inside;
    var col = mix(PAL.star, tint, 0.55);
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round';
    for (var i = 0; i < world.dust.length; i++) {
      var p = world.dust[i];
      var rp = fract(p.r0 + (S.t * 1.35 + cam.flow * 0.55) * p.z);
      var d = Math.pow(rp, 1.65);
      var a2 = p.a + Math.sin(S.t * 2.0) * 0.15;
      var rx = S.cx + Math.cos(a2) * d * maxR;
      var ry = S.cy + Math.sin(a2) * d * maxR * 0.92;
      var mx = p.mx * S.W + Math.sin(S.clock * 0.35 + p.ph) * S.W * 0.02;
      var my = fract(p.my + S.t * 0.03) * S.H + Math.cos(S.clock * 0.30 + p.ph) * S.H * 0.015;
      var px = lerp(rx, mx, inside);
      var py = lerp(ry, my, inside);
      var fade = ss(0.02, 0.10, rp) * (1 - ss(0.82, 1, rp));
      var al = cam.dustDensity * fade * p.z * (0.42 - 0.20 * inside);
      if (al < 0.01) continue;
      var len = (1.2 + (speedLen + cam.flow * 14) * p.z) * (1 - 0.8 * inside);
      g.strokeStyle = rgba(col, clamp(al, 0, 0.85));
      g.lineWidth = 0.5 + p.z * (1.4 - 0.6 * inside);
      g.beginPath();
      g.moveTo(px, py);
      g.lineTo(px - lerp(Math.cos(a2), 0.25, inside) * len,
               py - lerp(Math.sin(a2), -0.35, inside) * len);
      g.stroke();
    }
    g.restore();
  }

  /* ---------------- 前景剪影：掠过的桁架梁 / 舱体结构（1.22–1.42×） ---------------- */
  function drawBeams(g, world, S, cam, tint) {
    var travel = cam.zc - 1;
    var maxR = S.maxWH * 0.72;
    g.save();
    for (var i = 0; i < world.beams.length; i++) {
      var b = world.beams[i];
      var wi = fract(b.s0 + travel * b.k * 0.34);            /* k× 速度从镜头旁掠过 */
      var d = Math.pow(wi, 1.7) * maxR;
      var edge = ss(0.055, 0.16, wi) * (1 - ss(0.74, 0.95, wi));
      var A = cam.fgA * edge;
      if (A < 0.008) continue;
      var ang = b.a + b.tilt * 0.2;
      var x = S.cx + Math.cos(ang) * d;
      var y = S.cy + Math.sin(ang) * d * 0.86;
      var L = S.minWH * b.len * (0.5 + wi * 1.5);
      var Wd = S.minWH * b.w0 * (0.5 + wi * 2.2);
      g.save();
      g.translate(x, y);
      g.rotate(ang + b.tilt);
      /* 三层叠影 ≈ 焦外软边（半透明 + 模糊感） */
      for (var k2 = 2; k2 >= 0; k2--) {
        var off = k2 * Wd * 0.22;
        g.fillStyle = rgba(PAL.beam, (k2 === 0 ? 0.34 : 0.15) * A);
        rr(g, -L / 2 + off, -Wd / 2 + off * 0.4, L, Wd, Wd * 0.42);
        g.fill();
      }
      /* 桁架斜格 */
      if (Wd > S.minWH * 0.030) {
        g.strokeStyle = rgba(PAL.beam, 0.30 * A);
        g.lineWidth = Math.max(1, Wd * 0.10);
        var seg = Math.max(3, Math.round(L / (Wd * 1.4)));
        for (var q = 1; q < seg; q++) {
          var xx = -L / 2 + (L * q) / seg;
          g.beginPath();
          g.moveTo(xx, -Wd / 2);
          g.lineTo(xx + Wd * 0.5, Wd / 2);
          g.stroke();
        }
      }
      /* 受光边缘（色温随 p 连续） */
      g.globalCompositeOperation = 'lighter';
      g.strokeStyle = rgba(tint, 0.10 * A);
      g.lineWidth = Math.max(1, Wd * 0.14);
      rr(g, -L / 2, -Wd / 2, L, Wd, Wd * 0.42);
      g.stroke();
      g.globalCompositeOperation = 'source-over';
      g.restore();
    }
    g.restore();
  }

  /* ---------------- motivated 光晕（换图切点的藏身处） ---------------- */
  function drawGlow(g, S, k, col, width) {
    var R = S.maxWH * (0.55 + 0.95 * k) * width;             /* 峰值时覆盖全屏（含四角）*/
    g.save();
    g.globalCompositeOperation = 'lighter';
    var gr = g.createRadialGradient(S.cx, S.cy, 0, S.cx, S.cy, R);
    gr.addColorStop(0, rgba(PAL.glowCore, 0.98 * k));
    gr.addColorStop(0.45, rgba(col, 0.94 * k));
    gr.addColorStop(1, rgba(col, 0.80 * k));
    g.fillStyle = gr;
    g.fillRect(0, 0, S.W, S.H);
    g.restore();
  }

  /* ---------------- 核心段晶体环境辉光 ---------------- */
  function drawBloom(g, S, k, col) {
    var R = S.minWH * 0.55;
    g.save();
    g.globalCompositeOperation = 'lighter';
    var gr = g.createRadialGradient(S.cx, S.cy * 0.92, 0, S.cx, S.cy * 0.92, R);
    gr.addColorStop(0, rgba(col, 0.30 * k));
    gr.addColorStop(1, rgba(col, 0));
    g.fillStyle = gr;
    g.fillRect(0, 0, S.W, S.H);
    g.restore();
  }

  /* ---------------- 左侧文字压暗幕（常量，护标题可读性） ---------------- */
  function drawScrim(g, world, S) {
    var gr = world.grads.scrim;
    if (!gr) {
      gr = g.createLinearGradient(0, 0, S.W * 0.46, 0);
      gr.addColorStop(0, 'rgba(3,5,12,0.42)');
      gr.addColorStop(1, 'rgba(3,5,12,0)');
      world.grads.scrim = gr;
    }
    g.fillStyle = gr;
    g.fillRect(0, 0, S.W * 0.46, S.H);
  }

  /* ---------------- 电影感暗角（强度随 p 连续） ---------------- */
  function drawVignette(g, world, S, a) {
    var vg = world.grads.vig;
    if (!vg) {
      vg = g.createRadialGradient(S.cx, S.cy, Math.min(S.W, S.H) * 0.36, S.cx, S.cy, Math.max(S.W, S.H) * 0.72);
      vg.addColorStop(0, 'rgba(2,4,10,0)');
      vg.addColorStop(1, 'rgba(2,4,10,0.85)');
      world.grads.vig = vg;
    }
    g.save();
    g.globalAlpha = a;
    g.fillStyle = vg;
    g.fillRect(0, 0, S.W, S.H);
    g.restore();
  }

  /* ---------------- 导出 ---------------- */
  window.AstraEngine = {
    TL: TL,
    ANCHOR: ANCHOR,
    camera: camera,                 /* 纯函数：测试与导航相机位都用它 */
    build: build,
    render: render,
    load: load,
    setSceneSource: setSceneSource, /* 统一源接口（P2 视频段登记） */
    setVideoState: setVideoState,   /* P2：视频覆盖率注入（AstraVideo 每帧调用） */
    plateWeights: plateWeights,     /* P2：主图有效权重（纯函数，测试共用） */
    probeVideoSegments: probeVideoSegments,
    sourceState: function () { return sourceState; }
  };
})();
