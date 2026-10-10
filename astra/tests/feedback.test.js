/* ==========================================================================
 * ASTRA · P1 反馈层桩测试（Node 桩环境，无浏览器依赖）
 * astra/tests/feedback.test.js
 *
 * 用法：node tests/feedback.test.js （在 astra/ 目录下）
 *
 * 检查项（INTERACTION-DESIGN §2 / 任务自查 §3）：
 *   1. HUD 数值随进度插值：起止值精确、区间单调、传感器有界。
 *   2. 章界穿越门控：来回跨界只触发一次，直到离开 ±win 窗口才重新武装；
 *      初始定位（prev 为空）不触发。
 *   3. WebAudio 模块：首次手势（unlock）前不创建 AudioContext；
 *      unlock 幂等；unlock 后章切换不重复建 ctx；radioInterval 随速度单调降；
 *      exponentialRamp 目标恒 > 0（真实 WebAudio 会 throw）。
 * ========================================================================== */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

function load(file, extra) {
  var src = fs.readFileSync(path.join(__dirname, '..', 'js', file), 'utf8');
  var sandbox = { window: {}, console: console };
  if (extra) {
    Object.keys(extra).forEach(function (k) { sandbox[k] = extra[k]; });
  }
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
  check(Math.abs(a - b) <= (eps || 1e-9), msg + '（期望 ' + b + '，实测 ' + a + '）');
}

/* ================= 1. HUD 纯逻辑 ================= */
var L = load('astra-hud.js').AstraHUD.logic;
check(!!L, 'AstraHUD.logic 未导出');

/* SEG1 距离计 120.0km → 0.8km */
near(L.distanceKm(0), 120.0, 1e-9, 'distanceKm(0) 起值应为 120.0');
near(L.distanceKm(L.T1), 0.8, 1e-9, 'distanceKm(0.55) 止值应为 0.8');
(function () {
  var mono = true, prev = L.distanceKm(0);
  for (var p = 0.001; p <= L.T1 + 1e-9; p += 0.001) {
    var v = L.distanceKm(p);
    if (v > prev - 1e-12) mono = false;
    prev = v;
  }
  check(mono, 'distanceKm 应随进度单调递减');
})();

/* 章界划分 */
check(L.chapterOf(0) === 0 && L.chapterOf(0.549) === 0, 'chapterOf SEG1 划分错误');
check(L.chapterOf(0.55) === 1 && L.chapterOf(0.749) === 1, 'chapterOf SEG2 划分错误');
check(L.chapterOf(0.75) === 2 && L.chapterOf(1) === 2, 'chapterOf SEG3 划分错误');

/* 压强：稳定值 0 → 101kPa；爬升动画 1.5s */
near(L.pressureKpa(0.5), 0, 1e-9, 'pressureKpa(0.5) 应为 0');
near(L.pressureKpa(0.75), 101, 1e-9, 'pressureKpa(0.75) 应为 101');
near(L.climbKpa(0), 0, 1e-9, 'climbKpa(0) 起值应为 0');
near(L.climbKpa(1500), 101, 1e-9, 'climbKpa(1500) 止值应为 101');
near(L.climbKpa(9999), 101, 1e-9, 'climbKpa(>1500) 应保持 101');
(function () {
  var mono = true, prev = 0;
  for (var ms = 50; ms <= 1500; ms += 50) {
    var v = L.climbKpa(ms);
    if (v < prev - 1e-12) mono = false;
    prev = v;
  }
  check(mono, 'climbKpa 应随时间单调递增');
})();

/* 光传导同步率 0% → 100% */
near(L.syncPct(L.T2), 0, 1e-9, 'syncPct(0.75) 起值应为 0');
near(L.syncPct(0.995), 100, 1e-9, 'syncPct(0.995) 应达 100');
near(L.syncPct(1), 100, 1e-9, 'syncPct(1) 止值应为 100');
(function () {
  var mono = true, prev = 0;
  for (var p = 0.751; p <= 1; p += 0.001) {
    var v = L.syncPct(p);
    if (v < prev - 1e-12) mono = false;
    prev = v;
  }
  check(mono, 'syncPct 应随进度单调递增');
})();

