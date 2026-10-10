/* ==========================================================================
 * ASTRA · 计量 HUD / 穿越时刻 / 待机提示（P1 反馈层）
 * js/astra-hud.js
 *
 * 规格：INTERACTION-DESIGN §2.1 §2.2 §2.4 §2.5 + §1 ASTRA 一节
 *   SEG1（0–55%）   距离计 120.0km→0.8km（大数字连续插值）+ 接近速度
 *                   （随滚动速度）+ 中心目标锁定框（随距离收缩）
 *   穿越 A（55%）   DOCKING…→DOCKED 状态灯（黄→绿）+ 压强 0→101kPa
 *                   1.5s 数字爬升 + 气闸 sting + 青白 flash + ±2px/150ms 微震
 *   SEG2（55–75%）  舱内传感器：氧气 20.9% / 电力条 / 信号强度条（轻微波动）
 *   穿越 B（75%）   同步率组件启动 + 泛音 sting + 暖色 flash + 微震
 *   SEG3（75–100%） 「信标重启 · 信号将抵达 10,000 光年外」打字机 +
 *                   光传导同步率 0→100%（100% 达成：数字亮起 + 微脉冲 + chime）
 *   待机            3s 无输入 → 呼吸提示「继续接近 ↓」，任何输入消失
 *   约束            H/Esc 口播模式经 .ui 类隐藏（声音保留）；reduced 无微震
 *                   无 sting，HUD 切换淡入淡出。
 *
 * 结构：logic = 纯函数集（Node 桩测试对象，无 DOM 依赖）；
 *       init/update = DOM 控制器（由 astra-main.js 每帧喂 p/speed/dt）。
 * ========================================================================== */
