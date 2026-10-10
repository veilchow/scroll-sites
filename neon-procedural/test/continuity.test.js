/* ============================================================
 * 连续性自查（桩环境，无浏览器）：
 *   node test/continuity.test.js
 * 断言：
 *   1) 相机参数是 p 的连续函数（无跳变），travel 单调；
 *   2) cover 裁切在任意视口尺寸下不露边（dw≥W、dh≥H，绘制矩形完整覆盖视口）；
 *   3) zoom 关键帧 1.0 → 1.15(p=0.5) → 1.05(p=1)；
 *   4) 氛围参数（雨/雾/暗角/动态强度/色温 RGB）是 p 的连续函数，端点符合设计。
 * ============================================================ */
'use strict';
global.window = {};
require('../scene.js');
var NEON = global.window.NEON;

var EPS = 0.01;
var fail = 0;
function ok(cond, msg) {
  if (!cond) { console.error('FAIL: ' + msg); fail++; }
}

/* 桌面 / 笔记本 / 平板 / 手机竖屏 / 极端长窄视口 */
var SIZES = [
  [1440, 900], [1920, 1080], [2560, 1440], [1366, 768],
  [1024, 600], [768, 1024], [1280, 1280],
  [390, 844], [375, 667], [360, 740], [412, 915],
  [400, 1400]   // 比 1:3 更长的视口：cover 由高度决定，行程趋近 0，仍不允许露边
];

SIZES.forEach(function (sz) {
  var w = sz[0], h = sz[1];
  var prev = null;
  /* 行程单调性只在“高度有余量”的常规视口断言（图高约 3 倍宽）：
     视口比 1:3 更长时 cover 由高度决定，行程≈0，规格的 1.15→1.05 收焦
     会让底部锚定的画面在收焦时轻微回拉（连续、不露边，属预期） */
  var cBase = NEON.cameraFor(0.5, w, h);
  var hasMargin = cBase.dh > h * 1.2;
  for (var p = 0; p <= 1.0001; p += 0.001) {
    var c = NEON.cameraFor(p, w, h);
    /* cover：绘制尺寸至少覆盖视口 */
    ok(c.dw >= w - EPS && c.dh >= h - EPS, 'cover size ' + w + 'x' + h + ' p=' + p.toFixed(3));
    /* 不露边：绘制矩形完整覆盖 [0,0,w,h] */
    ok(c.dx <= EPS && c.dx + c.dw >= w - EPS && c.dy <= EPS && c.dy + c.dh >= h - EPS,
      'no edge ' + w + 'x' + h + ' p=' + p.toFixed(3));
    /* 连续性：相邻步进无跳变；常规视口下 travel 单调不减（相机只下行） */
    if (prev) {
      ok(Math.abs(c.dy - prev.dy) <= h * 0.02, 'dy jump ' + w + 'x' + h + ' p=' + p.toFixed(3));
      ok(Math.abs(c.dx - prev.dx) <= w * 0.02, 'dx jump ' + w + 'x' + h + ' p=' + p.toFixed(3));
      ok(Math.abs(c.zoom - prev.zoom) <= 0.02, 'zoom jump p=' + p.toFixed(3));
      if (hasMargin) ok(c.travel >= prev.travel - 1e-9, 'travel not monotonic ' + w + 'x' + h + ' p=' + p.toFixed(3));
      else ok(Math.abs(c.travel - prev.travel) <= h * 0.02, 'travel jump (degenerate) ' + w + 'x' + h + ' p=' + p.toFixed(3));
    }
    prev = c;
  }
});

/* zoom 关键帧 */
ok(Math.abs(NEON.cameraFor(0, 1440, 900).zoom - 1.0) < 1e-9, 'zoom(0)=1.0');
ok(Math.abs(NEON.cameraFor(0.5, 1440, 900).zoom - 1.15) < 1e-9, 'zoom(0.5)=1.15');
ok(Math.abs(NEON.cameraFor(1, 1440, 900).zoom - 1.05) < 1e-9, 'zoom(1)=1.05');

/* 相机端点：图顶/图底贴合视口（dy=0 与 dy=h-dh） */
var c0 = NEON.cameraFor(0, 1440, 900), c1 = NEON.cameraFor(1, 1440, 900);
ok(Math.abs(c0.dy) < EPS, 'p=0 shows image top');
ok(Math.abs((c1.dy + c1.dh) - 900) < EPS, 'p=1 shows image bottom');
ok(Math.abs(c0.travel) < EPS && c1.travel > 0, 'travel range sane');

/* 氛围参数连续性 + 端点 */
var prevA = null;
for (var q = 0; q <= 1.0001; q += 0.001) {
  var a = NEON.atmoFor(q);
  if (prevA) {
    ['rain', 'fog', 'vig', 'veh', 'car', 'und', 'cloud', 'far'].forEach(function (k) {
      ok(Math.abs(a[k] - prevA[k]) <= 0.02, 'atmo ' + k + ' jump p=' + q.toFixed(3));
    });
    for (var ch = 0; ch < 3; ch++) ok(Math.abs(a.rgb[ch] - prevA.rgb[ch]) <= 3, 'atmo rgb jump p=' + q.toFixed(3));
  }
  prevA = a;
}
var A0 = NEON.atmoFor(0), A5 = NEON.atmoFor(0.5), A1 = NEON.atmoFor(1);
ok(Math.abs(A0.rain - 0.30) < 1e-9, 'rain(0)=0.30');
ok(Math.abs(A5.rain - 1.0) < 1e-9, 'rain(0.5)=1.0');
ok(Math.abs(A1.rain - 0) < 1e-9, 'rain(1)=0');
ok(A1.und > 0.99 && A1.veh === 0, 'underground full / vehicles gone');
ok(A0.veh > 0.99 && A0.car === 0 && A0.und === 0, 'aerial: vehicles only');

if (fail) { console.error(fail + ' assertion(s) failed'); process.exit(1); }
console.log('continuity test OK: camera + atmosphere continuous, cover safe on ' + SIZES.length + ' viewport sizes');
