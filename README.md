# LiteCut 轻剪

一个**模仿剪映核心工作流**的桌面视频剪辑器：Electron + 原生 JS + ffmpeg。
工程数据模型直接沿用剪映（CapCut / JianyingPro）的 `draft_content.json` 字段体系。

> 说明：剪映是商业闭源软件，本项目的目标不是复制它的二进制，而是**按它的交互范式与工程数据模型，
> 做一个能真正跑起来的同类 App**。功能范围是可运行的 MVP（导入 / 多轨时间轴 / 画面合成 / 文字 /
> 速度 / 音量 / 分割 / 撤销 / 导出），不含它的云端素材库、AI 模型（抠像/美颜）和 GPU 特效。

---

## 一、对剪映安装包的分析结论（本项目的依据）

对象：`Jianying_8334474951210_installer.exe`（2,868,872 B）
SHA256 `9ac945243b81b8bc08d496b460c07566dcdbf6e3783c0b9679c5a3d5b1f3f347`

| 项目 | 结论 |
|---|---|
| 文件类型 | PE32 GUI，Intel i386，**NSIS-3 Unicode 自解压**（非完整安装包） |
| 数字签名 | **有效**，主体 `CN=深圳市脸萌科技有限公司, O=…, L=深圳市, S=广东省`（统一社会信用代码 9144030008867405X2），时间戳 Sectigo R37 |
| 实际载荷 | 解包只有 5 个文件：`$PLUGINSDIR/{BgWorker.dll, downloader_nsis_plugin.dll, shell_downloader.dll, System.dll, res.zip}` —— **它只是个下载器**，真程序联网拉取 |
| 安装界面 | `res.zip` 内 48 个资源：DuiLib 风格 XML 布局（`resource/install_v2.xml` 664×549 窗口、`logo_2x.png`、按钮四态图）+ `lang/zh-CN.json` + `i18n.json` |
| 下载/上报域名 | `mcs-v2-boot.capcutapi.com`、`mcs.zijieapi.com`、`mcs.bytedance.net`、`mcs.byteoversea.net`（配置下发）、`editor-api-sg.capcut.com/service/2/{app_alert_check,desktop/device_register}/`、`lv-api.ulikecam.com`；`shell_downloader.dll` 内嵌 libcurl |
| 安装行为（日志） | `VideofusionInstaller/src/{JIanyingInstaller,JianyingInstallPack}`（Conan 构建的 C++ 安装器）；静默参数 `/s /create_desktop=1 /enable_right_click_menu=1 /enable_file_association=1`；载荷 `app_package_*.exe` 860 MB（901,853,504 B）内存映射解包；默认装到 `D:\JianyingPro` |
| GPU 能力门控 | `EnvDetect.json` 按显卡型号逐项开关：H.264/HEVC 硬编解、D3D11 计算着色器、单纹理、视频解码/渲染、Qt 硬件渲染（如 `8086_3e98` 一项 8 个开关） |
| 本机残留（`AppData\Local\JianyingPro`，441 MB） | 本地 AI 模型：`tt_matting_video_gru`、`saliency_matting`、`tt_freid_v2.0`、`aed40_10m`（抠像/显著性等）；`Cache/GeckoCpp/.../image_lynx_videocutpc_guide`（**Lynx** 跨端 UI 框架，模块名 `videocutpc`）；`MMKV/settings_json`；`Projects/com.lveditor.cloud.draft_*`；草稿目录由 `Config/LocalDraftFolder` 指定 |

### 拿到的真实工程数据模型（`draft_content.json`，82 KB，来自 `D:\Program Files (x86)\CapCut Drafts\0924\`）

