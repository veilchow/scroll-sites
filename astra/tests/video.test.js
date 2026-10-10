/* ==========================================================================
 * ASTRA · P2 视频画面层桩测试（Node 桩环境，无浏览器依赖）
 * astra/tests/video.test.js
 *
 * 用法：node tests/video.test.js （在 astra/ 目录下）
 *
 * 检查项（任务自查 §3）：
 *   1. 进度 → currentTime 映射连续：p 0→1 步进 0.001，段内时间单调；
 *      0.549→0.551 无跳变（接缝两侧均锁定 port 构图、交叉权重互补和恒 1）。
 *   2. 两段接缝对齐：55% 处 map1=dur1 / map2=0；75% 处 map2=dur2，
 *      引擎 core 交叉权重接管（SWAP2 窗口连续，无黑帧/闪跳）。
 *   3. 失败回退路径：mock fetch 失败 / 8s 超时（压缩为 40ms）→ 段 failed、
 *      覆盖率归零；引擎 render 冒烟（fake 2d ctx）：无视频时绘程序化
 *      深空兜底，视频显影时跳过不透明底填充（不盖视频）→ 引擎照常渲染。
 *   4. tour 播放态与 scrub 态切换：engaged 段 unmuted+play、漫游节奏由
 *      视频时间接管、播完一段接下一段；中断 → 立即 pause+muted+seek 回
 *      当前进度；全局静音跟随。
 * ========================================================================== */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

function loadFile(file, globals) {
  var src = fs.readFileSync(path.join(__dirname, '..', 'js', file), 'utf8');
  var sandbox = Object.assign({ window: {}, console: console }, globals || {});
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.window;
}

