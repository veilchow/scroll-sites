/* ============================================================
   BLOOM v2 连续性自查（Node 桩环境，无浏览器依赖）
   ------------------------------------------------------------
   驱动 bloom-scenes.js 导出的纯相机/氛围路径，断言：
   1. 相机参数连续：p 从 0→1 步进 0.001，相邻两步的
      sy/sx/scale/fy 变化量均远小于一次正常滚动的变化量（无跳变）；
   2. cover 裁切任意视口不露边：绘制矩形永远完整覆盖视口
      （sx≤0, sx+DW≥W, sy≤0, sy+DH≥H），且缩放全程 ≥1；
   3. 端点对齐：p=0 图顶贴视口顶、p=1 图底贴视口底；
   4. 相机单调下移（fy 非降）；
   5. scale 关键帧 1.0 → 1.12(峰值) → 1.04；
   6. 氛围参数：全部有限、连续（|Δ|≤0.02/步）、值域 [0,1]，
      crossing 峰值位于 p≈1/3，waveGate 从 p>0.655 起淡入。

   运行：node tools/continuity-check.mjs（退出码 0 = 通过）
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'bloom-scenes.js'), 'utf8');

/* 桩环境：IIFE 只需要 window（纯函数路径不触 DOM） */
const stubWindow = {};
new Function('window', 'document', src)(stubWindow, undefined);

const BLOOM = stubWindow.BLOOM;
if (!BLOOM || !BLOOM.pure) {
  console.error('FAIL: window.BLOOM.pure 未导出');
  process.exit(1);
}
const { cameraAt, scalePath, atmosphere, IMG } = BLOOM.pure;

let failures = 0;
function fail(msg) { failures++; console.error('FAIL: ' + msg); }
function near(a, b, eps) { return Math.abs(a - b) <= eps; }

/* 视口几何样本：手机竖屏 / 平板 / 笔记本 / 桌面 / 超宽 / 图幅等比 / 极端 */
const VIEWPORTS = [
  [320, 568], [375, 667], [390, 844], [414, 896], [430, 932],
  [768, 1024], [820, 1180], [1280, 720], [1366, 768],
  [1920, 1080], [2560, 1440], [3440, 1440],
  [729, 2158],   /* 与图幅等比：cover 恰好无余量 */
  [729, 2400],   /* 比图幅更瘦长：cover 由高度决定 */
  [1200, 500]    /* 极扁 */
];

const STEP = 0.001;
let maxDsy = 0, maxDsx = 0, maxDscale = 0, maxDfy = 0, maxAtmo = 0;

/* scale 关键帧 */
const s0 = scalePath(0), sHalf = scalePath(0.5), s1 = scalePath(1);
if (!near(s0, 1.0, 1e-9)) fail(`scalePath(0)=${s0} 应为 1.0`);
if (!near(sHalf, 1.12, 1e-9)) fail(`scalePath(0.5)=${sHalf} 应为 1.12`);
if (!near(s1, 1.04, 1e-9)) fail(`scalePath(1)=${s1} 应为 1.04`);
for (let p = 0; p <= 1.0001; p += STEP) {
  const s = scalePath(p);
  if (!(s >= 1 - 1e-9 && s <= 1.12 + 1e-9)) { fail(`scalePath(${p.toFixed(3)})=${s} 超出 [1,1.12]`); break; }
}

