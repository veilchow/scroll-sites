/* ============================================================
 * BIOLUM 蓝眼泪 — audio.js（模板派生，声音人格按 PLAN-DESIGN §1.6 题材化）
 * 三床环境音（章间 800ms 交叉淡化）：
 *   黄昏小镇 = 远浪（棕噪 LP400 慢包络起落）+ 海风（粉噪 LP800 极轻）+
 *              远镇人声余温（带通极低）+ 偶发海鸟/暮虫（2.2-3.5k 正弦簇）
 *   夜海     = 浪沿沙沙（白噪带通 500-1500，浪周期呼吸）+
 *              荧光呼吸垫（220+329.6Hz 纯五度，0.05Hz 慢呼吸）+ 40Hz 洋流
 *   水下星河 = 低通 250Hz 水体闷响 + 星河泛音质感（高频带通极轻）+
 *              偶发气泡串（600→1200Hz 上滑）+ 55Hz 心跳脉冲（52 BPM）+
 *              偶发远风铃正弦点亮
 *   速度调制：滚动速度 → 浪包络/风噪 cutoff/闷响增益（快滚更"追"）
 *   穿越 sting：T1「点亮」=浪环境跳升+swish+660→1320Hz 上滑+浪拍面 Thump
 *               T2「骤闷」=白噪水花+夜海带通骤降扫频+55Hz 闷击+
 *                          深水混响轰+水封 Slam+气泡上滑补偿
 *   UI 音：导航 tick / 翻牌咔哒 / 漫游启停 / 抵达和弦（暖橙情绪点）
 *   首次用户手势才创建 AudioContext；M 键全局静音（有状态指示）
 * Node 桩安全：模块加载不触碰任何构造器，ensure() 前不创建 AudioContext。
 * ============================================================ */