- 顶层 35 键：`canvas_config{width,height,ratio,background}`、`duration`（**微秒**，如 506300000）、`fps`（30.0）、`version`(360000)/`new_version`("144.0.0")、`materials`、`tracks`、`keyframes`、`config`、`platform`…
- `materials` 50 个子集合：`videos` / `audios` / `texts` / `images` / `canvases` / `speeds` / `audio_fades` / `beats` / `material_animations` / `material_colors` / `vocal_separations` / `sound_channel_mappings` / `transitions` / `effects` / `chromas` / `masks`…
- `tracks[i]` = `{id, type, name, attribute, flag, is_default_name, segments[]}`，类型 `video|audio|text`
- `segments[j]` = `{id, material_id, target_timerange{start,duration}, source_timerange{start,duration}, clip{alpha,flip,rotation,scale{x,y},transform{x,y}}, extra_material_refs[], enable_* 能力位, common_keyframes[]}`

LiteCut 的模型就是这套字段的**子集**（同样的微秒时间轴、同样的 `materials/tracks/segments/clip` 命名），
所以工程文件与剪映草稿在结构上同构，便于日后做导入/导出适配。

---

## 二、怎么跑

```bash
npm install          # 已装好：electron 33
npm start            # 打开 LiteCut 轻剪
npm run selftest     # 纯逻辑端到端：造素材 → 编译 ffmpeg → 导出 → 抽帧验像素
npm run exptest      # 导出进阶：旋转方向 / 变速音频同步 / 轨道隐藏静音 / 淡入淡出
npm run subtest      # 字幕模块单测（SRT/VTT 解析生成、自动打轴）
npm run asrtest      # 语音识别端到端（需先备好语音文件和 whisper 模型）
npm run smoke        # 界面冒烟：真启动窗口 → 注入素材 → 校验预览像素 → 截图
```

依赖：Node ≥ 18、**ffmpeg/ffprobe**（自动在 PATH、winget 安装目录、`C:\ffmpeg\bin` 中查找）。

语音识别为可选能力，缺失时界面会提示「缺 whisper / 缺模型」，其余功能不受影响：

```
tools/whisper/Release/whisper-cli.exe   ← whisper.cpp 预编译包（Release 资产 whisper-blas-bin-x64.zip）
tools/whisper/models/ggml-small.bin     ← 模型，可换 ggml-medium.bin / ggml-large-v3.bin（界面自动列出）
```

---

## 三、界面与操作（对齐剪映的习惯）

```
┌──────────────── 顶栏：导入媒体 / 打开 / 保存 / 导出 ────────────────┐
│ 媒体库        │        预览（1920×1080 画布）      │ 属性│字幕 页签 │
│ 双击=加主轨   │  播放/暂停 · 进度 · 缩放            │ 缩放/位置/旋转 │
│ 拖拽=任意轨道 │                                     │ 不透明度/速度  │
│               │                                     │ 音量/文字      │
├───────────────────── 时间轴（多轨 + 播放头）──────────────────────┤
│ 主轨 / 画中画 / 文字 / 音频 / 字幕 · 拖动移动 · 边缘裁剪 · 吸附 · 分割 │
└──────────────────────────────────────────────────────────────────┘
```

快捷键：`空格` 播放/暂停 · `S` 在播放头分割 · `Del` 删除（留空）· `Shift+Del` 波纹删除 · `T` 加文字 · `Ctrl+Z/Y` 撤销/重做 · `Ctrl+S` 保存工程。

### 轨道与片段（2026-10-16 补齐）

| 能力 | 说明 |
|---|---|
| 轨道头开关 | 轨道名右侧两个按钮：**👁 显示/隐藏**（隐藏 = 画面与声音都不出）、**🔊 静音**（只掐声音，画面照常）；隐藏或静音时该轨在时间轴上变暗 |
| 波纹删除 | 删掉选中片段并把**同轨其后片段整体左移**，补上腾出的时长（剪映的默认手感）；原「删除留空」也保留 |
| 淡入/淡出 | 属性面板给片段设「淡入(秒)/淡出(秒)」，线性 ramp；**画面与字幕预览、导出同一套语义** |
| 暂停拖播放头 | 暂停状态下拖时间轴/拖进度条，各片段元素会 seek 到对应源时间再重画，**画面真的跟到那一刻** |
| 同一素材多实例 | 同一素材被多个片段同时引用时，各片段**各用各的播放元素**（源时间/变速/音量/静音互不干扰） |
| 旋转一致性 | 预览与导出都绕**片段中心**旋转、四周透明（导出侧 `rotate` 已按 canvas 旋向实测校准） |

