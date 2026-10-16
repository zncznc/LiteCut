// LiteCut 端到端自测：造素材 → 建剪映式工程 → 真跑 ffmpeg 导出 → 抽帧验像素
// 用法：node selftest.js
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");
const { buildExport, projectDuration } = require("./exporter");
const { FFMPEG, FFPROBE } = require("./tools");

const W = "C:\\Users\\chaoc\\AppData\\Local\\hermes\\cache\\scratch\\litecut_test";
const OUT = path.join(W, "out.mp4");
const RED = path.join(W, "red.mp4");
const BLUE = path.join(W, "blue.mp4");
const TONE = path.join(W, "tone.wav");
const US = 1e6;

function sh(args, label) {
  const r = spawnSync(FFMPEG, args, { encoding: "buffer" });
  if (r.status !== 0) {
    console.error("!! " + label + " 失败\n" + (r.stderr || "").toString().slice(-1500));
    process.exit(1);
  }
  console.log("   ok " + label);
}

/** 取某时刻一帧的平均 RGB（1x1 缩放后用 rawvideo 读 3 字节） */
function sampleRGB(file, atSec) {
  const r = spawnSync(FFMPEG, ["-v", "error", "-ss", String(atSec), "-i", file,
    "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { encoding: "buffer", maxBuffer: 1 << 20 });
  if (r.status !== 0 || !r.stdout || r.stdout.length < 3) return null;
  return [r.stdout[0], r.stdout[1], r.stdout[2]];
}

/** 取某时刻一帧指定区域的原始像素（不做缩放，用于逐像素统计） */
function sampleRaw(file, atSec, w, h, x, y) {
  const r = spawnSync(FFMPEG, ["-v", "error", "-ss", String(atSec), "-i", file, "-frames:v", "1",
    "-vf", `crop=${w}:${h}:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { encoding: "buffer", maxBuffer: 1 << 24 });
  return (r.status === 0 && r.stdout) ? r.stdout : null;
}
/** 统计区域里"亮像素"（三通道都 > 200，即白色字幕）的个数 */
function countBrightPixels(file, atSec, w, h, x, y) {
  const buf = sampleRaw(file, atSec, w, h, x, y);
  if (!buf) return -1;
  let n = 0;
  for (let i = 0; i < buf.length; i += 3) {
    if (buf[i] > 200 && buf[i + 1] > 200 && buf[i + 2] > 200) n++;
  }
  return n;
}

function probe(file) {
  const r = spawnSync(FFPROBE, ["-v", "error", "-print_format", "json",
    "-show_format", "-show_streams", file], { encoding: "utf8", maxBuffer: 1 << 22 });
  return JSON.parse(r.stdout);
}

console.log("== 0) 环境 ==");
console.log("   ffmpeg :", FFMPEG);
console.log("   ffprobe:", FFPROBE);
if (!FFMPEG || !FFPROBE) { console.error("缺 ffmpeg/ffprobe"); process.exit(1); }
fs.mkdirSync(W, { recursive: true });

console.log("== 1) 造测试素材 ==");
sh(["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=640x360:r=30:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", RED], "red.mp4 3s");
sh(["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=1280x720:r=30:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", BLUE], "blue.mp4 3s");
sh(["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-ac", "1", TONE], "tone.wav 4s");

console.log("== 2) 建剪映式工程（微秒时间轴）==");
const project = {
  id: "SELFTEST-0001", name: "自测工程", fps: 30, version: 360000, new_version: "144.0.0",
  canvas_config: { width: 1920, height: 1080, background: "black", ratio: "16:9" },
  materials: {
    videos: [
      { id: "v-red", path: RED, name: "red.mp4", kind: "video", duration: 3 * US, width: 640, height: 360, hasVideo: true, hasAudio: false },
      { id: "v-blue", path: BLUE, name: "blue.mp4", kind: "video", duration: 3 * US, width: 1280, height: 720, hasVideo: true, hasAudio: false },
    ],
    audios: [{ id: "a-tone", path: TONE, name: "tone.wav", kind: "audio", duration: 4 * US, hasAudio: true }],
    texts: [{ id: "t1", content: "LiteCut 轻剪 自测", size: 96, color: "#FFFFFF" }],
  },
  tracks: [
    { id: "tk-v", type: "video", segments: [
      { id: "s1", material_id: "v-red", target_timerange: { start: 0, duration: 2 * US }, source_timerange: { start: 0, duration: 2 * US }, speed: 1, volume: 0, clip: { alpha: 1, scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 } } },
      { id: "s2", material_id: "v-blue", target_timerange: { start: 2 * US, duration: 2 * US }, source_timerange: { start: 0, duration: 2 * US }, speed: 1, volume: 0, clip: { alpha: 1, scale: { x: 0.5, y: 0.5 }, transform: { x: 0, y: 0 } } },
    ] },
    { id: "tk-a", type: "audio", segments: [
      { id: "s3", material_id: "a-tone", target_timerange: { start: 0, duration: 4 * US }, source_timerange: { start: 0, duration: 4 * US }, volume: 0.6 },
    ] },
    { id: "tk-t", type: "text", segments: [
      { id: "s4", material_id: "t1", target_timerange: { start: 0.5 * US, duration: 3 * US }, clip: { transform: { x: 0, y: 380 } } },
    ] },
  ],
};
console.log("   总时长: " + (projectDuration(project) / US).toFixed(2) + "s");

console.log("== 3) 编译并跑 ffmpeg 导出 ==");
const { args, summary, filter } = buildExport(project, OUT);
console.log("   片段: %d 视频 / %d 图 / %d 文字 / %d 音频",
  summary.segments, summary.images, summary.texts, summary.audios);
console.log("   滤镜链长度: %d 字符", filter.length);
sh(args, "ffmpeg 导出");

console.log("== 4) 验证产物 ==");
const j = probe(OUT);
const fmt = j.format || {}, v = (j.streams || []).find((s) => s.codec_type === "video"), a = (j.streams || []).find((s) => s.codec_type === "audio");
const dur = parseFloat(fmt.duration || "0");
console.log("   容器: %s | 时长 %.2fs | 大小 %s",
  path.basename(fmt.format_name || "?"), dur, fmt.size);
console.log("   视频: %sx%s fps=%s codec=%s", v && v.width, v && v.height, v && v.r_frame_rate, v && v.codec_name);
console.log("   音频: %s ch=%s rate=%s", a && a.codec_name, a && a.channels, a && a.sample_rate);

const t1 = sampleRGB(OUT, 1.0), t3 = sampleRGB(OUT, 3.0);
console.log("   t=1.0s 平均色: %s  ← 期望偏红", t1);
console.log("   t=3.0s 平均色: %s  ← 期望偏蓝(0.5 缩放在黑底上)", t3);

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => { ok ? pass++ : fail++; console.log("   %s %s %s", ok ? "PASS" : "FAIL", name, extra); };
check("产物存在且非空", fs.existsSync(OUT) && fs.statSync(OUT).size > 10000, fs.existsSync(OUT) ? fs.statSync(OUT).size + "B" : "");
check("时长≈4s", Math.abs(dur - 4) < 0.35, dur.toFixed(2) + "s");
check("分辨率 1920x1080", v && v.width === 1920 && v.height === 1080);
check("有音频轨", !!a);
check("t=1s 偏红", !!t1 && t1[0] > 120 && t1[0] > t1[2] + 60, JSON.stringify(t1));
check("t=3s 偏蓝", !!t3 && t3[2] > t3[0] + 20, JSON.stringify(t3));

// 字幕：文字层 y=+380（字幕带）→ 画面底部应出现白色文字像素
const band = countBrightPixels(OUT, 1.5, 900, 160, 510, 860);
const noneBand = countBrightPixels(OUT, 3.75, 900, 160, 510, 860);
console.log("   字幕带亮像素 t=1.5s: " + band + " | t=3.75s(字幕窗之外): " + noneBand);
check("字幕已烧进画面", band > 100, "亮像素 " + band);
check("字幕时间窗之外无字幕", noneBand >= 0 && noneBand < Math.max(1, band / 3), "亮像素 " + noneBand);
console.log("\n== 结果: %d 通过 / %d 失败 ==", pass, fail);
console.log("产物: " + OUT);
process.exit(fail ? 1 : 0);