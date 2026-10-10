/* ==========================================================================
 * NEON · v3 视频画面层桩测试（Node 桩环境，无浏览器依赖）
 * neon/test/video.test.js
 *
 * 用法：node test/video.test.js （在 neon/ 目录下）
 *
 * 检查项：
 *   1. 进度 → 三段 currentTime 映射连续：段内单调、段界两侧互补
 *      （0.329→0.331、0.659→0.661 无跳变：接缝两侧锁定同一构图关键帧）；
 *      接缝交叉权重和恒 1（无黑帧）、窗口互不相交。
 *   2. 失败兜底海报按「覆盖段」切换：非覆盖段失败不提前切；
 *      失败链 = scrub 版 → 普通压缩版（8s 预算内）→ failed。
 *   3. 预载阈值：seg1 立即、seg2 p>0.15、seg3 p>0.45。
 *   4. 漫游三段连播：engaged 段 unmuted+play、漫游节奏由视频时间接管、
 *      播完一段接下一段（seg1→seg2→seg3→终点 1.0）；中断 → 立即
 *      pause+muted+seek 回当前进度；全局静音跟随；reduced 模块禁用。
 * ========================================================================== */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

function loadFile(file, globals) {
  var src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
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

var DUR = 6.0;                      /* 测试用任意时长（映射按 duration 归一化） */

/* ---------- fake <video> / poster 元素 ---------- */
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
function deadFetch() {
  return Promise.reject(new Error('net down'));
}

function makeEnv(fetchImpl, opts) {
  var v = [new FakeVideoEl(), new FakeVideoEl(), new FakeVideoEl()];
  var poster = { src: 'assets/keys/k1.png' };
  var winObj = {
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    fetch: fetchImpl,
    URL: { createObjectURL: function () { return 'blob:f'; }, revokeObjectURL: function () {} }
  };
  var docObj = {
    hidden: false,
    getElementById: function (id) {
      if (id === 'vid1') return v[0];
      if (id === 'vid2') return v[1];
      if (id === 'vid3') return v[2];
      if (id === 'poster') return poster;
      return null;
    }
  };
  var w = loadFile('neon-video.js', { window: winObj, document: docObj });
  var inited = w.NEONVID.init(opts || { revealMs: 0 });
  return { api: w.NEONVID, v: v, poster: poster, inited: inited };
}

function makeReady(el, api, fireP) {          /* 推进 fake 加载状态机到 ready+显影 */
  el.duration = DUR;
  el.fire('loadedmetadata');
  el.fire('loadeddata');
  el.fire('seeked');                          /* 首次 seeked → 开始显影 */
  if (fireP !== undefined) api.update({ p: fireP });
}

/* ==========================================================================
 * 1. 映射连续性 / 接缝权重（纯逻辑）
 * ========================================================================== */
var L = loadFile('neon-video.js').NEONVID.logic;
check(!!L, 'NEONVID.logic 未导出');

/* 常量规格 */
check(JSON.stringify(L.SPANS) === JSON.stringify([[0, 0.33], [0.33, 0.66], [0.66, 1.0]]), 'SPANS 三段 0–33/33–66/66–100');
check(JSON.stringify(L.SEAM1) === JSON.stringify([0.315, 0.345]), 'SEAM1 = [0.315,0.345]');
check(JSON.stringify(L.SEAM2) === JSON.stringify([0.645, 0.675]), 'SEAM2 = [0.645,0.675]');
check(L.SEAM1[1] < L.SEAM2[0], '两接缝窗口互不相交（权重代数互补的前提）');
check(L.PRELOAD_AT[1] === 0.15 && L.PRELOAD_AT[2] === 0.45, '预载阈值 seg2@0.15 / seg3@0.45');
check(L.SEGS_DEF[0].poster === 'assets/keys/k1.png' && L.SEGS_DEF[1].poster === 'assets/keys/k2.png' &&
  L.SEGS_DEF[2].poster === 'assets/keys/k4.png', '失败兜底海报 seg1→k1 / seg2→k2 / seg3→k4');
check(L.SEGS_DEF[0].urls[0] === 'assets/seg1-scrub.mp4' && L.SEGS_DEF[0].urls[1] === 'assets/seg1.mp4' &&
  L.SEGS_DEF[2].urls[0] === 'assets/seg3-scrub.mp4' && L.SEGS_DEF[2].urls[1] === 'assets/seg3.mp4',
  '段定义 = seg*-scrub.mp4（备用 seg*.mp4）');

/* 段边界映射精确值 */
near(L.segTime(0, L.SPANS[0], DUR), 0, 1e-9, 'segTime(0) seg1 = 0');
near(L.segTime(0.33, L.SPANS[0], DUR), DUR, 1e-9, 'segTime(0.33) seg1 = dur');
near(L.segTime(0.33, L.SPANS[1], DUR), 0, 1e-9, 'segTime(0.33) seg2 = 0');
near(L.segTime(0.66, L.SPANS[1], DUR), DUR, 1e-9, 'segTime(0.66) seg2 = dur');
near(L.segTime(0.66, L.SPANS[2], DUR), 0, 1e-9, 'segTime(0.66) seg3 = 0');
near(L.segTime(1.0, L.SPANS[2], DUR), DUR, 1e-9, 'segTime(1) seg3 = dur');
near(L.segTime(0.5, L.SPANS[1], DUR), DUR * (0.17 / 0.33), 1e-9, 'segTime(0.5) seg2 = 段内中点');

/* 全程扫描：三段各自时间单调不减 + 接缝权重和恒 1 */
(function () {
  var prev = [0, 0, 0], monoOK = true, sumOK = true;
  for (var p = 0; p <= 1.0000001; p += 0.0005) {
    for (var i = 0; i < 3; i++) {
      var t = L.segTime(p, L.SPANS[i], DUR);
      if (t < prev[i] - 1e-9) monoOK = false;
      prev[i] = t;
    }
    var sum = L.seamSum(p);
    if (Math.abs(sum - 1) > 1e-12) sumOK = false;      /* 黑帧/过曝 = 权重和 ≠ 1 */
  }
  check(monoOK, '各段 segTime 应随进度单调不减');
  check(sumOK, '全程接缝权重和应恒等于 1（互补交叉淡化，无黑帧）');
})();

/* 0.329 → 0.331 无跳变：接缝两侧锁定同一 k2 构图
 *（seg1 距尾的归一化余量 === seg2 距首的归一化余量，交叉权重互补）。
 * 容差说明：相邻段宽 0.33/0.33 相等 → SEAM1 精确互补；
 * SEAM2 相邻段宽 0.33/0.34（末段含 0.66–1.0）→ 互补差
 * δ·(1/0.33−1/0.34) ≈ 8.9e-5（6s 片长下 <1ms），远小于半帧阈值。 */
var MIRROR_EPS = 1.5e-4;
(function () {
  var f1a = L.segTime(0.329, L.SPANS[0], DUR) / DUR;   /* ≈ 0.99697（尾帧邻域） */
  var f2b = L.segTime(0.331, L.SPANS[1], DUR) / DUR;   /* ≈ 0.00303（首帧邻域） */
  near(1 - f1a, f2b, MIRROR_EPS, '0.329→0.331 段界两侧归一化余量互补（同构图 k2）');
  check(DUR - f1a * DUR <= 0.05, '0.329 时 seg1 应在尾帧邻域（k2），距尾 ' + (DUR - f1a * DUR).toFixed(4) + 's');
  check(f2b * DUR <= 0.05, '0.331 时 seg2 应在首帧邻域（k2），距首 ' + (f2b * DUR).toFixed(4) + 's');
  near(L.w1(0.329) + L.w2(0.329), 1, 1e-9, 'SEAM1 窗内 seg1+seg2 权重和恒 1');
  near(L.w3(0.329), 0, 1e-9, 'SEAM1 窗内 seg3 不参与');
})();

/* 0.659 → 0.661 无跳变：SEAM2 同理（k3 构图，段宽 0.33/0.34 近似互补） */
(function () {
  var f2a = L.segTime(0.659, L.SPANS[1], DUR) / DUR;
  var f3b = L.segTime(0.661, L.SPANS[2], DUR) / DUR;
  near(1 - f2a, f3b, MIRROR_EPS, '0.659→0.661 段界两侧归一化余量互补（同构图 k3）');
  near(L.w2(0.659) + L.w3(0.659), 1, 1e-9, 'SEAM2 窗内 seg2+seg3 权重和恒 1');
  near(L.w1(0.659), 0, 1e-9, 'SEAM2 窗内 seg1 不参与');
})();

/* 接缝邻域微步连续（时间与不透明度均无跳变） */
[0.315, 0.645].forEach(function (seam) {
  var prev = null, contOK = true;
  for (var p = seam - 0.012; p <= seam + 0.0240001; p += 0.0005) {
    var cur = [L.segTime(p, L.SPANS[0], DUR), L.segTime(p, L.SPANS[1], DUR), L.segTime(p, L.SPANS[2], DUR),
      L.w1(p), L.w2(p), L.w3(p)];
    if (prev) for (var j = 0; j < 6; j++) {
      var lim = j < 3 ? (0.0005 / 0.33) * DUR + 1e-9 : 0.16;
      if (Math.abs(cur[j] - prev[j]) > lim) contOK = false;
    }
    prev = cur;
  }
  check(contOK, '接缝 ' + seam + ' 邻域映射与权重应连续无跳变');
});

/* coveringSeg 段界归属（与 segTime 钳制一致：界点归下一段） */
check(L.coveringSeg(0) === 0 && L.coveringSeg(0.3299) === 0, 'coveringSeg: p<0.33 → seg1');
check(L.coveringSeg(0.33) === 1 && L.coveringSeg(0.6599) === 1, 'coveringSeg: 0.33–0.66 → seg2');
check(L.coveringSeg(0.66) === 2 && L.coveringSeg(1) === 2, 'coveringSeg: ≥0.66 → seg3');

/* tourP 端点 */
near(L.tourP(L.SPANS[0], DUR, 0), 0, 1e-9, 'tourP: seg1 首帧 → 0');
near(L.tourP(L.SPANS[0], DUR, DUR), 0.33, 1e-9, 'tourP: seg1 尾帧 → 0.33（接下一段）');
near(L.tourP(L.SPANS[1], DUR, DUR / 2), 0.495, 1e-9, 'tourP: seg2 中点 → 0.495');
near(L.tourP(L.SPANS[2], DUR, DUR), 1, 1e-9, 'tourP: seg3 尾帧 → 1.0（漫游终点）');

/* ==========================================================================
 * 2 + 3. 失败兜底海报 / 预载阈值 / 失败链（fake DOM）
 * ========================================================================== */
function runFallbackTests() {
  /* 失败链：scrub 版 → 普通压缩版（共 2 次请求）→ failed */
  var fetches = [];
  var envFail = makeEnv(function (url) {
    fetches.push(url);
    return deadFetch();
  });
  check(envFail.inited === true, 'init 应成功（元素存在）');
  return sleep(10).then(function () {
    check(fetches.length === 2, 'seg1 失败应重试普通压缩版（共 2 次请求），实测 ' + fetches.length);
    check(fetches[0] === 'assets/seg1-scrub.mp4' && fetches[1] === 'assets/seg1.mp4',
      '失败重试链应为 scrub 版 → 普通压缩版');
    var s = envFail.api._state();
    check(s.segs[0].status === 'failed', 'fetch 全失败后 seg1 应 failed');
    check(s.segs[1].status === 'idle' && s.segs[2].status === 'idle', '未到预载阈值的段应保持 idle');
    envFail.api.update({ p: 0.1 });
    check(envFail.poster.src === 'assets/keys/k1.png', 'seg1 失败（覆盖段）海报应为 k1');
    check(envFail.api.coverage().a1 === 0, '失败段覆盖率归零（海报静态兜底，无程序渲染）');

    /* 超时路径（8s 压缩为 40ms，fetch 永不 resolve） */
    var envTO = makeEnv(function () { return new Promise(function () {}); }, { revealMs: 0, timeoutMs: 40 });
    return sleep(120).then(function () {
      check(envTO.api._state().segs[0].status === 'failed', '超时后 seg1 应 failed');

      /* 覆盖段语义：seg2 失败时，p 在 seg1 区间不提前切海报，进入 seg2 区间才切 k2 */
      var envMix = makeEnv(function (url) {
        return (url === 'assets/seg1-scrub.mp4' || url === 'assets/seg1.mp4') ? okFetch() : deadFetch();
      }, { revealMs: 0 });
      return sleep(10).then(function () {
        check(envMix.api._state().segs[0].status === 'loading', 'seg1 加载中（fake 元素未就绪）');
        makeReady(envMix.v[0], envMix.api, 0.1);        /* seg1 ready；p 保持 seg1 区间 */
        envMix.api.update({ p: 0.16 });                 /* p>0.15 触发 seg2 预载 → 失败 */
        return sleep(15).then(function () {
          check(envMix.api._state().segs[0].status === 'ready', 'seg1 应 ready');
          check(envMix.api._state().segs[1].status === 'failed', 'seg2 双 URL 失败后应 failed');
          envMix.api.update({ p: 0.16 });
          check(envMix.poster.src === 'assets/keys/k1.png',
            'seg2 失败但 p 在 seg1 区间：不提前切海报（仍 k1）');
          envMix.api.update({ p: 0.40 });               /* 进入 seg2 覆盖区间 */
          check(envMix.poster.src === 'assets/keys/k2.png', '进入失败覆盖段后海报应切 k2');
          envMix.api.update({ p: 0.10 });               /* 回退到 seg1 区间：seg1 未失败，不回写 */
          check(envMix.poster.src === 'assets/keys/k2.png', '回退段未失败时不重复切海报');
        });
      });
    });
  });
}

/* ==========================================================================
 * 4. 漫游三段连播 / scrub 态 / 中断 / 静音 / reduced（fake DOM 状态机）
 * ========================================================================== */
function runTourTests() {
  var env = makeEnv(okFetch, { revealMs: 0 });
  return sleep(10).then(function () {
    makeReady(env.v[0], env.api, 0.1);          /* 先只就绪 seg1（p=0.1 不触发 seg2 预载） */
    return sleep(5).then(function () {
      var s = env.api._state();
      check(s.segs[0].status === 'ready' && s.segs[1].status === 'idle' && s.segs[2].status === 'idle',
        '初始应只有 seg1 ready（seg2/seg3 未到预载阈值）');

      /* scrub 态：muted + paused + currentTime 跟随阻尼进度 */
      env.api.update({ p: 0.1 });
      near(env.v[0].currentTime, L.segTime(0.1, L.SPANS[0], DUR), L.SEEK_EPS + 1e-9, 'scrub：seg1.currentTime 应映射 p=0.1');
      check(env.v[0].muted === true && env.v[0].paused === true, 'scrub 态应 muted 且暂停');
      check(env.v[0].style.display !== 'none' && env.v[1].style.display === 'none' && env.v[2].style.display === 'none',
        'scrub 态只有当前段显影');
      var cov = env.api.coverage();
      check(cov.a1 === 1 && cov.present1 === true && cov.a2 === 0 && cov.a3 === 0,
        '覆盖率：seg1=1 / seg2=seg3=0（未加载）');

      /* seek 节流/合并：seeking 期间只记录 want，落帧后补差 */
      env.v[0].seeking = true;
      env.api.update({ p: 0.11 });
      near(env.v[0].currentTime, L.segTime(0.1, L.SPANS[0], DUR), 1e-9, 'seeking 期间不应改写 currentTime');
      env.v[0].seeking = false;
      env.v[0].fire('seeked');
      near(env.v[0].currentTime, L.segTime(0.11, L.SPANS[0], DUR), 1e-9, 'seeked 后应补差到 want');

      /* 预载阈值：p=0.11 未触发 seg2；p>0.15 触发 seg2，p>0.45 触发 seg3 */
      env.api.update({ p: 0.11 });
      check(env.api._state().segs[1].status === 'idle', 'p=0.11 时 seg2 不应开始加载');
      env.api.update({ p: 0.16 });
      check(env.api._state().segs[1].status === 'loading' && env.api._state().segs[2].status === 'idle',
        'p=0.16 应开始加载 seg2，seg3 仍 idle');
      return sleep(5).then(function () {
        makeReady(env.v[1], env.api, 0.16);
        check(env.api._state().segs[1].status === 'ready', 'seg2 预载后 ready');
        env.api.update({ p: 0.46 });
        check(env.api._state().segs[2].status === 'loading', 'p=0.46 应开始加载 seg3');
        return sleep(5).then(function () {
          makeReady(env.v[2], env.api, 0.46);
          check(env.api._state().segs[2].status === 'ready', 'seg3 预载后 ready');
          env.api.update({ p: 0.2 });

          /* tour：engage seg1 → unmuted + play，节奏由视频时间接管 */
          env.api.update({ p: 0.2, touring: true });
          var vp = env.api.tourSync(0.2);
          check(env.v[0].playCount === 1 && env.v[0].muted === false && env.v[0].paused === false,
            '漫游 engage：seg1 应 unmuted 播放');
          near(vp, 0.2, 1e-9, '漫游节奏应从当前进度无缝接管');
          env.v[0].currentTime = 3.0;
          vp = env.api.tourSync(0.2);
          near(vp, 0.33 * (3.0 / DUR), 1e-9, '漫游进度应跟随 seg1 视频时间');

          /* 播完一段接下一段：seg1 → seg2 */
          env.v[0].currentTime = DUR; env.v[0].ended = true; env.v[0].paused = true;
          vp = env.api.tourSync(0.2);
          near(vp, 0.33, 1e-9, 'seg1 播完 → 漫游进度 = 0.33（段界）');
          vp = env.api.tourSync(0.33);
          check(env.v[1].playCount === 1 && env.v[1].muted === false && env.v[1].paused === false,
            'seg1 播完应 unmuted 接播 seg2');
          check(env.v[0].pauseCount >= 1 && env.v[0].muted === true, '接力后 seg1 应回 scrub 态（暂停+静音）');
          near(vp, 0.33, 1e-9, 'seg2 首帧 → p=0.33');
          env.v[1].currentTime = DUR / 2;
          vp = env.api.tourSync(0.495);
          near(vp, 0.33 + 0.33 * 0.5, 1e-9, 'seg2 播放中漫游进度应跟随视频时间');

          /* seg2 → seg3 → 终点 1.0 */
          env.v[1].currentTime = DUR; env.v[1].ended = true; env.v[1].paused = true;
          vp = env.api.tourSync(0.66);
          check(env.v[2].playCount === 1 && env.v[2].muted === false, 'seg2 播完应 unmuted 接播 seg3');
          check(env.v[1].pauseCount >= 1 && env.v[1].muted === true, '接力后 seg2 应回 scrub 态');
          env.v[2].currentTime = DUR;
          vp = env.api.tourSync(0.9);
          near(vp, 1.0, 1e-9, 'seg3 尾帧 → 漫游终点 1.0（外壳据此停漫游）');

          /* 漫游中断：立即回 scrub + muted + seek 到当前进度 */
          env.v[2].currentTime = 4.0; env.v[2].ended = false;
          env.api.update({ p: 0.7, touring: true });
          env.api.tourSync(0.7);
          check(env.v[2].paused === false, 'tour 态 seg3 播放中');
          env.api.update({ p: 0.7 });
          env.api.onTourEnd();
          check(env.v[2].paused === true && env.v[2].muted === true, '漫游中断后应立即 pause + muted');
          near(env.v[2].currentTime, L.segTime(0.7, L.SPANS[2], DUR), L.SEEK_EPS + 1e-9, '中断后应 seek 回当前进度');

          /* 全局静音跟随：漫游视频保持静音 */
          env.api.setMuted(true);
          env.api.update({ p: 0.7, touring: true });
          env.api.tourSync(0.7);
          check(env.v[2].muted === true, '全局静音时漫游视频应保持静音');
          env.api.onTourEnd();
          env.api.setMuted(false);

          /* 全失败环境：漫游不接管（外壳回 45s 匀速兜底），海报按覆盖段切换 */
          var envDead = makeEnv(deadFetch, { revealMs: 0 });
          return sleep(30).then(function () {
            check(envDead.api._state().segs[0].status === 'failed', '全失败环境 seg1 failed');
            check(envDead.api.tourSync(0.2) === null, '覆盖段失败时漫游不接管（回匀速兜底）');
            envDead.api.update({ p: 0.5 });            /* 触发 seg2/seg3 预载 → 均失败 */
            return sleep(30).then(function () {
              envDead.api.update({ p: 0.5 });
              check(envDead.poster.src === 'assets/keys/k2.png', '漫游失败环境中海报按覆盖段切 k2');
              envDead.api.update({ p: 0.8 });
              check(envDead.poster.src === 'assets/keys/k4.png', '覆盖到失败 seg3 后海报切 k4');
              var covD = envDead.api.coverage();
              check(covD.a1 === 0 && covD.a2 === 0 && covD.a3 === 0, '全失败覆盖率归零（海报静态兜底）');

              /* reduced 模式：模块禁用，不发起任何加载 */
              var redFetches = 0;
              var envRed = makeEnv(function () { redFetches++; return okFetch(); }, { reduced: true });
              check(envRed.inited === false && envRed.api._state().disabled === true, 'reduced 模式模块应禁用');
              check(redFetches === 0, 'reduced 模式不应发起任何视频加载');
              check(envRed.api.tourSync(0.3) === null, 'reduced 模式漫游不应接管');
              envRed.api.update({ p: 0.3 });
              check(envRed.api.coverage().a1 === 0, 'reduced 模式覆盖率恒 0（静态模式用海报）');
            });
          });
        });
      });
    });
  });
}

/* ================= 汇总 ================= */
runFallbackTests()
  .then(runTourTests)
  .then(function () {
    console.log('NEON video-layer test —— ' + checks + ' 项断言');
    console.log('  映射: 三段 0–33/33–66/66–100% → currentTime（按 ' + DUR + 's 归一化），单调无跳变；');
    console.log('        0.329→0.331、0.659→0.661 段界两侧同构图互补（k2/k3），SEAM 权重和恒 1');
    console.log('  兜底: 失败链 scrub→压缩版→failed；海报按覆盖段切 k1/k2/k4，非覆盖段不提前切');
    console.log('  预载: seg1 立即 / seg2 p>0.15 / seg3 p>0.45');
    console.log('  tour: 三段 unmuted 连播接管节奏（0.33/0.66 接力、1.0 终点）；');
    console.log('        中断 → pause+muted+seek 回当前进度；静音跟随；reduced 禁用');
    if (failures.length) {
      console.error('FAIL (' + failures.length + ' 项):');
      failures.slice(0, 20).forEach(function (m) { console.error('  - ' + m); });
      process.exit(1);
    }
    console.log('PASS: 映射连续 / 接缝权重 / 失败兜底海报 / 预载 / 漫游三段连播 全部符合规格。');
  })
  .catch(function (e) {
    console.error('ERROR: ' + (e && e.stack || e));
    process.exit(1);
  });