### 转场（2026-10-18）

选中一个片段 → 选类型与时长 → 点 **⇄ 转场**；**⇄✕ 去转场** 会把重叠与受影响的淡入淡出**原样还原**（不吞你设过的值）。

| 类型 | 做法 | 判据（测试怎么验的） |
|---|---|---|
| 叠化 dissolve | 后段左移 D 重叠 + 只让**上层淡入** D（前者保持不透明）| 中点 = 红蓝各半且总亮度不掉（= 真正的交叉溶解，不是淡经黑底）|
| 黑场 fadeblack | 后者淡入 D **且** 前者在自己的尾巴上淡出 D | 中点总亮度明显更低（实测 194 vs 叠化 256）|
| 左滑 / 上滑 | 后段在前 D 秒内**从画布外滑到位**（位移表达式，不动 alpha）| 中点：左半仍是前段、右半已是后段 |

为什么"只让上层淡入"就是交叉溶解：上层 B 以 alpha=a 覆盖不透明的 A，得到 `a*B + (1-a)*A`，这**正是** cross-dissolve 的定义；若前者也淡出，前半段会同时向黑底淡出、中点亮度掉一截（那是错的做法）。

> 边界：转场目前**只作用于画面**，音频不做交叉淡化；且加转场会把后段左移（总时长随之变短），这与剪映的默认行为一致，去掉转场会把重叠还回去。

### 关键帧（2026-10-18）

`seg.keyframes = [{ t(片段内相对微秒), x, y, scale, rotation, alpha }]`，线性插值；属性面板 **◆ 记录** 按钮在播放头处写一个关键帧（未给的字段取当前插值，不会跳），列表里可逐条删除。

| 属性 | 导出实现 | 说明 |
|---|---|---|
| 位置 X/Y | overlay 的 `x`/`y` **时间表达式** | 早期版本把位移交给 zoompan 的窗口坐标，会被钳制在输入范围内 → 位移一大就"预览动了导出没动"，已修 |
| 缩放 | `zoompan` 的 `z` 表达式（以最小缩放为静态基准，z≥1）| 实测 zoompan 保留 alpha，不会用黑底盖住下层轨道 |
| 旋转 | `rotate` 的 `angle` 表达式 + **最大绝对角**的静态包围盒 | `ow/oh` 不接受时间变量，所以包围盒取最大角，保证任何角度都不裁切 |
| 不透明度 | `geq` 逐帧 alpha（`a='clip(255*(expr),0,255)'`，时间变量是**大写 T**）| 实测比常规编码慢约 9 倍（2s/1080p：6.8s），所以**只在真的用了不透明度关键帧时**才走这条路；只有 2 个点的话用「淡入/淡出」更划算 |

### 多选与成组（2026-10-18）

`Ctrl/⌘/Shift + 点击`加减选；拖动多选中的任一片段会**整体移动**（多选时不做边缘裁剪，避免同时改多个源范围）；**⧉ 成组** 把选中的片段打上 `group_id`，之后点选任一片段即选中整组，**⧉✕ 解组** 解除。

### 字幕（右侧「字幕」页签）

| 功能 | 说明 |
|---|---|
| 导入 SRT / VTT | 解析后按时间码落到「字幕」轨；容忍 BOM、CRLF、缺序号、`<i>` 等标签、多行文本 |
| 导出 SRT | 把时间轴上的字幕条导出成标准 SRT（`HH:MM:SS,mmm`） |
| 批量生成 | 文本框粘台词，**每行一条**；单行长句按 `。！？；，` 断句，可设「每行字数」与「总时长秒」（0 = 按每字 0.28s 朗读速度估算），从**播放头**开始铺 |
| 播放头处一条 | 在当前播放头插入一条 2 秒字幕 |
| 字幕列表 | 逐条显示 `序号 / 起止时间 / 时长`，点行=跳到该时刻，行内直接改文字，✕ 删除 |
| 样式 | 默认 54px 白色、位置在画面下方 34%（剪映字幕的常规位置）；选中该片段后可在「属性」页签调字号/颜色/位置/不透明度 |

