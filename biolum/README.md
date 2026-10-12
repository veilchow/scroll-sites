# NEON DRIFT / 雨夜漫游（v3 · 视频优先架构）

滚动驱动的叙事网站：**视频 = 画面唯一来源**。三段全关键帧 scrub 视频
（`assets/seg1|2|3-scrub.mp4`）按滚动进度 `p ∈ [0,1]` 映射 currentTime，
从高空雨夜云层一路穿云俯冲、落到街面霓虹、再沉入地下市场的心跳——
滚动就是镜头在运动，停止滚动视频即停在当前帧（滚动条即播放器）。

本版对齐已定稿的 ASTRA v3 模式（`../astra/`），由程序化引擎版改造而来；
用户高度认可的程序化形态已完整存档于 **`../neon-procedural/`**
（tag `neon-procedural-v1`，此目录不再改动）。

## 隔离原则（NEON-BLOOM-VIDEO-PLAN §0）

1. **视频呈现期间 canvas 零绘制**：`index.html` 无任何 canvas，`scene.js`
   程序引擎已随视频化退役（存档于 neon-procedural/），不是"降级为兜底继续叠"；
2. **失败兜底 = 海报关键帧静态图**（`assets/keys/k1|k2|k4.png`），不是引擎渲染；
3. **合并白名单默认空**：原 `#fx` 暗角/扫描线叠加层已随程序画面一并移除；
   若日后实测视频雨效偏弱想加轻雨粒子等增强层，须先看片再定、且随时可关；
4. P1 反馈层（`feedback.js` / `audio.js`）**原样保留**：与画面解耦，
   穿越门控 33%/66% 与视频接缝精确对齐（ASTRA 已验证此模式）。

## 运行方法

方式一（本地服务器，推荐——视频走 fetch→Blob URL）：

```bash
cd scroll-sites/neon
python -m http.server 8802
# 浏览器访问 http://127.0.0.1:8802/
```

方式二：直接双击 `index.html`（视频加载失败时自然落到海报兜底，交互照常）。

## 文件结构

```
neon/
├── index.html      结构 + 全部 CSS + UI（#stage：海报底层 + vid1/2/3 + #fade；
│                   首屏 hero 版式；无 canvas）
├── biolum-video.js   v3 视频画面层（三段制）：加载/scrub/seek 节流合并/显影/
│                   接缝交叉淡化/漫游连播/海报兜底（logic 纯函数可桩测）
├── app.js          交互外壳：阻尼进度、rAF 单循环（无引擎渲染）、UI/DOM、
│                   漫游（视频连播优先，45s 匀速兜底）、舞台微颤、RM 静态模式
├── feedback.js     P1 反馈层（未改动）：计量 HUD 状态机、穿越时刻动画、待机提示
├── audio.js        P1 声音系统（未改动）：WebAudio 全合成三床音床/sting/UI 音/静音
├── test/video.test.js      视频层桩测试（映射连续/接缝权重/兜底海报/漫游连播）
├── test/feedback.test.js   P1 反馈层桩测试（scene.js 依赖已随引擎退役移除）
├── README.md       本文件
└── assets/
    ├── seg1|seg2|seg3-scrub.mp4   三段全关键帧 scrub 片（主 URL）
    ├── seg1|seg2|seg3.mp4         普通压缩版（8s 预算内的备用 URL）
    └── keys/k1|k2|k3|k4.png       章界关键帧（1792×1008）：海报/静态模式/失败兜底
```

## 图层 z 序（#stage 内）

| z | 元素 | 职责 |
|---|---|---|
| 1 | `#poster`（img，cover） | 首屏第一印象（视频就绪前显影前）→ 失败兜底关键帧 → RM 静态模式 |
| 2 | `#vid1 / #vid2 / #vid3`（cover） | 画面主体：三段 scrub 视频，接缝窗口内交叠交叉淡化 |
| 5 | `#fade` | RM 静态模式章节切换过场（非 RM 不参与） |
| — | `#flash`（fixed，z 15） | P1 穿越时刻色温脉冲（cool/warm） |