for (const [W, H] of VIEWPORTS) {
  let prevCam = null, prevA = null;
  for (let p = 0; p <= 1.0001; p += STEP) {
    const cam = cameraAt(p, W, H, IMG.w, IMG.h);
    const A = atmosphere(p);

    if (!Number.isFinite(cam.sx) || !Number.isFinite(cam.sy) ||
        !Number.isFinite(cam.DW) || !Number.isFinite(cam.DH)) {
      fail(`[${W}x${H}] p=${p.toFixed(3)} 相机参数非有限`); break;
    }
    /* 2. cover 不露边（绘制矩形完整覆盖视口） */
    if (cam.sx > 1e-6 || cam.sx + cam.DW < W - 1e-6 ||
        cam.sy > 1e-6 || cam.sy + cam.DH < H - 1e-6) {
      fail(`[${W}x${H}] p=${p.toFixed(3)} 露边: sx=${cam.sx.toFixed(2)} sy=${cam.sy.toFixed(2)} ` +
           `DW=${cam.DW.toFixed(1)} DH=${cam.DH.toFixed(1)}`);
      break;
    }
    if (prevCam) {
      /* 1. 连续无跳变 */
      const dsy = Math.abs(cam.sy - prevCam.sy);
      const dsx = Math.abs(cam.sx - prevCam.sx);
      const dsc = Math.abs(cam.scale - prevCam.scale);
      const dfy = cam.fy - prevCam.fy;
      maxDsy = Math.max(maxDsy, dsy); maxDsx = Math.max(maxDsx, dsx);
      maxDscale = Math.max(maxDscale, dsc); maxDfy = Math.max(maxDfy, dfy);
      /* 单步 0.001 的安全上界：sy/sx 视口尺寸的 2%，scale 0.004，fy 单调不降 */
      if (dsy > 0.02 * H || dsx > 0.02 * W || dsc > 0.004 || dfy < -1e-9) {
        fail(`[${W}x${H}] p=${p.toFixed(3)} 相机跳变: dsy=${dsy.toFixed(3)} dsx=${dsx.toFixed(3)} ` +
             `dscale=${dsc.toFixed(5)} dfy=${dfy.toExponential(2)}`);
        break;
      }
    }
    /* 6. 氛围连续、有界 */
    for (const k of Object.keys(A)) {
      const v = A[k];
      if (!Number.isFinite(v) || v < -1e-9 || v > 1 + 1e-9) {
        fail(`[${W}x${H}] p=${p.toFixed(3)} atmosphere.${k}=${v} 非法`); break;
      }
      if (prevA) {
        const d = Math.abs(v - prevA[k]);
        maxAtmo = Math.max(maxAtmo, d);
        if (d > 0.02) { fail(`atmosphere.${k} 在 p=${p.toFixed(3)} 跳变 ${d.toFixed(4)}`); break; }
      }
    }
    prevCam = cam; prevA = A;
  }
  if (failures > 40) break;

  /* 3. 端点对齐 */
  const c0 = cameraAt(0, W, H, IMG.w, IMG.h);
  const c1 = cameraAt(1, W, H, IMG.w, IMG.h);
  if (!near(c0.sy, 0, 1e-6)) fail(`[${W}x${H}] p=0 图顶未贴视口顶 (sy=${c0.sy})`);
  if (!near(c1.sy + c1.DH, H, 1e-6)) fail(`[${W}x${H}] p=1 图底未贴视口底 (sy+DH=${c1.sy + c1.DH})`);
}

/* crossing 峰值应位于 p≈1/3；waveGate 从 p>0.655 淡入 */
let peakP = 0, peakV = -1;
for (let p = 0; p <= 1.0001; p += STEP) {
  const v = atmosphere(p).crossing;
  if (v > peakV) { peakV = v; peakP = p; }
}
if (!near(peakP, 1 / 3, 0.002)) fail(`crossing 峰值 p=${peakP.toFixed(3)} 应 ≈ 0.333`);
if (atmosphere(0.6).waveGate > 0.001) fail('waveGate 在 p=0.6 应为 0（未入深处段）');
if (Math.abs(atmosphere(1).waveGate - 1) > 1e-6) fail('waveGate 在 p=1 应为 1');

console.log('相机连续性: max |Δsy|/步 = ' + maxDsy.toFixed(3) + 'px, |Δsx| = ' + maxDsx.toFixed(3) +
            'px, |Δscale| = ' + maxDscale.toFixed(6) + ', max Δfy = ' + maxDfy.toExponential(2));
console.log('氛围连续性: max |Δ参数|/步 = ' + maxAtmo.toFixed(5));
console.log('视口样本: ' + VIEWPORTS.length + ' 种（含图幅等比/更瘦长/极扁）× 1001 步');

if (failures) {
  console.error(`\n${failures} 项断言失败`);
  process.exit(1);
}
console.log('\n全部通过：相机路径连续、cover 任意视口不露边、端点对齐、氛围无跳变。');
