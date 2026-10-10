# 版本管理（VERSIONS）

本目录是 git 仓库。每个里程碑一次提交，回滚/对比随时可用（`git log --oneline`、`git checkout <tag>`）。

## 版本演进

| 版本 | 内容 | 状态与教训 |
|---|---|---|
| **v1** 海报轮播 | 三张独立构图 AI 插画 + 交叉淡化 + 程序化 Canvas 场景 | ❌ 割裂感严重：不同机位的图互相溶解=「切换」而非「镜头运动」（用户否决） |
| **v1.5** 海报混层 | AI 海报作底层、程序光效 screen 叠印 | 过渡方案，同根问题未解 |
| **v2** 连续相机引擎（⭐ NEON/BLOOM 程序版获用户高度认可，tag `neon-procedural-v1` / `bloom-procedural-v1`，思路=CONTINUITY-SPEC + INTERACTION-DESIGN §1/§2） | 一个世界+一条相机路径：ASTRA 同轴三帧 dolly / NEON、BLOOM 竖幅剖面全景图内连续下移 + 三平面视差 + 氛围参数连续化（CONTINUITY-SPEC） | ✅ 代码侧连续性成立；**NEON 赛博朋克版即使无视频也表现优秀（用户认可）** |
| **v2.5** P1 交互反馈层 | 三站 HUD 计量器（距离/海拔/深度+单位切换）、穿越时刻（sting/flash/微震）、WebAudio 分章音床、速度响应、待机提示 | ✅ 「网页在响应我」的核心体验（用户认可，对齐原帖数字位移设计） |
| **v3.3** NEON 视频版 | 三段制视频优先（keys2 原生关键帧参考链）：高空俯冲→楼隙沉降→入地市集，程序版冻结为 neon-procedural/ 档案。事故教训：低分辨率母图裁剪放大做关键帧=整批视频糊（¥15 损失，已归档 _discarded/neon-blurry-videos/） |
| **v3** 视频优先架构（ASTRA） | 对齐原帖管线：**视频=画面唯一来源**（两段 scrub 覆盖 0–100%），图片降级为海报/静态模式/失败兜底，删除程序化场景引擎 | ✅ 当前形态；教训：视频就位后程序渲染层必须整体退场而非叠加（黑竖条事故） |

## 关键资产

- `astra/assets/`：approach/port/core.png（同轴关键帧，视频首尾帧来源）+ seg1/seg2.mp4（原片）+ seg1/seg2-scrub.mp4（全关键帧 scrub 片）
- `neon/assets/city-tower.png`、`bloom/assets/forest-well.png`：1:3 竖幅剖面全景（v2 引擎主图，也是未来视频关键帧的裁剪来源）
- `_discarded/`：历史素材（废弃视频、ASTRA v2 引擎源码 astra-scene.js.removed）

## 生成管线（复现）

关键帧：Codex CLI 链式生图（`prompts/`，`-i` 参考链保证同轴/一体构图）
视频：MiniMax H3 首尾帧模式（结构化草稿 → H3-Context-IR 扩写 → 2K/6s 生成）→ `ffmpeg -g 1` 全关键帧转码
细节见 ASSETS-SPEC.md 与 INTERACTION-DESIGN.md §3
