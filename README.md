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

快捷键：`空格` 播放/暂停 · `S` 在播放头分割 · `Del` 删除 · `T` 加文字 · `Ctrl+Z/Y` 撤销/重做 · `Ctrl+S` 保存工程。

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

**界面冒烟** `npx electron smoke.js` — 24/24：

```
PASS preload 桥可用        PASS ffmpeg 已定位        PASS 初始 2 条轨道
PASS 画布 1920x1080        PASS 注入后 3 轨 4 片段
PASS t=1s 预览偏红 [254,0,0]   PASS t=3s 预览偏蓝 [0,15,255]   PASS 视频元素就绪
PASS 分割 1→2 段           PASS 撤销回 1 段          PASS 删除生效
PASS SRT 解析出 2 条       PASS 导入后字幕列表 2 行  PASS SRT 往返文本一致
PASS SRT 头部时间码正确    PASS 批量生成按行+标点断句 PASS 批量生成从播放头起
PASS 预览里字幕可见(亮像素 6263)  PASS 截图非黑屏     PASS 渲染进程无报错
```

截图见 `screenshot.png`。

---

## 六、已知边界（诚实说明）

- 预览用同一个 `<video>` 元素池按活动片段播放：**同一素材在同一时刻被多个片段引用**时，预览只按最后一次设置生效（导出不受影响，导出对每段独立取流）。
- 旋转在预览与导出都支持，但导出侧是绕画面中心旋转（透明填充），不是剪映那种框选自由变换。
- 无 GPU 特效 / 转场 / 关键帧动画 / 抠像 / 美颜 / 云端素材（这些正是剪映的重资产部分）。
- 时间轴拖动仅支持同轨移动与两端裁剪，没有波纹删除、磁吸整轨、片段分组。

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
| `selftest.js` / `smoke.js` | 端到端自测 / 界面冒烟（都带真实断言） |
| `screenshot.png` | 冒烟测试截取的真实界面 |

MIT License.