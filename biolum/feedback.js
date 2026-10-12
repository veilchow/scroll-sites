/* ============================================================
 * BIOLUM 蓝眼泪 — feedback.js（模板派生，内容按 PLAN-DESIGN §1.3/§1.5 题材化）
 * 计量 HUD 四计量（机制外壳继承自模板）：
 *   CH1 潮汐时钟 19:42→21:17（HH:MM 翻牌感）+ 追光步速 0-88 步/分（速度联动）
 *   CH2 发光指数 0→100% + 夜光藻爆发等级 Ⅰ-Ⅴ（阈值跳变）+ 双筒望远镜
 *   CH3 水下深度 0.0→8.0m（p≥71.7% 破水激活走数 + ±0.1m 悬浮呼吸漂移）
 *     + 爆发等级翻牌（Ⅰ→Ⅴ 定格奖牌）+ 双态温度 气温22°→水温18° + 抵达
 * 穿越时刻（门控 33%/66% 位置继承，与视频接缝对齐）：
 *   T1 夜幕初光（id 0）：sting + bio 饱和度脉冲 + 冷色 flash + 微震 +
 *     HUD 翻滚退场 + 望远镜收起编舞（land→folded 两段式，时序继承）
 *   T2 破水入水（id 1）：sting + 暖色 flash + 微震 + HUD 翻滚退场 +
 *     爆发等级翻牌（60ms 起翻 + 520ms 第二声咔哒）+ 双态温度滚动
 *   破水峰值 p=71.7%：深度计灰→亮点亮 + 深青 flash（DET 内部探测器）
 * 结构：
 *   BIOFX.core —— 纯函数核心（Node 桩可测：插值/章界去重/速度映射）
 *   BIOFX.init/update/transit/onActivity —— DOM HUD 驱动（app.js 调用）
 * 约束：prefers-reduced-motion 下无微震无动画（HUD 淡切）；
 *   全部 HUD 元素挂 .ui 类，H/Esc 口播模式随 body.ui-hidden 隐藏。
 * ============================================================ */