window.BIOSND = (function () {
  'use strict';

  var MASTER = 0.9;          // 总音量
  var BED_L = [0.9, 0.85, 0.95];   // 各章音床目标电平
  var XFADE_TAU = 0.28;      // setTargetAtTime 时间常数 ≈ 800ms 到位

  var ctx = null, master = null, reverb = null;
  var beds = null, nCache = {};
  var chapter = -1;
  var muted = false;
  var tNow = 0;
  var nextGull = 6, nextBub = 4, nextPing = 3, nextBeat = 0;
  var washBoost = 1;         // 穿越 T1 的浪环境音量跳升（JS 端指数回落，不与帧写打架）

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function hasContext() { return !!ctx; }
  function isMuted() { return muted; }

  /* ---------- 手势初始化（幂等；浏览器手势事件里调用） ---------- */
  function ensure() {
    if (ctx) { if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} } return true; }
    var AC = (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) || null;
    if (!AC) return false;
    try { ctx = new AC(); } catch (e) { ctx = null; return false; }
    build();
    return true;
  }

  /* ============================================================
   * 噪声源（缓冲区合成：白 / 粉 / 棕）
   * ============================================================ */
  function noiseBuf(type) {
    if (nCache[type]) return nCache[type];
    var sr = ctx.sampleRate, len = Math.floor(sr * 6);
    var buf = ctx.createBuffer(1, len, sr), d = buf.getChannelData(0);
    var i;
    if (type === 'white') {
      for (i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    } else if (type === 'pink') {           // Paul Kellet 近似粉噪
      var b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (i = 0; i < len; i++) {
        var w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520;
        b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.0168980;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      }
    } else {                                 // 棕色噪声（泄漏积分 + 归一）
      var last = 0, mx = 0;
      for (i = 0; i < len; i++) {
        var w2 = Math.random() * 2 - 1;
        last = (last + 0.02 * w2) / 1.02;
        d[i] = last * 3.5;
        if (Math.abs(d[i]) > mx) mx = Math.abs(d[i]);
      }
      if (mx > 0) for (i = 0; i < len; i++) d[i] /= mx;
    }
    var F = Math.floor(sr * 0.03);           // 首尾 30ms 淡化，循环无咔哒
    for (i = 0; i < F; i++) { var g = i / F; d[i] *= g; d[len - 1 - i] *= g; }
    nCache[type] = buf;
    return buf;
  }
  function noiseSrc(type) {
    var s = ctx.createBufferSource();
    s.buffer = noiseBuf(type);
    s.loop = true;
    s.start();
    return s;
  }
  function bi(type, freq, q) {
    var f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q || 0.7;
    return f;
  }
  function gainOf(v) { var g = ctx.createGain(); g.gain.value = v; return g; }

  /* 卷积混响 IR：指数衰减噪声（全合成，1.8s） */
  function makeIR() {
    var sr = ctx.sampleRate, len = Math.floor(sr * 1.8);
    var buf = ctx.createBuffer(2, len, sr);
    for (var c = 0; c < 2; c++) {
      var d = buf.getChannelData(c);
      for (var i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.4);
      }
    }
    return buf;
  }

  /* ============================================================
   * 三床环境音图（图形状继承：noiseSrc → 滤波 → 增益 → bed）
   * ============================================================ */
  function buildDusk() {                       // 床 A 黄昏小镇：暖、慢、人间
    var bed = gainOf(0);
    bed.connect(master);
    var surf = noiseSrc('brown');              // 远浪：棕噪低通 400Hz（8s 慢包络起落在 update 里）
    var slp = bi('lowpass', 400);
    var sg = gainOf(0.2);
    surf.connect(slp); slp.connect(sg); sg.connect(bed);
    var breeze = noiseSrc('pink');             // 海风：粉噪低通 800Hz 极轻
    var blp = bi('lowpass', 800);
    var bg = gainOf(0.05);
    breeze.connect(blp); blp.connect(bg); bg.connect(bed);
    var town = noiseSrc('pink');               // 远镇人声余温：300-800Hz 带通极低起伏
    var tbp = bi('bandpass', 520, 1.1);
    var tg = gainOf(0.035);
    town.connect(tbp); tbp.connect(tg); tg.connect(bed);
    return { gain: bed, surfLP: slp, surfG: sg, breezeLP: blp, breezeG: bg, townG: tg };
  }
  function buildSea() {                        // 床 B 夜海：清冷、神秘、期待
    var bed = gainOf(0);
    bed.connect(master);
    var wash = noiseSrc('white');              // 浪沿沙沙：白噪带通 500-1500（sting 骤闷扫频目标）
    var wbp = bi('bandpass', 1000, 0.8);
    var wlp = bi('lowpass', 4500);             // 速度调制 cutoff（与扫频目标分离，帧写不打架）
    var wg = gainOf(0.16);
    wash.connect(wbp); wbp.connect(wlp); wlp.connect(wg); wg.connect(bed);
    var o1 = ctx.createOscillator(), o2 = ctx.createOscillator();   // 荧光呼吸垫：纯五度双正弦
    o1.type = 'sine'; o1.frequency.value = 220;
    o2.type = 'sine'; o2.frequency.value = 329.6;
    var dg = gainOf(0.035);
    o1.connect(dg); o2.connect(dg); dg.connect(bed);
    o1.start(); o2.start();
    var cur = ctx.createOscillator();          // 洋流低频 40Hz 极轻
    cur.type = 'sine'; cur.frequency.value = 40;
    var cg = gainOf(0.03);
    cur.connect(cg); cg.connect(bed);
    cur.start();
    return { gain: bed, washBP: wbp, washLP: wlp, washG: wg, droneG: dg, curG: cg };
  }
  function buildDeep() {                       // 床 C 水下星河：包裹、安静、神圣
    var bed = gainOf(0);
    bed.connect(master);
    var rum = noiseSrc('brown');               // 水体闷响：棕噪低通 250Hz（持续层）
    var rlp = bi('lowpass', 250);
    var rg = gainOf(0.28);
    rum.connect(rlp); rlp.connect(rg); rg.connect(bed);
    var star = noiseSrc('white');              // 星河泛音质感层：2-5kHz 带通极轻（氛围层）
    var sbp = bi('bandpass', 3200, 2.5);
    var sg = gainOf(0.012);
    star.connect(sbp); sbp.connect(sg); sg.connect(bed);
    return { gain: bed, rumLP: rlp, rumG: rg, starG: sg };
  }

  function build() {
    master = gainOf(muted ? 0 : MASTER);
    master.connect(ctx.destination);
    reverb = ctx.createConvolver();
    reverb.buffer = makeIR();
    var rvOut = gainOf(1);
    reverb.connect(rvOut); rvOut.connect(master);
    beds = { dusk: buildDusk(), sea: buildSea(), deep: buildDeep() };
    chapter = -1;
  }

  /* ---------- 章切换：800ms 交叉淡化 ---------- */
  function crossfade(ch) {
    var t = ctx.currentTime, i;
    var arr = [beds.dusk, beds.sea, beds.deep];
    for (i = 0; i < 3; i++) {
      arr[i].gain.gain.setTargetAtTime(i === ch ? BED_L[i] : 0, t, XFADE_TAU);
    }
    /* 回到夜海床：撤掉穿越 T2 留下的带通闷化（浪沿沙沙恢复正常密度） */
    if (ch === 1) {
      var se = beds.sea;
      se.washBP.frequency.cancelScheduledValues(t);
      se.washBP.frequency.value = 1000;
    }
  }

  /* ============================================================
   * 偶发事件：海鸟（黄昏）/ 气泡串 + 心跳 + 远风铃（水下）
   * ============================================================ */
  function gull() {                            // 海鸟/暮虫：2.2-3.5kHz 断续正弦簇
    var t = ctx.currentTime;
    var n = 2 + Math.floor(Math.random() * 3);
    for (var i = 0; i < n; i++) {
      var t0 = t + i * (0.16 + Math.random() * 0.12);
      var f = 2200 + Math.random() * 1300;
      var o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(f, t0);
      o.frequency.exponentialRampToValueAtTime(f * (0.72 + Math.random() * 0.2), t0 + 0.14);
      var g = envG(beds.dusk.gain, t0, 0.028 + Math.random() * 0.02, 0.02, 0.16);
      var wet = envG(reverb, t0, 0.012, 0.02, 0.3);
      o.connect(g); o.connect(wet);
      o.start(t0); o.stop(t0 + 0.32);
    }
  }

  function bubbleBurst() {                     // 气泡串：500→1100Hz 正弦上滑 40-80ms × 3-6
    var t = ctx.currentTime;
    var n = 3 + Math.floor(Math.random() * 4);
    var pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    var out = beds.deep.gain;
    if (pan) {
      pan.pan.value = Math.random() * 1.2 - 0.6;
      pan.connect(beds.deep.gain); pan.connect(reverb);
      out = pan;
    }
    for (var i = 0; i < n; i++) {
      var t0 = t + i * (0.07 + Math.random() * 0.10);
      var f0 = 500 + Math.random() * 250;
      var o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(f0, t0);
      o.frequency.exponentialRampToValueAtTime(f0 * (2.0 + Math.random() * 0.6), t0 + 0.05 + Math.random() * 0.03);
      var g = envG(out, t0, 0.05 + Math.random() * 0.03, 0.008, 0.09);
      o.connect(g);
      o.start(t0); o.stop(t0 + 0.18);
    }
  }

  function heartbeat() {                       // 心跳低频：55Hz 双跳，52 BPM 极低幅度
    var t = ctx.currentTime;
    [0, 0.14].forEach(function (d, i) {
      var o = ctx.createOscillator();
      o.type = 'sine'; o.frequency.value = 55;
      var g = envG(beds.deep.gain, t + d, i ? 0.035 : 0.05, 0.012, 0.16);
      o.connect(g); o.start(t + d); o.stop(t + d + 0.3);
    });
  }

  function starPing() {                        // 星河泛音：2-5kHz 正弦极轻点亮（极远风铃）
    var t = ctx.currentTime;
    var o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = 2000 + Math.random() * 3000;
    var wet = envG(reverb, t, 0.02, 0.008, 1.2);
    var dry = envG(beds.deep.gain, t, 0.008, 0.008, 0.5);
    o.connect(wet); o.connect(dry);
    o.start(t); o.stop(t + 1.5);
  }

  /* ============================================================
   * 每帧驱动（app.js 主循环）：章切换 + 速度调制 + 事件调度
   *   p 进度 · v 平滑速度 0..1 · dt ms
   * ============================================================ */
  function update(p, v, dt) {
    if (!ctx || ctx.state !== 'running' || !beds) return;
    var ch = p < 1 / 3 ? 0 : p < 2 / 3 ? 1 : 2;
    if (ch !== chapter) { chapter = ch; crossfade(ch); }
    var sv = clamp(v, 0, 1);
    if (washBoost > 1.001) {                               // T1 sting 跳升回落（约 1.1s）
      washBoost += (1 - washBoost) * (1 - Math.exp(-(dt / 1000) * 2.4));
    } else washBoost = 1;
    tNow += dt / 1000;
    var swell = 0.5 + 0.5 * Math.sin(tNow * Math.PI * 2 / 8);      // 浪涌 8s 慢包络
    beds.dusk.surfG.gain.value = 0.14 + 0.10 * swell + 0.06 * sv;  // 远浪起落，快滚更近
    beds.dusk.breezeLP.frequency.value = 560 + 1100 * sv;         // 快滚风急（频率+增益双参单调）
    beds.dusk.breezeG.gain.value = 0.035 + 0.05 * sv;
    beds.dusk.townG.gain.value = 0.03 + 0.012 * swell;
    beds.sea.washG.gain.value = (0.10 + 0.16 * sv) * washBoost;    // 快滚浪密（跳升回落）
    beds.sea.washLP.frequency.value = 3000 + 2400 * sv;            // 快滚浪沿更亮
    beds.sea.droneG.gain.value = 0.028 + 0.016 * (0.5 + 0.5 * Math.sin(tNow * Math.PI * 2 * 0.05));  // 0.05Hz 荧光呼吸
    beds.deep.rumG.gain.value = 0.26 + 0.08 * sv;                  // 快滚水体更涌
    if (chapter === 0 && tNow >= nextGull) {
      gull();
      nextGull = tNow + 9 + Math.random() * 13;
    }
    if (chapter === 2 && tNow >= nextBub) {
      bubbleBurst();
      nextBub = tNow + 2.8 + Math.random() * 4.5;
    }
    if (chapter === 2 && tNow >= nextPing) {
      starPing();
      nextPing = tNow + 4 + Math.random() * 7;
    }
    if (chapter === 2 && tNow >= nextBeat) {
      heartbeat();
      nextBeat = tNow + 60 / 52;                       // 52 BPM
    }
  }

  /* ============================================================
   * 穿越 sting 与 UI 音
   * ============================================================ */
  function envG(dest, t, pk, atk, dec) {
    var g = gainOf(0);
    g.connect(dest);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(pk, t + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t + atk + dec);
    return g;
  }

  function sting(id) {
    if (!ctx || ctx.state !== 'running') return;
    var t = ctx.currentTime;
    if (id === 0) {
      /* T1 · 夜幕初光「点亮」：浪环境跳升（washBoost 帧驱动 ~1.1s 回落）
         + 高频 swish + 660→1320Hz 上滑音（第一道荧光浪破开）+ 浪拍面 Thump */
      washBoost = 2.4;
      var sw = ctx.createBufferSource();                  // swish：高频带通噪声 300ms
      sw.buffer = noiseBuf('white'); sw.loop = true;
      var sbp = bi('bandpass', 2600, 1.2);
      var sg = envG(master, t, 0.28, 0.02, 0.3);
      sw.connect(sbp); sbp.connect(sg);
      sw.start(t); sw.stop(t + 0.45);
      var gl = ctx.createOscillator();                    // 点亮上滑音 660→1320Hz 160ms + 轻混响尾
      gl.type = 'sine';
      gl.frequency.setValueAtTime(660, t);
      gl.frequency.exponentialRampToValueAtTime(1320, t + 0.16);
      var glg = envG(master, t, 0.16, 0.01, 0.5);
      var glw = envG(reverb, t, 0.14, 0.01, 0.9);
      gl.connect(glg); gl.connect(glw);
      gl.start(t); gl.stop(t + 0.75);
      var th = ctx.createOscillator();                    // 浪拍面低频 Thump 82→36Hz
      th.type = 'sine'; th.frequency.setValueAtTime(82, t);
      th.frequency.exponentialRampToValueAtTime(36, t + 0.28);
      var thg = envG(master, t, 0.4, 0.012, 0.3);
      th.connect(thg); th.start(t); th.stop(t + 0.35);
    } else if (id === 1) {
      /* T2 · 破水入水「骤闷」：白噪水花爆发（40ms）+ 夜海床带通骤降扫频（200ms）
         + 55Hz 闷击（100ms）+ 深水混响轰 + 水封 Slam + 气泡上滑补偿（600ms） */
      var sp = ctx.createBufferSource();                  // 水花：白噪爆发 40ms
      sp.buffer = noiseBuf('white'); sp.loop = true;
      var spg = envG(master, t, 0.45, 0.004, 0.09);
      sp.connect(spg); sp.start(t); sp.stop(t + 0.2);
      var se = beds.sea;                                  // 环境骤闷：浪沿带通 1000→300 扫频 200ms
      se.washBP.frequency.cancelScheduledValues(t);
      se.washBP.frequency.setValueAtTime(se.washBP.frequency.value || 1000, t);
      se.washBP.frequency.linearRampToValueAtTime(300, t + 0.2);
      var th2 = ctx.createOscillator();                   // 55Hz 入水闷击 100ms
      th2.type = 'sine'; th2.frequency.value = 55;
      var thg2 = envG(master, t, 0.5, 0.008, 0.22);
      th2.connect(thg2); th2.start(t); th2.stop(t + 0.4);
      var rg = envG(reverb, t, 0.5, 0.02, 1.1);           // 深水轰经混响 → 水下空间感
      var o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
      o1.type = 'sine'; o1.frequency.value = 110;
      o2.type = 'sine'; o2.frequency.value = 165;
      o1.connect(rg); o2.connect(rg);
      o1.start(t); o2.start(t); o1.stop(t + 1.3); o2.stop(t + 1.3);
      var dry = envG(master, t, 0.2, 0.015, 0.5);         // 干声少量
      o1.connect(dry);
      var sl = ctx.createBufferSource();                  // 水封 Slam：棕噪短促
      sl.buffer = noiseBuf('brown'); sl.loop = true;
      var slp = bi('lowpass', 300);
      var slg = envG(master, t + 0.05, 0.4, 0.01, 0.14);
      sl.connect(slp); slp.connect(slg);
      sl.start(t); sl.stop(t + 0.3);
      for (var bi2 = 0; bi2 < 3; bi2++) {                 // 气泡上滑补偿 600ms
        var t0 = t + 0.1 + bi2 * 0.18 + Math.random() * 0.04;
        var bo = ctx.createOscillator();
        bo.type = 'sine';
        bo.frequency.setValueAtTime(420 + Math.random() * 200, t0);
        bo.frequency.exponentialRampToValueAtTime(1100 + Math.random() * 400, t0 + 0.1);
        var bog = envG(master, t0, 0.07, 0.01, 0.12);
        bo.connect(bog); bo.start(t0); bo.stop(t0 + 0.28);
      }
    }
  }

  function flick() {                                      // 翻牌咔哒
    if (!ctx || ctx.state !== 'running') return;
    var t = ctx.currentTime;
    var s = ctx.createBufferSource();
    s.buffer = noiseBuf('white'); s.loop = true;
    var hp = bi('highpass', 3200);
    var g = envG(master, t, 0.14, 0.004, 0.05);
    s.connect(hp); hp.connect(g);
    s.start(t); s.stop(t + 0.08);
    var o = ctx.createOscillator();
    o.type = 'sine'; o.frequency.value = 1180;
    var og = envG(master, t, 0.07, 0.004, 0.05);
    o.connect(og); o.start(t); o.stop(t + 0.08);
  }

  function tick() {                                       // 导航跳章 tick
    if (!ctx || ctx.state !== 'running') return;
    var t = ctx.currentTime;
    [1180, 1760].forEach(function (f, i) {
      var o = ctx.createOscillator();
      o.type = 'sine'; o.frequency.value = f;
      var g = envG(master, t + i * 0.045, 0.09, 0.005, 0.06);
      o.connect(g); o.start(t + i * 0.045); o.stop(t + 0.2);
    });
  }

  function blip(on) {                                     // 漫游启停确认音
    if (!ctx || ctx.state !== 'running') return;
    var t = ctx.currentTime;
    var seq = on ? [620, 930] : [930, 590];
    seq.forEach(function (f, i) {
      var o = ctx.createOscillator();
      o.type = 'triangle'; o.frequency.value = f;
      var g = envG(master, t + i * 0.1, 0.11, 0.012, 0.12);
      o.connect(g); o.start(t + i * 0.1); o.stop(t + 0.35);
    });
  }

  function arrive() {                                     // 抵达：暖和弦（岸上黄昏的暖橙情绪点）
    if (!ctx || ctx.state !== 'running') return;
    var t = ctx.currentTime;
    [392, 523.25, 659.25, 784].forEach(function (f, i) {
      var o = ctx.createOscillator();
      o.type = 'sine'; o.frequency.value = f;
      var wet = envG(reverb, t + i * 0.09, 0.12, 0.03, 1.6);
      var dry = envG(master, t + i * 0.09, 0.08, 0.03, 1.2);
      o.connect(wet); o.connect(dry);
      o.start(t + i * 0.09); o.stop(t + 2.2);
    });
  }

  /* ---------- 静音 / 生命周期 ---------- */
  function toggleMute() {
    muted = !muted;
    if (ctx && master) master.gain.setTargetAtTime(muted ? 0 : MASTER, ctx.currentTime, 0.05);
    return muted;
  }
  function suspend() { if (ctx && ctx.state === 'running') { try { ctx.suspend(); } catch (e) {} } }
  function resume() { if (ctx && ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} } }

  return {
    ensure: ensure,
    update: update,
    sting: sting,
    flick: flick,
    tick: tick,
    blip: blip,
    arrive: arrive,
    toggleMute: toggleMute,
    hasContext: hasContext,
    isMuted: isMuted,
    suspend: suspend,
    resume: resume
  };
})();
