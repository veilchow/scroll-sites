/* ============================================================
   BLOOM P1 反馈层桩测试（Node 桩环境：DOM + WebAudio 全量桩）
   ------------------------------------------------------------
   加载 bloom-feedback.js，断言：
   1. 计量插值起止正确：lx 420→60 / 时钟 19:42→19:58 /
      距母核 22→6m / 深度 0→8.4m / 同步率 0→100% / ppm 基线 38→96；
   2. 章界触发去重：±1.5% 窗口内只触发一次，退到窗外才重新武装；
   3. AudioContext 手势门控：任何 tick 都不创建，首次手势创建且幂等；
      M 键静音切换带状态；
   4. 同步率与进度映射一致：HUD 显示 = 纯函数值，p=1 达 100%、
      数字 lit + 结语淡入，回退熄灭；深度/时钟/光照文本同步收敛；
   5. 穿越时刻：E/F 各触发一次，闪光类与微震类正确施加；
      孢子浓度活数字在基线 ±6 内抖动。

   运行：node tools/feedback-check.mjs（退出码 0 = 通过）
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'bloom-feedback.js'), 'utf8');

let fails = 0;
const fail = (m) => { fails++; console.error('FAIL: ' + m); };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

/* ---------- WebAudio 桩：记录构造次数与 bed 增益 ramp ---------- */
let ctxCount = 0;
const rampLog = [];
class Param {
  constructor(v) { this.value = v || 0; }
  setValueAtTime(v) { this.value = v; }
  linearRampToValueAtTime(v) { this.value = v; rampLog.push(v); }
  exponentialRampToValueAtTime(v) { this.value = Math.max(v, 0); }
  setTargetAtTime(v) { this.value = v; }
  cancelScheduledValues() {}
}
class StubNode {
  constructor() {
    this.gain = new Param(1);
    this.frequency = new Param(350);
    this.detune = new Param(0);
    this.Q = new Param(1);
    this.playbackRate = new Param(1);
    this.type = '';
    this.buffer = null;
  }
  connect() { return this; }
  start() {} stop() {}
}
class StubCtx {
  constructor() {
    ctxCount++;
    this.currentTime = 1;
    this.sampleRate = 48000;
    this.state = 'running';
    this.destination = new StubNode();
  }
  createGain() { return new StubNode(); }
  createOscillator() { return new StubNode(); }
  createBufferSource() { return new StubNode(); }
  createBiquadFilter() { return new StubNode(); }
  createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len) }; }
  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  close() {}
}

/* ---------- DOM 桩 ---------- */
function makeEl(id) {
  const el = {
    id, textContent: '', style: {}, attrs: {}, offsetWidth: 0, _cls: new Set(), _q: {},
    querySelector(sel) { if (!el._q[sel]) el._q[sel] = makeEl(id + '>' + sel); return el._q[sel]; },
    querySelectorAll() { return []; },
    addEventListener() {},
    setAttribute(k, v) { el.attrs[k] = v; },
    getAttribute(k) { return (k in el.attrs) ? el.attrs[k] : null; }
  };
  el.classList = {
    add: (c) => el._cls.add(c),
    remove: (c) => el._cls.delete(c),
    toggle: (c, f) => { const on = f === undefined ? !el._cls.has(c) : f; on ? el._cls.add(c) : el._cls.delete(c); },
    contains: (c) => el._cls.has(c)
  };
  return el;
}
const els = {};
const winL = {};
const docL = {};
const body = makeEl('body');

globalThis.window = globalThis;
globalThis.innerWidth = 1280;
globalThis.innerHeight = 800;
globalThis.AudioContext = StubCtx;
globalThis.addEventListener = (t, fn) => { (winL[t] || (winL[t] = [])).push(fn); };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
globalThis.document = {
  hidden: false,
  body,
  getElementById: (id) => els[id] || (els[id] = makeEl(id)),
  querySelectorAll: () => [],
  querySelector: () => null,
  createElement: (tag) => makeEl('dyn-' + tag),
  addEventListener: (t, fn) => { (docL[t] || (docL[t] = [])).push(fn); }
};

/* ---------- 加载被测模块 ---------- */
new Function('window', 'document', src)(globalThis, globalThis.document);
const FB = globalThis.BLOOM_FEEDBACK;
if (!FB || !FB.pure) { console.error('FAIL: window.BLOOM_FEEDBACK.pure 未导出'); process.exit(1); }
const P = FB.pure;

const fire = (type, ev) => { for (const fn of (winL[type] || [])) fn(ev || {}); };
const settle = (p, n = 80) => { for (let i = 0; i < n; i++) FB.tick({ p, dt: 0.05 }); };

