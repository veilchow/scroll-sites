/* ============================================================
   BLOOM · 菌丝秘境 — P1 交互反馈层（INTERACTION-DESIGN §2）
   ------------------------------------------------------------
   叠加在 v2 引擎与交互外壳之上的顶层反馈，不改动既有行为：
     · 计量 HUD（左下）：ch1 光照 lx（420→60）+ 时间 19:42→19:58 /
       ch2 孢子浓度 ppm 活数字（断续 +2/−1）+ 距母核 22m→6m /
       ch3 深度 0→8.4m + 光传导同步率 0→100%（100% 达成瞬间
       数字亮起 +「所有光，都连成一张网」淡入）
     · 穿越时刻：33% 穿伞盖 E（荧光簌簌 sting + 青碧脉冲 + 微震）、
       66% 入土 F（低沉闭锁 sting·低通扫频 400ms + 变暗脉冲 + 微震）；
       章界 ±1.5% 窗口去重（下行跨越触发，退到窗外重新武装）
     · WebAudio 声音系统（全合成零素材）：三床环境音
       地表=高频断续正弦虫鸣+轻风粉噪 / 伞下=正弦叠加缓慢相位差的
       空灵垫 / 深处=60BPM 低频心跳脉动+微弱 shimmer；章间 800ms
       交叉淡化；首次用户手势才创建 AudioContext；M 键全局静音
       （带状态指示）；滚动速度 → 风噪滤波截止与虫鸣密度调制
     · 速度响应：滚动速度 → HUD 数字滚动加速；getSpeed() 供引擎
       做孢子/萤火粒子拉伸（快滚拉丝）
     · 待机提示：停留 3s → 底部呼吸「向下 ↓」（按章换语：
       潜入伞下 / 深入菌丝），任何输入立即隐藏
   约束：H/Esc 口播模式经 .ui 类隐藏全部新 HUD（声音保留）；
   prefers-reduced-motion：无微震无 sting、HUD 淡切、数字直切；
   移动端 HUD 压缩左下角（媒体查询）。
   纯函数与去重器经 pure.* 导出，供 tools/feedback-check.mjs 桩测。
   ============================================================ */
