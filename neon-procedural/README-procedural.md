# neon-procedural —— 程序化引擎档案版

> **用户认可版**，tag `neon-procedural-v1`。这是 NEON 视频化改造前的完整程序化形态，
> 此目录不再改动（对齐 `../astra-procedural/` 的档案模式，见根目录 VERSIONS.md v2/v2.5 条目）。

## 这是什么

NEON DRIFT 雨夜漫游的**程序化引擎版**（v2 连续相机 + v2.5 P1 反馈层）：

- `scene.js` —— 程序场景引擎：以 `assets/city-tower.png`（724×2172 竖幅城市剖面长图）为唯一素材，
  相机模型连续取景（一镜到底），叠加远景 0.7× / 前景 1.3× 视差与雨/雾/色温氛围的程序化绘制；
- `app.js` —— rAF 主循环内直接调用 `NEON.init/resize/tick/render` 驱动 canvas；
- `feedback.js` / `audio.js` —— P1 反馈层（计量 HUD / 穿越时刻 / WebAudio 音床），
  与画面解耦，在视频版 `../neon/` 中**原样保留**；
- `test/` —— 连续性测试（相机/氛围/cover 不露边）与反馈层桩测试，依赖 `scene.js`，
  在本目录内仍可直接运行。

## 运行

```bash
cd scroll-sites/neon-procedural
python -m http.server 8803   # 或直接双击 index.html（file:// 可运行）
node test/continuity.test.js
node test/feedback.test.js
```

## 与视频版的关系

- 视频版 `../neon/` 采用三段 scrub 视频为画面唯一来源（`neon-video.js`），失败兜底为
  `assets/keys/k1|k2|k4.png` 海报关键帧——**不是**回退到本引擎（隔离原则，见根目录
  `NEON-BLOOM-VIDEO-PLAN.md` §0：视频呈现期间 canvas 零绘制、合并白名单默认空）。
- 本目录的存在价值：留存用户认可的程序化观感基线，供对比与回滚
  （`git checkout neon-procedural-v1`）。
