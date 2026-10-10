/* ==========================================================================
 * ASTRA · WebAudio 声音系统（P1 反馈层 · 全合成 · 零素材）
 * js/astra-audio.js
 *
 * 规格：INTERACTION-DESIGN §2.3（ASTRA 一节）
 *   - 首次用户手势（wheel / touchstart / keydown / pointerdown）才创建
 *     AudioContext；加载期零副作用（Node 桩测试可直接验证）。
 *   - M 键全局静音（主增益归零，由外壳调 toggleMute），状态经 onState 回调。
 *   - 三床环境音（章间 800ms 交叉淡化）：
 *       真空（SEG1）= 40Hz 推进 hum + 无线电杂音（带通噪声断续）+ 星尘沙沙
 *       舱内（SEG2）= 50Hz 电力 hum + 白噪通风 + 仪器滴答
 *       核心（SEG3）= 纯低频 36Hz + 泛音垫（正弦叠加 + 慢 LFO 缓慢展开）
 *   - 速度调制：滚动速度 → 真空床无线电杂音密度（radioInterval）+ 嘶声增益。
 *   - 穿越 sting：A 气闸（白噪+高通+1.2s 指数衰减） / B 泛音（正弦叠加缓慢展开）。
 *   - UI 音：导航 tick / 打字机微 tick / 同步达成 chime / 漫游启停确认。
 * ========================================================================== */
