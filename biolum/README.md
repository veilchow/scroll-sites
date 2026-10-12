# 蓝眼泪 / BIOLUMINESCE（v1 · 视频优先架构，neon 模板派生）

滚动驱动的叙事网站：**视频 = 画面唯一来源**。三段全关键帧 scrub 视频
（`assets/seg1|2|3-scrub.mp4`）按滚动进度 `p ∈ [0,1]` 映射 currentTime——
从橙粉黄昏的海边小镇出发，等来夜幕落下时第一道「蓝眼泪」浪，看整片海
苏醒发光，最后纵身破水、潜进一片会游泳的星河。滚动就是追光者的脚步与
视线，停止滚动视频即停在当前帧（滚动条即播放器）。

由稳定模板 `../neon/`（tag `astra-neon-v4-stable`）复制派生 + 全量题材化：
交互骨架/漫游机制/主循环铠甲/16 项稳定性资产**行为零改动**，只替换内容层
（文案/色板/HUD 计量/音床/sting/图标编舞）。设计终值见
`../biolum-plan/PLAN-DESIGN.md` 与 `PLAN-INTEGRATION.md`（项目侧文档）。

## 隔离原则

1. **视频呈现期间 canvas 零绘制**：`index.html` 无任何 canvas、无程序渲染；
2. **失败兜底 = 海报关键帧静态图**（`assets/keys/k1|k2|k4.png`），不是引擎渲染；
3. **P1 反馈层（`feedback.js` / `audio.js`）与画面解耦**：穿越门控 33%/66%
   与视频接缝精确对齐（模板已验证的解耦模式），题材化只发生在内容层；
4. 色彩纪律（全站最高法）：深蓝底 `#03121f` + 青绿荧光 `#3df0c8`，
   暖橙 `#ff9e6d` 仅三处语义点（抵达文案+和弦 / 翻牌背面 / T2 暖闪），
   全站禁紫色、禁品红（与 NEON 站拉开一眼可辨的差异）。

## 运行方法

方式一（本地服务器，推荐——视频走 fetch→Blob URL）：

```bash
cd scroll-sites/biolum
python -m http.server 8818
# 浏览器访问 http://127.0.0.1:8818/
```

方式二：直接双击 `index.html`（视频加载失败时自然落到海报兜底，交互照常）。

## 文件结构

```
biolum/
├── index.html      结构 + 全部 CSS + UI（#stage：海报底层 + vid1/2/3 + #fade；
│                   首屏 hero 版式；无 canvas）
├── biolum-video.js   v3 视频画面层（三段制）：加载/scrub/seek 节流合并/显影/
│                   接缝交叉淡化/漫游连播/海报兜底（logic 纯函数可桩测）
├── app.js          交互外壳：阻尼进度、rAF 单循环（无引擎渲染）、UI/DOM、
│                   漫游（视频连播优先，45s 匀速兜底）、舞台微颤、RM 静态模式
├── feedback.js     P1 反馈层（已题材化）：潮汐时钟/发光指数/爆发等级/深度计
│                   四计量状态机、双筒望远镜收起编舞、爆发等级翻牌、
│                   双态温度、破水 71.7% 激活、待机提示
├── audio.js        P1 声音系统（已题材化）：黄昏/夜海/水下三床 WebAudio 合成、
│                   T1 点亮 / T2 骤闷双 sting、UI 音、静音
├── test/video.test.js      视频层桩测试（映射连续/接缝权重/兜底海报/漫游连播）
├── test/feedback.test.js   P1 反馈层桩测试（D-HUD 数值断言）
├── README.md       本文件
└── assets/
    ├── seg1|seg2|seg3-scrub.mp4   三段全关键帧 scrub 片（主 URL）
    ├── seg1|seg2|seg3.mp4         普通压缩版（8s 预算内的备用 URL）
    └── keys/k1|k2|k3|k4.png       章界关键帧：海报/静态模式/失败兜底
                                    （单一 keys/ 目录——RM 静态模式与视频海报同源）
```

## 图层 z 序（#stage 内）

| z | 元素 | 职责 |
|---|---|---|
| 1 | `#poster`（img，cover） | 首屏第一印象（视频就绪前显影前）→ 失败兜底关键帧 → RM 静态模式 |
| 2 | `#vid1 / #vid2 / #vid3`（cover） | 画面主体：三段 scrub 视频，接缝窗口内交叠交叉淡化 |
| 5 | `#fade` | RM 静态模式章节切换过场（非 RM 不参与） |
| — | `#flash`（fixed，z 15） | P1 穿越时刻色温脉冲（cool=夜幕初光 / warm=破水 / deep=破水峰值 71.7%） |

