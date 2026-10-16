# tools/whisper —— 语音识别（可选能力）

这个目录里的**二进制与模型不入库**（`.gitignore` 已排除 `Release/` 与 `models/`，共约 535MB）。
缺失时 LiteCut 只是把「🎙 识别时间轴」按钮置灰并提示「缺 whisper / 缺模型」，其它功能不受影响。

## 怎么补齐

```
tools/whisper/
├── Release/                  ← whisper.cpp 预编译包解压到这里（whisper-cli.exe + ggml*.dll）
└── models/
    └── ggml-small.bin        ← 模型（可放多个，界面自动列出）
```

1. **whisper.cpp 预编译（Windows x64）**：取官方 Release 资产 `whisper-blas-bin-x64.zip`
   （https://github.com/ggml-org/whisper.cpp/releases ），把 `Release/` 目录内容放进本目录的 `Release/`。
2. **模型**：放到 `models/`，文件名形如 `ggml-*.bin`，任选其一或全放：

   | 模型 | 大小 | 说明 |
   |---|---|---|
   | `ggml-small.bin` | 488MB | 中文已够用，本项目实测用这个 |
   | `ggml-medium.bin` | 1.5GB | 更稳，稍慢 |
   | `ggml-large-v3.bin` | 3.0GB | 最准，最慢 |

   下载（示例）：
   ```bash
   curl -L -o tools/whisper/models/ggml-small.bin \
     https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
   ```

## 设计要点（代码在 `asr.js`）

- **整条时间轴**的音频按各自时间轴位置混成 16k 单声道后再转写，所以识别出的时间码天然对齐剪辑。
- whisper 会把**前导静音折叠到 0.00s**，本项目实测前导静音长度后把时间码平移回真实位置（`shiftedUs`）。
- 全程本地离线，不联网、不上传音频。