字幕在预览与导出里走的是同一套文字层（预览用 canvas `fillText`，导出用 ffmpeg `drawtext`），所以**所见即所得**。

> **已实现（2026-10-16 补齐）**：按音频自动识别字幕 —— 走本地 **whisper.cpp**（`tools/whisper/`）。
> 「🎙 识别时间轴」会把**整条时间轴的音频**混成 16k 单声道（时序与时间轴一致），再转写成字幕落回「字幕」轨；
> 实测 9 秒中文语音用 `small` 模型在 CPU 上 **3.7 秒**转完，识别结果逐字正确。
> 下图的 `small` 模型 488MB，想更准可换 `medium`/`large-v3`（放进 `tools/whisper/models/` 即可，界面自动列出来）。
> 注意：whisper 会把**前导静音折叠成 0.00s**，本项目实测前导静音长度后把时间码平移回真实位置（`shiftedUs`）。

---

## 四、导出是怎么做到的

`exporter.js` 把工程编译成**一条 ffmpeg filtergraph**（不落中间文件，一次编码）：

1. `color=c=<背景>:s=WxH:r=fps:d=<总时长>` 作底；
2. 每个视频片段：`trim` 取源区间 → `setpts` 处理变速 → `scale/pad` 到画布 → `colorchannelmixer=aa` 处理不透明度 → `setpts=PTS+起点/TB` 平移到时间轴位置；
3. 逐段 `overlay=…:enable='between(t,起,止)'` 叠加（轨道顺序 = 图层顺序，画中画在上）；
4. 文字用 `drawtext`（带 `enable` 时间窗，自动找中文字体 `msyh.ttc`/`simhei.ttf`）；
5. 音频逐段 `atrim/volume/adelay` 后 `amix`；
6. 输出 `libx264 veryfast crf20 + aac 192k + faststart`，`-progress pipe:1` 回报进度。

---

## 五、验证（都是真跑出来的结果）

**导出引擎自测** `node selftest.js` — 8/8：

```
片段: 2 视频 / 0 图 / 1 文字 / 1 音频      滤镜链 1062 字符
容器: mov,mp4 时长 4.00s  大小 141918B
视频: 1920x1080 fps=30/1 codec=h264      音频: aac ch=2 rate=48000
t=1.0s 平均色 [255,2,4]  ← 红片段
t=3.0s 平均色 [2,0,99]   ← 蓝片段（0.5 缩放居中在黑底）
字幕带亮像素 t=1.5s: 17432 | t=3.75s(字幕窗之外): 0   ← 字幕确实烧进了画面，且时间窗准确
PASS 8 / FAIL 0
```

**导出进阶** `node exptest.js` — 44/44（旋转方向 / 变速音频同步 / 轨道开关 / 淡入淡出 / 转场 4 型 / 关键帧 3 属性 / 字幕时基）：

