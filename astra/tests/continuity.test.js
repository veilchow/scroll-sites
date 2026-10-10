/* ==========================================================================
 * ASTRA · 连续性自查（Node 桩环境，无浏览器依赖）
 * astra/tests/continuity.test.js
 *
 * 用法：node tests/continuity.test.js （在 astra/ 目录下）
 *
 * 检查项（CONTINUITY-SPEC）：
 *   1. 驱动 AstraEngine.camera(p)，p 从 0→1 步进 0.001；
 *      相机参数（scale / pan / alpha）与氛围参数相邻步差值有界 —— 无跳变。
 *   2. 两次换图（SWAP1/SWAP2）交叉加权严格发生在对应光晕的峰值平台内
 *      （glow ≥ 0.98），即"切点藏在光里"，不存在裸交叉淡化。
 *   3. 任意 p 处可见主图权重之和恒为 1（同一世界，无双图裸混）。
 *   4. 换图窗口之外不存在半透明主图；边界相机位数值与参数表一致。
 *   5. 全程无 NaN；zc（推进深度）单调。
 * ========================================================================== */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var src = fs.readFileSync(path.join(__dirname, '..', 'js', 'astra-scene.js'), 'utf8');
var sandbox = { window: {}, console: console };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

var Eng = sandbox.window.AstraEngine;
if (!Eng) { console.error('FAIL: window.AstraEngine 未导出'); process.exit(1); }

var failures = [];
function check(cond, msg) {
  if (!cond) failures.push(msg);
}

/* 步进采样：相机/氛围逐参数相邻差上界（步长 0.001）。
 * alpha 上界 0.16 对应换图窗口（宽 0.010，约 0.45s@45s 漫游）内的最快合法渐变；
 * scale 上界 0.012 对应 approach dolly 最陡处（2.0×跨度 / 0.55 区间 × easeInOutCubic
 * 中点斜率 3.0 → 10.9/单位进度 ≈ 0.0109/步）；硬切的特征是单步 Δ≈1，与之相差两个数量级。 */
var STEP = 0.001;
var BOUNDS = {
  alpha: 0.16, scale: 0.012, pan: 0.001,
  glow: 0.05, temp: 0.01, zc: 0.006,
  mistA: 0.02, fgA: 0.02, dustDensity: 0.02, flow: 0.03,
  inside: 0.02, vinA: 0.01, bloom: 0.01
};
var maxDelta = {};
Object.keys(BOUNDS).forEach(function (k) { maxDelta[k] = 0; });
var maxPlate = { alpha: 0, scale: 0, panX: 0, panY: 0 };
var prev = null;
var samples = 0;
var monoZc = true;

var PLATE_IDS = ['approach', 'port', 'core'];
var TL = Eng.TL;

function inWin(w, p) { return p >= w[0] - 1e-9 && p <= w[1] + 1e-9; }
function inStrict(w, p) { return p > w[0] + 1e-9 && p < w[1] - 1e-9; }