/* 打字机字符数 */
check(L.typedChars(0.77) === 0, 'typedChars(0.77) 应为 0');
check(L.typedChars(0.795) === 0, 'typedChars(0.795) 起值应为 0');
check(L.typedChars(0.935) === L.TYPE_TEXT.length, 'typedChars(0.935) 应为全文');
check(L.typedChars(1) === L.TYPE_TEXT.length, 'typedChars(1) 止值应为全文');
(function () {
  var mono = true, prev = 0;
  for (var p = 0.796; p <= 1; p += 0.001) {
    var v = L.typedChars(p);
    if (v < prev) mono = false;
    prev = v;
  }
  check(mono, 'typedChars 应随进度不减');
})();

/* 舱内传感器：有界 + 氧气围绕 20.9% */
(function () {
  for (var c = 0; c <= 100; c += 0.7) {
    var o2 = L.oxygenPct(c);
    check(o2 >= 20.75 && o2 <= 21.05, 'oxygenPct 越界: ' + o2);
    var pw = L.powerPct(c);
    check(pw >= 55 && pw <= 97, 'powerPct 越界: ' + pw);
    for (var pi = 0.56; pi <= 0.74; pi += 0.03) {
      var sg = L.signalPct(pi, c);
      check(sg >= 8 && sg <= 99, 'signalPct 越界: ' + sg);
    }
  }
})();

/* 锁定框收缩 + 接近速度非负有界 */
near(L.lockBoxFrac(0), 0.16, 1e-9, 'lockBoxFrac(0) 起值应为 0.16');
near(L.lockBoxFrac(L.T1), 0.055, 1e-9, 'lockBoxFrac(0.55) 止值应为 0.055');
(function () {
  var mono = true, prev = L.lockBoxFrac(0);
  for (var p = 0.01; p <= 0.55; p += 0.01) {
    var v = L.lockBoxFrac(p);
    if (v > prev + 1e-12) mono = false;
    prev = v;
  }
  check(mono, 'lockBoxFrac 应随进度收缩');
  for (var s = 0; s <= 1.01; s += 0.25) {
    var cs = L.closingSpeed(0, s);
    check(cs > 0 && cs < 1000, 'closingSpeed 越界: ' + cs);
  }
})();

/* ================= 2. 章界穿越门控 ================= */
var g = L.makeTransitGates([
  { id: 'A', at: 0.55, win: 0.015 },
  { id: 'B', at: 0.75, win: 0.015 }
]);
var seq = [0, 0.3, 0.540, 0.551, 0.549, 0.552, 0.550, 0.553, 0.560,
  0.566, 0.560, 0.570, 0.540, 0.551, 0.70, 0.749, 0.751, 0.749, 0.752, 0.770];
var fires = { A: 0, B: 0 };
seq.forEach(function (p) {
  g.feed(p).forEach(function (id) { fires[id]++; });
});
check(fires.A === 2, '穿越 A 触发次数应为 2（来回跨界各一次 + 离开窗口后重触发），实测 ' + fires.A);
check(fires.B === 1, '穿越 B 触发次数应为 1（窗口内震荡只触发一次），实测 ' + fires.B);

/* 初始定位（prev 为空，如页面中途刷新）不触发 */
var g2 = L.makeTransitGates([{ id: 'A', at: 0.55, win: 0.015 }]);
var n2 = 0;
[0.57, 0.57, 0.568].forEach(function (p) { g2.feed(p).forEach(function () { n2++; }); });
check(n2 === 0, '初始定位在窗口外上方不应触发，实测 ' + n2);

/* ================= 3. WebAudio 模块 ================= */
var created = 0;
function makeParam() {
  return {
    value: 0,
    setValueAtTime: function () { return this; },
    linearRampToValueAtTime: function () { return this; },
    exponentialRampToValueAtTime: function (v) {
      if (!(v > 0)) throw new Error('exponentialRampToValueAtTime 目标必须 > 0');
      return this;
    },
    setTargetAtTime: function () { return this; },
    cancelScheduledValues: function () { return this; },
    connect: function () { return this; }
  };
}
function makeNode(extra) {
  return Object.assign({
    connect: function () { return this; },
    disconnect: function () {},
    start: function () {},
    stop: function () {}
  }, extra || {});
}
function FakeCtx() {
  created++;
  this.state = 'running';
  this.currentTime = 0;
  this.sampleRate = 44100;
  this.destination = makeNode();
}
FakeCtx.prototype.createGain = function () { return makeNode({ gain: makeParam() }); };
FakeCtx.prototype.createOscillator = function () {
  return makeNode({ frequency: makeParam(), detune: makeParam(), type: 'sine' });
};
FakeCtx.prototype.createBufferSource = function () {
  return makeNode({ loop: false, playbackRate: makeParam() });
};
FakeCtx.prototype.createBiquadFilter = function () {
  return makeNode({ frequency: makeParam(), Q: makeParam(), type: 'lowpass' });
};
FakeCtx.prototype.createBuffer = function (ch, len, rate) {
  if (ch !== 1) throw new Error('测试桩只支持单声道');
  var data = new Float32Array(len);
  return { numberOfChannels: 1, length: len, sampleRate: rate,
    duration: len / rate, getChannelData: function (c) { return data; } };
};
FakeCtx.prototype.resume = function () { this.state = 'running'; };

