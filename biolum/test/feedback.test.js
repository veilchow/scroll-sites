/* ============================================================
 * P1 反馈层桩测试（无浏览器）：
 *   node test/feedback.test.js
 * 断言：
 *   1) 计量插值端点正确：海拔 480→30（0→1/3）、门牌 07→19（1/3→2/3）、
 *      距离 12→0（2/3→1）、步数单调、垂直速度映射有界单调；
 *   2) 章界触发去重：一次向下跨越只触发一次（阻尼抖动不重复），
 *      退回滞回窗外重新武装后可再次触发；全程序扫每界恰好一次；
 *   3) AudioContext 手势前不创建：模块加载与无手势 ensure() 均不触碰构造器；
 *   4) 反馈层接线存在（BIOFX 接口；v3 视频化后 scene.js 已随程序引擎
 *      引擎已退役（见模板存档）；
 *   5) chapterOf 章节映射与视频段界一致。
 * ============================================================ */
'use strict';
global.window = {};
require('../audio.js');
require('../feedback.js');
var SND = global.window.BIOSND;
var BIOFX = global.window.BIOFX;
var FXC = BIOFX.core;

var fail = 0;
function ok(cond, msg) {
  if (!cond) { console.error('FAIL: ' + msg); fail++; }
}

/* ---------- 1) 计量插值 ---------- */
ok(Math.abs(FXC.altitudeAt(0) - 480) < 1e-9, 'alt(0)=480');
ok(Math.abs(FXC.altitudeAt(1 / 3) - 30) < 1e-9, 'alt(1/3)=30');
ok(Math.abs(FXC.altitudeAt(1 / 6) - 255) < 1e-9, 'alt(1/6)=255 线性中点');
ok(FXC.altitudeAt(0.6) === 30 && FXC.altitudeAt(1) === 30, 'alt 界外钳制 30');
var prevA = 1e9, monoA = true;
for (var q = 0; q <= 1.0001; q += 0.001) {
  var a = FXC.altitudeAt(q);
  if (a > prevA + 1e-9) monoA = false;
  prevA = a;
}
ok(monoA, 'alt 单调不增');

ok(FXC.doorAt(1 / 3) === 7 && FXC.doorAt(1 / 3 + 1e-6) === 7, 'door(1/3)=07');
ok(FXC.doorAt(1 / 2) === 13, 'door(1/2)=13');
ok(FXC.doorAt(2 / 3) === 19 && FXC.doorAt(1) === 19, 'door(2/3)=19');
ok(FXC.pad2(FXC.doorAt(1 / 3)) === '07' && FXC.pad2(FXC.doorAt(2 / 3)) === '19', 'pad2 两位门牌');

ok(FXC.distAt(2 / 3) === 12, 'dist(2/3)=12');
ok(Math.abs(FXC.distAt(2 / 3 + 1e-6) - 12) < 1e-3, 'dist 界后缓起');
ok(Math.abs(FXC.distAt(5 / 6) - 6) < 1e-9, 'dist(5/6)=6');
ok(Math.abs(FXC.distAt(1) - 0) < 1e-9, 'dist(1)=0');

ok(FXC.stepsAt(1 / 3) === 0 && FXC.stepsAt(2 / 3) === 486, 'steps 0→486');
var prevS = -1, monoS = true;
for (var q2 = 1 / 3; q2 <= 2 / 3 + 1e-9; q2 += 0.001) {
  var s = FXC.stepsAt(q2);
  if (s < prevS) monoS = false;
  prevS = s;
}
ok(monoS, 'steps 单调不减');

ok(FXC.vspeedOf(0) === 0, 'vspeed(0)=0');
ok(FXC.vspeedOf(0.2) < FXC.vspeedOf(0.5) && FXC.vspeedOf(0.5) < FXC.vspeedOf(2), 'vspeed 随滚动速度单调');
ok(FXC.vspeedOf(100) <= 88, 'vspeed 封顶 88 m/s');