var failures = [];
var checks = 0;
function check(cond, msg) {
  checks++;
  if (!cond) failures.push(msg);
}
function near(a, b, eps, msg) {
  check(Math.abs(a - b) <= (eps === undefined ? 1e-9 : eps), msg + '（期望 ' + b + '，实测 ' + a + '）');
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

var DUR = 6.584;                       /* 与素材实测 duration 一致（ffprobe） */

/* ---------- fake 2d ctx（render 冒烟用；统计 drawImage 次数） ---------- */
function makeCtx() {
  var grad = { addColorStop: function () {} };
  var c = { _drawImage: 0 };
  return new Proxy(c, {
    get: function (t, k) {
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return function () { return grad; };
      if (k === 'drawImage') return function () { t._drawImage++; };
      if (typeof k === 'symbol') return undefined;
      return (k in t) ? t[k] : function () {};
    },
    set: function (t, k, v) { t[k] = v; return true; }
  });
}

/* ---------- fake <video> 元素 ---------- */
function FakeVideoEl() {
  this.listeners = {};
  this.muted = true; this.currentTime = 0; this.duration = NaN;
  this.paused = true; this.ended = false; this.seeking = false;
  this.readyState = 0; this.volume = 1; this.src = '';
  this.playsInline = false; this.preload = '';
  this.playCount = 0; this.pauseCount = 0;
  this.style = {};
}
FakeVideoEl.prototype.addEventListener = function (t, fn) {
  (this.listeners[t] = this.listeners[t] || []).push(fn);
};
FakeVideoEl.prototype.fire = function (t) {
  var ls = (this.listeners[t] || []).slice();
  for (var i = 0; i < ls.length; i++) ls[i]({ type: t });
};
FakeVideoEl.prototype.play = function () {
  this.paused = false; this.ended = false; this.playCount++;
  return { catch: function () {} };
};
FakeVideoEl.prototype.pause = function () { this.paused = true; this.pauseCount++; };
FakeVideoEl.prototype.load = function () {};
FakeVideoEl.prototype.removeAttribute = function () {};
FakeVideoEl.prototype.setAttribute = function () {};

function okFetch() {
  return Promise.resolve({ ok: true, status: 200, blob: function () { return Promise.resolve({ size: 1 }); } });
}

function makeEnv(fetchImpl, opts) {
  var v1 = new FakeVideoEl(), v2 = new FakeVideoEl();
  var setVideoStateCalls = [];
  var winObj = {
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    fetch: fetchImpl,
    URL: { createObjectURL: function () { return 'blob:f'; }, revokeObjectURL: function () {} },
    AstraEngine: { setVideoState: function (s) { setVideoStateCalls.push(s); } }
  };
  var docObj = {
    hidden: false,
    getElementById: function (id) { return id === 'vid1' ? v1 : (id === 'vid2' ? v2 : null); }
  };
  var w = loadFile('astra-video.js', { window: winObj, document: docObj });
  var inited = w.AstraVideo.init(opts || { revealMs: 0 });
  return { api: w.AstraVideo, v1: v1, v2: v2, calls: setVideoStateCalls, inited: inited };
}

function makeReady(el, api, fireP) {          /* 推进 fake 加载状态机到 ready+显影 */
  el.duration = DUR;
  el.fire('loadedmetadata');
  el.fire('loadeddata');
  el.fire('seeked');                          /* 首次 seeked → 开始显影 */
  if (fireP !== undefined) api.update({ p: fireP });
}

/* ==========================================================================
 * 1 + 2. 映射连续性 / 接缝对齐（纯逻辑 + 引擎主图权重）
 * ========================================================================== */
var VidLogic = loadFile('astra-video.js').AstraVideo.logic;
check(!!VidLogic, 'AstraVideo.logic 未导出');
var Eng = loadFile('astra-scene.js', {
  document: { createElement: function () { return { width: 0, height: 0, getContext: function () { return makeCtx(); } }; } }
}).AstraEngine;
check(!!Eng, 'AstraEngine 未导出');
var L = VidLogic;

function weights(p, a1, a2) {
  var cam = Eng.camera(p);
  var w = Eng.plateWeights(cam, { a1: a1, a2: a2 });
  return { w: w, o1: L.opFor(0, p, a1), o2: L.opFor(1, p, a2) };
}

/* 段边界映射精确值 */
near(L.segTime(0, L.SPANS[0], DUR), 0, 1e-9, 'segTime(0) 应为 0');
near(L.segTime(L.SPANS[0][1], L.SPANS[0], DUR), DUR, 1e-9, 'segTime(0.55) seg1 应为 duration');
near(L.segTime(L.SPANS[1][0], L.SPANS[1], DUR), 0, 1e-9, 'segTime(0.55) seg2 应为 0');
near(L.segTime(L.SPANS[1][1], L.SPANS[1], DUR), DUR, 1e-9, 'segTime(0.75) seg2 应为 duration');
near(L.segTime(0.6, L.SPANS[1], DUR), DUR * 0.25, 1e-9, 'segTime(0.6) seg2 应为 25% duration');

/* 全程扫描：单调 + 无洞 + （非堆叠区）权重和恒 1 */
(function () {
  var prevT1 = -1, prevT2 = -1, monoOK = true, holeOK = true, sumOK = true;
  for (var p = 0; p <= 1.0000001; p += 0.001) {
    var ww = weights(p, 1, 1);
    var t1 = L.segTime(p, L.SPANS[0], DUR), t2 = L.segTime(p, L.SPANS[1], DUR);
    if (t1 < prevT1 - 1e-9 || t2 < prevT2 - 1e-9) monoOK = false;
    prevT1 = t1; prevT2 = t2;
    var total = ww.o1 + ww.o2 + ww.w[0] + ww.w[1] + ww.w[2];
    if (total < 1 - 1e-9) holeOK = false;                       /* 黑帧/闪跳 = 权重空洞 */
    /* [0.745,0.765] = 引擎 core 与视频的堆叠交叉淡化（canvas 在上、视频在下，
     * source-over 合成，权重和 >1 是预期）；其余区域必须恰好 1 */
    if (!(p > 0.7445 && p < 0.7655)) {
      if (Math.abs(total - 1) > 1e-6) sumOK = false;
    }
  }
  check(monoOK, 'segTime 应随进度单调不减');
  check(holeOK, '全程画面权重不得出现空洞（无黑帧）');
  check(sumOK, '非堆叠区 视频权重+主图权重 和应恒为 1');
})();

/* 单段失败模式：权重和恒 1（引擎路径与 v2 等价，无缝兜底）；
 * seg2 激活时 [0.745,0.765] 仍是"canvas core 交叉盖在视频上"的堆叠淡化，不计入 */
[function (a) { return [a, 0]; }, function (a) { return [0, a]; }].forEach(function (mode, mi) {
  var ok = true;
  for (var p = 0; p <= 1.0000001; p += 0.001) {
    var av = mode(1);
    var ww = weights(p, av[0], av[1]);
    var total = ww.o1 + ww.o2 + ww.w[0] + ww.w[1] + ww.w[2];
    var stacked = (mi === 1) && p > 0.7445 && p < 0.7655;
    if (total < 1 - 1e-9) { ok = false; break; }
    if (!stacked && Math.abs(total - 1) > 1e-6) { ok = false; break; }
  }
  check(ok, '单段失败模式(' + mi + ') 权重和应恒为 1（回退无接缝）');
});

/* 0.549 → 0.551 无跳变 */
(function () {
  var sA = weights(0.549, 1, 1), sB = weights(0.551, 1, 1);
  near(sA.o1 + sA.o2, 1, 1e-9, 'p=0.549 交叉权重和应为 1');
  near(sB.o1 + sB.o2, 1, 1e-9, 'p=0.551 交叉权重和应为 1');
  var t1a = L.segTime(0.549, L.SPANS[0], DUR);
  var t2b = L.segTime(0.551, L.SPANS[1], DUR);
  near(t1a, DUR * (0.549 / 0.55), 1e-9, 'segTime(0.549) seg1 精确值');
  near(t2b, DUR * ((0.551 - 0.55) / 0.20), 1e-9, 'segTime(0.551) seg2 精确值');
  check(DUR - t1a <= 0.04, '0.549 时 seg1 应在尾帧邻域（port 构图），距尾 ' + (DUR - t1a).toFixed(4) + 's');
  check(t2b <= 0.04, '0.551 时 seg2 应在首帧邻域（port 构图），距首 ' + t2b.toFixed(4) + 's');
  /* 接缝邻域微步：视频时间与不透明度均连续（无跳变） */
  var prev = null, contOK = true;
  for (var p = 0.540; p <= 0.5600001; p += 0.0005) {
    var cur = {
      t1: L.segTime(p, L.SPANS[0], DUR),
      t2: L.segTime(p, L.SPANS[1], DUR),
      o1: L.base1(p), o2: L.base2(p)
    };
    if (prev) {
      if (Math.abs(cur.t1 - prev.t1) > (0.0005 / 0.55) * DUR + 1e-9) contOK = false;
      if (Math.abs(cur.t2 - prev.t2) > (0.0005 / 0.20) * DUR + 1e-9) contOK = false;
      if (Math.abs(cur.o1 - prev.o1) > 0.16 || Math.abs(cur.o2 - prev.o2) > 0.16) contOK = false;
    }
    prev = cur;
  }
  check(contOK, '0.549→0.551 接缝邻域映射应连续无跳变');
})();

/* 75% 接缝：map2=dur2、引擎 core 交叉权重接管 */
(function () {
  near(L.base2(0.749), 1, 1e-9, '0.749 时 seg2 应满显');
  near(L.base2(0.755), 1, 1e-9, '0.755（CORE_IN 起点）seg2 应仍满显');
  near(L.base2(0.765), 0, 1e-9, '0.765 后 seg2 应完全淡出（画面已被 canvas core 覆盖）');
  var cam75 = Eng.camera(0.75);
  var w75 = Eng.plateWeights(cam75, { a1: 1, a2: 1 });
  near(w75[2], 0.5, 1e-9, '引擎 core 交叉权重在 0.75 应为中点 0.5');
  near(w75[1], 0, 1e-9, '0.75 时 port 主图权重应已让位');
  /* SWAP2 窗口相邻步连续（与 continuity.test 的 alpha 界一致） */
  var prev = null, contOK = true;
  for (var p = 0.740; p <= 0.7700001; p += 0.0005) {
    var cw = Eng.plateWeights(Eng.camera(p), { a1: 1, a2: 1 })[2];
    var co = L.base2(p);
    if (prev !== null) {
      if (Math.abs(cw - prev.cw) > 0.16) contOK = false;
      if (Math.abs(co - prev.co) > 0.16) contOK = false;
    }
    prev = { cw: cw, co: co };
  }
  check(contOK, '75% 接缝邻域（引擎接管交叉淡化）应连续无跳变');
})();

/* ==========================================================================
 * 3. 失败回退路径（mock fetch 失败 / 超时 / 引擎 render 冒烟）
 * ========================================================================== */
function runFallbackTests() {
  var fetches = [];
  var envFail = makeEnv(function (url) {
    fetches.push(url);
    return Promise.reject(new Error('net down'));
  });
  check(envFail.inited === true, 'init 应成功（元素存在）');
  return sleep(10).then(function () {
    check(fetches.length === 2, 'scrub 版失败后应重试普通压缩版（共 2 次请求），实测 ' + fetches.length);
    check(fetches[0] === 'assets/seg1-scrub.mp4' && fetches[1] === 'assets/seg1.mp4',
      '失败重试链应为 scrub 版 → 普通压缩版');
    var s = envFail.api._state();
    check(s.segs[0].status === 'failed', 'fetch 全失败后 seg1 应 failed，实测 ' + s.segs[0].status);
    check(s.segs[1].status === 'idle', 'seg2 未到预载阈值应保持 idle');
    envFail.api.update({ p: 0.3 });
    var cov = envFail.api.coverage();
    check(cov.a1 === 0 && !cov.present1 && cov.a2 === 0 && !cov.present2, '失败段覆盖率应归零（回退引擎）');
    var last = envFail.calls[envFail.calls.length - 1];
    check(last && last.a1 === 0 && last.present1 === false, '应向引擎注入零覆盖率');

    /* 超时路径（8s 压缩为 40ms，fetch 永不 resolve） */
    var envTO = makeEnv(function () { return new Promise(function () {}); }, { revealMs: 0, timeoutMs: 40 });
    return sleep(120).then(function () {
      var s2 = envTO.api._state();
      check(s2.segs[0].status === 'failed', '超时后 seg1 应 failed，实测 ' + s2.segs[0].status);

      /* 引擎 render 冒烟：失败（无视频显影）→ 程序化深空兜底照常渲染 */
      Eng.setSceneSource({ kind: 'video', segments: [
        { url: 'assets/seg1-scrub.mp4', span: [0, 0.55] },
        { url: 'assets/seg2-scrub.mp4', span: [0.55, 0.75] }
      ]});
      var world = Eng.build({ W: 1280, H: 720, minWH: 720, maxWH: 1280, area: 1280 * 720 });
      var S = { W: 1280, H: 720, cx: 640, cy: 360, minWH: 720, maxWH: 1280, t: 0.3, clock: 1, speed: 0 };
      Eng.setVideoState({ a1: 0, a2: 0, present1: false, present2: false });
      var ctxA = makeCtx();
      Eng.render(ctxA, world, S);
      check(ctxA._drawImage > 0, '无视频显影时引擎应绘程序化深空兜底（剧照未载入路径）');
      Eng.setVideoState({ a1: 1, a2: 1, present1: true, present2: true });
      var ctxB = makeCtx();
      Eng.render(ctxB, world, S);
      check(ctxB._drawImage === 0, '视频显影时引擎不应绘不透明兜底底图（会盖住视频）');
      Eng.setVideoState({ a1: 0, a2: 0, present1: false, present2: false });
    });
  });
}

/* ==========================================================================
 * 4. tour 播放态与 scrub 态切换（fake DOM 状态机）
 * ========================================================================== */
function runTourTests() {
  var env = makeEnv(okFetch, { revealMs: 0 });
  return sleep(10).then(function () {
    makeReady(env.v1, env.api, 0.2);           /* 先只就绪 seg1（seg2 保持 idle）*/
    return sleep(5).then(function () {
      var s = env.api._state();
      check(s.segs[0].status === 'ready' && s.segs[1].status === 'idle', '初始应只有 seg1 ready');

      /* scrub 态：muted + paused + currentTime 跟随阻尼进度 */
      env.api.update({ p: 0.3 });
      near(env.v1.currentTime, L.segTime(0.3, L.SPANS[0], DUR), L.SEEK_EPS + 1e-9, 'scrub：seg1.currentTime 应映射 p=0.3');
      check(env.v1.muted === true && env.v1.paused === true, 'scrub 态应 muted 且暂停');
      check(env.v1.style.display !== 'none' && env.v2.style.display === 'none', 'scrub 态只有当前段显影');
      var cov = env.api.coverage();
      check(cov.a1 === 1 && cov.present1 === true && cov.a2 === 0 && cov.present2 === false,
        '覆盖率：seg1=1 / seg2=0（p=0.3，seg2 未加载）');

      /* seek 节流/合并：seeking 期间只记录 want，落帧后补差 */
      env.v1.seeking = true;
      env.api.update({ p: 0.31 });
      near(env.v1.currentTime, L.segTime(0.3, L.SPANS[0], DUR), 1e-9, 'seeking 期间不应改写 currentTime');
      env.v1.seeking = false;
      env.v1.fire('seeked');
      near(env.v1.currentTime, L.segTime(0.31, L.SPANS[0], DUR), 1e-9, 'seeked 后应补差到 want');

      /* 预载：p>35% 触发 seg2 加载 → ready */
      env.api.update({ p: 0.36 });
      return sleep(5).then(function () {
        makeReady(env.v2, env.api, 0.36);
        check(env.api._state().segs[1].status === 'ready', 'seg2 预载后 ready');
        env.api.update({ p: 0.2 });

        /* tour 播放态：engage seg1 → unmuted + play，节奏由视频时间接管 */
        env.api.update({ p: 0.2, touring: true });
        var vp = env.api.tourSync(0.2);
        check(env.v1.playCount === 1 && env.v1.muted === false && env.v1.paused === false,
          '漫游 engage：seg1 应 unmuted 播放');
        near(vp, 0.2, 1e-9, '漫游节奏应从当前进度无缝接管');
        env.v1.currentTime = 3.5;
        vp = env.api.tourSync(0.2);
        near(vp, 0.55 * (3.5 / DUR), 1e-9, '漫游进度应跟随视频时间');

        /* 播完一段接下一段 */
        env.v1.currentTime = DUR; env.v1.ended = true; env.v1.paused = true;
        vp = env.api.tourSync(0.55);
        check(env.v2.playCount === 1 && env.v2.muted === false, 'seg1 播完应 unmuted 接播 seg2');
        check(env.v1.pauseCount >= 1 && env.v1.muted === true, '接力后 seg1 应回 scrub 态（暂停+静音）');
        near(vp, 0.55, 1e-9, 'seg2 首帧 → p=0.55');
        env.v2.currentTime = DUR / 2;
        vp = env.api.tourSync(0.65);
        near(vp, 0.55 + 0.20 * 0.5, 1e-9, 'seg2 播放中漫游进度应跟随视频时间');

        /* 引擎 core 区间：无视频接管 → 回匀速漫游 */
        vp = env.api.tourSync(0.8);
        check(vp === null, 'core 区间（75–100%）应由引擎渲染、漫游回匀速');
        check(env.v2.pauseCount >= 1 && env.v2.muted === true, '进入 core 区间后 seg2 应释放');

        /* 漫游中断：立即回 scrub + muted + seek 到当前进度 */
        env.api.update({ p: 0.62, touring: true });
        env.api.tourSync(0.62);
        check(env.v2.paused === false, 'tour 态 seg2 播放中');
        env.v2.currentTime = 4.0;
        env.api.update({ p: 0.62 });
        env.api.onTourEnd();
        check(env.v2.paused === true && env.v2.muted === true, '漫游中断后应立即 pause + muted');
        near(env.v2.currentTime, L.segTime(0.62, L.SPANS[1], DUR), L.SEEK_EPS + 1e-9, '中断后应 seek 回当前进度');

        /* 全局静音跟随：漫游视频保持静音 */
        env.api.setMuted(true);
        env.api.update({ p: 0.62, touring: true });
        env.api.tourSync(0.62);
        check(env.v2.muted === true, '全局静音时漫游视频应保持静音');
        env.api.onTourEnd();

        /* reduced 模式：模块禁用，静态模式不受影响 */
        var envRed = makeEnv(function () { return Promise.resolve({ ok: true, blob: function () { return Promise.resolve({}); } }); },
          { reduced: true });
        check(envRed.inited === false && envRed.api._state().disabled === true, 'reduced 模式模块应禁用');
        envRed.api.update({ p: 0.3 });
        check(envRed.calls.length === 0, 'reduced 模式不应注入覆盖率（引擎走 stills）');
        check(envRed.api.tourSync(0.3) === null, 'reduced 模式漫游不应接管');
      });
    });
  });
}

/* ================= 汇总 ================= */
runFallbackTests()
  .then(runTourTests)
  .then(function () {
    console.log('ASTRA video-layer test —— ' + checks + ' 项断言');
    console.log('  映射: seg1 0–55% / seg2 55–75% → currentTime（按 ' + DUR + 's 归一化），全程单调无空洞');
    console.log('  接缝: 55% map1=dur1 & map2=0（SWAP1 交叉权重和恒 1，藏于光晕①峰值）；');
    console.log('        75% map2=dur2，引擎 core 交叉权重接管（SWAP2 连续，无黑帧/闪跳）');
    console.log('  回退: fetch 失败重试普通压缩版后 failed / 超时(压缩 40ms) failed → 覆盖率归零，');
    console.log('        引擎 render 照常（无视频绘深空兜底，显影时跳过不透明底填充）');
    console.log('  tour: unmuted 连播接管节奏、播完接下一段、core 区间回匀速；');
    console.log('        中断 → pause+muted+seek 回当前进度；全局静音跟随；reduced 禁用');
    if (failures.length) {
      console.error('FAIL (' + failures.length + ' 项):');
      failures.slice(0, 20).forEach(function (m) { console.error('  - ' + m); });
      process.exit(1);
    }
    console.log('PASS: 映射连续 / 接缝对齐 / 失败回退 / tour-scrub 切换全部符合规格。');
  })
  .catch(function (e) {
    console.error('ERROR: ' + (e && e.stack || e));
    process.exit(1);
  });