(function () {
  'use strict';

  var win = typeof window !== 'undefined' ? window : null;
  var doc = typeof document !== 'undefined' ? document : null;
  if (!win) return;

  /* ---------- 基础 ---------- */
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function smoothstep(a, b, x) {
    var t = clamp01((x - a) / (b - a));
    return t * t * (3 - 2 * t);
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function nowFn() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }
  function $(id) { return doc ? doc.getElementById(id) : null; }

  var B1 = 1 / 3, B2 = 2 / 3; /* 章界：33% / 66% */

  /* ============================================================
     一、纯计量函数（HUD 目标值；Node 桩可直接断言）
     ============================================================ */
  function luxAt(p) { return 420 - 360 * clamp01(p / B1); }        /* 光照 420→60 lx */
  function clockAt(p) { return 42 + 16 * clamp01(p / B1); }        /* 分钟 42→58（19:42→19:58） */
  function distAt(p) { return 22 - 16 * clamp01((p - B1) / B1); }  /* 距母核 22→6 m */
  function depthAt(p) { return 8.4 * clamp01((p - B2) / B1); }     /* 深度 0→8.4 m */
  function syncAt(p) { return 100 * smoothstep(B2, 1, p); }        /* 同步率 0→100%（随深处段平滑爬升） */
  function ppmAt(p) { return 38 + 58 * clamp01((p - B1) / B1); }   /* 孢子浓度基线 38→96 ppm */

  function fmtInt(v) { return String(Math.round(v)); }
  function fmtM(v) { return v.toFixed(1); }
  function fmtPct(v) { return Math.round(v) + '%'; }
  function fmtClock(v) { return '19:' + pad2(Math.floor(v + 1e-6)); }

  /* 章界去重：下行跨越触发一次；退到界下 1.5% 之外才重新武装 */
  function makeBoundary(bound) {
    return {
      bound: bound, armed: true, last: 0, fires: 0,
      update: function (p) {
        var fire = false;
        if (this.armed && this.last < this.bound && p >= this.bound) {
          fire = true;
          this.armed = false;
          this.fires++;
        }
        if (!this.armed && p < this.bound - 0.015) this.armed = true;
        this.last = p;
        return fire;
      }
    };
  }

  /* ============================================================
     二、WebAudio 声音系统（全合成零素材；首次手势才创建 ctx）
     ============================================================ */
  var audio = (function () {
    var AC = win.AudioContext || win.webkitAudioContext || null;
    var ctx = null, created = false, muted = false, chapter = -1;
    var master = null, beds = null, windFilter = null, windGain = null, noiseBuf = null;
    var nextChirp = 0, nextBeat = 0, timer = 0;
    var speedFn = function () { return 0; };

    function makeNoiseBuf() {
      var len = Math.max(1, Math.floor(ctx.sampleRate * 2));
      var buf = ctx.createBuffer(1, len, ctx.sampleRate);
      var d = buf.getChannelData(0);
      var b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (var i = 0; i < len; i++) {
        var w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      }
      return buf;
    }
    function noiseSrc() {
      var s = ctx.createBufferSource();
      s.buffer = noiseBuf;
      s.loop = true;
      return s;
    }
    /* 缓慢幅度 LFO（各声部速率不同 → 缓慢相位差的明灭） */
    function lfo(param, rate, depth, t0) {
      var o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = rate;
      var g = ctx.createGain();
      g.gain.value = depth;
      o.connect(g);
      g.connect(param);
      o.start(t0);
    }

    function build() {
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.9;
      master.connect(ctx.destination);
      noiseBuf = makeNoiseBuf();
      var t0 = ctx.currentTime;
      beds = { s: ctx.createGain(), c: ctx.createGain(), d: ctx.createGain() };
      beds.s.gain.value = 0; beds.c.gain.value = 0; beds.d.gain.value = 0;
      beds.s.connect(master); beds.c.connect(master); beds.d.connect(master);

      /* 床一 · 地表：轻风粉噪（截止随滚动速度开合）+ 断续虫鸣（chirp 由 schedule 调度） */
      var wind = noiseSrc();
      windFilter = ctx.createBiquadFilter();
      windFilter.type = 'lowpass';
      windFilter.frequency.value = 600;
      windFilter.Q.value = 0.4;
      windGain = ctx.createGain();
      windGain.gain.value = 0.06;
      wind.connect(windFilter);
      windFilter.connect(windGain);
      windGain.connect(beds.s);
      wind.start(t0);

      /* 床二 · 伞下：正弦叠加缓慢相位差的空灵垫（F 泛音列）+ 气流薄噪 */
      var pad = [[174.61, 0.032, 0.05], [220.0, 0.028, 0.083], [261.63, 0.024, 0.117], [349.23, 0.02, 0.053]];
      for (var v = 0; v < pad.length; v++) {
        var o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = pad[v][0];
        o.detune.value = v % 2 ? -3 : 4;
        var og = ctx.createGain();
        og.gain.value = pad[v][1];
        lfo(og.gain, pad[v][2], pad[v][1] * 0.55, t0 + v * 0.7);
        o.connect(og);
        og.connect(beds.c);
        o.start(t0);
      }
      var air = noiseSrc();
      var airF = ctx.createBiquadFilter();
      airF.type = 'bandpass';
      airF.frequency.value = 1240;
      airF.Q.value = 0.5;
      var airG = ctx.createGain();
      airG.gain.value = 0.012;
      air.connect(airF); airF.connect(airG); airG.connect(beds.c);
      air.start(t0);
      lfo(airG.gain, 0.06, 0.007, t0);

      /* 床三 · 深处：极低垫 + 微弱 shimmer + 60BPM 心跳（beat 由 schedule 调度） */
      var sub = ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.value = 36;
      var subG = ctx.createGain();
      subG.gain.value = 0.02;
      sub.connect(subG); subG.connect(beds.d); sub.start(t0);
      var shim = [[1318.5, 0.006, 0.07], [1975.5, 0.0038, 0.045]];
      for (var h = 0; h < shim.length; h++) {
        var so = ctx.createOscillator();
        so.type = 'sine';
        so.frequency.value = shim[h][0];
        var sg = ctx.createGain();
        sg.gain.value = shim[h][1];
        lfo(sg.gain, shim[h][2], shim[h][1] * 0.7, t0 + h * 1.3);
        so.connect(sg); sg.connect(beds.d); so.start(t0);
      }

      nextChirp = t0 + 0.3;
      nextBeat = t0 + 0.5;
      if (typeof setInterval === 'function') timer = setInterval(schedule, 200);
      crossfade(); /* 按当前章建立床增益 */
    }

    /* 章间 800ms 交叉淡化 */
    function crossfade() {
      if (!ctx || !beds) return;
      var t = ctx.currentTime;
      var key = ['s', 'c', 'd'];
      for (var i = 0; i < 3; i++) {
        var g = beds[key[i]].gain;
        var target = chapter === i ? 1 : 0;
        try {
          g.cancelScheduledValues(t);
          g.setValueAtTime(g.value, t);
          g.linearRampToValueAtTime(target, t + 0.8);
        } catch (e) { /* noop */ }
      }
    }

    /* 虫鸣：2–4 声一组的短正弦 ping（3.9–4.8kHz） */
    function chirp(t) {
      var n = 2 + Math.floor(Math.random() * 3);
      for (var i = 0; i < n; i++) {
        var tt = t + i * 0.075;
        var o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = 3900 + Math.random() * 900;
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, tt);
        g.gain.exponentialRampToValueAtTime(0.05, tt + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.09);
        o.connect(g); g.connect(beds.s);
        o.start(tt); o.stop(tt + 0.1);
      }
    }
    function thump(t, f0, amp, dur) {
      var o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(f0, t);
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(amp, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(beds.d);
      o.start(t); o.stop(t + dur + 0.02);
    }
    function beat(t) { /* 60 BPM 心跳：lub-dub 双跳 */
      thump(t, 54, 0.5, 0.14);
      thump(t + 0.18, 46, 0.34, 0.12);
    }

    /* 前瞻调度（200ms 节拍器，独立于 rAF：静态模式/后台节流均稳定） */
    function schedule() {
      if (!ctx || ctx.state !== 'running' || !beds) return;
      var now = ctx.currentTime;
      var horizon = now + 0.6;
      var sp = clamp01(speedFn());
      if (windFilter) {
        try { windFilter.frequency.setTargetAtTime(600 + 2600 * sp, now, 0.2); } catch (e) { /* noop */ }
      }
      if (windGain) {
        try { windGain.gain.setTargetAtTime(0.055 + 0.11 * sp, now, 0.2); } catch (e) { /* noop */ }
      }
      if (nextChirp < now - 0.2) nextChirp = now + 0.05; /* 节流恢复保护：不追帧 */
      if (nextBeat < now - 0.2) nextBeat = now + 0.05;
      while (nextChirp < horizon) {
        chirp(nextChirp);
        nextChirp += (0.55 + Math.random() * 1.9) / (0.55 + 0.95 * sp); /* 速度快 → 虫鸣密 */
      }
      while (nextBeat < horizon) {
        beat(nextBeat);
        nextBeat += 1.0; /* 60 BPM */
      }
    }

    /* 穿越 sting E：荧光簌簌（高频短噪声簇 + 柔和衰减 + 一点高频闪光） */
    function stingE() {
      var t = ctx.currentTime + 0.02;
      for (var i = 0; i < 8; i++) {
        var tt = t + i * 0.045 + Math.random() * 0.018;
        var s = ctx.createBufferSource();
        s.buffer = noiseBuf;
        var hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 2600 + Math.random() * 2800;
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, tt);
        g.gain.exponentialRampToValueAtTime(0.16 * (1 - i / 9), tt + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.06);
        s.connect(hp); hp.connect(g); g.connect(master);
        s.start(tt, Math.random() * 1.4, 0.03);
        s.stop(tt + 0.05);
      }
      var o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = 2637;
      var og = ctx.createGain();
      og.gain.setValueAtTime(0.0001, t);
      og.gain.exponentialRampToValueAtTime(0.045, t + 0.015);
      og.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
      o.connect(og); og.connect(master);
      o.start(t); o.stop(t + 0.4);
    }

    /* 穿越 sting F：低沉闭锁（低通扫频 400ms + 次低频闷击） */
    function stingF() {
      var t = ctx.currentTime + 0.02;
      var s = ctx.createBufferSource();
      s.buffer = noiseBuf;
      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 0.9;
      lp.frequency.setValueAtTime(760, t);
      lp.frequency.exponentialRampToValueAtTime(60, t + 0.4);
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.4, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.46);
      s.connect(lp); lp.connect(g); g.connect(master);
      s.start(t, 0, 0.5);
      s.stop(t + 0.5);
      var o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(52, t);
      o.frequency.exponentialRampToValueAtTime(38, t + 0.28);
      var og = ctx.createGain();
      og.gain.setValueAtTime(0.0001, t);
      og.gain.exponentialRampToValueAtTime(0.5, t + 0.015);
      og.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.connect(og); og.connect(master);
      o.start(t); o.stop(t + 0.32);
    }

    return {
      init: function () {
        if (created || !AC) {
          if (ctx && ctx.state === 'suspended' && ctx.resume) {
            try { ctx.resume().catch(function () { /* noop */ }); } catch (e) { /* noop */ }
          }
          return;
        }
        try {
          ctx = new AC();
          created = true;
          build();
          if (ctx.state === 'suspended' && ctx.resume) {
            try { ctx.resume().catch(function () { /* noop */ }); } catch (e) { /* noop */ }
          }
        } catch (e) {
          ctx = null;
          created = false;
        }
      },
      setChapter: function (i) { chapter = i; crossfade(); },
      setMuted: function (m) {
        muted = !!m;
        if (!ctx || !master) return;
        var t = ctx.currentTime;
        try {
          master.gain.cancelScheduledValues(t);
          master.gain.setValueAtTime(master.gain.value, t);
          master.gain.linearRampToValueAtTime(muted ? 0 : 0.9, t + 0.18);
        } catch (e) { /* noop */ }
      },
      sting: function (which) {
        if (!ctx) return;
        if (which === 'E') stingE();
        else stingF();
      },
      uiTick: function () { /* 导航/漫游确认 tick */
        if (!ctx) return;
        var t = ctx.currentTime + 0.01;
        var o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = 1174.66;
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.055, t + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
        o.connect(g); g.connect(master);
        o.start(t); o.stop(t + 0.06);
      },
      visibility: function (hidden) {
        if (!ctx) return;
        try { hidden ? ctx.suspend() : ctx.resume(); } catch (e) { /* noop */ }
      },
      bindSpeed: function (fn) { if (typeof fn === 'function') speedFn = fn; },
      info: function () { return { ctxCreated: created, muted: muted, chapter: chapter }; },
      dispose: function () {
        if (timer) { clearInterval(timer); timer = 0; }
        try { if (ctx && ctx.close) ctx.close(); } catch (e) { /* noop */ }
      }
    };
  })();

  /* ---------- DOM 引用（全部可选，桩环境安全） ---------- */
  var els = {
    lux: $('hudLux'), clock: $('hudClock'), ppm: $('hudPpm'), dist: $('hudDist'),
    depth: $('hudDepth'), sync: $('hudSync'), syncDone: $('syncDone'),
    flash: $('transitFlash'), stage: $('stage'),
    idle: $('idleHint'), idleText: $('idleText'),
    muteBtn: $('muteBtn')
  };
  els.muteLabel = (els.muteBtn && els.muteBtn.querySelector) ? els.muteBtn.querySelector('.mute-label') : null;
  var blocks = (doc && doc.querySelectorAll)
    ? Array.prototype.slice.call(doc.querySelectorAll('.hud-block')) : [];

  /* ---------- 状态 ---------- */
  var mql = null;
  try { if (win.matchMedia) mql = win.matchMedia('(prefers-reduced-motion: reduce)'); } catch (e) { /* noop */ }
  function isReduced() {
    var r = false;
    try { if (mql && mql.matches) r = true; } catch (e) { /* noop */ }
    try {
      if (doc && doc.body && doc.body.classList && doc.body.classList.contains('reduced')) r = true;
    } catch (e) { /* noop */ }
    return r;
  }
  var redCache = isReduced();

  var chapter = -1;
  var disp = { lux: 420, clock: 42, dist: 22, depth: 0, sync: 0, ppm: 38 }; /* 追逐显示值 */
  var shown = {};              /* 上次写入 textContent（去重 DOM 写） */
  var ppmJit = 0, jitTimer = 0;
  var bE = makeBoundary(B1), bF = makeBoundary(B2);
  var fires = { E: 0, F: 0 };
  var syncLit = false, doneShown = false;
  var speedNorm = 0, lastP = 0, lastT = 0;
  var started = false, lastInput = nowFn(), idleShown = false;
  var mutedUI = false;
  var scrambleIv = 0;
  var dtCur = 0.016;

  var IDLE_TEXT = ['向下 ↓ 潜入伞下', '向下 ↓ 深入菌丝', '旅程尽头 · 光在等你'];

  audio.bindSpeed(function () { return speedNorm; });

  function write(key, text, el) {
    if (!el || shown[key] === text) return;
    shown[key] = text;
    el.textContent = text;
  }

  /* 计量追逐：速率随滚动速度加速（快滚 → 数字滚得快）；reduced 直切 */
  function chase(key, target, fmt, el) {
    var d = disp[key];
    var rate = redCache ? 1 : (1 - Math.exp(-dtCur * (5 + 26 * speedNorm)));
    d += (target - d) * rate;
    if (Math.abs(target - d) < 0.03) d = target;
    disp[key] = d;
    if (fmt && el) write(key, fmt(d), el);
  }

  /* ---------- 穿越时刻 ---------- */
  function transit(which) {
    fires[which]++;
    if (redCache) return; /* 静态模式：无微震无 sting，仅 HUD 淡切 */
    audio.sting(which);
    if (els.flash) {
      els.flash.classList.remove('flash-teal');
      els.flash.classList.remove('flash-dark');
      void els.flash.offsetWidth;
      els.flash.classList.add(which === 'E' ? 'flash-teal' : 'flash-dark');
    }
    if (els.stage) {
      els.stage.classList.remove('shake');
      void els.stage.offsetWidth;
      els.stage.classList.add('shake');
    }
  }

  /* ---------- HUD 章节切换（翻滚归零 → 新单位自下淡入） ---------- */
  function scrambleIn(el, getter) {
    if (!el) return;
    if (scrambleIv) { clearInterval(scrambleIv); scrambleIv = 0; }
    var t0 = nowFn();
    scrambleIv = setInterval(function () {
      var k = Math.min(1, (nowFn() - t0) / 300);
      var text = getter();
      if (k >= 1) {
        el.textContent = text;
        clearInterval(scrambleIv);
        scrambleIv = 0;
        return;
      }
      el.textContent = text.replace(/[0-9]/g, function (d) {
        return Math.random() < k ? d : String(Math.floor(Math.random() * 10));
      });
    }, 34);
  }

  function onChapter(i) {
    if (i === chapter) return;
    chapter = i;
    for (var k = 0; k < blocks.length; k++) blocks[k].classList.toggle('on', k === i);
    audio.setChapter(i); /* 音床 800ms 交叉淡化 */
    if (els.idleText && i >= 0 && i < IDLE_TEXT.length) els.idleText.textContent = IDLE_TEXT[i];
    if (!redCache) { /* 新章大数字翻滚入场（reduced 直接淡入） */
      if (i === 0) scrambleIn(els.lux, function () { return fmtInt(disp.lux); });
      else if (i === 1) scrambleIn(els.ppm, function () { return String(Math.round(disp.ppm) + ppmJit); });
      else if (i === 2) scrambleIn(els.depth, function () { return fmtM(disp.depth); });
    }
  }

  /* ---------- 待机提示 ---------- */
  function updateIdle() {
    var touring = false;
    try {
      touring = !!(doc && doc.body && doc.body.classList && doc.body.classList.contains('touring'));
    } catch (e) { /* noop */ }
    var on = started && !touring && (nowFn() - lastInput > 3000);
    if (on !== idleShown && els.idle) {
      idleShown = on;
      els.idle.classList.toggle('show', on);
    }
  }
  function notifyActivity() {
    lastInput = nowFn();
    started = true;
  }

  /* ---------- 静音（M 键 / 按钮，带状态指示） ---------- */
  function setMute(m) {
    mutedUI = !!m;
    audio.setMuted(mutedUI);
    if (els.muteLabel) els.muteLabel.textContent = mutedUI ? '声音 关' : '声音 开';
    if (els.muteBtn) {
      els.muteBtn.classList.toggle('muted', mutedUI);
      if (els.muteBtn.setAttribute) {
        els.muteBtn.setAttribute('aria-pressed', mutedUI ? 'true' : 'false');
      }
    }
  }

  /* ---------- 主 tick（由 bloom-app.js 每帧 / 静态模式滚动事件驱动） ---------- */
  function tick(o) {
    if (!o || typeof o.p !== 'number') return;
    var p = clamp01(o.p);
    var t = nowFn();
    var dt;
    if (typeof o.dt === 'number' && o.dt > 0) dt = Math.min(o.dt, 0.1);
    else dt = lastT ? Math.min((t - lastT) / 1000, 0.1) : 0.016;
    lastT = t;
    if (dt <= 0) dt = 0.0001;
    dtCur = dt;
    redCache = isReduced();

    /* 速度响应：平滑追逐 |Δp|/Δt（0.25 p/s 归一） */
    var raw = Math.abs(p - lastP) / dt;
    lastP = p;
    speedNorm += (clamp01(raw / 0.25) - speedNorm) * (1 - Math.exp(-dt * 4));

    /* 穿越时刻（章界去重） */
    if (bE.update(p)) transit('E');
    if (bF.update(p)) transit('F');

    /* 计量 HUD */
    chase('lux', luxAt(p), fmtInt, els.lux);
    chase('clock', clockAt(p), fmtClock, els.clock);
    chase('dist', distAt(p), fmtM, els.dist);
    chase('depth', depthAt(p), fmtM, els.depth);
    chase('sync', syncAt(p), fmtPct, els.sync);

    /* 孢子浓度活数字：基线追逐 + 断续 +2/−1 阶跃 */
    chase('ppm', ppmAt(p), null, null);
    if (!redCache) {
      jitTimer -= dt;
      if (jitTimer <= 0) {
        jitTimer = 0.28 + Math.random() * 0.4;
        ppmJit += (Math.random() < 0.5 ? 2 : -1) * (Math.random() < 0.7 ? 1 : 2);
        if (ppmJit > 5) ppmJit = 5;
        if (ppmJit < -3) ppmJit = -3;
      }
    } else ppmJit = 0;
    write('ppm', String(Math.round(disp.ppm) + ppmJit), els.ppm);

    /* 同步率 100% 达成：数字亮起 + 结语淡入（回退自动熄灭） */
    var lit = syncAt(p) >= 99.5;
    if (lit !== syncLit && els.sync) {
      syncLit = lit;
      els.sync.classList.toggle('lit', lit);
    }
    if (lit !== doneShown && els.syncDone) {
      doneShown = lit;
      els.syncDone.classList.toggle('on', lit);
    }

    updateIdle();
  }

  /* ---------- 事件 ---------- */
  function onGesture() {
    audio.init(); /* 首次用户手势才创建 AudioContext */
    notifyActivity();
  }
  if (win.addEventListener) {
    win.addEventListener('pointerdown', onGesture);
    win.addEventListener('touchstart', onGesture);
    win.addEventListener('wheel', onGesture, { passive: true });
    win.addEventListener('scroll', function () { notifyActivity(); }, { passive: true });
    win.addEventListener('keydown', function (e) {
      onGesture();
      if (e && (e.key === 'm' || e.key === 'M')) setMute(!mutedUI);
    });
  }
  if (doc && doc.addEventListener) {
    doc.addEventListener('visibilitychange', function () {
      audio.visibility(!!doc.hidden);
    });
  }
  if (els.muteBtn && els.muteBtn.addEventListener) {
    els.muteBtn.addEventListener('click', function () {
      audio.init();
      setMute(!mutedUI);
    });
  }
  /* UI 音：章节导航 / 漫游按钮 tick */
  if (doc && doc.querySelectorAll) {
    var chaps = doc.querySelectorAll('.chap');
    for (var c = 0; c < chaps.length; c++) {
      (function (btn) {
        if (btn && btn.addEventListener) {
          btn.addEventListener('click', function () { audio.init(); audio.uiTick(); });
        }
      })(chaps[c]);
    }
    var tourB = doc.getElementById('tourBtn');
    if (tourB && tourB.addEventListener) {
      tourB.addEventListener('click', function () { audio.init(); audio.uiTick(); });
    }
  }

  /* ---------- 导出 ---------- */
  var api = {
    version: '1.0',
    tick: tick,
    onChapter: onChapter,
    notifyActivity: notifyActivity,
    getSpeed: function () { return speedNorm; }, /* 引擎侧粒子拉伸用 */
    setMute: setMute,
    info: function () {
      return {
        ctxCreated: audio.info().ctxCreated,
        muted: mutedUI,
        chapter: chapter,
        fires: { E: fires.E, F: fires.F },
        speed: speedNorm
      };
    },
    dispose: function () {
      if (scrambleIv) { clearInterval(scrambleIv); scrambleIv = 0; }
      audio.dispose();
    },
    pure: {
      luxAt: luxAt, clockAt: clockAt, distAt: distAt, depthAt: depthAt,
      syncAt: syncAt, ppmAt: ppmAt, smoothstep: smoothstep, makeBoundary: makeBoundary
    }
  };
  win.BLOOM_FEEDBACK = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