for (var p = 0; p <= 1.0000001; p += STEP) {
  var c = Eng.camera(p);
  samples++;

  /* 5) 无 NaN */
  function finiteScan(obj, where) {
    for (var k in obj) {
      if (typeof obj[k] === 'number') check(isFinite(obj[k]), 'NaN/Inf at p=' + p.toFixed(3) + ' ' + where + '.' + k);
      else if (obj[k] && typeof obj[k] === 'object') finiteScan(obj[k], where + '.' + k);
    }
  }
  finiteScan(c, 'cam');

  check(c.zc >= (prev ? prev.zc : c.zc) - 1e-9, 'zc 非单调 at p=' + p.toFixed(3));
  if (prev && c.zc < prev.zc - 1e-9) monoZc = false;

  /* 1) 相邻步差有界 */
  if (prev) {
    ['glow1', 'glow2', 'temp', 'zc', 'mistA', 'fgA', 'dustDensity', 'flow', 'inside', 'vinA', 'bloom'].forEach(function (k) {
      var d = Math.abs(c[k] - prev[k]);
      var key = k === 'glow1' || k === 'glow2' ? 'glow' : k;
      if (d > maxDelta[key]) maxDelta[key] = d;
      check(d <= BOUNDS[key] + 1e-9, '跳变 ' + k + ' at p=' + p.toFixed(3) + ' Δ=' + d.toFixed(5));
    });
    for (var i = 0; i < 3; i++) {
      var a = c.plates[i], b = prev.plates[i];
      var dAl = Math.abs(a.alpha - b.alpha);
      var dSc = Math.abs(a.scale - b.scale);
      var dPx = Math.abs(a.panX - b.panX);
      var dPy = Math.abs(a.panY - b.panY);
      if (dAl > maxPlate.alpha) maxPlate.alpha = dAl;
      if (dSc > maxPlate.scale) maxPlate.scale = dSc;
      if (dPx > maxPlate.panX) maxPlate.panX = dPx;
      if (dPy > maxPlate.panY) maxPlate.panY = dPy;
      check(dAl <= BOUNDS.alpha + 1e-9, '跳变 alpha(' + a.id + ') at p=' + p.toFixed(3) + ' Δ=' + dAl.toFixed(5));
      check(dSc <= BOUNDS.scale + 1e-9, '跳变 scale(' + a.id + ') at p=' + p.toFixed(3) + ' Δ=' + dSc.toFixed(5));
      check(dPx <= BOUNDS.pan + 1e-9 && dPy <= BOUNDS.pan + 1e-9, '跳变 pan(' + a.id + ') at p=' + p.toFixed(3));
    }
  }

  /* 2) 换图窗口严格处于光晕峰值平台内（切点藏在光里） */
  var sum = c.plates[0].alpha + c.plates[1].alpha + c.plates[2].alpha;
  check(Math.abs(sum - 1) <= 1e-9, '主图权重和 ≠ 1 at p=' + p.toFixed(3) + ' sum=' + sum);
  var inS1 = inWin(TL.SWAP1, p), inS2 = inWin(TL.SWAP2, p);
  if (inS1) {
    check(c.glow1 >= 0.98, 'SWAP1 内光晕①不足 (p=' + p.toFixed(3) + ' glow1=' + c.glow1.toFixed(3) + ')');
    if (inStrict(TL.SWAP1, p)) {
      check(c.plates[0].alpha > 0 && c.plates[1].alpha > 0, 'SWAP1 内双图未同时可见 at p=' + p.toFixed(3));
    }
  }
  if (inS2) {
    check(c.glow2 >= 0.98, 'SWAP2 内光晕②不足 (p=' + p.toFixed(3) + ' glow2=' + c.glow2.toFixed(3) + ')');
    if (inStrict(TL.SWAP2, p)) {
      check(c.plates[1].alpha > 0 && c.plates[2].alpha > 0, 'SWAP2 内双图未同时可见 at p=' + p.toFixed(3));
    }
  }
  if (!inS1 && !inS2) {
    var half = 0;
    for (var i2 = 0; i2 < 3; i2++) {
      if (c.plates[i2].alpha > 1e-9 && c.plates[i2].alpha < 1 - 1e-9) half++;
    }
    check(half === 0, '换图窗口外出现半透明主图 at p=' + p.toFixed(3));
  }

  prev = c;
}

/* 4) 边界相机位与参数表一致 */
var c0 = Eng.camera(0);
check(c0.plates[0].alpha === 1 && c0.plates[0].scale === 1, 'p=0 应为 approach scale 1.0');
var c1 = Eng.camera(TL.SWAP1[0]);
check(Math.abs(c1.plates[0].scale - TL.A_S[1]) < 0.001, 'SWAP1 起点 approach 应已到 ' + TL.A_S[1] + '×（实测 ' + c1.plates[0].scale.toFixed(4) + '）');
var c2 = Eng.camera(TL.SWAP1[1] + 0.001);
check(c2.plates[0].alpha === 0 && c2.plates[1].alpha === 1, 'SWAP1 终点后应全为 port');
check(Math.abs(c2.plates[1].scale - 1.0) < 0.01, 'port 起始 framing 应 ≈1.0（匹配 framing）');
var c3 = Eng.camera(TL.SWAP2[0]);
check(Math.abs(c3.plates[1].scale - TL.P_S[1]) < 0.01, 'SWAP2 起点 port 应 ≈' + TL.P_S[1] + '×');
var c4 = Eng.camera(1);
check(c4.plates[2].alpha === 1 && Math.abs(c4.plates[2].scale - TL.C_S[1]) < 1e-9, 'p=1 应为 core scale ' + TL.C_S[1]);
check(c4.glow1 === 0 && c4.glow2 === 0, '终点不应有残余光晕');
check(c4.temp === 1, '终点应为暖青白');

/* 汇总 */
console.log('ASTRA continuity test —— 采样 ' + samples + ' 点（步长 ' + STEP + '）');
console.log('  氛围参数最大相邻步差: ' + Object.keys(maxDelta).map(function (k) {
  return k + '=' + maxDelta[k].toFixed(5) + '(≤' + BOUNDS[k].toFixed(3) + ')';
}).join('  '));
console.log('  主图参数最大相邻步差: alpha=' + maxPlate.alpha.toFixed(5) +
  '  scale=' + maxPlate.scale.toFixed(5) +
  '  panX=' + maxPlate.panX.toExponential(2) +
  '  panY=' + maxPlate.panY.toExponential(2));
console.log('  zc 单调: ' + (monoZc ? 'yes' : 'NO'));

if (failures.length) {
  console.error('FAIL (' + failures.length + ' 项):');
  failures.slice(0, 20).forEach(function (m) { console.error('  - ' + m); });
  process.exit(1);
}
console.log('PASS: 相机路径连续无跳变；两次换图均藏于光晕峰值平台；主图权重恒和为 1。');
