/* ============================================================
   BLOOM v2 渲染冒烟测试（Node 桩环境：DOM + Canvas 2D 全量桩）
   ------------------------------------------------------------
   以桩浏览器加载 bloom-scenes.js + bloom-app.js（真实启动路径），
   泵动 rAF 驱动滚动 0→100%（含章节切换/光传导波触发/resize），
   断言：全程无异常、主图每帧都被绘制、相机走完全程。

   运行：node tools/render-smoke.mjs（退出码 0 = 通过）
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const W = 1920, H = 1080;

/* ---------- Canvas 2D 上下文桩 ---------- */
function makeCtx(stats) {
  const grad = { addColorStop() {} };
  return {
    canvas: null,
    globalAlpha: 1, filter: 'none',
    imageSmoothingEnabled: true, imageSmoothingQuality: 'low',
    setTransform() {}, save() {}, restore() {},
    translate() {}, scale() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
    quadraticCurveTo() {}, arc() {}, ellipse() {},
    fill() {}, stroke() {}, fillRect() {},
    clearRect() {},
    createLinearGradient() { stats.grads++; return grad; },
    createRadialGradient() { stats.grads++; return grad; },
    drawImage(img, ...a) { stats.draws++; if (img && img.__isWorld) stats.worldDraws++; }
  };
}
function makeCanvas(stats) {
  const cv = {
    width: 300, height: 150, style: {},
    __ctx: null,
    getContext() { if (!this.__ctx) { this.__ctx = makeCtx(stats); this.__ctx.canvas = this; } return this.__ctx; }
  };
  return cv;
}

/* ---------- DOM 桩 ---------- */
const stats = { draws: 0, worldDraws: 0, grads: 0 };
function makeElSafe(id) {
  const el = {
    id, style: {}, textContent: '', offsetWidth: 0, _cls: new Set(),
    getBoundingClientRect() { return { width: W, height: H, left: 0, top: 0 }; },
    querySelector() { return makeElSafe(id + '-child'); },
    querySelectorAll() { return []; },
    getAttribute() { return null; },
    setAttribute() {},
    addEventListener() {}
  };
  el.classList = {
    add: c => el._cls.add(c), remove: c => el._cls.delete(c),
    toggle: (c, f) => { const on = f === undefined ? !el._cls.has(c) : f; on ? el._cls.add(c) : el._cls.delete(c); },
    contains: c => el._cls.has(c)
  };
  return el;
}

const els = {
  view: makeCanvas(stats), fade: makeCanvas(stats), stage: makeElSafe('stage'),
  hint: makeElSafe('hint'), tourBtn: makeElSafe('tourBtn'), pct: makeElSafe('pct')
};
const winListeners = {};
const rafQueue = [];
let scrollYNow = 0;
const scrollDocHeight = 7 * H;

globalThis.window = globalThis;
globalThis.innerWidth = W;
globalThis.innerHeight = H;
globalThis.scrollY = 0;
globalThis.pageYOffset = 0;
window.scrollTo = (x, y) => { scrollYNow = Math.max(0, y || 0); globalThis.scrollY = scrollYNow; globalThis.pageYOffset = scrollYNow; };
window.scrollBy = (o) => window.scrollTo(0, scrollYNow + (o && o.top || 0));
window.addEventListener = (t, fn) => { (winListeners[t] || (winListeners[t] = [])).push(fn); };
window.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
globalThis.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };
globalThis.cancelAnimationFrame = () => {};
globalThis.history = { scrollRestoration: '' };
globalThis.Image = class {
  constructor() { this.naturalWidth = 0; this.naturalHeight = 0; this.__isWorld = true; }
  set src(v) { this._src = v; Promise.resolve().then(() => { this.naturalWidth = 729; this.naturalHeight = 2158; if (this.onload) this.onload(); }); }
  get src() { return this._src; }
};
globalThis.document = {
  hidden: false,
  body: makeElSafe('body'),
  documentElement: { scrollHeight: scrollDocHeight, scrollTop: 0 },
  getElementById: (id) => els[id] || null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: (tag) => (tag === 'canvas' ? makeCanvas(stats) : makeElSafe('dyn-' + tag)),
  addEventListener() {}
};
globalThis.console = console;

/* ---------- 加载两个脚本（真实启动路径） ---------- */
const scenes = readFileSync(join(here, '..', 'bloom-scenes.js'), 'utf8');
const app = readFileSync(join(here, '..', 'bloom-app.js'), 'utf8');
new Function('window', 'document', scenes)(globalThis, globalThis.document);
if (!globalThis.BLOOM) throw new Error('bloom-scenes.js 未挂载 window.BLOOM');
new Function('window', 'document', app)(globalThis, globalThis.document);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  /* 等待主图 onload → backend.ready → app 启动（loading 揭幕 + startLoop） */
  await sleep(30);

  const pump = (t) => { const q = rafQueue.splice(0); for (const cb of q) cb(t); };
  let now = performance.now();

  /* 滚动全程：0 → 100%，每帧推进一点（经过 ch1→ch2→ch3，触发穿越/光传导波） */
  const steps = 240;
  for (let i = 0; i <= steps; i++) {
    scrollYNow = (i / steps) * (scrollDocHeight - H);
    globalThis.scrollY = scrollYNow;
    for (const fn of (winListeners.scroll || [])) fn({});
    now += 1000 / 60;
    pump(now);
  }
  /* 尾帧收敛阻尼 */
  for (let k = 0; k < 90; k++) { now += 1000 / 60; pump(now); }

  const worldDraws = stats.worldDraws, grads = stats.grads;
  const pctText = els.pct.textContent;
  console.log(`主图绘制帧数(worldDraws)=${worldDraws} 总drawImage=${stats.draws} 渐变=${grads}`);
  console.log(`进度显示="${pctText}" body.loading=${document.body._cls.has('loading')} touring=${document.body._cls.has('touring')}`);

  let failures = 0;
  const fail = (m) => { failures++; console.error('FAIL: ' + m); };
  if (worldDraws < 300) fail('主图帧数过少：' + worldDraws);
  if (grads < 300) fail('氛围/雾/分级渐变过少：' + grads);
  if (pctText !== '100%') fail(`末帧进度应为 100%，实际 "${pctText}"`);
  if (document.body._cls.has('loading')) fail('loading 态未解除');

  /* 模拟 resize 重建（backend.resize 走 buildWorld，含全部预烘焙路径） */
  try {
    globalThis.innerWidth = 390; globalThis.innerHeight = 844;
    for (const fn of (winListeners.resize || [])) fn({});
    await sleep(220);
    now += 1000 / 60; pump(now);
    console.log('resize 重建 OK（390×844 移动端几何）');
  } catch (e) { fail('resize 重建异常: ' + e.message); }

  if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
  console.log('\n冒烟通过：全程渲染无异常，主图一镜到底，进度到 100%，resize 重建正常。');
  process.exit(0);
})().catch(e => { console.error('冒烟异常:', e); process.exit(1); });
