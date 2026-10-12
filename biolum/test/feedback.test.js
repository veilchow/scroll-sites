/* ============================================================
 * P1 反馈层桩测试（无浏览器）：
 *   node test/feedback.test.js
 * 断言（数值按 PLAN-DESIGN §1.5 D-HUD 定稿改写，性质逐条保留）：
 *   1) 计量插值端点正确：潮汐时刻 19:42→21:17（0→1/3，分钟数+HH:MM）、
 *      发光指数 0→100（1/3→2/3）、爆发等级阈值跳变+界外钳制、
 *      深度 0→8m（2/3→1）、追光步速映射有界单调（公式继承）；
 *   2) 章界触发去重：一次向下跨越只触发一次（阻尼抖动不重复），
 *      退回滞回窗外重新武装后可再次触发；全程序扫每界恰好一次；
 *   3) AudioContext 手势前不创建：模块加载与无手势 ensure() 均不触碰构造器；
 *   4) 反馈层接线存在（BIOFX 接口）；
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

/* ---------- 1) 计量插值（D-HUD） ---------- */
/* 潮汐时刻：19:42(1182) → 21:17(1277)，分钟数线性插值，HH:MM 格式化 */
ok(FXC.tideAt(0) === 1182, 'tide(0)=1182（19:42）');
ok(FXC.tideAt(1 / 3) === 1277, 'tide(1/3)=1277（21:17 满潮定格）');
ok(FXC.tideAt(1 / 6) === 1230, 'tide(1/6)=1230（线性中点 1229.5 取整）');
ok(FXC.tideAt(0.6) === 1277 && FXC.tideAt(1) === 1277, 'tide 界外钳制 1277');
var prevT = -1, monoT = true;
for (var q = 0; q <= 1.0001; q += 0.001) {
  var tm = FXC.tideAt(q);
  if (tm < prevT) monoT = false;
  prevT = tm;
}
ok(monoT, 'tide 单调不减（时光只向前）');
ok(FXC.fmtTide(1182) === '19:42' && FXC.fmtTide(1277) === '21:17', 'fmtTide HH:MM 端点');
ok(FXC.fmtTide(FXC.tideAt(1 / 6)) === '20:30', 'fmtTide 中点 20:30');
ok(FXC.pad2(7) === '07' && FXC.pad2(42) === '42', 'pad2 分钟补零');

/* 发光指数：0% → 100%（1/3→2/3），无 pad2（百分比整数） */
ok(FXC.glowAt(1 / 3) === 0 && FXC.glowAt(1 / 3 + 1e-6) === 0, 'glow(1/3)=0');
ok(FXC.glowAt(1 / 2) === 50, 'glow(1/2)=50 线性中点');
ok(FXC.glowAt(2 / 3) === 100 && FXC.glowAt(1) === 100, 'glow 界外钳制 100');
ok(FXC.glowAt(0) === 0, 'glow 章前钳制 0');

/* 爆发等级：阈值 20/40/60/80 跳变（Ⅰ-Ⅴ），非累加计数 */
ok(FXC.burstAt(1 / 3) === 0 && FXC.burstAt(0.39) === 0, 'burst 章首=0（Ⅰ SPARK）');
ok(FXC.burstAt(0.40) === 1, 'burst 阈值跳变：glow 20% → Ⅱ（0.40）');
ok(FXC.burstAt(0.4667) === 2, 'burst 阈值跳变：glow 40% → Ⅲ');
ok(FXC.burstAt(0.5333) === 3, 'burst 阈值跳变：glow 60% → Ⅳ');
ok(FXC.burstAt(0.60) === 4, 'burst 阈值跳变：glow 80% → Ⅴ');
ok(FXC.burstAt(2 / 3) === 4 && FXC.burstAt(1) === 4 && FXC.burstAt(0) === 0, 'burst 界外钳制 0/4');
ok(FXC.BURST_LV.length === 5 && FXC.BURST_LV[0] === 'Ⅰ SPARK' &&
  FXC.BURST_LV[4] === 'Ⅴ SEA OF LIGHT', '等级标签序列 Ⅰ-Ⅴ');
var prevB = -1, monoB = true;
for (var q3 = 0; q3 <= 1.0001; q3 += 0.001) {
  var bl = FXC.burstAt(q3);
  if (bl < prevB) monoB = false;
  prevB = bl;
}
ok(monoB, 'burst 单调不减');

/* 水下深度：0.0 → 8.0m（2/3→1 递增），破水激活阈值 0.717 */
ok(FXC.DEPTH_ON === 0.717, '破水激活位 p=0.717');
ok(FXC.depthAt(2 / 3) === 0, 'depth(2/3)=0.0');
ok(Math.abs(FXC.depthAt(2 / 3 + 1e-6) - 0) < 1e-3, 'depth 界后缓起');
ok(Math.abs(FXC.depthAt(5 / 6) - 4) < 1e-9, 'depth(5/6)=4.0 线性中点');
ok(Math.abs(FXC.depthAt(1) - 8) < 1e-9, 'depth(1)=8.0 终点悬浮');
ok(FXC.depthAt(0.5) === 0 && FXC.depthAt(0) === 0, 'depth 章前钳制 0');
var prevD = -1, monoD = true;
for (var q4 = 0; q4 <= 1.0001; q4 += 0.001) {
  var dp = FXC.depthAt(q4);
  if (dp < prevD - 1e-9) monoD = false;
  prevD = dp;
}
ok(monoD, 'depth 单调不减（只下沉）');

/* 追光步速：公式与封顶值继承零改动（0-88 步/分） */
ok(FXC.vspeedOf(0) === 0, 'vspeed(0)=0');
ok(FXC.vspeedOf(0.2) < FXC.vspeedOf(0.5) && FXC.vspeedOf(0.5) < FXC.vspeedOf(2), 'vspeed 随滚动速度单调');
ok(FXC.vspeedOf(100) <= 88, 'vspeed 封顶 88 步/分');

/* 双态温度常量（T2 破水翻牌伴随） */
ok(FXC.T_AIR === 22 && FXC.T_WATER === 18, '双态温度 气温22° → 水温18°');

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
ok(r1[0] === 1 && r1[1] === 0, 'T1 界抖动去重（恰一次），T2 未到：' + JSON.stringify(r1));
/* 退回滞回窗外（< 33%-1.5%）重新武装，再跨越可再触发（共两次） */
var r2 = run([0.30, 0.34, 0.31, 0.335, 0.35]);
ok(r2[0] === 2, '退回重武装后再触发（共两次）：' + r2[0]);
/* 全程 0→1 扫描：每界恰好一次 */
var det2 = FXC.makeTransitDetector([1 / 3, 2 / 3], 0.015);
var c2 = 0, d2 = 0;
for (var p2 = 0; p2 <= 1.0001; p2 += 0.002) {
  det2(p2).forEach(function (id) { if (id === 0) c2++; else d2++; });
}
ok(c2 === 1 && d2 === 1, '全程扫描每界恰一次：T1=' + c2 + ' T2=' + d2);
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
console.log('feedback test OK: 插值端点（潮汐/发光/等级/深度）/ 章界去重 / AudioContext 手势前不创建 / 接线 全部通过');