(function () {
  'use strict';

  var win = (typeof window !== 'undefined') ? window : {};
  var hasDoc = (typeof document !== 'undefined');

  function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }

  /* 无线电杂音密度（纯函数，供桩测试）：快滚 → 间隔缩短 → 密度升高 */
  function radioInterval(speed) {
    return clamp(1.7 / (1 + clamp(speed, 0, 1) * 5), 0.12, 1.7);
  }

  var st = {
    ctx: null, master: null, beds: [],
    bedIdx: 0,                       /* 0=真空 1=舱内 2=核心 */
    muted: false, speed: 0,
    noise: null, brown: null, radG: null, hissG: null,
    radioNext: 0, tickNext: 0, hissAt: -1,
    timer: 0
  };
  var api = null;                    /* 导出对象（fireState 读 api.onState） */

  function ctor() {
    if (typeof win.AudioContext !== 'undefined') return win.AudioContext;
    if (typeof win.webkitAudioContext !== 'undefined') return win.webkitAudioContext;
    return null;
  }

  /* ---------------- 节点小工具 ---------------- */
  function gain(v) { var g = st.ctx.createGain(); g.gain.value = v; return g; }
  function filt(type, f, q) {
    var b = st.ctx.createBiquadFilter();
    b.type = type; b.frequency.value = f;
    if (q !== undefined) b.Q.value = q;
    return b;
  }
  function osc(type, f, v) {
    var o = st.ctx.createOscillator();
    o.type = type; o.frequency.value = f;
    var g = gain(v);
    o.connect(g);
    return { o: o, g: g };
  }
  function lfo(rate, depth, param) {          /* 慢 LFO 调制某 AudioParam */
    var o = st.ctx.createOscillator();
    o.frequency.value = rate;
    var g = gain(depth);
    o.connect(g); g.connect(param);
    o.start();
    return o;
  }
  function noiseBuffer(sec, brown) {
    var sr = st.ctx.sampleRate || 44100;
    var n = Math.max(1, Math.floor(sec * sr));
    var buf = st.ctx.createBuffer(1, n, sr);
    var d = buf.getChannelData(0);
    var last = 0;
    for (var i = 0; i < n; i++) {
      var w = Math.random() * 2 - 1;
      if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
      else d[i] = w;
    }
    return buf;
  }
  function loopSrc(buf) {
    var s = st.ctx.createBufferSource();
    s.buffer = buf; s.loop = true;
    return s;
  }
  function buildBed(level) {                  /* 床输出（初始 0，交叉淡化驱动） */
    var out = gain(0);
    out.connect(st.master);
    return { out: out, level: level };
  }

  /* ---------------- 三床环境音图 ---------------- */
  function buildGraph() {
    st.master = gain(0.55);
    st.master.connect(st.ctx.destination);
    st.noise = noiseBuffer(1.4, false);
    st.brown = noiseBuffer(1.4, true);

    /* 床 1 · 真空（SEG1）：近无声 —— hum + 杂音 + 沙沙 */
    var vac = buildBed(0.9);
    var humA = osc('sine', 40, 0.045);  humA.g.connect(vac.out); humA.o.start();
    var humB = osc('sine', 55.5, 0.018); humB.g.connect(vac.out); humB.o.start();
    var rum = loopSrc(st.brown);                    /* 推进器低鸣（棕噪低通） */
    var rumF = filt('lowpass', 90, 0.7);
    var rumG = gain(0.05);
    rum.connect(rumF); rumF.connect(rumG); rumG.connect(vac.out); rum.start();
    var hiss = loopSrc(st.noise);                   /* 星尘沙沙（高通白噪，速度调制增益） */
    var hissF = filt('highpass', 6300, 0.6);
    st.hissG = gain(0.004);
    hiss.connect(hissF); hissF.connect(st.hissG); st.hissG.connect(vac.out); hiss.start();
    var rad = loopSrc(st.noise);                    /* 无线电杂音（带通断续，调度器驱动） */
    var radF = filt('bandpass', 1750, 9);
    st.radG = gain(0);
    rad.connect(radF); radF.connect(st.radG); st.radG.connect(vac.out); rad.start();

    /* 床 2 · 舱内（SEG2）：电力 hum + 通风白噪 + 仪器滴答（调度器驱动） */
    var cab = buildBed(0.85);
    var h50 = osc('sine', 50, 0.032);   h50.g.connect(cab.out);  h50.o.start();
    var h100 = osc('sine', 100, 0.011); h100.g.connect(cab.out); h100.o.start();
    var vent = loopSrc(st.noise);
    var ventF = filt('lowpass', 480, 0.5);
    var ventG = gain(0.045);
    vent.connect(ventF); ventF.connect(ventG); ventG.connect(cab.out); vent.start();

    /* 床 3 · 核心（SEG3）：纯低频 + 泛音垫（正弦叠加缓慢展开） */
    var cor = buildBed(1.0);
    var sub = osc('sine', 36, 0.06);
    sub.g.connect(cor.out); sub.o.start();
    lfo(0.05, 0.018, sub.g.gain);
    var partials = [110, 165, 220, 330, 440, 550];
    for (var i = 0; i < partials.length; i++) {
      var pk = osc('sine', partials[i], 0.016 / (1 + i * 0.35));
      pk.g.connect(cor.out); pk.o.start();
      lfo(0.03 + 0.017 * i, 0.006, pk.g.gain);
    }

    st.beds = [vac, cab, cor];
  }

  /* ---------------- 事件调度（250ms 前瞻） ---------------- */
  function burst(at) {                        /* 一次无线电杂音突发 */
    var g = st.radG.gain;
    var peak = 0.04 + Math.random() * 0.10;
    var dur = 0.06 + Math.random() * 0.22;
    try {
      g.cancelScheduledValues(at);
      g.setValueAtTime(0.0001, at);
      g.linearRampToValueAtTime(peak, at + 0.012);
      g.exponentialRampToValueAtTime(0.0001, at + dur);
    } catch (e) {}
  }
  function blipAt(at, freq, vol, dur) {       /* 短促正弦（滴答/tick/chime 用） */
    var o = st.ctx.createOscillator();
    o.type = 'sine'; o.frequency.value = freq;
    var g = gain(0.0001);
    o.connect(g); g.connect(st.master);
    try {
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(vol, at + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    } catch (e) {}
    o.start(at); o.stop(at + dur + 0.05);
  }
  function scheduler() {
    if (!st.ctx || st.muted) return;
    var t = st.ctx.currentTime;
    /* 真空床无线电杂音：密度随滚动速度 */
    if (st.radioNext < t) st.radioNext = t + 0.05;
    while (st.radioNext < t + 0.6) {
      if (st.bedIdx === 0) burst(st.radioNext);
      st.radioNext += radioInterval(st.speed);
    }
    /* 舱内仪器滴答：随机间隔 */
    if (st.tickNext < t) st.tickNext = t + 0.1;
    while (st.tickNext < t + 0.6) {
      if (st.bedIdx === 1) blipAt(st.tickNext, 1318, 0.03 + Math.random() * 0.03, 0.05);
      st.tickNext += 1.8 + Math.random() * 2.7;
    }
  }

  /* ---------------- 穿越 sting ---------------- */
  function stingA() {                          /* 气闸增压：白噪+高通+1.2s 衰减 + 密封闷响 */
    if (!st.ctx || st.muted) return;
    var t = st.ctx.currentTime + 0.01;
    var src = st.ctx.createBufferSource();
    src.buffer = st.noise; src.loop = true;
    var hp = filt('highpass', 420, 0.8);
    var g = gain(0.0001);
    src.connect(hp); hp.connect(g); g.connect(st.master);
    try {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.5, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);   /* 1.2s 衰减包络 */
    } catch (e) {}
    src.start(t); src.stop(t + 1.25);
    var th = osc('sine', 72, 0.0001);          /* 闸门密封低频闷响 */
    th.g.connect(st.master);
    try {
      th.o.frequency.setValueAtTime(72, t);
      th.o.frequency.exponentialRampToValueAtTime(44, t + 0.32);
      th.g.gain.setValueAtTime(0.0001, t);
      th.g.gain.exponentialRampToValueAtTime(0.2, t + 0.015);
      th.g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    } catch (e) {}
    th.o.start(t); th.o.stop(t + 0.45);
  }
  function stingB() {                          /* 泛音：正弦叠加缓慢展开 */
    if (!st.ctx || st.muted) return;
    var t = st.ctx.currentTime + 0.01;
    var partials = [174.6, 261.6, 349.2, 523.3, 784.0];
    for (var i = 0; i < partials.length; i++) {
      var o = st.ctx.createOscillator();
      o.frequency.value = partials[i];
      var g = gain(0.0001);
      o.connect(g); g.connect(st.master);
      var t0 = t + i * 0.26;                   /* 逐个错峰进入 */
      var vol = 0.085 / (1 + i * 0.4);
      try {
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.linearRampToValueAtTime(vol, t0 + 1.05);       /* 缓慢展开 */
        g.gain.setValueAtTime(vol, t0 + 2.1);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 3.4);
      } catch (e) {}
      o.start(t0); o.stop(t0 + 3.5);
    }
  }

  /* ---------------- UI 音 ---------------- */
  function tick()    { if (st.ctx && !st.muted) blipAt(st.ctx.currentTime + 0.01, 880, 0.055, 0.06); }
  function uiTick()  { if (st.ctx && !st.muted) blipAt(st.ctx.currentTime + 0.01, 1318, 0.024, 0.03); }
  function chime() {                          /* 同步率 100% 达成 */
    if (!st.ctx || st.muted) return;
    var t = st.ctx.currentTime + 0.01;
    blipAt(t, 659.25, 0.07, 0.55);
    blipAt(t + 0.16, 987.77, 0.06, 0.7);
  }
  function pair(f1, f2) {                     /* 漫游启停确认 */
    if (!st.ctx || st.muted) return;
    var t = st.ctx.currentTime + 0.01;
    blipAt(t, f1, 0.05, 0.09);
    blipAt(t + 0.1, f2, 0.05, 0.12);
  }

  /* ---------------- 控制 ---------------- */
  function fireState() {
    if (api && typeof api.onState === 'function') api.onState({ active: !!st.ctx, muted: st.muted });
  }
  function applyMute() {
    if (!st.ctx || !st.master) return;
    try {
      st.master.gain.setTargetAtTime(st.muted ? 0 : 0.55, st.ctx.currentTime, 0.03);
    } catch (e) {}
  }
  function setChapter(n, immediate) {          /* 章床交叉淡化 800ms */
    var idx = clamp((n | 0) - 1, 0, 2);
    st.bedIdx = idx;
    if (!st.ctx) return idx;
    var t = st.ctx.currentTime;
    for (var i = 0; i < st.beds.length; i++) {
      var g = st.beds[i].out.gain;
      var target = (i === idx) ? st.beds[i].level : 0;
      try {
        g.cancelScheduledValues(t);
        if (immediate) g.setValueAtTime(target, t);
        else {
          g.setValueAtTime(g.value, t);
          g.linearRampToValueAtTime(target, t + 0.8);
        }
      } catch (e) {}
    }
    return idx;
  }
  function setSpeed(v) {                       /* 滚动速度 → 杂音密度 + 嘶声增益 */
    st.speed = clamp(v, 0, 1);
    if (!st.ctx || !st.hissG) return;
    var t = st.ctx.currentTime;
    if (t - st.hissAt < 0.15) return;
    st.hissAt = t;
    try {
      st.hissG.gain.cancelScheduledValues(t);
      st.hissG.gain.setTargetAtTime(0.004 + st.speed * 0.05, t, 0.25);
    } catch (e) {}
  }
  function toggleMute() {
    st.muted = !st.muted;
    applyMute();
    fireState();
    return st.muted;
  }
  function unlock() {                          /* 首次用户手势初始化 AudioContext */
    var C = ctor();
    if (!C) return false;
    if (!st.ctx) {
      try { st.ctx = new C(); } catch (e) { st.ctx = null; return false; }
      buildGraph();
      if (hasDoc && typeof win.setInterval === 'function' && !st.timer) {
        st.timer = win.setInterval(scheduler, 250);
      }
    }
    if (st.ctx.state === 'suspended' && st.ctx.resume) {
      try { st.ctx.resume(); } catch (e) {}
    }
    applyMute();
    setChapter(st.bedIdx + 1, true);
    fireState();
    return true;
  }

  /* ---------------- 导出 ---------------- */
  api = {
    onState: null,                   /* 外壳可注册：function({active, muted}) */
    unlock: unlock,
    setChapter: setChapter,
    setSpeed: setSpeed,
    toggleMute: toggleMute,
    isMuted: function () { return st.muted; },
    isActive: function () { return !!st.ctx; },
    stingA: stingA,
    stingB: stingB,
    tick: tick,
    uiTick: uiTick,
    chime: chime,
    tourOn: function () { pair(440, 660); },
    tourOff: function () { pair(660, 440); },
    radioInterval: radioInterval,
    _state: function () {
      return { created: !!st.ctx, bedIdx: st.bedIdx, muted: st.muted, speed: st.speed };
    }
  };
  win.AstraAudio = api;

  /* 首次用户手势初始化（浏览器环境；模块自身挂监听，外壳无需关心） */
  if (hasDoc && typeof win.addEventListener === 'function') {
    var evs = ['wheel', 'touchstart', 'keydown', 'pointerdown'];
    for (var e = 0; e < evs.length; e++) {
      win.addEventListener(evs[e], unlock, { passive: true });
    }
  }
})();
