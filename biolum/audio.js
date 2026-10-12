/* ============================================================
 * BIOLUM 蓝眼泪 — audio.js（模板派生，内容 Phase 2 替换）
 * 依 ../INTERACTION-DESIGN.md §2.3 规格（题材内容 Phase 2 替换）：
 *   三床环境音（高空/街面/地下），章间 800ms 交叉淡化：
 *     高空 = 粉噪风（cutoff 随滚动速度）+ 偶发闷雷（低频爆发）
 *     街面 = 密雨（高通白噪）+ 市井（棕色噪声低通）
 *     地下 = 低通闷响 + 缓慢人声碎片感（共振峰锯齿短句）
 *   速度调制：滚动速度 → 雨声强度 / 风噪 cutoff（快滚更呼啸）
 *   穿越 sting：C=雨声音量跳升+落点闷响 / D=雨声低通扫频 400ms+混响感闷响
 *   UI 音：导航 tick / 翻牌咔哒 / 漫游启停 / 抵达和弦
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
  var tNow = 0, nextThunder = 6, nextVoice = 4;
  var rainBoost = 1;         // 穿越 C 的雨声音量跳升（JS 端指数回落，不与帧写打架）

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
   * 三床环境音图
   * ============================================================ */
  function buildAerial() {
    var bed = gainOf(0);
    bed.connect(master);
    var wind = noiseSrc('pink');
    var lp = bi('lowpass', 340);
    var g = gainOf(0.26);
    wind.connect(lp); lp.connect(g); g.connect(bed);
    return { gain: bed, windLP: lp, windG: g };
  }
  function buildStreet() {
    var bed = gainOf(0);
    bed.connect(master);
    var rain = noiseSrc('white');                       // 密雨：高通白噪
    var hp = bi('highpass', 1400);
    var lp = bi('lowpass', 6200);
    var rg = gainOf(0.15);
    rain.connect(hp); hp.connect(lp); lp.connect(rg); rg.connect(bed);
    var mur = noiseSrc('brown');                        // 市井：棕色噪声低通
    var mlp = bi('lowpass', 460);
    var mg = gainOf(0.14);
    mur.connect(mlp); mlp.connect(mg); mg.connect(bed);
    return { gain: bed, rainHP: hp, rainLP: lp, rainG: rg, murLP: mlp, murG: mg };
  }
  function buildUnder() {
    var bed = gainOf(0);
    bed.connect(master);
    var rum = noiseSrc('brown');                        // 闷响：低通棕噪
    var rlp = bi('lowpass', 150);
    var rg = gainOf(0.28);
    rum.connect(rlp); rlp.connect(rg); rg.connect(bed);
    var room = noiseSrc('pink');                        // 地下空气感
    var plp = bi('lowpass', 700);
    var pg = gainOf(0.05);
    room.connect(plp); plp.connect(pg); pg.connect(bed);
    return { gain: bed, rumLP: rlp, rumG: rg, roomLP: plp };
  }

  function build() {
    master = gainOf(muted ? 0 : MASTER);
    master.connect(ctx.destination);
    reverb = ctx.createConvolver();
    reverb.buffer = makeIR();
    var rvOut = gainOf(1);
    reverb.connect(rvOut); rvOut.connect(master);
    beds = { aerial: buildAerial(), street: buildStreet(), under: buildUnder() };
    chapter = -1;
  }

  /* ---------- 章切换：800ms 交叉淡化 ---------- */
  function crossfade(ch) {
    var t = ctx.currentTime, i;
    var arr = [beds.aerial, beds.street, beds.under];
    for (i = 0; i < 3; i++) {
      arr[i].gain.gain.setTargetAtTime(i === ch ? BED_L[i] : 0, t, XFADE_TAU);
    }
    /* 回到街面床：撤掉穿越 D 留下的低通闷化（雨声恢复正常密度） */
    if (ch === 1) {
      var st = beds.street;
      st.rainLP.frequency.cancelScheduledValues(t);
      st.rainLP.frequency.value = 6200;
      st.murLP.frequency.cancelScheduledValues(t);
      st.murLP.frequency.value = 460;
    }
  }

  /* ============================================================
   * 偶发事件：闷雷（高空）/ 人声碎片（地下）
   * ============================================================ */
  function thunder() {
    var t = ctx.currentTime;
    var s = ctx.createBufferSource();
    s.buffer = noiseBuf('brown'); s.loop = true; s.playbackRate.value = 0.4;
    var lp = bi('lowpass', 110);
    var g = gainOf(0);
    s.connect(lp); lp.connect(g); g.connect(beds.aerial.gain);
    var pk = 0.4 + Math.random() * 0.3, dur = 2.4 + Math.random() * 1.2;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(pk, t + 0.07);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    var o = ctx.createOscillator();                     // 次声层 44→26Hz
    o.type = 'sine'; o.frequency.setValueAtTime(44, t);
    o.frequency.exponentialRampToValueAtTime(26, t + 2);
    var og = gainOf(0);
    o.connect(og); og.connect(beds.aerial.gain);
    og.gain.setValueAtTime(0.18, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 2.1);
    s.start(t); o.start(t);
    s.stop(t + dur + 0.1); o.stop(t + 2.2);
  }

  function voiceBurst() {                                // 远处人声碎片：共振峰锯齿短句
    var t = ctx.currentTime;
    var dur = 0.5 + Math.random() * 1.1;
    var f0 = 96 + Math.random() * 58;
    var o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.linearRampToValueAtTime(f0 * (0.88 + Math.random() * 0.24), t + dur);
    var f1 = bi('bandpass', 350 + Math.random() * 200, 6);   // 共振峰 F1
    var f2 = bi('bandpass', 900 + Math.random() * 500, 6);   // 共振峰 F2
    var g = gainOf(0);
    var pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    o.connect(f1); o.connect(f2);
    f1.connect(g); f2.connect(g);
    if (pan) { pan.pan.value = Math.random() * 1.2 - 0.6; g.connect(pan); pan.connect(beds.under.gain); pan.connect(reverb); }
    else { g.connect(beds.under.gain); g.connect(reverb); }
    var pk = 0.05 + Math.random() * 0.04;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(pk, t + 0.12);
    g.gain.setValueAtTime(pk, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t); o.stop(t + dur + 0.05);
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
    if (rainBoost > 1.001) {                               // C sting 跳升回落（约 1.1s）
      rainBoost += (1 - rainBoost) * (1 - Math.exp(-(dt / 1000) * 2.4));
    } else rainBoost = 1;
    beds.aerial.windLP.frequency.value = 320 + 1500 * sv;   // 快滚呼啸
    beds.aerial.windG.gain.value = 0.22 + 0.22 * sv;
    beds.street.rainG.gain.value = (0.12 + 0.21 * sv) * rainBoost;   // 快滚雨密
    beds.street.rainHP.frequency.value = 1450 - 520 * sv;   // 雨点更沉
    beds.under.rumG.gain.value = 0.26 + 0.08 * sv;
    tNow += dt / 1000;
    if (chapter === 0 && tNow >= nextThunder) {
      thunder();
      nextThunder = tNow + 9 + Math.random() * 13;
    }
    if (chapter === 2 && tNow >= nextVoice) {
      voiceBurst();
      nextVoice = tNow + 2.8 + Math.random() * 4.5;
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
      /* C · 穿云落地：雨声音量跳升（rainBoost 帧驱动 ~1.1s 回落）+ 落点闷响 + 雨泼溅 */
      rainBoost = 2.4;
      var sp = ctx.createBufferSource();                 // 泼溅：宽带白噪 Burst
      sp.buffer = noiseBuf('white'); sp.loop = true;
      var bp = bi('bandpass', 2600, 1);
      var sg = envG(master, t, 0.4, 0.02, 0.25);
      sp.connect(bp); bp.connect(sg);
      sp.start(t); sp.stop(t + 0.4);
      var o = ctx.createOscillator();                    // 落点低频 Thump
      o.type = 'sine'; o.frequency.setValueAtTime(82, t);
      o.frequency.exponentialRampToValueAtTime(36, t + 0.28);
      var og = envG(master, t, 0.5, 0.012, 0.3);
      o.connect(og); o.start(t); o.stop(t + 0.35);
    } else if (id === 1) {
      /* D · 沉入地下：雨声闷掉（低通 400ms 扫频）+ 市井低通闷化
         + 混响感闷响（正弦对过卷积混响）+ 关门 Slam */
      var st2 = beds.street;
      st2.rainLP.frequency.cancelScheduledValues(t);
      st2.rainLP.frequency.setValueAtTime(st2.rainLP.frequency.value || 6200, t);
      st2.rainLP.frequency.linearRampToValueAtTime(240, t + 0.4);
      st2.murLP.frequency.cancelScheduledValues(t);
      st2.murLP.frequency.setValueAtTime(st2.murLP.frequency.value || 460, t);
      st2.murLP.frequency.linearRampToValueAtTime(190, t + 0.4);
      var rg = envG(reverb, t, 0.55, 0.02, 1.1);         // 闷响经混响 → 地下空间感
      var o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
      o1.type = 'sine'; o1.frequency.value = 96;
      o2.type = 'sine'; o2.frequency.value = 144;
      o1.connect(rg); o2.connect(rg);
      o1.start(t); o2.start(t); o1.stop(t + 1.3); o2.stop(t + 1.3);
      var dry = envG(master, t, 0.22, 0.015, 0.5);       // 干声少量
      o1.connect(dry);
      var sl = ctx.createBufferSource();                 // Slam：棕噪短促
      sl.buffer = noiseBuf('brown'); sl.loop = true;
      var slp = bi('lowpass', 300);
      var slg = envG(master, t + 0.05, 0.4, 0.01, 0.14);
      sl.connect(slp); slp.connect(slg);
      sl.start(t); sl.stop(t + 0.3);
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

  function arrive() {                                     // 抵达：暖和弦（面档暖光）
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