`#stage` 之上是 UI 层（topbar/titles/rail/hud/hint 等，z≥20，挂 `.ui` 类，
H/Esc 口播模式随 `body.ui-hidden` 隐藏）。舞台微颤与穿越 `shake`/`bio-pulse`
以 transform/filter 作用于 `#stage` 整体（含视频）。

## 三段映射参数表（biolum-video.js，全部继承模板）

| 参数 | 值 | 说明 |
|---|---|---|
| `SPANS` | `[0,0.33] / [0.33,0.66] / [0.66,1.0]` | 段界 = 章界 = 视频关键帧事件 |
| `SEAM1` | `[0.315, 0.345]` | 33% 接缝交叉淡化窗（seg1 尾帧 ≡ seg2 首帧 = k2 构图，藏在第一道荧光浪峰值内） |
| `SEAM2` | `[0.645, 0.675]` | 66% 接缝交叉淡化窗（seg2 尾帧 ≡ seg3 首帧 = k3 构图，藏在俯冲起点上） |
| `XFADE_S` | `0.45 s` | 漫游接缝交叠时长（timeupdate 驱动，后台免疫；NEON 实测 434/448ms 基线） |
| 段权重 | `w1=1−s1`、`w2=s1·(1−s2)`、`w3=s2` | 两窗不相交 ⇒ **任意时刻三段权重和恒 1**（无黑帧/过曝） |
| `PRELOAD_AT` | seg1 立即 / seg2 `p>0.15` / seg3 `p>0.45` | fetch → Blob URL；scrub 版失败重试普通压缩版（8s 总预算） |
| `SEEK_EPS` | `1/48 s` | seek 节流阈值（24fps 半帧）；seeking 期间只记 want、seeked 后补差 |
| `REVEAL_MS` | `400 ms` | 就绪后海报→视频显影交叉淡化 |
| scrub | 恒 `muted` + `paused` + currentTime 跟随阻尼进度 | 不可见段 `display:none` 停止解码 |
| 漫游 | 三段 `unmuted` 顺序连播接管节奏 | 视频时长即漫游时长；中断立即回 scrub+muted+seek |
| 失败兜底 | 海报按**覆盖段**切 `k1/k2/k4` | 非覆盖段失败不提前切（避免海报与所在区间不符） |

进度 → currentTime 映射：`segTime(p) = clamp((p−span[0])/(span[1]−span[0]),0,1) · duration`。
接缝两侧锁定同一构图关键帧（k2=夜海初光 / k3=海面全亮），配合权重互补
交叉淡化——无跳变、无黑帧。

## HUD 计量（D-HUD，feedback.js 纯核心可桩测）

| 计量器 | 生效区间 | 数值区间 | 联动 |
|---|---|---|---|
| 潮汐时刻 | 0–33%（CH1 主） | 19:42 → 21:17（满潮定格） | 分钟数线性插值 + HH:MM 格式化（95 分钟压缩进 0–33%） |
| 追光步速 | 0–33%（CH1 副） | 0 → 88 步/分 | `min(88, 27·√(速度×13.5))`——公式继承零改动，仅换量纲标签 |
| 发光指数 | 33–66%（CH2 主） | 0% → 100% | 线性插值整数百分比；满潮 21:17 ✓ 角标常驻 |
| 爆发等级 | 33–66%（CH2 副） | Ⅰ SPARK → Ⅴ SEA OF LIGHT | 阈值 20/40/60/80 跳变（非累加计数） |
| 水下深度 | 66–100%（CH3 主） | 0.0 → 8.0 m | p≥71.7% 破水激活走数（灰待命→点亮+深青 flash）；停滚 ±0.1m 悬浮呼吸漂移 |
| 双态温度 | T2 破水伴随 | 气温 22° → 水温 18° | 500ms 延迟 + 900ms 数字滚动（RM 瞬时） |

穿越时刻：**T1 夜幕初光 @33%**（sting 点亮 + 冷青 flash + 微震 + 潮汐时钟
翻滚退场 + 双筒望远镜收起编舞 land→folded）；**T2 破水入水 @66%**（sting
骤闷 + 暖橙 flash + 微震 + 发光指数退场 + 爆发等级翻牌 Ⅰ→Ⅴ + 温度滚动）；
**破水峰值 @71.7%**（深度计点亮 + 深青 flash）。门控 33%/66% 位置与滞回
±1.5% 继承模板。

## 交互（键位与轨道全部继承）