/* ---------- 2) 章界触发去重 ---------- */
var det = FXC.makeTransitDetector([1 / 3, 2 / 3], 0.015);
function run(seq) {
  var c = 0, d = 0;
  seq.forEach(function (p) {
    det(p).forEach(function (id) { if (id === 0) c++; else d++; });
  });
  return [c, d];
}
/* 阻尼缓动在 33% 附近的抖动序列：只允许触发一次 */
var r1 = run([0.30, 0.325, 0.332, 0.334, 0.3335, 0.34, 0.3338, 0.35]);
ok(r1[0] === 1 && r1[1] === 0, 'C 界抖动去重（恰一次），D 未到：' + JSON.stringify(r1));
/* 退回滞回窗外（< 33%-1.5%）重新武装，再跨越可再触发（共两次） */
var r2 = run([0.30, 0.34, 0.31, 0.335, 0.35]);
ok(r2[0] === 2, '退回重武装后再触发（共两次）：' + r2[0]);
/* 全程 0→1 扫描：每界恰好一次 */
var det2 = FXC.makeTransitDetector([1 / 3, 2 / 3], 0.015);
var c2 = 0, d2 = 0;
for (var p2 = 0; p2 <= 1.0001; p2 += 0.002) {
  det2(p2).forEach(function (id) { if (id === 0) c2++; else d2++; });
}
ok(c2 === 1 && d2 === 1, '全程扫描每界恰一次：C=' + c2 + ' D=' + d2);
/* 跳章（0.1 → 0.8 一步跨双界）：两界各触发一次 */
var det3 = FXC.makeTransitDetector([1 / 3, 2 / 3], 0.015);
var hits3 = det3(0.8);
ok(hits3.length === 2 && hits3[0] === 0 && hits3[1] === 1, '跳章双界各一次');
/* 已在界上方：抖动/继续上行不再触发；退回武装仅发生在滞回窗外 */
var det4 = FXC.makeTransitDetector([1 / 3], 0.015);
ok(det4(0.5).length === 1, '向下穿越触发一次');
ok(det4(0.6).length === 0, '已在界上方：不触发');
ok(det4(0.34).length === 0, '界上方抖动不触发');
ok(det4(0.30).length === 0, '退回滞回窗外仅重新武装（不触发）');
ok(det4(0.40).length === 1, '再次向下穿越触发');

/* ---------- 3) AudioContext 手势前不创建 ---------- */
ok(typeof SND.hasContext === 'function' && typeof SND.ensure === 'function', 'BIOSND 接口存在');
ok(SND.hasContext() === false, '模块加载不创建 AudioContext');
ok(SND.isMuted() === false, '默认未静音（可读，无需 context）');
ok(SND.ensure() === false, '无 AudioContext 环境下 ensure() 安全返回');
ok(SND.hasContext() === false, 'ensure() 失败仍不创建 context');
ok(typeof SND.update === 'function' && typeof SND.sting === 'function', 'update/sting 可安全持有');
SND.update(0.5, 0, 16);          // 无 context：应静默返回不抛错
SND.sting(0); SND.flick(); SND.tick(); SND.blip(true); SND.arrive(); SND.toggleMute();
ok(SND.isMuted() === true, 'toggleMute 状态翻转（不依赖 context）');
SND.toggleMute();
ok(SND.isMuted() === false, 'toggleMute 翻回');
SND.suspend(); SND.resume();     // 无 context：静默

/* ---------- 4) 反馈层接线 ---------- */
ok(typeof BIOFX === 'object' && typeof BIOFX.update === 'function', 'BIOFX 接口存在');
ok(BIOFX.init({}) === false, '无 DOM 环境下 init 安全返回 false');
BIOFX.update(16, 0.5, 0, { rm: false });   // 未 init：静默短路
BIOFX.transit(0); BIOFX.onActivity();     // 均不抛错

/* ---------- 5) 章节映射 ---------- */
ok(FXC.chapterOf(0) === 0 && FXC.chapterOf(0.1) === 0, 'ch(0.1)=0');
ok(FXC.chapterOf(1 / 3) === 1 && FXC.chapterOf(0.5) === 1, 'ch(0.5)=1');
ok(FXC.chapterOf(2 / 3) === 2 && FXC.chapterOf(0.99) === 2, 'ch(0.99)=2');

if (fail) { console.error(fail + ' assertion(s) failed'); process.exit(1); }
console.log('feedback test OK: 插值端点 / 章界去重 / AudioContext 手势前不创建 / 接线 全部通过');