(function () {
  'use strict';

  var win = (typeof window !== 'undefined') ? window : {};
  var hasDoc = (typeof document !== 'undefined');

  function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
  function lerp(a, b, p) { return a + (b - a) * p; }
  function ss(a, b, x) {
    if (b === a) return x >= a ? 1 : 0;
    x = clamp((x - a) / (b - a), 0, 1);
    return x * x * (3 - 2 * x);
  }
  function easeIO(p) { p = clamp(p, 0, 1); return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; }
  function easeOut3(p) { p = clamp(p, 0, 1); return 1 - Math.pow(1 - p, 3); }

  var T1 = 0.55, T2 = 0.75;                        /* 章界（与 v2 引擎一致） */
  var TYPE_TEXT = '信标重启 · 信号将抵达 10,000 光年外';
  var IDLE_TEXT = ['继续接近 ↓', '继续深入 ↓', '继续点亮 ↓'];

  /* ================= 纯逻辑（Node 桩测试对象） ================= */
  var logic = {
    T1: T1, T2: T2, TYPE_TEXT: TYPE_TEXT,
    chapterOf: function (p) { return p < T1 ? 0 : (p < T2 ? 1 : 2); },
    /* SEG1 距离计：120.0km → 0.8km（easeInOutCubic 插值） */
    distanceKm: function (p) { return lerp(120.0, 0.8, easeIO(p / T1)); },
    /* 接近速度 m/s：随进度衰减的基值 × 滚动速度加成 */
    closingSpeed: function (p, speed) {
      return lerp(420, 8, clamp(p / T1, 0, 1)) * (0.25 + 1.9 * clamp(speed, 0, 1));
    },
    /* 锁定框边长（min 屏边比例）：16% → 5.5% 收缩 */
    lockBoxFrac: function (p) { return lerp(0.16, 0.055, easeIO(p / T1)); },
    /* 压强（稳定值）：0 → 101kPa（对接后舱压建立） */
    pressureKpa: function (p) { return 101 * ss(0.552, 0.605, p); },
    /* 压强爬升动画（穿越 A 触发，1.5s easeOut） */
    climbKpa: function (ms) { return 101 * easeOut3(ms / 1500); },
    /* SEG2 传感器（clock 驱动轻微波动，有生命感） */
    oxygenPct: function (clock) {
      return 20.9 + Math.sin(clock * 0.7 + 1.3) * 0.06 + Math.sin(clock * 2.3) * 0.025;
    },
    powerPct: function (clock) {
      return clamp(76 + Math.sin(clock * 0.23) * 7 + Math.sin(clock * 0.71 + 2.1) * 3.5, 55, 97);
    },
    signalPct: function (p, clock) {
      return clamp(58 + (p - 0.65) * 90 + Math.sin(clock * 0.9 + 0.5) * 7 + Math.sin(clock * 2.7 + 1.7) * 3, 8, 99);
    },
    /* SEG3 光传导同步率：0% → 100%（p=0.995 达到 100） */
    syncPct: function (p) { return clamp((p - T2) / 0.245, 0, 1) * 100; },
    /* 打字机字符数：p 0.795–0.935 → 0..全文（滚动驱动） */
    typedChars: function (p) { return Math.round(clamp((p - 0.795) / (0.935 - 0.795), 0, 1) * TYPE_TEXT.length); },
    /* 章界穿越门控：跨界触发一次；离开 ±win 窗口后才重新武装 */
    makeTransitGates: function (defs) {
      var list = [];
      for (var i = 0; i < defs.length; i++) {
        list.push({ id: defs[i].id, at: defs[i].at, win: defs[i].win, armed: true, prev: null });
      }
      function feed(p) {
        var fired = [];
        for (var j = 0; j < list.length; j++) {
          var g = list[j];
          var crossed = (g.prev !== null) &&
            ((g.prev < g.at && p >= g.at) || (g.prev > g.at && p <= g.at));
          if (crossed && g.armed) { fired.push(g.id); g.armed = false; }
          if (Math.abs(p - g.at) > g.win) g.armed = true;   /* 离开窗口 → 重新武装 */
          g.prev = p;
        }
        return fired;
      }
      return { feed: feed };
    }
  };

  /* ================= DOM 控制器 ================= */
  var dom = {}, ready = false, reduced = false;
  var gates = null;
  var disp = { km: 120, type: -1 };
  var kpaAnim = { on: false, t0: 0 };
  var kpaLatch = false;
  var wigClock = 0;
  var lastPoke = 0, idleOn = false, dockTimer = 0;

  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }
  function setText(el, s) { if (el && el._t !== s) { el._t = s; el.textContent = s; } }
  function setOn(el, on) { if (el && el._on !== on) { el._on = on; el.classList.toggle('on', on); } }
  function setOpacity(el, o) {
    o = Math.round(clamp(o, 0, 1) * 1000) / 1000;
    if (el && el._op !== o) { el._op = o; el.style.opacity = o; }
  }
  function setBar(fill, valEl, pct) {
    if (fill && fill._w !== pct) { fill._w = pct; fill.style.width = pct + '%'; }
    if (valEl) setText(valEl, String(pct));
  }

  function init(opts) {
    if (!hasDoc) return false;
    opts = opts || {};
    reduced = !!opts.reduced;
    var ids = ['hud', 'hud-ch1', 'hud-dist', 'hud-closing', 'hud-dock', 'dock-dot', 'dock-state',
      'hud-kpa', 'hud-o2', 'hud-pwr', 'hud-pwr-v', 'hud-sig', 'hud-sig-v',
      'hud-ch3', 'hud-type', 'hud-sync', 'hud-sync-fill',
      'lockbox', 'idle-hint', 'flash', 'stage'];
    for (var i = 0; i < ids.length; i++) dom[ids[i]] = document.getElementById(ids[i]);
    gates = logic.makeTransitGates([
      { id: 'A', at: T1, win: 0.015 },
      { id: 'B', at: T2, win: 0.015 },
      { id: 'S', at: 0.995, win: 0.005 }
    ]);
    lastPoke = nowMs();
    ready = true;
    /* 任何输入 → 收回待机提示（模块自挂监听，与外壳解耦） */
    if (typeof win.addEventListener === 'function') {
      var evs = ['wheel', 'touchstart', 'keydown', 'pointerdown'];
      for (var e = 0; e < evs.length; e++) win.addEventListener(evs[e], poke, { passive: true });
    }
    return true;
  }

  function poke() {
    lastPoke = nowMs();
    if (idleOn) { idleOn = false; if (dom['idle-hint']) dom['idle-hint'].classList.remove('on'); }
  }

  /* ---------------- 穿越 / 达成 ---------------- */
  function fx(kind) {                           /* 色温 flash（200ms）+ 微震（±2px/150ms） */
    var f = dom.flash;
    if (f) {
      f.className = kind === 'a' ? 'flash-a' : 'flash-b';
      void f.offsetWidth;                       /* 重触发 CSS 动画 */
      f.classList.add('on');
    }
    if (dom.stage) {
      dom.stage.classList.remove('quake');
      void dom.stage.offsetWidth;
      dom.stage.classList.add('quake');
    }
  }
  function dockDone() {
    if (dom['dock-dot']) dom['dock-dot'].className = 'hud-dot docked';
    setText(dom['dock-state'], 'DOCKED');
  }
  function transitA() {                         /* 穿越 A · 对接气闸（55%） */
    if (dom['dock-dot']) dom['dock-dot'].className = 'hud-dot docking';
    setText(dom['dock-state'], 'DOCKING…');
    if (!reduced) {
      fx('a');                                  /* 青白 flash + 微震 */
      if (win.AstraAudio) win.AstraAudio.stingA();
      kpaAnim.on = true;                        /* 压强 0→101kPa 爬升动画 */
      kpaAnim.t0 = nowMs();
      if (dockTimer) win.clearTimeout(dockTimer);
      dockTimer = win.setTimeout(dockDone, 700);/* 黄 → 绿 */
    } else {
      kpaLatch = true;                          /* reduced：无动画，直接视为已建立舱压 */
      dockDone();
    }
  }
  function transitB() {                         /* 穿越 B · 抵达核心（75%）：同步率组件启动 */
    if (!reduced) {
      fx('b');                                  /* 暖色 flash + 微震 */
      if (win.AstraAudio) win.AstraAudio.stingB();
      var c3 = dom['hud-ch3'];
      if (c3) { c3.classList.remove('boot'); void c3.offsetWidth; c3.classList.add('boot'); }
    }
  }
  function syncAchieve(on) {                    /* 同步率 100% 达成：数字亮起 + 微脉冲 */
    var el = dom['hud-sync'];
    if (!el) return;
    if (on) {
      el.classList.add('lit');
      if (!reduced) {
        el.classList.remove('pulse');
        void el.offsetWidth;
        el.classList.add('pulse');
        if (win.AstraAudio) win.AstraAudio.chime();
      }
    } else {
      el.classList.remove('lit', 'pulse');      /* 离开达成窗口 → 允许再次达成 */
    }
  }

  /* ---------------- 每帧更新（由 astra-main 喂参） ---------------- */
  function update(env) {
    if (!ready) return;
    env = env || {};
    var p = clamp(env.p || 0, 0, 1);
    var speed = clamp(env.speed || 0, 0, 1);
    var dt = clamp(env.dt || 0, 0, 0.1);
    wigClock += dt;

    /* 1) 章界门控（来回跨界只触发一次，直到离开 ±win 窗口） */
    var fires = gates.feed(p);
    for (var i = 0; i < fires.length; i++) {
      if (fires[i] === 'A') transitA();
      else if (fires[i] === 'B') transitB();
      else if (fires[i] === 'S') syncAchieve(true);
    }
    if (p < 0.988 && dom['hud-sync'] && dom['hud-sync'].classList.contains('lit')) syncAchieve(false);

    /* 2) 章集群可见性（互斥，CSS 300ms 淡入淡出；reduced 为 500ms） */
    setOn(dom['hud-ch1'], p < T1);
    setOn(dom['hud-dock'], p >= T1 && p < T2);
    setOn(dom['hud-ch3'], p >= T2);

    /* 3) SEG1 · 距离计 + 接近速度 + 锁定框 */
    if (p < T1) {
      var tgtKm = logic.distanceKm(p);
      disp.km += (tgtKm - disp.km) * (1 - Math.exp(-(5 + speed * 36) * dt));  /* 快滚数字加速 */
      if (Math.abs(tgtKm - disp.km) < 0.0005) disp.km = tgtKm;
      setText(dom['hud-dist'], disp.km.toFixed(1));
      var cs = logic.closingSpeed(p, speed) * (1 + Math.sin(wigClock * 1.7) * 0.03);
      setText(dom['hud-closing'], Math.max(0, cs).toFixed(0));
      var minWH = Math.min(win.innerWidth || 960, win.innerHeight || 600);
      var size = Math.round(logic.lockBoxFrac(p) * minWH);
      var lb = dom.lockbox;
      if (lb) {
        if (lb._s !== size) { lb._s = size; lb.style.width = size + 'px'; lb.style.height = size + 'px'; }
        setOpacity(lb, ss(0.02, 0.06, p) * (1 - ss(0.500, 0.543, p)));       /* 光晕前退场 */
      }
    } else {
      setOpacity(dom.lockbox, 0);
    }

    /* 4) 穿越 A 之后 · 对接状态 + 压强 + 舱内传感器（SEG2 集群） */
    if (p < 0.552) { kpaLatch = false; kpaAnim.on = false; }   /* 退回闸门外 → 舱压复位 */
    if (p >= T1 && p < T2) {
      var kpa;
      if (kpaAnim.on) {
        kpa = logic.climbKpa(nowMs() - kpaAnim.t0);
        if (nowMs() - kpaAnim.t0 >= 1500) { kpaAnim.on = false; kpaLatch = true; }
      } else kpa = kpaLatch ? 101 : logic.pressureKpa(p);
      setText(dom['hud-kpa'], String(Math.round(kpa)));
      var wc = reduced ? 3 : wigClock;          /* reduced：读数静止 */
      setText(dom['hud-o2'], logic.oxygenPct(wc).toFixed(1));
      setBar(dom['hud-pwr'], dom['hud-pwr-v'], Math.round(logic.powerPct(wc)));
      setBar(dom['hud-sig'], dom['hud-sig-v'], Math.round(logic.signalPct(p, wc)));
    }

    /* 5) SEG3 · 打字机 + 光传导同步率 */
    if (p >= T2) {
      var n = logic.typedChars(p);
      if (n !== disp.type) {
        var prevN = disp.type;
        disp.type = n;
        var ty = dom['hud-type'];
        if (ty) {
          ty.textContent = TYPE_TEXT.slice(0, n);
          ty.classList.toggle('typing', n > 0 && n < TYPE_TEXT.length);
        }
        if (!reduced && n > prevN && n % 2 === 0 && win.AstraAudio) win.AstraAudio.uiTick();
      }
      var sy = Math.round(logic.syncPct(p));
      setText(dom['hud-sync'], String(sy));
      setBar(dom['hud-sync-fill'], null, sy);
    }

    /* 6) 待机呼吸提示：3s 无输入（漫游/滑翔/开场提示期间不出现） */
    var idle = !reduced && env.introDone && !env.touring && !env.gliding &&
      p < 0.985 && (nowMs() - lastPoke > 3000);
    if (idle !== idleOn) {
      idleOn = idle;
      var ih = dom['idle-hint'];
      if (ih) {
        if (idle) ih.textContent = IDLE_TEXT[logic.chapterOf(p)];
        ih.classList.toggle('on', idle);
      }
    }
  }

  /* ---------------- 导出 ---------------- */
  win.AstraHUD = {
    logic: logic,
    init: init,
    update: update,
    poke: poke,
    fx: fx
  };
})();
