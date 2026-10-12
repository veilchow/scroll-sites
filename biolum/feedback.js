/* ============================================================
 * BIOLUM 蓝眼泪 — feedback.js（模板派生）
 * 依 ../INTERACTION-DESIGN.md §2：
 *   计量 HUD（海拔计/街道定位/楼层翻牌/温度/距离倒数/抵达）
 *   穿越时刻 C（33% 穿云落地）/ D（66% 沉入地下）的
 *     HUD 单位切换动画 + 霓虹饱和度脉冲 + 色温 flash + 微震
 *   待机呼吸提示（按章变化文案）
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
  var B1 = 1 / 3, B2 = 2 / 3;                 // 章界 33% / 66%
  var ALT0 = 480, ALT1 = 30;                  // SEG1 海拔 480m → 30m（落地）
  var DOOR0 = 7, DOOR1 = 19;                  // SEG2 门牌 路口07 → 19
  var STEPS_END = 486;                        // SEG2 步数（行程映射）
  var DIST0 = 12;                             // SEG3 距核心面档 12m → 0m
  var T_SURF = 12, T_UND = 18;                // 地表 12° → 地下 18°
  var HYST = 0.015;                           // 章界触发滞回窗（±1.5%）

  function segT(p, lo, hi) { return clamp((p - lo) / (hi - lo), 0, 1); }

  function altitudeAt(p) { return lerp(ALT0, ALT1, segT(p, 0, B1)); }
  function doorAt(p) { return DOOR0 + Math.round((DOOR1 - DOOR0) * segT(p, B1, B2)); }
  function stepsAt(p) { return Math.round(STEPS_END * segT(p, B1, B2)); }
  function distAt(p) { return DIST0 * (1 - segT(p, B2, 1)); }
  /* 垂直速度显示（m/s）：真实导数 1350·(进度/秒) 数值失控，
     用平方压缩映射到 0–88 m/s 的可信下坠区间，仍严格随滚动速度单调 */
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
    ALT0: ALT0, ALT1: ALT1, DOOR0: DOOR0, DOOR1: DOOR1,
    DIST0: DIST0, T_SURF: T_SURF, T_UND: T_UND,
    altitudeAt: altitudeAt, doorAt: doorAt, stepsAt: stepsAt, distAt: distAt,
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
  var last = { alt: '', vs: '', door: '', steps: '', dist: '', hudSpd: -1 };

  function isRM() { return !!(opts && opts.rm && opts.rm()); }

  function init(o) {
    opts = o || {};
    var d = typeof document !== 'undefined' ? document : null;
    if (!d) return false;
    var q = function (id) { return d.getElementById(id); };
    E = {
      hud: q('hud'),
      groups: [q('hud-seg1'), q('hud-seg2'), q('hud-seg3')],
      alt: q('hud-alt'), vs: q('hud-vs'),
      door: q('hud-door'), steps: q('hud-steps'), umb: q('umb'),
      dist: q('hud-dist'), floor: q('hud-floor'), temp: q('hud-temp'),
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
    if (ch < prev) { resetTransients(); }      // 回退方向：复位伞/翻牌/温度，供下次正向穿越重放
  }

  function resetTransients() {
    if (E.floor) E.floor.classList.remove('b2');
    if (E.umb) E.umb.classList.remove('folded', 'land');
    if (E.temp) E.temp.textContent = '地表 ' + T_SURF + '°';
    stopTempAnim();
  }

  /* ---------- 穿越时刻视觉（微震/脉冲/flash；RM 全部跳过） ---------- */
  function stageFX(kind) {
    if (!E.stage || isRM()) return;
    var st = E.stage;
    if (kind === 'shake') { st.classList.remove('shake'); void st.offsetWidth; st.classList.add('shake'); }
    if (kind === 'bio') { st.classList.remove('bio-pulse'); void st.offsetWidth; st.classList.add('bio-pulse'); }
    if ((kind === 'cool' || kind === 'warm') && E.flash) {
      var f = E.flash;
      f.className = '';
      void f.offsetWidth;
      f.classList.add(kind);
      later(function () { f.classList.remove(kind); }, 620);
    }
  }

  /* ---------- 伞：落地收起（CSS transform 过渡；RM 瞬时到位） ---------- */
  function landUmbrella() {
    if (!E.umb) return;
    E.umb.classList.add('land');
    later(function () { E.umb.classList.add('folded'); }, 240);   // 下落触地 → 收伞
  }

  /* ---------- 楼层翻牌 B1→B2（rotateX 整牌机械翻转 + 两声咔哒） ---------- */
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

  /* ---------- 温度 12°→18°（数字滚动 + 标签切换） ---------- */
  var tempTimer = 0;
  function stopTempAnim() { if (tempTimer) { clearInterval(tempTimer); tempTimer = 0; } }
  function animTemp() {
    if (!E.temp) return;
    if (isRM()) { E.temp.textContent = '地下 ' + T_UND + '°'; return; }
    var el = E.temp, t0 = performance.now();
    stopTempAnim();
    tempTimer = setInterval(function () {
      var k = clamp((performance.now() - t0 - 500) / 900, 0, 1);   // 翻牌后再滚温
      var v = Math.round(lerp(T_SURF, T_UND, k));
      el.textContent = (k < 0.5 ? '地表 ' : '地下 ') + v + '°';
      if (k >= 1) stopTempAnim();
    }, 40);
  }

  /* ---------- 穿越时刻（app.js 在进度越界瞬间调用；id 0=C 1=D） ---------- */
  function transit(id) {
    if (!E) return;
    if (isRM()) return;                          // RM：无 sting 无动画，update 的淡切已足够
    clearTimers();
    stopTempAnim();
    if (id === 0) {
      /* C · 穿云落地：雨声音量跳升(sting) + 霓虹饱和度脉冲 + 冷色 flash + 微震
         HUD：海拔计翻滚退场(240ms) → 街道定位淡入 + 伞收起 */
      if (opts && opts.onSting) opts.onSting(0);
      stageFX('bio'); stageFX('cool'); stageFX('shake');
      setChapter(1, 240);
      landUmbrella();
    } else if (id === 1) {
      /* D · 沉入地下：雨声闷掉(sting) + 冷→暖 flash + 微震
         HUD：门牌退场 → 楼层翻牌 B1→B2 + 温度 12°→18° */
      if (opts && opts.onSting) opts.onSting(1);
      stageFX('warm'); stageFX('shake');
      setChapter(2, 240);
      playFlip();
      animTemp();
    }
  }

  /* ---------- 抵达（SEG3 尾端 0m） ---------- */
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
      setText(E.alt, altitudeAt(p).toFixed(1), 'alt');
      setText(E.vs, vspeedOf(sps).toFixed(1), 'vs');
    } else if (ch === 1) {
      setText(E.door, pad2(doorAt(p)), 'door');
      setText(E.steps, '' + stepsAt(p), 'steps');
    } else {
      setText(E.dist, distAt(p).toFixed(1), 'dist');
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
      E.idle.textContent = ['继续下落 ↓', '继续前行 ↓', '再往下 ↓'][ch];
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