```
T1 旋转     左蓝右红源片：rot0 左半蓝右半红 → rot90 竖切变横切（上红下蓝，与预览 canvas 旋向一致）
T2 变速     speed=2 → 容器 2.00s / 音频 2.00s（atempo=2）；speed=0.5 → 音频 1.97s（atempo=0.5）
T3 隐藏轨   画面平均色 [1,0,2]（完全不出画面）· summary.hiddenTracks=1
T4 静音轨   无音频流，画面照常偏红 [255,0,1] · summary.mutedTracks=1
T5 淡入淡出 t=0.1s [24,0,0] → t=1.0s [255,0,1] → t=1.9s [49,0,0]
T6 字幕淡入 亮像素 t=0.15s: 0 → t=1.0s: 25095
T7 叠化转场 1.1s 红 → 1.75s 中点 [118,0,138]（红蓝各半、亮度不掉）→ 2.4s 蓝
T8 关键帧位移+缩放 0.1s 满幅红 [253,0,0] → 1.9s 左上角黑 [2,0,2]、右侧仍有画面 [253,0,0]
T9 黑场转场 中点 sum=194（比叠化的 256 明显暗，两端仍亮）
T10 左滑转场 中点 左 [252,0,0] / 右 [1,0,253]（真的是滑进来的，不是淡化）
T11 旋转关键帧 0.1s 左蓝右红 → 1.0s 上蓝下红（90°）→ 1.9s 左红右蓝（≈180°）
T12 不透明度关键帧 0.1s [241,0,2] → 1.0s [128,0,0] → 1.9s [11,0,0]（走 geq，本机 2s/1080p 编码 6.8s）
T13 字幕淡入时基 片段起点 3s：3.1s 亮像素 0 → 4.0s 24856（按绝对时间，不再错位）
```

**字幕模块单测** `node subtest.js` — 20/20（时间换算、SRT/VTT 解析与生成、往返一致、多行/长句自动打轴、空输入与杂乱输入不崩）。

**语音识别端到端** `node asrtest.js` — 11/11（真实中文语音 → 时间轴抽音频 → whisper 转写 → 时间码对齐）：

```
模型 ggml-small.bin(488MB) · 输入 8.8s 中文语音（Windows SAPI Huihui 合成）
用时 3.7s | cue 数 2 | 前导静音回补 0.647s
转写全文: 今天我们做一个视频剪辑工具,它可以导入素材,然后把字幕自动加到画面上。
[1] 0.65s → 5.78s  今天我们做一个视频剪辑工具,它可以导入素
[2] 5.78s → 9.65s  材,然后把字幕自动加到画面上。
PASS 11 / FAIL 0
```

**界面冒烟** `npx electron smoke.js` — 52/52：

```
PASS preload 桥可用        PASS ffmpeg 已定位        PASS 初始 2 条轨道
PASS 画布 1920x1080        PASS 注入后 3 轨 4 片段
PASS t=1s 预览偏红 [254,0,0]   PASS t=3s 预览偏蓝 [0,15,255]   PASS 视频元素就绪
PASS 分割 1→2 段           PASS 撤销回 1 段          PASS 删除生效
PASS SRT 解析出 2 条       PASS 导入后字幕列表 2 行  PASS SRT 往返文本一致
PASS SRT 头部时间码正确    PASS 批量生成按行+标点断句 PASS 批量生成从播放头起
PASS 预览里字幕可见(亮像素 6263)  PASS 截图非黑屏     PASS 渲染进程无报错
PASS 轨道头有 显示/静音 两个开关    PASS 隐藏主轨后预览变黑 [0,0,0]   PASS 恢复显示后预览回红 [254,0,0]
PASS 静音开关可切换      PASS 暂停拖播放头画面跟到 3s [0,15,255]   PASS seek 后元素时间码跟随源时间
PASS 同素材多实例各自独立元素  PASS 波纹删除：后续片段左移到 0s   PASS 属性面板有淡入/淡出输入
PASS 预览淡入：0.1s 暗于 1.0s    PASS 波纹删除有状态提示
PASS 转场类型下拉有 4 种        PASS 左滑转场：位移轴=x 且不动 alpha   PASS 预览滑动中点：左红右蓝
PASS 去转场后重叠与位移都还原    PASS 黑场转场：前者淡出 0.5s + 后者淡入 0.5s
PASS 关键帧记录含 rotation/alpha 字段   PASS 关键帧插值：旋转≈45° 透明度≈0.575
PASS 预览按不透明度关键帧变暗    PASS 属性面板显示关键帧列表
```

截图见 `screenshot.png`。

---

## 六、已知边界（诚实说明）

