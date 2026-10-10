# 素材规范与升级指南（ASSETS-SPEC）

三个滚动叙事网站的场景层目前为**纯程序化 Canvas 绘制**；每个站点都预留了 **AI 关键帧海报槽位**，放入图片即自动升级为「AI 定格层 + 程序动效层」的混合渲染。本文档是素材管理与升级的唯一规范。

## 1. 槽位与命名（严格一致）

| 站点 | 章节一 | 章节二 | 章节三 |
|---|---|---|---|
| [astra/](astra/) 星云接近/环绕对接/核心点亮 | `astra/assets/poster-1.png` | `astra/assets/poster-2.png` | `astra/assets/poster-3.png` |
| [neon/](neon/) 高空/街面/地下 | `neon/assets/poster-1.png` | `neon/assets/poster-2.png` | `neon/assets/poster-3.png` |
| [bloom/](bloom/) 地表/伞下/深处 | `bloom/assets/poster-1.png` | `bloom/assets/poster-2.png` | `bloom/assets/poster-3.png` |

- 尺寸建议：16:9 横幅（≥1792×1024），CSS 以 `object-fit:cover` 铺满视口，更大无损
- 格式：PNG（JPG 也可，但文件名保持 `poster-N.png` 不变）
- 文件缺失时 `onerror` 静默隐藏，站点自动退回纯程序化渲染，不会报错

## 2. 各站点的消费方式（升级后画面如何混合）

| 站点 | 海报出现时机 | 混合方式 |
|---|---|---|
| astra | 停驻在章节定格点时淡入为定格底层，滚动即淡出 | 海报为底，Canvas 星尘/光效叠上 |
| neon | 按章节权重全程淡入淡出 | 海报为底，Canvas 霓虹以 `mix-blend-mode:screen` 叠印 |
| bloom | 默认仅静态模式（reduced-motion）显示；常规模式需开启（见 §3） | 海报为底，Canvas 荧光粒子叠上 |

## 3. BLOOM 常规模式开启海报底层

`bloom/index.html` 中把 poster 的默认 `display:none / opacity:0` 样式放开（README「AI 关键帧」一节有精确位置），海报即在常规旅程中全程作为背景层。

## 4. 素材生产流程（已验证）

1. **提示词**：`image-brief.md` 是 9 张图的完整艺术指导（风格锚定/构图/禁区），可直接复用或改写换主题
2. **生成**：本地 Codex CLI（`codex exec`，工作目录为本目录，提示词走 stdin），需求书即 image-brief.md
   - 备选通道：StepFun `step-image-edit-2` / `step-2x-large`（注意：官方公告 2026-10-10 下线；密钥在 `../.env`，严禁外传）
3. **落盘**：按 §1 命名放入对应 `assets/`，浏览器强刷（Ctrl+F5）即生效
4. **验收**：浏览器滚动至 0% / 50% / 97% 三档检查海报与程序层叠加效果、接缝处无闪跳

## 5. 目录结构

```
scroll-sites/
├── index.html          # hub 导航页（http://127.0.0.1:8890/）
├── ASSETS-SPEC.md      # 本文档
├── image-brief.md      # 9 张关键帧的生图需求书
├── astra/  { index.html, js/, assets/, README.md }
├── neon/   { index.html, scene.js, app.js, assets/, README.md }
└── bloom/  { index.html, bloom-scenes.js, bloom-app.js, assets/, README.md }
```

各站 `README.md` 含运行方法、设计说明、章节结构与关键帧接入细节；`gen_posters.py` 为 StepFun 备选通道脚本（可留作参考）。