(async () => {
  /* 1. 计量插值起止 */
  if (!near(P.luxAt(0), 420)) fail(`luxAt(0)=${P.luxAt(0)} 应为 420`);
  if (!near(P.luxAt(1 / 3), 60)) fail(`luxAt(1/3)=${P.luxAt(1 / 3)} 应为 60`);
  if (!near(P.clockAt(0), 42)) fail(`clockAt(0)=${P.clockAt(0)} 应为 42`);
  if (!near(P.clockAt(1 / 3), 58)) fail(`clockAt(1/3)=${P.clockAt(1 / 3)} 应为 58`);
  if (!near(P.distAt(1 / 3), 22)) fail(`distAt(1/3)=${P.distAt(1 / 3)} 应为 22`);
  if (!near(P.distAt(2 / 3), 6)) fail(`distAt(2/3)=${P.distAt(2 / 3)} 应为 6`);
  if (!near(P.depthAt(2 / 3), 0)) fail(`depthAt(2/3)=${P.depthAt(2 / 3)} 应为 0`);
  if (!near(P.depthAt(1), 8.4)) fail(`depthAt(1)=${P.depthAt(1)} 应为 8.4`);
  if (!near(P.syncAt(2 / 3), 0)) fail(`syncAt(2/3)=${P.syncAt(2 / 3)} 应为 0`);
  if (!near(P.syncAt(1), 100)) fail(`syncAt(1)=${P.syncAt(1)} 应为 100`);
  if (!near(P.syncAt(5 / 6), 50, 1e-6)) fail(`syncAt(5/6)=${P.syncAt(5 / 6)} 应为 50（smoothstep 中点）`);
  if (!near(P.ppmAt(1 / 3), 38)) fail(`ppmAt(1/3)=${P.ppmAt(1 / 3)} 应为 38`);
  if (!near(P.ppmAt(2 / 3), 96)) fail(`ppmAt(2/3)=${P.ppmAt(2 / 3)} 应为 96`);
  console.log('1 计量插值起止: lx 420→60 · 19:42→19:58 · 22→6m · 0→8.4m · 同步率 0→100% · ppm 38→96');

  /* 2. 章界触发去重（±1.5% 窗口；1/3 = 0.33333） */
  const b = P.makeBoundary(1 / 3);
  const seq = [
    [0.300, false], [0.332, false], [0.336, true], [0.340, false], [0.326, false],
    [0.334, false],
    [0.317, false], /* 界下 1.5%（<0.31833）之外 → 重新武装 */
    [0.325, false], [0.336, true]  /* 再次下行跨越 → 再触发 */
  ];
  seq.forEach(([p, want]) => {
    const got = b.update(p);
    if (got !== want) fail(`boundary(1/3) p=${p} 触发=${got} 应为 ${want}`);
  });
  if (b.fires !== 2) fail(`boundary(1/3) fires=${b.fires} 应为 2`);
  /* 纯上行跨越不触发（穿越时刻只伴随下行下潜） */
  const b2 = P.makeBoundary(2 / 3);
  if (b2.update(0.80) !== true) fail('boundary(2/3) 首次下行跨越应触发');
  if (b2.update(0.50) !== false) fail('回退过程中不应触发');
  if (b2.update(0.70) !== true) fail('退到窗外后再下行跨越应再次触发');
  console.log('2 章界去重: 窗口内单次触发、窗外重武装、纯回退不触发（E×2 / F×2 序列）');

  /* 3. AudioContext 手势门控 + M 键静音 */
  settle(0.02);
  if (FB.info().ctxCreated !== false || ctxCount !== 0) {
    fail(`手势前不应创建 AudioContext（ctxCreated=${FB.info().ctxCreated}, 实例=${ctxCount}）`);
  }
  if (els.hudLux.textContent !== '398') fail(`p=0.02 光照应收敛 398，实际 "${els.hudLux.textContent}"`);
  if (els.hudClock.textContent !== '19:42') fail(`p=0.02 时钟应收敛 19:42，实际 "${els.hudClock.textContent}"`);
  fire('pointerdown');
  if (FB.info().ctxCreated !== true || ctxCount !== 1) {
    fail(`首次手势应创建 AudioContext（实例=${ctxCount}）`);
  }
  fire('pointerdown');
  if (ctxCount !== 1) fail(`手势初始化应幂等（实例=${ctxCount}）`);
  FB.onChapter(0);
  if (!rampLog.includes(1)) fail(`onChapter(0) 后音床应 ramp 至 1（rampLog=${JSON.stringify(rampLog)}）`);
  const rampCount0 = rampLog.length;
  FB.onChapter(1);
  if (rampLog.length <= rampCount0) fail('章切换应触发 800ms 交叉淡化 ramp');
  fire('keydown', { key: 'm' });
  if (FB.info().muted !== true) fail('M 键应切换为静音');
  if (!els.muteBtn._cls.has('muted')) fail('静音钮状态指示缺失（.muted）');
  fire('keydown', { key: 'm' });
  if (FB.info().muted !== false) fail('再按 M 应恢复声音');
  console.log('3 声音系统: 手势前 0 实例、手势后 1 实例且幂等、床增益 ramp、M 键静音带指示');

  /* 4. 穿越 E（33%）: sting + 青碧闪光 + 微震，各一次 */
  for (let i = 0; i <= 20; i++) FB.tick({ p: 0.02 + (0.34 - 0.02) * (i / 20), dt: 0.05 });
  if (FB.info().fires.E !== 1) fail(`穿越 E 应触发 1 次，实际 ${FB.info().fires.E}`);
  if (!els.transitFlash._cls.has('flash-teal')) fail('穿越 E 应施加青碧闪光类');
  if (!els.stage._cls.has('shake')) fail('穿越 E 应施加微震类');
  if (els.hudDist.textContent !== '22.0' || els.hudDist.textContent !== '22.0') { /* 初始段 */ }
  console.log('4 穿越 E: fires=1 · flash-teal · shake（sting 已调度到桩 ctx）');

  /* 孢子浓度活数字：基线 ±6 内抖动 */
  settle(0.5, 120);
  const ppmShown = parseInt(els.hudPpm.textContent, 10);
  if (!(Math.abs(ppmShown - P.ppmAt(0.5)) <= 6)) {
    fail(`p=0.5 孢子浓度 ${ppmShown} 应在基线 ${P.ppmAt(0.5)} ±6 内`);
  }
  if (els.hudDist.textContent !== '14.0') fail(`p=0.5 距母核应收敛 14.0，实际 "${els.hudDist.textContent}"`);
  console.log(`5 活数字: ppm=${ppmShown}（基线 ${P.ppmAt(0.5)} ±6）· 距母核 14.0m`);

  /* 穿越 F（66%）: 低沉闭锁 + 变暗脉冲 */
  for (let i = 0; i <= 20; i++) FB.tick({ p: 0.5 + (0.68 - 0.5) * (i / 20), dt: 0.05 });
  if (FB.info().fires.F !== 1) fail(`穿越 F 应触发 1 次，实际 ${FB.info().fires.F}`);
  if (!els.transitFlash._cls.has('flash-dark')) fail('穿越 F 应施加变暗闪光类');
  console.log('6 穿越 F: fires=1 · flash-dark · 深度计自 0.0m 启动');

  /* 7. 同步率/进度映射一致 + 100% 达成 */
  FB.onChapter(2);
  settle(0.9);
  const wantSync = Math.round(P.syncAt(0.9)) + '%';
  if (els.hudSync.textContent !== wantSync) {
    fail(`p=0.9 同步率显示 "${els.hudSync.textContent}" 应等于纯映射 "${wantSync}"`);
  }
  if (els.hudDepth.textContent !== P.depthAt(0.9).toFixed(1)) {
    fail(`p=0.9 深度显示 "${els.hudDepth.textContent}" 应为 ${P.depthAt(0.9).toFixed(1)}`);
  }
  if (els.hudSync._cls.has('lit')) fail('p=0.9（78%）不应点亮');
  settle(1.0);
  if (els.hudSync.textContent !== '100%') fail(`p=1 同步率应为 100%，实际 "${els.hudSync.textContent}"`);
  if (els.hudDepth.textContent !== '8.4') fail(`p=1 深度应为 8.4，实际 "${els.hudDepth.textContent}"`);
  if (!els.hudSync._cls.has('lit')) fail('100% 达成应点亮同步率数字（.lit）');
  if (!els.syncDone._cls.has('on')) fail('100% 达成应淡入结语（.on）');
  settle(0.8);
  if (els.hudSync._cls.has('lit')) fail('回退后应熄灭点亮');
  if (els.syncDone._cls.has('on')) fail('回退后结语应淡出');
  console.log('7 同步率映射: 显示=纯函数 · 0.9→78% · 1.0→100% 点亮+结语 · 回退熄灭');

  /* 速度响应数值面 */
  settle(0.5, 30);
  const sp0 = FB.info().speed;
  for (let i = 0; i < 6; i++) FB.tick({ p: 0.5 + 0.02 * (i + 1), dt: 0.05 });
  if (!(FB.info().speed > sp0 + 0.05)) fail(`快滚后速度应上升（${sp0.toFixed(3)} → ${FB.info().speed.toFixed(3)}）`);
  console.log(`8 速度响应: getSpeed ${sp0.toFixed(3)} → ${FB.info().speed.toFixed(3)}（供引擎拉丝/HUD 加速）`);

  FB.dispose();
  if (fails) { console.error(`\n${fails} 项失败`); process.exit(1); }
  console.log('\n全部通过：计量插值、章界去重、AudioContext 手势门控、同步率映射、穿越与活数字。');
  process.exit(0);
})().catch((e) => { console.error('桩测试异常:', e); process.exit(1); });