`#stage` 之上是 UI 层（topbar/titles/rail/hud/hint 等，z≥20，挂 `.ui` 类，
H/Esc 口播模式随 `body.ui-hidden` 隐藏）。舞台微颤与穿越 `shake`/`bio-pulse`
以 transform/filter 作用于 `#stage` 整体（含视频）。

## 三段映射参数表（biolum-video.js）

| 参数 | 值 | 说明 |
|---|---|---|
| `SPANS` | `[0,0.33] / [0.33,0.66] / [0.66,1.0]` | 段界 = 章界 = 视频关键帧事件 |
| `SEAM1` | `[0.315, 0.345]` | 33% 接缝交叉淡化窗（seg1 尾帧 ≡ seg2 首帧 = k2 构图） |
| `SEAM2` | `[0.645, 0.675]` | 66% 接缝交叉淡化窗（seg2 尾帧 ≡ seg3 首帧 = k3 构图） |
| 段权重 | `w1=1−s1`、`w2=s1·(1−s2)`、`w3=s2` | 两窗不相交 ⇒ **任意时刻三段权重和恒 1**（无黑帧/过曝） |
| `PRELOAD_AT` | seg1 立即 / seg2 `p>0.15` / seg3 `p>0.45` | fetch → Blob URL；scrub 版失败重试普通压缩版（8s 总预算） |
| `SEEK_EPS` | `1/48 s` | seek 节流阈值（24fps 半帧）；seeking 期间只记 want、seeked 后补差 |
| `REVEAL_MS` | `400 ms` | 就绪后海报→视频显影交叉淡化 |
| scrub | 恒 `muted` + `paused` + currentTime 跟随阻尼进度 | 不可见段 `display:none` 停止解码 |
| 漫游 | 三段 `unmuted` 顺序连播接管节奏 | 视频时长即漫游时长；中断立即回 scrub+muted+seek |
| 失败兜底 | 海报按**覆盖段**切 `k1/k2/k4` | 非覆盖段失败不提前切（避免海报与所在区间不符） |

进度 → currentTime 映射：`segTime(p) = clamp((p−span[0])/(span[1]−span[0]),0,1) · duration`。
接缝两侧锁定同一构图关键帧：0.329→0.331 时 seg1 距尾 / seg2 距首的归一化余量
互补（≈3e-3，6s 片长下 ≈18ms，SEAM1 因相邻段宽相等精确互补；SEAM2 相邻段宽
0.33/0.34，互补差 <1ms），配合权重互补交叉淡化——无跳变、无黑帧。

## 交互（全部保留）

| 操作 | 行为 |
|---|---|
| 滚轮 / 触摸 / 拖动滚动条 | 连续 scrub 视频（4.5 阻尼缓动，停滚即停）；快滚有 HUD 数字加速、音床更呼啸、舞台微颤 |
| 首屏 hero「▶ 开始自动漫游」 | 视频三段 unmuted 连播接管漫游节奏（= hero CTA 接真实行为） |
| 首屏 hero「滚动接管 · 继续下落 ↓」 | 平滑滑翔到第二章落点 0.36 |
| 导航「高空 / 街面 / 地下」 | 平滑滚动到落点 **0.02 / 0.36 / 0.70**（各章越过接缝后的稳定位），tick 音 |
| 进度条点击 | 按点击位置比例滑翔跳转 |
| 空格 或「▶ 自动漫游」 | 漫游播放/暂停（先 1s 回卷到起点；任意滚轮/触摸/方向键立即中断） |
| H 或 Esc | 隐藏/恢复全部 UI（口播模式，画面与声音继续） |
| M 或「♪ 音效」钮 | 全局静音（漫游视频原声跟随） |
| ↑↓ / PageUp/Down / Home/End | 滚动 |
| 停留 3 秒 | 底部呼吸提示（按章变化，任何输入立即隐藏） |
| 系统开启「减少动态」 | 静态模式：`#poster` 在 **k1/k2/k4** 三关键帧间淡切换（#fade 过场），模块禁用、漫游禁用、无微震无 sting |

