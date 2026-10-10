/* ============================================================
 * NEON DRIFT / 雨夜漫游 — scene.js（v2 连续世界 / 一镜到底）
 * 依 CONTINUITY-SPEC v2：一个连续世界 + 一条相机路径。
 *
 * 主图层：assets/city-tower.png（724×2172 竖幅城市剖面全景，
 *   雨夜高空 → 楼隙/街面 → 地下市场，一整张图）以 cover 语义
 *   铺满视口，滚动进度 p∈[0,1] 连续驱动相机 translateY（图顶→图底），
 *   叠加 scale 1.0→1.15→1.05 的推轨曲线。
 *   全程 translateY/scale 是 p 的连续函数——无换图、无交叉淡化。
 * 视差三平面：远景 0.7×（雨云/远处楼群灯火）/ 主图 1.0× /
 *   前景 1.3×（楼体边缘·霓虹招牌·街灯剪影，半透明+叠影=焦外）。
 * 氛围（雨/雾/色温/暗角/动态元素强度）全部是 p 的平滑连续函数；
 *   章节只是 UI 标记（ch1=图 0–33%、ch2=33–66%、ch3=66–100%），画面不随章节切换。
 * ============================================================ */
window.NEON = (function () {
  'use strict';

  /* ---------- 数学工具 ---------- */
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function seg(v, a, b) { return clamp((v - a) / (b - a), 0, 1); }
  function ss(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------- 调色板 ---------- */
  var MAG = 'rgba(255,45,149,';
  var CYN = 'rgba(38,230,255,';
  var WRM = 'rgba(255,180,84,';
  var WHT = 'rgba(235,240,255,';
  var SIGNS = ['雨', '電', '酒', '夜', '麵', '歌', '網', '藥', '燈', '市', '堂', '夢'];
  var CJK = '"Microsoft YaHei","PingFang SC","Noto Sans SC",sans-serif';

  /* ---------- 状态 ---------- */
  var cv = null, ctx = null;
  var W = 0, H = 0, DPR = 1, RM = false;
  var time = 0;      // 环境时钟（雨/蒸汽/车流等氛围动画）
  var AM = 1;        // 整帧透明度（RM 关键帧淡入淡出用）
  var SM = false;    // static 模式（reduced-motion）
  var TT = 0;        // 当前使用的环境时间
  var SPD = 0;       // 平滑滚动速度 0..1（P1 速度响应：雨丝拉伸/斜拉/掠过光带）
  var S = { cam: null, mt: 1, steamT: 0, steam: [] }; // 场景数据（resize 按面积重建）

  /* P1 速度响应入口：app.js 每帧喂入平滑后的滚动速度（RM 静态模式恒 0） */
  function setSpeed(v) { SPD = clamp(v, 0, 1); }

  function setA(x) { ctx.globalAlpha = clamp(x * AM, 0, 1); }

  /* ============================================================
   * 基础层后端 —— 统一接口（为后续视频 scrub 层预留）
   *
   * 契约：backend = { ready():boolean, draw(g, cam, alpha):void }
   *   - ready() 为 true 之前，渲染管线使用 drawFallback 夜色渐变兜底；
   *   - draw() 只负责「主图层」这一个平面（cover 铺满视口）；
   *     远景/前景视差、氛围、动态元素一律由本引擎在其上叠加，不随后端变化。
   *
   * 预留（本期仅注释，不实现）：若 assets/segment-1.mp4 / segment-2.mp4 存在，
   * 可创建 videoScrubBackend，实现「视频 scrub 优先、本引擎兜底」：
   *   ready()  —— 两段视频均 loadedmetadata 且 canPlayType 通过；
   *   draw()   —— p∈[0,0.5) → segment-1.seek(p*2*duration)，
   *               p∈[0.5,1]  → segment-2.seek((p-0.5)*2*duration)；
   *               seek 未完成（await 'seeked' 期间）与解码失败时内部回退
   *               imageBackend.draw()；视频缺失则整体回退本引擎。
   *   切换入口：NEON.setBase('video')（见下方 setBase 桩）。
   * ============================================================ */
  var IMG_SRC = 'assets/city-tower.png';
  var IMG_W = 724, IMG_H = 2172;      // 与素材一致；载入后以 naturalWidth/Height 为准
  var img = null, imgOK = false, imgT = 0;

  var imageBackend = {
    ready: function () { return imgOK; },
    load: function () {
      if (typeof Image === 'undefined' || img) return;
      img = new Image();
      img.onload = function () {
        imgOK = true;
        imgT = performance.now();
        if (W > 0 && H > 0) S.mt = cameraFor(1, W, H).travel; // 按真实尺寸刷新分布行程
      };
      img.onerror = function () { imgOK = false; }; // 保持兜底渲染（夜色渐变 + 全部氛围层）
      img.src = IMG_SRC;
    },
    draw: function (g, cam, alpha) {
      var f = ss((performance.now() - imgT) / 900);  // 载入后一次性淡入（素材预热，非滚动过渡）
      g.globalAlpha = clamp(alpha * f, 0, 1);
      g.drawImage(img, cam.dx, cam.dy, cam.dw, cam.dh);
    }
  };

  function createBaseBackend() {
    // TODO(v3 视频层)：探测 assets/segment-1.mp4 / segment-2.mp4，
    // 存在则返回 videoScrubBackend（其内部在 seek 未就绪/失败时回退 imageBackend）。
    return imageBackend;
  }
  var base = null;

  /* 预留：基础层后端切换。本期仅 'image'；'video' 待 segment-*.mp4 就绪后实现。 */
  function setBase(name) { return name === 'image'; }

  /* ============================================================
   * 相机模型（核心）：p → {scale, translateY}，连续，无换图
   *   zoom(p) = 1.0 → 1.15(p=0.5) → 1.05(p=1)，两段 smoothstep 拼接（C1 连续）
   *   cover 语义：dw ≥ W 且 dh ≥ H 恒成立；dy ∈ [H-dh, 0]，任意视口尺寸不露边
   * ============================================================ */
  function zoomOf(p) { return 1 + 0.15 * ss(seg(p, 0, 0.5)) - 0.10 * ss(seg(p, 0.5, 1)); }

  function cameraFor(p, w, h) {
    var iw = (imgOK && img && img.naturalWidth) || IMG_W;
    var ih = (imgOK && img && img.naturalHeight) || IMG_H;
    var cover = Math.max(w / iw, h / ih);       // object-fit: cover
    var z = zoomOf(p);
    var sc = cover * z;
    var dw = iw * sc, dh = ih * sc;
    var vh = h / sc;                             // 视口可见的图高（图像素）
    var cy = lerp(vh * 0.5, ih - vh * 0.5, p);   // 相机中心（图像素）：图顶正中 → 图底正中
    return {
      scale: sc, zoom: z, dw: dw, dh: dh,
      dx: (w - dw) / 2,
      dy: h * 0.5 - cy * sc,                     // 图在视口中的绘制原点（≤ 0）
      travel: cy * sc - h * 0.5,                 // 相机已下移量（屏幕像素，∈ [0, dh-h]，随 p 单调）
      iw: iw, ih: ih
    };
  }

  /* ============================================================
   * 氛围参数：全部是 p 的平滑连续函数（smoothstep 区间渐变，无章节跳变）
   * ============================================================ */
  function atmoFor(p) {
    var w1 = ss(seg(p, 0.25, 0.45));   // 高空 → 街面 色温过渡
    var w2 = ss(seg(p, 0.60, 0.80));   // 街面 → 地下 色温过渡
    var wu = ss(seg(p, 0.62, 0.80));   // 雾色转暖
    return {
      rain: (0.30 + 0.70 * ss(seg(p, 0.10, 0.38))) * (1 - ss(seg(p, 0.60, 0.76))), // 高空少→街面最密→地下 0
      fog: 0.18 + 0.42 * ss(seg(p, 0.18, 0.42)) * (1 - ss(seg(p, 0.52, 0.72))),    // 楼隙段最浓
      vig: 0.45 - 0.15 * ss(seg(p, 0.20, 0.40)) + 0.20 * ss(seg(p, 0.62, 0.85)),   // 高空强→街面弱→地下强
      veh: 1 - ss(seg(p, 0.40, 0.58)),            // 飞行器光轨（高空段）
      car: ss(seg(p, 0.30, 0.48)) * (1 - ss(seg(p, 0.62, 0.78))), // 车灯/人流（街面段）
      und: ss(seg(p, 0.62, 0.80)),                // 蒸汽/灯串（地下段）
      cloud: 1 - ss(seg(p, 0.30, 0.60)),          // 远景雨云（高空段）
      far: 1 - ss(seg(p, 0.62, 0.86)),            // 远处楼群灯火（入地淡出）
      rgb: [                                       // 光色温：高空品红青 → 街面饱和霓虹 → 地下暖黄
        lerp(lerp(64, 170, w1), 210, w2),
        lerp(lerp(96, 30, w1), 140, w2),
        lerp(lerp(150, 110, w1), 60, w2)
      ],
      fogc: [lerp(158, 240, wu), lerp(168, 196, wu), lerp(214, 158, wu)] // 雾色：冷紫 → 暖橙
    };
  }

  /* ============================================================
   * 数据重建（按屏幕面积缩放元素数量）
   * f = 元素在全程序程 [0..1] 上的分布位；屏幕位置 = f*mt - k*travel(p)
   * （k 为平面速度：远景 0.7 / 前景 1.3；主平面元素直接锚定图像坐标）
   * ============================================================ */
  function rebuild() {
    var rnd = mulberry32(20261009);
    var area = W * H;
    var sc = clamp(Math.sqrt(area / (1440 * 900)), 0.45, 1.6);
    var i, j;

    /* 远景雨云（高空段，0.7× 平面） */
    S.clouds = [];
    for (i = 0; i < Math.round(10 * sc); i++) {
      S.clouds.push({
        f: -0.28 + rnd() * 0.82, x: rnd(), rx: 0.16 + rnd() * 0.24,
        ry: 0.4 + rnd() * 0.5, a: 0.10 + rnd() * 0.12,
        sp: (0.3 + rnd() * 0.7) * (rnd() < 0.5 ? -1 : 1)
      });
    }

    /* 远处楼群灯火（0.7× 平面，screen 叠加微闪烁） */
    S.far = [];
    for (i = 0; i < Math.round(24 * sc); i++) {
      var dots = [];
      var n = 4 + ((rnd() * 5) | 0);
      for (j = 0; j < n; j++) {
        var hc = rnd();
        dots.push({
          dx: (rnd() - 0.5) * 0.045, dy: (rnd() - 0.5) * 0.03,
          c: hc < 0.5 ? WHT : hc < 0.78 ? WRM : CYN,
          a: 0.16 + rnd() * 0.26, r: 0.9 + rnd() * 1.3
        });
      }
      S.far.push({ f: -0.12 + rnd() * 0.95, x: 0.03 + rnd() * 0.94, dots: dots });
    }

    /* 前景楼体边缘剪影（1.3× 平面，半透明 + 叠影 = 焦外） */
    S.fg = [];
    for (i = 0; i < Math.round(12 * sc); i++) {
      var wins = [];
      var nw = (rnd() * 6) | 0;
      for (j = 0; j < nw; j++) {
        var hw = rnd();
        wins.push({
          u: 0.15 + rnd() * 0.7, v: rnd(),
          c: hw < 0.55 ? WRM + '0.5)' : hw < 0.8 ? WHT + '0.4)' : CYN + '0.45)'
        });
      }
      S.fg.push({
        f: -0.30 + rnd() * 1.55, side: rnd() < 0.5 ? 0 : 1,
        w: 0.05 + rnd() * 0.11, h: 0.55 + rnd() * 0.95,
        tone: rnd(), neon: rnd() < 0.55,
        edge: [MAG, CYN, WRM][(rnd() * 3) | 0],
        wins: wins
      });
    }

    /* 前景霓虹招牌（1.3×） */
    S.fgsign = [];
    for (i = 0; i < Math.round(6 * sc); i++) {
      S.fgsign.push({
        f: -0.25 + rnd() * 1.5, side: rnd() < 0.5 ? 0 : 1,
        ox: rnd() * 0.16, ch: SIGNS[(rnd() * SIGNS.length) | 0],
        col: [MAG, CYN, WRM][(rnd() * 3) | 0], w: 0.045 + rnd() * 0.03
      });
    }

    /* 前景街灯（1.3×，主要掠过街面段） */
    S.fglamp = [];
    for (i = 0; i < Math.round(6 * sc); i++) {
      S.fglamp.push({ f: 0.48 + rnd() * 0.58, x: 0.10 + rnd() * 0.80, h: 0.24 + rnd() * 0.30 });
    }

    /* 高空飞行器光轨（主平面，锚定主图坐标 iy 0.03–0.22） */
    S.veh = [];
    for (i = 0; i < Math.round(8 * sc); i++) {
      S.veh.push({
        iy: 0.03 + rnd() * 0.19, x: rnd(),
        sp: (0.05 + rnd() * 0.11) * (rnd() < 0.5 ? -1 : 1),
        len: 0.05 + rnd() * 0.08,
        c: [CYN, MAG, WRM][(rnd() * 3) | 0]
      });
    }

    /* 街面车灯（主平面，主图路面带 iy≈0.44–0.50） */
    S.cars = [];
    for (i = 0; i < Math.round(6 * sc); i++) {
      S.cars.push({
        iy: 0.442 + rnd() * 0.056, x: rnd(),
        dir: rnd() < 0.5 ? 1 : -1,
        sp: 0.03 + rnd() * 0.07,
        c: rnd() < 0.5 ? 'rgba(255,80,80,' : WRM
      });
    }

    /* 街面撑伞人流剪影（同路面带） */
    S.crowd = [];
    for (i = 0; i < Math.round(16 * sc); i++) {
      S.crowd.push({
        iy: 0.440 + rnd() * 0.062, x: rnd(),
        s: 0.75 + rnd() * 0.55, ph: rnd() * 6.28,
        ph1: rnd() < 0.35,
        sp: (0.004 + rnd() * 0.010) * (rnd() < 0.5 ? -1 : 1)
      });
    }

    /* 地下蒸汽源（主图市场带 iy≈0.86–0.95） */
    S.vents = [
      { ix: 0.30, iy: 0.875 }, { ix: 0.62, iy: 0.905 },
      { ix: 0.80, iy: 0.865 }, { ix: 0.45, iy: 0.945 }
    ];
    S.steam = [];
    S.steamT = 0;
    for (i = 0; i < 12; i++) {   // 预置静态蒸汽（RM 静态帧也可见）
      var vv = S.vents[i % S.vents.length];
      S.steam.push({
        ix: vv.ix + (rnd() - 0.5) * 0.03, iy: vv.iy - rnd() * 0.028,
        r: 3 + rnd() * 20, age: rnd() * 2.4, life: 3.2,
        vx: 0, vy: -0.010
      });
    }

    /* 地下灯串（主图 iy≈0.79–0.88，弧垂暖灯泡） */
    S.strng = [];
    for (i = 0; i < Math.round(5 * sc); i++) {
      S.strng.push({
        iy: 0.79 + rnd() * 0.09, sag: 0.018 + rnd() * 0.022,
        n: 7 + ((rnd() * 5) | 0), ph: rnd() * 6.28
      });
    }

    /* 雨丝（屏幕空间，数量按面积缩放；强度由 atmoFor(p).rain 门控） */
    S.rain = [];
    var nR = Math.round(clamp(area / 8500, 50, 240));
    for (i = 0; i < nR; i++) {
      S.rain.push({
        x: rnd() * (W + 120) - 60, y: rnd() * H,
        sp: (1.05 + rnd() * 0.95) * H,
        len: 13 + rnd() * 15,
        m: rnd() < 0.14
      });
    }
  }

  /* ============================================================
   * 尺寸 / 初始化
   * ============================================================ */
  function resize(w, h, rm) {
    W = Math.max(320, Math.round(w));
    H = Math.max(240, Math.round(h));
    RM = !!rm;
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    if (cv) {
      cv.width = Math.round(W * DPR);
      cv.height = Math.round(H * DPR);
    }
    if (ctx) ctx.imageSmoothingQuality = 'high';
    rebuild();
    S.mt = cameraFor(1, W, H).travel;   // 全程相机位移（前景/远景元素分布用）
  }
  function init(canvas, w, h, rm) {
    cv = canvas;
    ctx = canvas.getContext('2d');
    base = createBaseBackend();
    if (base.load) base.load();
    resize(w, h, rm);
  }

  /* ============================================================
   * 氛围粒子推进（相机不动时雨/蒸汽也保持生命感）
   * ============================================================ */
  function tick(dt, p) {
    time += dt;
    var A = atmoFor(p);
    var i;
    for (i = 0; i < S.rain.length; i++) {
      var r = S.rain[i];
      r.y += r.sp * dt * (1 + SPD * 1.15);          // 快滚雨落更急（速度响应）
      r.x += (26 + 80 * A.rain + 70 * SPD) * dt;
      if (r.y > H + 24) { r.y = -24 - Math.random() * 60; r.x = Math.random() * (W + 120) - 90; }
      if (r.x > W + 70) r.x -= W + 140;
      else if (r.x < -70) r.x += W + 140;
    }
    if (A.und > 0.08 && S.cam) {
      S.steamT -= dt;
      if (S.steamT <= 0) {
        S.steamT = 0.22;
        var v = S.vents[(Math.random() * S.vents.length) | 0];
        S.steam.push({
          ix: v.ix + (Math.random() - 0.5) * 0.03, iy: v.iy,
          r: 3, age: 0, life: 2.6 + Math.random() * 1.2,
          vx: (Math.random() - 0.5) * 0.004, vy: -(0.010 + Math.random() * 0.008)
        });
        if (S.steam.length > 36) S.steam.shift();
      }
    }
    for (i = S.steam.length - 1; i >= 0; i--) {
      var st = S.steam[i];
      st.age += dt; st.ix += st.vx * dt; st.iy += st.vy * dt; st.r += 9 * dt;
      if (st.age > st.life) S.steam.splice(i, 1);
    }
  }

  /* ============================================================
   * 通用绘制件
   * ============================================================ */

  /* 霓虹招牌板：发光描边 + 汉字（前景层复用） */
  function neonBoard(x, y, w2, h2, txt, col, horiz) {
    ctx.save();
    ctx.strokeStyle = col + '0.9)';
    ctx.lineWidth = 2;
    ctx.shadowColor = col + '0.9)';
    ctx.shadowBlur = 16;
    ctx.strokeRect(x, y, w2, h2);
    ctx.shadowBlur = 7;
    ctx.strokeRect(x, y, w2, h2);
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = 'rgba(6,3,16,0.72)';
    ctx.fillRect(x + 2, y + 2, w2 - 4, h2 - 4);
    var n = txt.length;
    ctx.shadowColor = col + '1)';
    ctx.shadowBlur = 14;
    ctx.fillStyle = col + '1)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (horiz) {
      var pxh = Math.min(h2 * 0.52, w2 / n * 0.72);
      ctx.font = '700 ' + pxh + 'px ' + CJK;
      for (var i = 0; i < n; i++) ctx.fillText(txt[i], x + w2 * (i + 0.5) / n, y + h2 / 2 + 1);
      ctx.fillStyle = WHT + '0.85)';
      ctx.shadowBlur = 4;
      for (var j = 0; j < n; j++) ctx.fillText(txt[j], x + w2 * (j + 0.5) / n, y + h2 / 2 + 1);
    } else {
      var pxv = Math.min(w2 * 0.62, h2 * 0.40);
      ctx.font = '700 ' + pxv + 'px ' + CJK;
      ctx.fillText(txt, x + w2 / 2, y + h2 / 2 + 1);
      ctx.fillStyle = WHT + '0.85)';
      ctx.shadowBlur = 4;
      ctx.fillText(txt, x + w2 / 2, y + h2 / 2 + 1);
    }
    ctx.restore();
  }

  /* 撑伞人剪影（s 为伞半径，屏幕像素） */
  function person(x, y, s, ph, phone) {
    var bob = SM ? 0 : Math.sin(TT * 1.7 + ph) * s * 0.12;
    ctx.fillStyle = '#05030c';
    ctx.beginPath();
    ctx.arc(x, y + bob, s, Math.PI, 0);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(x - s * 0.055, y + bob, s * 0.11, s * 1.9);
    ctx.beginPath();
    ctx.moveTo(x - s * 0.5, y + bob + s * 2.0);
    ctx.lineTo(x - s * 0.28, y + bob + s * 0.9);
    ctx.lineTo(x + s * 0.28, y + bob + s * 0.9);
    ctx.lineTo(x + s * 0.5, y + bob + s * 2.0);
    ctx.closePath();
    ctx.fill();
    if (phone) {
      ctx.fillStyle = WRM + '0.9)';
      ctx.fillRect(x + s * 0.14, y + bob + s * 1.1, s * 0.16, s * 0.28);
    }
  }

  /* ============================================================
   * 1) 主图层（基础层后端：图片相机 / 预留视频 scrub）
   * ============================================================ */
  function drawBase(cam) {
    if (base && base.ready()) {
      base.draw(ctx, cam, AM);
    } else {
      /* 兜底：主图载入前/失败的深夜渐变（其余氛围层照常叠加，站点不空白） */
      var g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#04030e');
      g.addColorStop(0.6, '#0a0520');
      g.addColorStop(1, '#070312');
      setA(0.96);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
  }

  /* ============================================================
   * 2) 远景层 0.7×：雨云（高空）+ 远处楼群灯火（screen 叠加）
   * ============================================================ */
  function drawFar(cam, A) {
    var trav = cam.travel, mt = S.mt, i, j;
    if (A.cloud > 0.02) {
      for (i = 0; i < S.clouds.length; i++) {
        var c = S.clouds[i];
        var y = c.f * mt - 0.7 * trav;             // 远景平面 0.7×
        if (y < -H * 0.6 || y > H * 1.2) continue;
        var fx = ((c.x + (SM ? 0.3 : TT * 0.004 * c.sp)) % 1.3 + 1.3) % 1.3;
        var x = fx * W * 1.3 - W * 0.15;
        var rw = c.rx * W;
        var g = ctx.createRadialGradient(0, 0, 0, 0, 0, rw);
        g.addColorStop(0, 'rgba(150,158,205,' + (c.a * A.cloud).toFixed(3) + ')');
        g.addColorStop(1, 'rgba(150,158,205,0)');
        ctx.save();
        setA(1);
        ctx.translate(x, y);
        ctx.scale(1, c.ry);
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(0, 0, rw, 0, 6.283); ctx.fill();
        ctx.restore();
      }
    }
    if (A.far > 0.02) {
      ctx.globalCompositeOperation = 'screen';
      for (i = 0; i < S.far.length; i++) {
        var fc = S.far[i];
        var fy = fc.f * mt - 0.7 * trav;
        if (fy < -30 || fy > H + 30) continue;
        var bx = fc.x * W + (SM ? 0 : Math.sin(TT * 0.05 + i) * 2);
        for (j = 0; j < fc.dots.length; j++) {
          var d = fc.dots[j];
          var tw = SM ? 0.8 : 0.65 + 0.35 * Math.abs(Math.sin(TT * 0.9 + i * 1.3 + j * 2.1));
          setA(d.a * tw * A.far);
          ctx.fillStyle = d.c + '1)';
          ctx.fillRect(bx + d.dx * W, fy + d.dy * H, d.r, d.r);
        }
      }
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  /* ============================================================
   * 3) 主平面动态元素（锚定主图坐标，强度随 p 连续淡入淡出，不硬切）
   *    高空：飞行器光轨 / 街面：车灯 + 人流 / 地下：灯串 + 蒸汽
   * ============================================================ */
  function drawDynamics(cam, A) {
    var i;
    if (A.veh > 0.01) {
      for (i = 0; i < S.veh.length; i++) {
        var v = S.veh[i];
        var vy = cam.dy + v.iy * cam.dh;
        if (vy < -30 || vy > H + 30) continue;
        var fx = ((v.x + (SM ? 0.4 : TT * v.sp)) % 1.25 + 1.25) % 1.25 - 0.125;
        var vx = cam.dx + fx * cam.dw;
        var dir = v.sp >= 0 ? 1 : -1;
        var L = v.len * W;
        var g = ctx.createLinearGradient(vx, vy, vx - dir * L, vy);
        g.addColorStop(0, v.c + (0.8 * A.veh).toFixed(3) + ')');
        g.addColorStop(1, v.c + '0)');
        setA(1);
        ctx.strokeStyle = g;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(vx, vy);
        ctx.lineTo(vx - dir * L, vy);
        ctx.stroke();
        setA(0.9 * A.veh);
        ctx.fillStyle = v.c + '1)';
        ctx.beginPath(); ctx.arc(vx, vy, 1.8, 0, 6.283); ctx.fill();
      }
    }
    if (A.car > 0.01) {
      for (i = 0; i < S.cars.length; i++) {
        var cr = S.cars[i];
        var cy2 = cam.dy + cr.iy * cam.dh;
        if (cy2 < -30 || cy2 > H + 30) continue;
        var cfx = ((cr.x + (SM ? 0.5 : TT * cr.sp * cr.dir)) % 1.15 + 1.15) % 1.15 - 0.075;
        var cx2 = cam.dx + cfx * cam.dw;
        var L2 = W * 0.06;
        var g2 = ctx.createLinearGradient(cx2, cy2, cx2 - cr.dir * L2, cy2);
        g2.addColorStop(0, cr.c + (0.8 * A.car).toFixed(3) + ')');
        g2.addColorStop(1, cr.c + '0)');
        setA(1);
        ctx.strokeStyle = g2;
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.moveTo(cx2, cy2);
        ctx.lineTo(cx2 - cr.dir * L2, cy2);
        ctx.stroke();
      }
      for (i = 0; i < S.crowd.length; i++) {
        var pd = S.crowd[i];
        var py = cam.dy + pd.iy * cam.dh;
        if (py < -40 || py > H + 40) continue;
        var px = ((pd.x + (SM ? 0.5 : TT * pd.sp)) % 1.1 + 1.1) % 1.1 - 0.05;
        setA(0.9 * A.car);
        person(cam.dx + px * cam.dw, py, 9 * cam.scale * pd.s, pd.ph, pd.ph1);
      }
    }
    if (A.und > 0.01) {
      /* 灯串：弧垂暖灯泡，微微摆动 */
      for (i = 0; i < S.strng.length; i++) {
        var s2 = S.strng[i];
        var y0 = cam.dy + s2.iy * cam.dh;
        if (y0 < -80 || y0 > H + 160) continue;
        var sag = (s2.sag + (SM ? 0 : Math.sin(TT * 0.7 + s2.ph) * 0.006)) * H;
        setA(0.8 * A.und);
        ctx.strokeStyle = 'rgba(16,9,6,0.9)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(-30, y0);
        ctx.quadraticCurveTo(W / 2, y0 + sag * 2, W + 30, y0);
        ctx.stroke();
        ctx.save();
        ctx.shadowColor = WRM + '0.9)';
        ctx.shadowBlur = 7;
        ctx.fillStyle = WRM + '1)';
        for (var b = 0; b < s2.n; b++) {
          var t = (b + 0.5) / s2.n;
          var bx2 = lerp(-30, W + 30, t);
          var by2 = y0 + sag * 2 * 2 * t * (1 - t);   // 二次贝塞尔 y(t)
          setA(A.und * (0.6 + 0.4 * (SM ? 0.5 : Math.sin(TT * 2.2 + b * 1.7 + s2.ph))));
          ctx.beginPath(); ctx.arc(bx2, by2, 2.1, 0, 6.283); ctx.fill();
        }
        ctx.restore();
      }
      /* 蒸汽（图像坐标锚定，随相机移动） */
      for (i = 0; i < S.steam.length; i++) {
        var st = S.steam[i];
        var sx = cam.dx + st.ix * cam.dw;
        var sy = cam.dy + st.iy * cam.dh;
        var sr = st.r * cam.scale;
        if (sy < -sr || sy > H + sr) continue;
        var sa = 0.14 * (1 - st.age / st.life) * A.und;
        if (sa <= 0.004) continue;
        var sg = ctx.createRadialGradient(sx, sy, 0, sx, sy, sr);
        sg.addColorStop(0, 'rgba(226,222,206,' + sa.toFixed(3) + ')');
        sg.addColorStop(1, 'rgba(226,222,206,0)');
        setA(1);
        ctx.fillStyle = sg;
        ctx.beginPath(); ctx.arc(sx, sy, sr, 0, 6.283); ctx.fill();
      }
    }
  }

  /* ============================================================
   * 4) 雾：缓慢漂移的横带（浓度是 p 的连续函数）+ 地下暖雾
   * ============================================================ */
  function drawFog(A) {
    var i;
    if (A.fog > 0.02) {
      var col = 'rgba(' + Math.round(A.fogc[0]) + ',' + Math.round(A.fogc[1]) + ',' + Math.round(A.fogc[2]) + ',';
      var fa = (A.fog * 0.14).toFixed(3);
      for (i = 0; i < 4; i++) {
        var phz = i / 4 + (SM ? 0.22 : TT * 0.006 * (i % 2 ? 1 : -1));
        phz = ((phz % 1) + 1) % 1;
        var cy3 = phz * (H * 1.6) - H * 0.3;
        var hh = H * 0.34;
        var g = ctx.createLinearGradient(0, cy3 - hh, 0, cy3 + hh);
        g.addColorStop(0, col + '0)');
        g.addColorStop(0.5, col + fa + ')');
        g.addColorStop(1, col + '0)');
        setA(1);
        ctx.fillStyle = g;
        ctx.fillRect(0, cy3 - hh, W, hh * 2);
      }
    }
    if (A.und > 0.02) {
      var g2 = ctx.createLinearGradient(0, H * 0.55, 0, H);
      g2.addColorStop(0, 'rgba(255,172,84,0)');
      g2.addColorStop(1, 'rgba(255,172,84,' + (0.13 * A.und).toFixed(3) + ')');
      setA(1);
      ctx.fillStyle = g2;
      ctx.fillRect(0, H * 0.5, W, H * 0.5);
    }
  }

  /* ============================================================
   * 5) 前景层 1.3×：楼体边缘 / 霓虹招牌 / 街灯（半透明 + 叠影 = 焦外）
   * ============================================================ */
  function drawForeground(cam) {
    var trav = cam.travel, mt = S.mt, i, j;
    for (i = 0; i < S.fg.length; i++) {
      var sl = S.fg[i];
      var y = sl.f * mt - 1.3 * trav;             // 前景平面 1.3×
      var hp = sl.h * H;
      if (y > H + 140 || y + hp < -140) continue;
      var wp = sl.w * W;
      var x = sl.side ? W - wp : 0;
      setA(0.14);
      ctx.fillStyle = '#020109';
      ctx.fillRect(x + 9, y + 9, wp, hp);          // 焦外叠影
      setA(0.40 + 0.20 * sl.tone);
      ctx.fillStyle = '#04020c';
      ctx.fillRect(x, y, wp, hp);
      for (j = 0; j < sl.wins.length; j++) {
        var wd = sl.wins[j];
        setA(0.5);
        ctx.fillStyle = wd.c;
        ctx.fillRect(x + wd.u * wp, y + wd.v * hp, 2.2, 2.8);
      }
      if (sl.neon) {
        var ex = sl.side ? x + 2 : x + wp - 2;
        ctx.save();
        setA(0.5);
        ctx.shadowColor = sl.edge + '0.8)';
        ctx.shadowBlur = 12;
        ctx.strokeStyle = sl.edge + '0.6)';
        ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.moveTo(ex, y); ctx.lineTo(ex, y + hp); ctx.stroke();
        ctx.restore();
      }
    }
    for (i = 0; i < S.fgsign.length; i++) {
      var sg2 = S.fgsign[i];
      var sy2 = sg2.f * mt - 1.3 * trav;
      var bw = sg2.w * W, bh = bw * 2.4;
      if (sy2 > H + bh || sy2 + bh < -bh) continue;
      var sx2 = sg2.side ? W * (0.70 + sg2.ox) : W * (0.30 - sg2.ox) - bw;
      setA(0.85);
      neonBoard(sx2, sy2, bw, bh, sg2.ch, sg2.col, false);
    }
    for (i = 0; i < S.fglamp.length; i++) {
      var lp = S.fglamp[i];
      var ly = lp.f * mt - 1.3 * trav;
      var lh = lp.h * H;
      if (ly > H + 60 || ly + lh < -60) continue;
      var lx = lp.x * W;
      var arm = lp.x < 0.5 ? 1 : -1;
      setA(0.55);
      ctx.strokeStyle = '#050310';
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx, ly + lh); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx + 18 * arm, ly); ctx.stroke();
      var lgx = lx + 18 * arm, lgy = ly + 3;
      var lg = ctx.createRadialGradient(lgx, lgy, 0, lgx, lgy, 26);
      lg.addColorStop(0, 'rgba(255,196,110,0.55)');
      lg.addColorStop(1, 'rgba(255,196,110,0)');
      setA(1);
      ctx.fillStyle = lg;
      ctx.beginPath(); ctx.arc(lgx, lgy, 26, 0, 6.283); ctx.fill();
      setA(0.95);
      ctx.fillStyle = '#ffd9a0';
      ctx.beginPath(); ctx.arc(lgx, lgy, 2.6, 0, 6.283); ctx.fill();
    }
  }

  /* ============================================================
   * 6) 雨丝（屏幕空间近景斜落；密度/alpha/倾角随 rain(p) 连续变化；
   *    滚动速度 SPD → 拉丝加长 + 倾角更斜（快滚斜拉丝，P1 速度响应））
   * ============================================================ */
  function drawRain(A) {
    var inten = clamp(A.rain, 0, 1);
    if (inten <= 0.02) return;
    var slant = 0.16 + 0.26 * inten + 0.34 * SPD;   // 快滚 → 斜拉
    var stretch = 1 + 1.7 * SPD;                    // 快滚 → 拉丝
    var n = Math.ceil(S.rain.length * inten);
    var i, r;
    ctx.lineWidth = 1;
    setA(inten);
    ctx.strokeStyle = 'rgba(170,225,255,0.34)';
    ctx.beginPath();
    for (i = 0; i < n; i++) {
      if (S.rain[i].m) continue;
      r = S.rain[i];
      ctx.moveTo(r.x, r.y);
      ctx.lineTo(r.x - r.len * slant * 2.4 * stretch, r.y + r.len * stretch);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,120,200,0.30)';
    ctx.beginPath();
    for (i = 0; i < n; i++) {
      if (!S.rain[i].m) continue;
      r = S.rain[i];
      ctx.moveTo(r.x, r.y);
      ctx.lineTo(r.x - r.len * slant * 2.4 * stretch, r.y + r.len * stretch);
    }
    ctx.stroke();
  }

  /* ============================================================
   * 6b) 速度光带（P1）：快滚时楼隙间掠过的竖向速度线，
   *     位于 1.6× 平面（比前景 1.3× 更快）增强「掠过」速度感；
   *     静态模式（SM）与慢滚（SPD<0.12）不绘制
   * ============================================================ */
  function drawStreaks() {
    if (SM || SPD < 0.12) return;
    var trav = S.cam ? S.cam.travel : 0;
    var k = 1.6;
    var L = H * (0.16 + 0.42 * SPD);
    var span = k * S.mt + H + L * 2;
    var al = 0.04 + 0.11 * SPD;
    var xs = [0.06, 0.13, 0.30, 0.50, 0.79, 0.90];
    ctx.lineWidth = 1.4;
    for (var i = 0; i < xs.length; i++) {
      var f = (i * 0.1618 + 0.08) % 1;
      var y = ((f * span - k * trav) % span + span) % span - L;
      if (y > H + L || y + L < 0) continue;
      var x = xs[i] * W;
      var col = i % 2 ? '255,150,210' : '185,228,255';   // 青/品红交替
      var g = ctx.createLinearGradient(x, y, x + 6, y + L);
      g.addColorStop(0, 'rgba(' + col + ',0)');
      g.addColorStop(0.5, 'rgba(' + col + ',' + al.toFixed(3) + ')');
      g.addColorStop(1, 'rgba(' + col + ',0)');
      setA(1);
      ctx.strokeStyle = g;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 6, y + L);
      ctx.stroke();
    }
  }

  /* ============================================================
   * 7) 色温（soft-light 全屏罩，颜色是 p 的连续函数）+ 暗角
   * ============================================================ */
  function drawGrade(A) {
    ctx.globalCompositeOperation = 'soft-light';
    setA(0.5);
    ctx.fillStyle = 'rgb(' + Math.round(A.rgb[0]) + ',' + Math.round(A.rgb[1]) + ',' + Math.round(A.rgb[2]) + ')';
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
    var R = Math.max(W, H) * 0.75;
    var g = ctx.createRadialGradient(W / 2, H * 0.47, Math.min(W, H) * 0.40, W / 2, H * 0.5, R);
    g.addColorStop(0, 'rgba(2,1,8,0)');
    g.addColorStop(1, 'rgba(2,1,8,' + clamp(A.vig, 0, 0.85).toFixed(3) + ')');
    setA(1);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  /* ============================================================
   * 主渲染入口：单一世界的连续参数化绘制（无章节分支、无换图）
   * noClear=true 供 RM 静态模式叠加第二帧（两个相机位取景的真交叉溶解）
   * ============================================================ */
  function render(p, alphaMul, staticMode, noClear) {
    if (!ctx) return;
    AM = alphaMul == null ? 1 : alphaMul;
    SM = !!staticMode;
    TT = SM ? 8.5 : time;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    if (!noClear) ctx.clearRect(0, 0, W, H);
    var cam = cameraFor(p, W, H);
    S.cam = cam;
    var A = atmoFor(p);
    drawBase(cam);        // 1) 主图层（图片相机 / 预留视频 scrub 后端）
    drawFar(cam, A);      // 2) 远景 0.7×：雨云 + 远处楼群灯火
    drawDynamics(cam, A); // 3) 主平面动态：光轨 / 车灯人流 / 灯串蒸汽
    drawFog(A);           // 4) 雾（横带漂移 + 地下暖雾）
    drawForeground(cam);  // 5) 前景 1.3×：楼缘 / 招牌 / 街灯 剪影（焦外）
    drawStreaks();        // 6b) 速度光带（快滚楼隙掠过感）
    drawRain(A);          // 6) 雨丝（屏幕空间，速度→拉丝/斜拉）
    drawGrade(A);         // 7) 色温 + 暗角
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  return {
    init: init,
    resize: resize,
    tick: tick,
    render: render,
    setSpeed: setSpeed,    // P1 速度响应：喂入平滑滚动速度 0..1
    cameraFor: cameraFor,  // 相机参数（连续性测试 / 视频层同步用）
    atmoFor: atmoFor,      // 氛围参数（连续性测试 / 调试用）
    setBase: setBase       // 基础层后端切换（预留视频 scrub，本期仅 'image'）
  };
})();