| 操作 | 行为 |
|---|---|
| 滚轮 / 触摸 / 拖动滚动条 | 连续 scrub 视频（4.5 阻尼缓动，停滚即停）；快滚有 HUD 数字加速、音床更涌、舞台微颤 |
| 导航「黄昏 / 夜海 / 水下」 | 平滑滚动到落点 **0.02 / 0.36 / 0.70**（各章越过接缝后的稳定位），tick 音 |
| 进度条点击 | 按点击位置比例滑翔跳转（33%/66% 刻度=章界） |
| 空格 或「▶ 自动漫游」 | 漫游播放/暂停（先 1s 回卷到起点；任意滚轮/触摸/方向键立即中断） |
| H 或 Esc | 隐藏/恢复全部 UI（口播模式，画面与声音继续） |
| M 或「♪ 音效」钮 | 全局静音（漫游视频原声跟随） |
| ↑↓ / PageUp/Down / Home/End | 滚动 |
| 停留 3 秒 | 底部呼吸提示（按章变化，任何输入立即隐藏） |
| 系统开启「减少动态」 | 静态模式：`#poster` 在 **k1/k2/k4** 三关键帧间淡切换（#fade 过场），模块禁用、漫游禁用、无微震无 sting |

## 首屏 hero

kicker「蓝眼泪 · BIOLUMINESCE · 追光一夜」+ 大标题「听说，海今晚会发光。」
+ 副标（滚动即追光——…停下，浪也为你停。）+ 元信息行（三章 · 满潮 21:17 ·
自动漫游见右下 · 建议开启声音）。0% 即完整可见（模板机制），标题窗（JS
淡入淡出）：

| 章 | 进入 | 退出 | 说明 |
|---|---|---|---|
| ch1 hero | 0%（即完整可见） | 0.16–0.30 | 0% 即现，滚动后随节奏淡出 |
| ch2 | 0.36–0.44 | 0.60–0.66 | 0.36 导航落点后进入，第二接缝前退场 |
| ch3 | 0.72–0.80 | 驻留到终点 | 0.70 导航落点后进入 |

窄屏（≤720px）：`#titles` 上移到 9vh 顶部起始（`align-content:start`），
hero 副标/元信息压缩字号，不与左下 HUD、底部提示、右侧进度条碰撞。

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

主循环铠甲 + 心跳看门狗（可见时 1.5s 复活）、事件驱动漫游、惯性磁吸
（REST=0/⅓/⅔/1 四关键帧停靠点）等 16 项稳定性资产行为零改动
（清单见 PLAN-INTEGRATION §2）。

## 模块接口

```
BIOVID.logic               纯函数：SPANS/SEAM/segTime/w1-w3/seamSum/tourP/coveringSeg/…
BIOVID.init({reduced})     缓存 DOM、装载 seg1；reduced → 模块禁用
BIOVID.update({p,touring,tourPaused})   每帧喂阻尼进度（scrub/显影/预载/兜底海报）
BIOVID.tourSync(p)         漫游：返回视频接管的进度（null = 回匀速兜底）
BIOVID.onTourEnd()         漫游中断：立即 pause+muted+seek 回当前进度
BIOVID.setMuted(m)         全局静音跟随（漫游原声）
BIOFX.core                 纯函数：tideAt/fmtTide/glowAt/burstAt/depthAt/vspeedOf/
                           chapterOf/pad2/makeTransitDetector（Node 桩测试对象）
BIOFX.init/update/transit/onActivity   DOM HUD 驱动（app.js 调用）
BIOSND.*                   三床音床 + 双 sting + UI 音 + 静音/生命周期
```

## 自查

```bash
node --check app.js biolum-video.js audio.js feedback.js test/video.test.js test/feedback.test.js
node test/video.test.js       # 84 项：映射连续/接缝权重和恒 1/兜底海报按覆盖段/漫游三段连播
node test/feedback.test.js    # D-HUD：潮汐/发光/等级/深度插值端点 / 章界去重 / 手势前不建 AudioContext
python -m http.server 8818    # biolum/ 首页与全部资源 200；DOM 标记：
                              # poster + vid1-3 + hero + loading + 四计量 HUD
grep -rn "NEON" .             # 应零命中（模板残留验收）
```

## 已知限制 / 备注

- `assets/seg*.mp4` 由 MiniMax-H3 管线产出（首尾帧 2K/6s → ffmpeg 1792 宽
  `-g 1` 全关键帧双轨转码）。模块按路径引用，缺哪段哪段落海报兜底，
  不影响其余段与其余交互。
- 视频时长即漫游时长（三段 ≈18s；仅视频不可用时回落 45s 匀速）。
- 直接 file:// 打开时 fetch 受限 → 走海报静态兜底（交互与反馈层照常）。
- 漫游视频原声在首次用户手势前可能被自动播放策略拒绝（playFail）→ 该段
  回匀速漫游，不阻塞行程。
- `prefers-reduced-motion` 模式切换（系统级）触发页面重载，保证视频模块
  干净禁用（astra v3 同款处理）。
- 破水峰值位 `DEPTH_ON=0.717` 是 v3 片内 t≈1.0s 的确定性映射
  （0.66+0.34×(1.0/6)）；若日后换片，按成片破水帧实际时刻校准后锁定。