window.BIOFX = (function () {
  'use strict';

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }

  /* ============================================================
   * 纯核心（Node 桩测试直接驱动，无 DOM 依赖）
   * ============================================================ */
  var B1 = 1 / 3, B2 = 2 / 3;                 // 章界 33% / 66%（继承）
  var TIDE0 = 1182, TIDE1 = 1277;             // SEG1 潮汐时刻 19:42 → 21:17（满潮定格；当日分钟数）
  var GLOW0 = 0, GLOW1 = 100;                 // SEG2 发光指数 0% → 100%
  var BURST_TH = [20, 40, 60, 80];            // 爆发等级阈值（发光指数 %处跳级）
  var BURST_LV = ['Ⅰ SPARK', 'Ⅱ RIPPLE', 'Ⅲ SURGE', 'Ⅳ BLOOM', 'Ⅴ SEA OF LIGHT'];
  var DEPTH1 = 8;                             // SEG3 水下深度 0.0 → 8.0 m（递增）
  var DEPTH_ON = 0.717;                       // 破水激活位（v3 片内 t≈1.0s 的确定性映射）
  var T_AIR = 22, T_WATER = 18;               // 双态温度：气温 22° → 水温 18°
  var HYST = 0.015;                           // 章界触发滞回窗（±1.5%）

  function segT(p, lo, hi) { return clamp((p - lo) / (hi - lo), 0, 1); }

  function tideAt(p) { return Math.round(lerp(TIDE0, TIDE1, segT(p, 0, B1))); }   // 分钟数
  function fmtTide(m) { return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60); }   // HH:MM 车站翻页钟
  function glowAt(p) { return Math.round(lerp(GLOW0, GLOW1, segT(p, B1, B2))); }  // 发光指数 %
  function burstAt(p) {                                                        // 爆发等级 0-4（阈值跳变，非累加计数）
    var g = glowAt(p), lv = 0;
    for (var i = 0; i < BURST_TH.length; i++) { if (g >= BURST_TH[i]) lv = i + 1; }
    return lv;
  }
  function depthAt(p) { return lerp(0, DEPTH1, segT(p, B2, 1)); }                // 深度 m 递增（同 altitudeAt 结构）
  /* 追光步速（步/分）：公式与封顶值继承零改动（0-88 平方压缩可信区间，
     严格随滚动速度单调、有界）；停滚随惯性衰减回 0 */
  function vspeedOf(sps) { return Math.min(88, 27 * Math.sqrt(Math.max(0, sps) * 13.5)); }
  function chapterOf(p) { return p < B1 ? 0 : p < B2 ? 1 : 2; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* 章界探测器：向下越过界线触发一次；退回界线以下 hyst 之外才重新武装
     （阻尼缓动在界线附近的抖动不会重复触发 —— 去重） */
  function makeTransitDetector(bounds, hyst) {
    var hs = hyst == null ? HYST : hyst;
    var armed = [];
    for (var i = 0; i < bounds.length; i++) armed.push(true);
    return function (p) {
      var out = [];
      for (var i = 0; i < bounds.length; i++) {
        var b = bounds[i];
        if (armed[i] && p >= b) { armed[i] = false; out.push(i); }
        else if (!armed[i] && p < b - hs) { armed[i] = true; }
      }
      return out;
    };
  }

  var core = {
    B1: B1, B2: B2,
    TIDE0: TIDE0, TIDE1: TIDE1, GLOW0: GLOW0, GLOW1: GLOW1,
    BURST_TH: BURST_TH, BURST_LV: BURST_LV, DEPTH1: DEPTH1, DEPTH_ON: DEPTH_ON,
    T_AIR: T_AIR, T_WATER: T_WATER,
    tideAt: tideAt, fmtTide: fmtTide, glowAt: glowAt, burstAt: burstAt, depthAt: depthAt,
    vspeedOf: vspeedOf, chapterOf: chapterOf, pad2: pad2,
    makeTransitDetector: makeTransitDetector
  };

  /* ============================================================
   * DOM 层（浏览器；Node 桩环境 init 不会被调用，update 自动短路）
   * ============================================================ */
  var E = null;              // 元素缓存（init 成功前为 null）
  var opts = null;           // { rm():boolean, onSting(id), onFlick(), onArrive() }
  var curCh = -1;
  var arriveLit = false;
  var started = false;       // 首次输入后才开始待机计时
  var lastAct = 0;           // 最近一次输入（performance.now()；0=尚无）
  var idleOn = false;
  var timers = [];
  var last = { tide: '', vs: '', glow: '', burst: '', depth: '', depthOn: false, hudSpd: -1 };

  function isRM() { return !!(opts && opts.rm && opts.rm()); }

  function init(o) {
    opts = o || {};
    var d = typeof document !== 'undefined' ? document : null;
    if (!d) return false;
    var q = function (id) { return d.getElementById(id); };
    E = {
      hud: q('hud'),
      groups: [q('hud-seg1'), q('hud-seg2'), q('hud-seg3')],
      tide: q('hud-tide'), vs: q('hud-vs'),
      glow: q('hud-glow'), burst: q('hud-burst'), bino: q('bino'),
      depth: q('hud-depth'), depthBig: q('hud-depth-big'),
      floor: q('hud-floor'), temp: q('hud-temp'),
      arrive: q('hud-arrive'),
      idle: q('idle-hint'),
      stage: q('stage'),
      flash: q('flash')
    };
    if (!E.hud || !E.groups[0]) { E = null; return false; }
    return true;
  }

  function later(fn, ms) {
    timers.push(setTimeout(function () { fn(); }, ms));
  }
  function clearTimers() {
    for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]);
    timers = [];
  }
  function setText(el, s, cacheKey) {
    if (!el || last[cacheKey] === s) return;
    last[cacheKey] = s;
    el.textContent = s;
  }

  /* ---------- 章组切换（双向通用；delayMs=旧组翻滚退场时长） ---------- */
  function setChapter(ch, delayMs) {
    if (curCh === ch) return;
    var prev = curCh;
    curCh = ch;
    var outG = prev >= 0 ? E.groups[prev] : null;
    var inG = E.groups[ch];
    var rm = isRM();
    if (outG) {
      if (!rm && delayMs) {
        outG.classList.add('roll-out');
        (function (g, ms) {
          later(function () { g.classList.remove('active', 'roll-out', 'in'); }, ms);
        })(outG, delayMs);
      } else {
        outG.classList.remove('active', 'roll-out', 'in');
      }
    }
    inG.classList.remove('in', 'roll-out');
    void inG.offsetWidth;                      // 重启入场动画
    inG.classList.add('active', 'in');
    if (ch < prev) { resetTransients(); }      // 回退方向：复位翻牌/望远镜/温度/深度计，供下次正向穿越重放
  }

  function resetTransients() {
    if (E.floor) E.floor.classList.remove('b2');
    if (E.bino) E.bino.classList.remove('folded', 'land');
    if (E.temp) E.temp.textContent = '气温 ' + T_AIR + '°';
    if (E.depthBig) E.depthBig.classList.remove('on');
    last.depth = '';
    last.depthOn = false;
    stopTempAnim();
  }

  /* ---------- 穿越时刻视觉（微震/脉冲/flash；RM 全部跳过） ---------- */
  function stageFX(kind) {
    if (!E.stage || isRM()) return;
    var st = E.stage;
    if (kind === 'shake') { st.classList.remove('shake'); void st.offsetWidth; st.classList.add('shake'); }
    if (kind === 'bio') { st.classList.remove('bio-pulse'); void st.offsetWidth; st.classList.add('bio-pulse'); }
    if ((kind === 'cool' || kind === 'warm' || kind === 'deep') && E.flash) {
      var f = E.flash;
      f.className = '';
      void f.offsetWidth;
      f.classList.add(kind);
      later(function () { f.classList.remove(kind); }, 620);
    }
  }

  /* ---------- 望远镜：夜幕落下收起（CSS transform 过渡；RM 瞬时到位） ---------- */
  function foldBinoculars() {
    if (!E.bino) return;
    E.bino.classList.add('land');
    later(function () { E.bino.classList.add('folded'); }, 240);   // 触地 → 收拢挂回身侧
  }

  /* ---------- 爆发等级翻牌 Ⅰ→Ⅴ（rotateX 整牌机械翻转 + 两声咔哒） ---------- */
  function playFlip() {
    if (!E.floor) return;
    var fl = E.floor;
    fl.classList.remove('b2');
    void fl.offsetWidth;
    later(function () {
      fl.classList.add('b2');
      if (opts && opts.onFlick && !isRM()) opts.onFlick();
      later(function () { if (opts && opts.onFlick && !isRM()) opts.onFlick(); }, 520);
    }, 60);
  }

  /* ---------- 双态温度 气温22°→水温18°（数字滚动 + 标签切换） ---------- */
  var tempTimer = 0;
  function stopTempAnim() { if (tempTimer) { clearInterval(tempTimer); tempTimer = 0; } }
  function animTemp() {
    if (!E.temp) return;
    if (isRM()) { E.temp.textContent = '水温 ' + T_WATER + '°'; return; }
    var el = E.temp, t0 = performance.now();
    stopTempAnim();
    tempTimer = setInterval(function () {
      var k = clamp((performance.now() - t0 - 500) / 900, 0, 1);   // 翻牌后再滚温
      var v = Math.round(lerp(T_AIR, T_WATER, k));
      el.textContent = (k < 0.5 ? '气温 ' : '水温 ') + v + '°';
      if (k >= 1) stopTempAnim();
    }, 40);
  }

  /* ---------- 穿越时刻（app.js 在进度越界瞬间调用；id 0=T1 1=T2） ---------- */
  function transit(id) {
    if (!E) return;
    if (isRM()) return;                          // RM：无 sting 无动画，update 的淡切已足够
    clearTimers();
    stopTempAnim();
    if (id === 0) {
      /* T1 · 夜幕初光：点亮 sting + bio 饱和度脉冲 + 冷色 flash + 微震
         HUD：潮汐时钟翻滚退场(240ms) → 发光指数淡入 + 望远镜收起 */
      if (opts && opts.onSting) opts.onSting(0);
      stageFX('bio'); stageFX('cool'); stageFX('shake');
      setChapter(1, 240);
      foldBinoculars();
    } else if (id === 1) {
      /* T2 · 破水入水：骤闷 sting + 暖色 flash + 微震
         HUD：发光指数退场 → 爆发等级翻牌 Ⅰ→Ⅴ + 温度 气温22°→水温18° */
      if (opts && opts.onSting) opts.onSting(1);
      stageFX('warm'); stageFX('shake');
      setChapter(2, 240);
      playFlip();
      animTemp();
    }
  }

  /* ---------- 抵达（SEG3 尾端 8m 悬浮稳住） ---------- */
  function updateArrive(p) {
    if (!E.arrive) return;
    if (p >= 0.995 && !arriveLit) {
      arriveLit = true;
      E.arrive.classList.add('lit');
      if (opts && opts.onArrive && !isRM()) opts.onArrive();
    } else if (p < 0.97 && arriveLit) {
      arriveLit = false;
      E.arrive.classList.remove('lit');
    }
  }

  /* ---------- 每帧驱动（app.js 主循环调用） ----------
     dt ms · p 进度 · sps 平滑后的 |进度/秒| · o {rm, tour} */
  function update(dt, p, sps, o) {
    if (!E) return;
    var ch = chapterOf(p);
    if (ch !== curCh) setChapter(ch, 0);
    var rm = isRM();

    /* 计量数字（只写变化的 DOM） */
    if (ch === 0) {
      setText(E.tide, fmtTide(tideAt(p)), 'tide');
      setText(E.vs, '' + Math.round(vspeedOf(sps)), 'vs');
    } else if (ch === 1) {
      setText(E.glow, '' + glowAt(p), 'glow');
      setText(E.burst, BURST_LV[burstAt(p)], 'burst');
    } else {
      /* 深度计：p<71.7% 灰待命 0.0；破水点亮走数；停滚时 ±0.1m 悬浮呼吸漂移 */
      var on = p >= DEPTH_ON;
      if (on !== last.depthOn) {
        last.depthOn = on;
        if (E.depthBig) E.depthBig.classList.toggle('on', on);
        if (on) stageFX('deep');                 // 破水瞬间：数字点亮 + 深青 flash
      }
      var dv = on ? depthAt(p) : 0;
      if (on && sps < 0.004) {
        dv += 0.1 * Math.sin((typeof performance !== 'undefined' ? performance.now() : Date.now()) / 900);
      }
      setText(E.depth, dv.toFixed(1), 'depth');
    }
    updateArrive(p);

    /* 速度响应：快滚 HUD 数字加速感（轻模糊 + 更亮辉光） */
    var spd = !rm && sps > 0.28 ? 1 : 0;
    if (spd !== last.hudSpd) {
      last.hudSpd = spd;
      E.hud.classList.toggle('spd', !!spd);
    }

    /* 待机提示：首次输入后，停留 3s 且非漫游非终点 */
    var now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    var showIdle = started && lastAct > 0 && (now - lastAct > 3000) &&
      !(o && o.tour) && p < 0.99;
    if (showIdle && !idleOn) {
      idleOn = true;
      E.idle.textContent = ['一晚能看到满海发光的人，不到一船 ↓', '夜光藻要被浪惊扰，才肯发光 ↓', '这片光，只亮给今晚的潮水 ↓'][ch];
      E.idle.classList.add('on');
    } else if (!showIdle && idleOn) {
      idleOn = false;
      E.idle.classList.remove('on');
    }
  }

  /* 任何输入：立即隐藏待机提示并重置 3s 计时 */
  function onActivity() {
    started = true;
    lastAct = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (E && idleOn) { idleOn = false; E.idle.classList.remove('on'); }
  }

  return {
    core: core,
    init: init,
    update: update,
    transit: transit,
    onActivity: onActivity
  };
})();