## 首屏 hero（ASTRA v3.1 模式）

第一章标题升级为 hero：kicker「BIOLUM · 蓝眼泪」+ 大标题「雨落下来，
城市才醒。」+ 副标 + 双 CTA（开始自动漫游 / 滚动接管·继续下落↓，均接真实
行为）+ 元信息行（三章旅程 · 海拔 480M · 建议开启声音）。标题窗（JS 淡入淡出）：

| 章 | 进入 | 退出 | 说明 |
|---|---|---|---|
| ch1 hero | 0%（即完整可见） | 0.16–0.30 | 0% 即现，滚动后随节奏淡出 |
| ch2 | 0.36–0.44 | 0.60–0.66 | 0.36 导航落点后进入，第二接缝前退场 |
| ch3 | 0.72–0.80 | 驻留到终点 | 0.70 导航落点后进入 |

窄屏（≤720px）：`#titles` 上移到 9vh 顶部起始（`align-content:start`），
hero 副标/CTA/元信息压缩字号，不与左下 HUD、底部提示、右侧进度条碰撞。

## rAF 主循环（app.js，无引擎渲染）

```
loop(now):
  1 readTarget()            滚动 → 目标进度
  2 tourTick(dt)            漫游：视频连播优先（tourSync 驱动 scrollTo），否则匀速兜底
  3 阻尼插值 curP            4.5 指数缓动（停滚即停）
  4 Vid.update(curP)        视频模块：显影/权重/seek/预载/兜底海报
  5 syncUI(curP)            进度条/导航/标题窗/提示
  6 fxFrame(dt, curP)       P1：速度平滑 → audio 喂参、章界穿越（33%/66%）、HUD、待机
  7 舞台微颤                 speedSm → #stage transform（sin/cos 摆动，停滚即停）
```

## 模块接口

```
BIOVID.logic               纯函数：SPANS/SEAM/segTime/w1-w3/seamSum/tourP/coveringSeg/…
BIOVID.init({reduced})     缓存 DOM、装载 seg1；reduced → 模块禁用
BIOVID.update({p,touring,tourPaused})   每帧喂阻尼进度（scrub/显影/预载/兜底海报）
BIOVID.tourSync(p)         漫游：返回视频接管的进度（null = 回匀速兜底）
BIOVID.onTourEnd()         漫游中断：立即 pause+muted+seek 回当前进度
BIOVID.setMuted(m)         全局静音跟随（漫游原声）
BIOFX.* / BIOSND.*        P1 反馈层与声音系统（与程序版完全一致，未改动）
```

## 自查

```bash
node --check app.js biolum-video.js audio.js feedback.js test/video.test.js test/feedback.test.js
node test/video.test.js       # 84 项：映射连续/接缝权重和恒 1/兜底海报按覆盖段/漫游三段连播
node test/feedback.test.js    # P1：插值端点 / 章界去重 / AudioContext 手势前不创建
python -m http.server 8817    # neon/ 与 neon-procedural/ 首页 200；DOM 标记：
                              # poster + vid1-3 + hero CTA；无 <canvas>、无 scene.js 引用
```

## 已知限制 / 备注

- **视频生成中**：`assets/seg*.mp4` 由 MiniMax-H3 管线产出（规格同 ASTRA：
  首尾帧 2K/6s → ffmpeg 1792 宽全关键帧转码）。模块按路径引用，缺哪段哪段
  落海报兜底，不影响其余段与其余交互。
- 视频时长即漫游时长（三段 ≈18s，短于程序版 45s 匀速漫游——漫游节奏以
  视频为准；仅在视频不可用时回落 45s 匀速）。
- 直接 file:// 打开时 fetch 受限 → 走海报静态兜底（交互与反馈层照常）。
- 漫游视频原声在首次用户手势前可能被自动播放策略拒绝（playFail）→ 该段
  回匀速漫游，不阻塞行程。
- `prefers-reduced-motion` 模式切换（系统级）触发页面重载，保证视频模块
  干净禁用（astra v3 同款处理）。