var awin = load('astra-audio.js');
var Aud = awin.AstraAudio;
check(!!Aud, 'AstraAudio 未导出');
check(created === 0, '模块加载不应创建 AudioContext，实测 ' + created);

/* 手势前：一切控制接口可用但不创建 ctx */
Aud.setChapter(2);
Aud.setSpeed(0.9);
Aud.toggleMute();
Aud.toggleMute();
Aud.stingA(); Aud.stingB(); Aud.tick(); Aud.uiTick(); Aud.chime();
check(created === 0, '首次用户手势前不应创建 AudioContext，实测 ' + created);
check(Aud._state().bedIdx === 1, '手势前 setChapter(2) 应只记录不建图，实测 bedIdx=' + Aud._state().bedIdx);

/* 无线电杂音密度：速度升高 → 间隔单调下降且有界 */
var ri0 = Aud.radioInterval(0), ri05 = Aud.radioInterval(0.5), ri1 = Aud.radioInterval(1);
check(ri0 === 1.7, 'radioInterval(0) 应为 1.7s，实测 ' + ri0);
check(ri0 > ri05 && ri05 > ri1, 'radioInterval 应随速度单调下降');
check(ri1 >= 0.12, 'radioInterval 下限应 ≥ 0.12，实测 ' + ri1);

/* 手势（unlock）→ 创建一次，幂等 */
awin.AudioContext = FakeCtx;
check(Aud.unlock() === true, 'unlock 应返回 true');
check(created === 1, 'unlock 后应恰好创建 1 个 AudioContext，实测 ' + created);
check(Aud.isActive() === true, 'unlock 后 isActive 应为 true');
Aud.unlock();
check(created === 1, '重复 unlock 不应再创建 AudioContext，实测 ' + created);

/* unlock 后：章切换/sting 走真实图路径，不重复建 ctx */
Aud.setChapter(3);
check(created === 1 && Aud._state().bedIdx === 2, 'unlock 后 setChapter(3) 应切到核心床');
Aud.setSpeed(1);
Aud.stingA(); Aud.stingB(); Aud.tick(); Aud.uiTick(); Aud.chime();
check(created === 1, '章切换与 sting 不应重复创建 AudioContext，实测 ' + created);

/* 静音往返 */
check(Aud.isMuted() === false, '静音初始应为 false');
Aud.toggleMute();
check(Aud.isMuted() === true, 'toggleMute 后应为 true');
Aud.toggleMute();
check(Aud.isMuted() === false, '再次 toggleMute 应恢复 false');

/* ================= 汇总 ================= */
console.log('ASTRA feedback test —— ' + checks + ' 项断言');
console.log('  距离计: 120.0km → 0.8km (p 0→0.55)，单调');
console.log('  压强: 稳定 0→101kPa / 爬升动画 1500ms 0→101');
console.log('  同步率: 0%→100% (p 0.75→0.995)，单调');
console.log('  穿越门控: A×2 B×1（窗口内震荡仅一次），初始定位不触发');
console.log('  WebAudio: 手势前 0 ctx，unlock 后 1 ctx（幂等），radioInterval 1.7s→' + ri1.toFixed(3) + 's');

if (failures.length) {
  console.error('FAIL (' + failures.length + ' 项):');
  failures.slice(0, 20).forEach(function (m) { console.error('  - ' + m); });
  process.exit(1);
}
console.log('PASS: HUD 插值/门控/WebAudio 手势门全部符合规格。');