- ~~预览用同一个 `<video>` 元素池，同一素材同刻被多段引用时只按最后一次设置生效~~ **已修**：元素改为按**片段**缓存，各段源时间/变速/音量/静音互不干扰。
- 旋转在预览与导出都支持（绕片段中心、四周透明、已按 canvas 旋向实测校准），但不是剪映那种框选自由变换。
- **音频淡入淡出还没做**：画面与字幕的淡入淡出已做且两侧一致；音频侧导出没有 `afade`、预览也没有 WebAudio 增益包络——宁缺勿滥，不做只在一侧生效的半套。
- **转场只作用于画面**：音频不做交叉淡化（同上：做不符就不做）。且加转场会把后段左移、总时长变短（与剪映默认一致）。
- **不透明度关键帧走 geq，明显更慢**：本机 2s/1080p 从 0.3s 变成 6.8s（约 9 倍）。只有 2 个点就用「淡入/淡出」；多点才用关键帧。
- **字幕不支持旋转**：`drawtext` 没有旋转变换，预览侧也就一致地不做（避免出现"预览转了、导出没转"的半套）。
- 无 GPU 特效 / 抠像 / 美颜 / 云端素材（这些正是剪映的重资产部分）。
- 时间轴拖动仅支持同轨移动与两端裁剪；已有波纹删除、吸附、多选与片段成组，但没有整轨磁吸、波纹插入。

---

## 七、文件清单

| 文件 | 作用 |
|---|---|
| `main.js` / `ipc.js` | 主进程：窗口 + 全部 IPC（文件对话框、探测、工程读写、导出执行） |
| `preload.js` | contextBridge 安全桥 |
| `index.html` / `styles.css` / `renderer.js` | 界面：媒体库、画布预览合成、时间轴、属性面板、播放时钟 |
| `exporter.js` | 工程 → ffmpeg filtergraph 编译器（纯函数，可独立测试） |
| `subtitle.js` | 字幕：SRT/VTT 解析与生成、长文本自动打轴（纯函数；浏览器端挂 `window.LCSub`） |
| `asr.js` | 语音识别：时间轴音频抽取、whisper 调用、前导静音回补、模型发现 |
| `tools/whisper/` | whisper.cpp 预编译（`Release/whisper-cli.exe` + DLL）与 `models/ggml-small.bin`（488MB，可替换） |
| `subtest.js` / `asrtest.js` | 字幕模块单测 / 语音识别端到端测试 |
| `tools.js` | ffmpeg/ffprobe 定位 |
| `selftest.js` / `exptest.js` / `smoke.js` | 端到端自测 / 导出进阶（旋转·变速·轨道开关·淡入淡出）/ 界面冒烟（都带真实断言） |
| `screenshot.png` | 冒烟测试截取的真实界面 |

---

## 八、打包（2026-10-18）

```bash
npm i -D electron-builder --registry=https://registry.npmmirror.com   # 直连 npmjs 会 ECONNRESET
npm run dist                                                          # = electron-builder --win nsis
```

产物在 `dist/`：`LiteCut Setup <版本>.exe`（NSIS 安装包）+ `win-unpacked/`（免安装目录）。
安装包为非 oneClick、可改安装目录、自动建桌面与开始菜单快捷方式。

网络慢/被墙时给构建器指定镜像（实测可用）：

```bash
export ELECTRON_BUILDER_BINARIES_MIRROR="https://registry.npmmirror.com/-/binary/electron-builder-binaries/"
export ELECTRON_MIRROR="https://registry.npmmirror.com/-/binary/electron/"
```

`build.files` 是**白名单**，只放运行必需的 11 个文件；**whisper 二进制与模型（约 535MB）刻意不进包**：
打包版里「🎙 识别时间轴」会置灰并提示缺 whisper/缺模型，其它功能不受影响。
要在打包版里启用语音识别，二选一：把 `tools/whisper/` 与模型放到应用目录旁（`asr.js` 按相对路径找），
或改成 `extraResources` 打进包内——代价是安装包体积 +535MB，所以默认没做。

MIT License.