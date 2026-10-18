// LiteCut 导出进阶测试：旋转 / 变速音频同步 / 轨道隐藏与静音 / 淡入淡出（画面与字幕）
// 全部靠 ffmpeg 抽帧验像素，不靠"看着对"。
// 用法：node exptest.js
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { buildExport, projectDuration } = require("./exporter");
const { FFMPEG, FFPROBE } = require("./tools");

const W = "C:\\Users\\chaoc\\AppData\\Local\\hermes\\cache\\scratch\\litecut_test";
const SPLIT = path.join(W, "split.mp4");     // 640x360：左半蓝、右半红
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
}
function probe(file) {
  const r = spawnSync(FFPROBE, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
    { encoding: "utf8", maxBuffer: 1 << 22 });
  return JSON.parse(r.stdout);
}
/** 某时刻一帧指定区域的平均 RGB */
function avgRGB(file, atSec, crop) {
  const vf = (crop ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},` : "") + "scale=1:1";
  const r = spawnSync(FFMPEG, ["-v", "error", "-ss", String(atSec), "-i", file, "-frames:v", "1",
    "-vf", vf, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { encoding: "buffer", maxBuffer: 1 << 20 });
  if (r.status !== 0 || !r.stdout || r.stdout.length < 3) return null;
  return [r.stdout[0], r.stdout[1], r.stdout[2]];
}
/** 某时刻一帧里"亮像素"（三通道都 >200，即白字）的个数 */
function brightPixels(file, atSec, w, h, x, y) {
  const r = spawnSync(FFMPEG, ["-v", "error", "-ss", String(atSec), "-i", file, "-frames:v", "1",
    "-vf", `crop=${w}:${h}:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { encoding: "buffer", maxBuffer: 1 << 24 });
  if (r.status !== 0 || !r.stdout) return -1;
  let n = 0;
  for (let i = 0; i < r.stdout.length; i += 3) {
    if (r.stdout[i] > 200 && r.stdout[i + 1] > 200 && r.stdout[i + 2] > 200) n++;
  }
  return n;
}
let pass = 0, fail = 0;
const check = (name, ok, extra = "") => { ok ? pass++ : fail++; console.log("   %s %s %s", ok ? "PASS" : "FAIL", name, extra); };
const canvas = { width: 1920, height: 1080, background: "black", ratio: "16:9" };
const matVideo = (id, p, name, w, h) => ({ id, path: p, name, kind: "video", duration: 3 * US, width: w, height: h, hasVideo: true, hasAudio: false });
const matAudio = (id, p, dur) => ({ id, path: p, name: path.basename(p), kind: "audio", duration: dur, hasAudio: true });
const segVideo = (id, mid, start, dur, clip = {}, extra = {}) => ({
  id, material_id: mid, visible: true, speed: 1, volume: 0,
  target_timerange: { start, duration: dur }, source_timerange: { start: 0, duration: dur },
  clip: { alpha: 1, scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 }, rotation: 0, ...clip }, ...extra,
});
const mkProject = (tracks) => ({
  id: "EXPTEST", name: "导出进阶测试", fps: 30, canvas_config: canvas, materials: {}, tracks,
});

console.log("== 0) 环境 ==");
if (!FFMPEG || !FFPROBE) { console.error("缺 ffmpeg/ffprobe"); process.exit(1); }
console.log("   ffmpeg:", FFMPEG);
fs.mkdirSync(W, { recursive: true });

console.log("== 1) 造素材 ==");
// 左半蓝、右半红：旋转之后"竖切"会变成"横切"，一眼可验
sh(["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=640x360:r=30:d=3",
  "-vf", "drawbox=x=0:y=0:w=320:h=360:color=blue:t=fill",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", SPLIT], "split.mp4（左蓝右红）");
sh(["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=640x360:r=30:d=3",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", RED], "red.mp4");
sh(["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=1280x720:r=30:d=3",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", BLUE], "blue.mp4");
if (!fs.existsSync(TONE)) sh(["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-ac", "1", TONE], "tone.wav");

/* ---------- T1 旋转：竖切 → 横切，且方向与预览（canvas 顺时针）一致 ---------- */
console.log("== 2) T1 旋转 ==");
const outRot0 = path.join(W, "rot0.mp4"), outRot90 = path.join(W, "rot90.mp4");
{
  const p0 = mkProject([{ id: "tk-v", type: "video", name: "主轨", segments: [segVideo("s1", "v1", 0, 2 * US)] }]);
  p0.materials = { videos: [matVideo("v1", SPLIT, "split.mp4", 640, 360)], audios: [], texts: [] };
  const c0 = buildExport(p0, outRot0); sh(c0.args, "导出 rot0");

  const p9 = mkProject([{ id: "tk-v", type: "video", name: "主轨", segments: [segVideo("s1", "v1", 0, 2 * US, { rotation: 90 })] }]);
  p9.materials = p0.materials;
  const c9 = buildExport(p9, outRot90);
  console.log("   滤镜含 rotate:", /rotate=/.test(c9.filter), "| summary.rotations =", c9.summary.rotations);
  sh(c9.args, "导出 rot90");

  const L0 = avgRGB(outRot0, 1.0, { w: 960, h: 1080, x: 0, y: 0 });
  const R0 = avgRGB(outRot0, 1.0, { w: 960, h: 1080, x: 960, y: 0 });
  const T9 = avgRGB(outRot90, 1.0, { w: 1920, h: 540, x: 0, y: 0 });
  const B9 = avgRGB(outRot90, 1.0, { w: 1920, h: 540, x: 0, y: 540 });
  const L9 = avgRGB(outRot90, 1.0, { w: 960, h: 1080, x: 0, y: 0 });
  const R9 = avgRGB(outRot90, 1.0, { w: 960, h: 1080, x: 960, y: 0 });
  console.log("   rot0  左半 %s / 右半 %s", L0, R0);
  console.log("   rot90 上半 %s / 下半 %s", T9, B9);
  console.log("   rot90 左半 %s / 右半 %s", L9, R9);
  check("rot0 左半偏蓝", !!L0 && L0[2] > L0[0] + 40, JSON.stringify(L0));
  check("rot0 右半偏红", !!R0 && R0[0] > R0[2] + 40, JSON.stringify(R0));
  check("rotate 已进滤镜链", /rotate=/.test(c9.filter) && c9.summary.rotations === 1);
  check("rot90 竖切消失（左右半趋同）", !!L9 && !!R9 && Math.abs(L9[2] - R9[2]) < 25, JSON.stringify([L9, R9]));
  check("rot90 变横切（上下半差异明显）", !!T9 && !!B9 && Math.abs(T9[2] - B9[2]) > 60, JSON.stringify([T9, B9]));
  check("rot90 方向=预览语义（左半蓝转到上方）", !!T9 && T9[2] > T9[0] + 40, JSON.stringify(T9));
}

/* ---------- T2 变速：视频加快/放慢时音频必须同步（等时长拉伸） ---------- */
console.log("== 3) T2 变速音频同步 ==");
{
  const mat = (dur) => ({ materials: { videos: [], audios: [matAudio("a1", TONE, dur)], texts: [] } });
  // 2 倍速：源 4s → 时间轴 2s
  const pFast = mkProject([{ id: "tk-a", type: "audio", name: "音频", segments: [
    { id: "s1", material_id: "a1", visible: true, speed: 2, volume: 1,
      target_timerange: { start: 0, duration: 2 * US }, source_timerange: { start: 0, duration: 4 * US } }] }]);
  Object.assign(pFast, mat(4 * US));
  const outFast = path.join(W, "speed2.mp4");
  const cFast = buildExport(pFast, outFast);
  sh(cFast.args, "导出 speed=2");
  const jF = probe(outFast);
  const aF = (jF.streams || []).find((s) => s.codec_type === "audio");
  const durF = parseFloat((jF.format || {}).duration || "0");
  const aDurF = aF ? parseFloat(aF.duration || "0") : 0;
  console.log("   speed=2 → 容器 %.2fs / 音频 %.2fs", durF, aDurF);
  check("speed=2 滤镜含 atempo=2", /atempo=2/.test(cFast.filter));
  check("speed=2 容器时长≈2s", Math.abs(durF - 2) < 0.25, durF.toFixed(2) + "s");
  check("speed=2 音频时长≈2s（与画面同步）", Math.abs(aDurF - 2) < 0.3, aDurF.toFixed(2) + "s");

  // 0.5 倍速：源 1s → 时间轴 2s
  const pSlow = mkProject([{ id: "tk-a", type: "audio", name: "音频", segments: [
    { id: "s1", material_id: "a1", visible: true, speed: 0.5, volume: 1,
      target_timerange: { start: 0, duration: 2 * US }, source_timerange: { start: 0, duration: 1 * US } }] }]);
  Object.assign(pSlow, mat(4 * US));
  const outSlow = path.join(W, "speed05.mp4");
  const cSlow = buildExport(pSlow, outSlow);
  sh(cSlow.args, "导出 speed=0.5");
  const jS = probe(outSlow);
  const aS = (jS.streams || []).find((s) => s.codec_type === "audio");
  const aDurS = aS ? parseFloat(aS.duration || "0") : 0;
  console.log("   speed=0.5 → 音频 %.2fs", aDurS);
  check("speed=0.5 滤镜含 atempo=0.5", /atempo=0\.5/.test(cSlow.filter));
  check("speed=0.5 音频时长≈2s", Math.abs(aDurS - 2) < 0.3, aDurS.toFixed(2) + "s");
}

/* ---------- T3 轨道隐藏：不出画面 ---------- */
console.log("== 4) T3 轨道隐藏 ==");
{
  const p = mkProject([{ id: "tk-v", type: "video", name: "主轨", visible: false, segments: [segVideo("s1", "v1", 0, 1 * US)] }]);
  p.materials = { videos: [matVideo("v1", RED, "red.mp4", 640, 360)], audios: [], texts: [] };
  const out = path.join(W, "hidden.mp4");
  const c = buildExport(p, out);
  sh(c.args, "导出（隐藏轨）");
  const px = avgRGB(out, 0.5);
  console.log("   隐藏轨画面平均色 %s | summary.hiddenTracks=%d", px, c.summary.hiddenTracks);
  check("隐藏轨不出画面（画面为黑）", !!px && px[0] < 40 && px[1] < 40 && px[2] < 40, JSON.stringify(px));
  check("summary 记到隐藏轨", c.summary.hiddenTracks >= 1, String(c.summary.hiddenTracks));
}

/* ---------- T4 轨道静音：掐掉声音 ---------- */
console.log("== 5) T4 轨道静音 ==");
{
  const p = mkProject([
    { id: "tk-v", type: "video", name: "主轨", segments: [segVideo("s1", "v1", 0, 1 * US)] },
    { id: "tk-a", type: "audio", name: "音频", muted: true, segments: [
      { id: "s2", material_id: "a1", visible: true, speed: 1, volume: 1,
        target_timerange: { start: 0, duration: 1 * US }, source_timerange: { start: 0, duration: 1 * US } }] },
  ]);
  p.materials = { videos: [matVideo("v1", RED, "red.mp4", 640, 360)], audios: [matAudio("a1", TONE, 4 * US)], texts: [] };
  const out = path.join(W, "muted.mp4");
  const c = buildExport(p, out);
  sh(c.args, "导出（静音轨）");
  const j = probe(out);
  const a = (j.streams || []).find((s) => s.codec_type === "audio");
  const px = avgRGB(out, 0.5);
  console.log("   音频流: %s | summary.mutedTracks=%d | 画面 %s", a ? a.codec_name : "（无）", c.summary.mutedTracks, px);
  check("静音轨不产生音频流", !a, a ? a.codec_name : "无音频流");
  check("静音轨画面照常（仍偏红）", !!px && px[0] > 120, JSON.stringify(px));
  check("summary 记到静音轨", c.summary.mutedTracks >= 1, String(c.summary.mutedTracks));
}

/* ---------- T5 画面淡入淡出：亮度随时间 ramp ---------- */
console.log("== 6) T5 画面淡入淡出 ==");
{
  const p = mkProject([{ id: "tk-v", type: "video", name: "主轨", segments: [
    segVideo("s1", "v1", 0, 2 * US, {}, { fade: { in: 1 * US, out: 0.5 * US } })] }]);
  p.materials = { videos: [matVideo("v1", RED, "red.mp4", 640, 360)], audios: [], texts: [] };
  const out = path.join(W, "fade.mp4");
  const c = buildExport(p, out);
  sh(c.args, "导出（淡入淡出）");
  const at = (t) => avgRGB(out, t);
  const [f01, f10, f19] = [at(0.1), at(1.0), at(1.9)];
  console.log("   淡入暗 t=0.1s %s → 全亮 t=1.0s %s → 淡出 t=1.9s %s", f01, f10, f19);
  check("滤镜含 fade=t=in", /fade=t=in/.test(c.filter) && c.summary.fades >= 2, "fades=" + c.summary.fades);
  check("t=0.1s 处于淡入（暗）", !!f01 && f01[0] < 70, JSON.stringify(f01));
  check("t=1.0s 已全亮（红）", !!f10 && f10[0] > 150, JSON.stringify(f10));
  check("t=1.9s 处于淡出（暗）", !!f19 && f19[0] < 90 && f19[0] < f10[0], JSON.stringify(f19));
}

/* ---------- T6 字幕淡入：亮像素随时间增多 ---------- */
console.log("== 7) T6 字幕淡入 ==");
{
  const p = mkProject([{ id: "tk-t", type: "text", name: "文字", segments: [
    { id: "s1", material_id: "t1", visible: true, fade: { in: 1 * US, out: 0 },
      target_timerange: { start: 0, duration: 2 * US }, source_timerange: { start: 0, duration: 2 * US },
      clip: { alpha: 1, scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 }, rotation: 0 } }] }]);
  p.materials = { videos: [], audios: [], texts: [{ id: "t1", content: "LiteCut 轻剪 淡入", size: 120, color: "#FFFFFF" }] };
  const out = path.join(W, "textfade.mp4");
  const c = buildExport(p, out);
  sh(c.args, "导出（字幕淡入）");
  const b015 = brightPixels(out, 0.15, 1400, 300, 260, 390);
  const b10 = brightPixels(out, 1.0, 1400, 300, 260, 390);
  console.log("   亮像素 t=0.15s: %d | t=1.0s: %d", b015, b10);
  check("滤镜含 drawtext alpha 表达式", /alpha='/.test(c.filter));
  check("字幕淡入：0.15s 明显暗于 1.0s", b015 >= 0 && b10 > 0 && b10 > Math.max(3 * b015, 200), `${b015} → ${b10}`);
}

/* ---------- T7 片段间转场：真交叉溶解（中途不能变暗） ---------- */
console.log("== 8) T7 转场交叉溶解 ==");
{
  const p = mkProject([{ id: "tk-v", type: "video", name: "主轨", segments: [
    segVideo("s1", "v1", 0, 2 * US),
    { ...segVideo("s2", "v2", 1.5 * US, 2 * US), fade: { in: 0.5 * US, out: 0 } },   // 上层淡入=溶解
  ] }]);
  p.materials = {
    videos: [matVideo("v1", RED, "red.mp4", 640, 360), matVideo("v2", BLUE, "blue.mp4", 1280, 720)],
    audios: [], texts: [],
  };
  const out = path.join(W, "transition.mp4");
  const c = buildExport(p, out);
  sh(c.args, "导出（溶解转场）");
  const before = avgRGB(out, 1.1), mid = avgRGB(out, 1.75), after = avgRGB(out, 2.4);
  console.log("   1.1s %s → 1.75s(中点) %s → 2.4s %s", before, mid, after);
  check("转场前为红", !!before && before[0] > 150 && before[2] < 60, JSON.stringify(before));
  check("中点=红蓝各半（真交叉溶解）", !!mid && mid[0] > 60 && mid[2] > 60 && Math.abs(mid[0] - mid[2]) < 70, JSON.stringify(mid));
  check("中点亮度没掉（不是淡经黑底）", !!mid && mid[0] + mid[1] + mid[2] > 150, JSON.stringify(mid));
  check("转场后为蓝", !!after && after[2] > 150 && after[0] < 60, JSON.stringify(after));
}

/* ---------- T8 关键帧：缩放 + 位移（zoompan 时间表达式） ---------- */
console.log("== 9) T8 关键帧（缩放+位移）==");
{
  const seg = {
    ...segVideo("s1", "v1", 0, 2 * US),
    keyframes: [{ t: 0, x: 0, y: 0, scale: 1 }, { t: 2 * US, x: 500, y: 0, scale: 0.4 }],
  };
  const p = mkProject([{ id: "tk-v", type: "video", name: "主轨", segments: [seg] }]);
  p.materials = { videos: [matVideo("v1", RED, "red.mp4", 640, 360)], audios: [], texts: [] };
  const out = path.join(W, "keyframe.mp4");
  const c = buildExport(p, out);
  console.log("   滤镜含 zoompan:", /zoompan=/.test(c.filter), "| summary.keyframed =", c.summary.keyframed);
  sh(c.args, "导出（关键帧）");
  const full = avgRGB(out, 0.1);
  const cornerLate = avgRGB(out, 1.9, { w: 300, h: 200, x: 20, y: 20 });
  const rightLate = avgRGB(out, 1.9, { w: 400, h: 300, x: 1400, y: 400 });
  console.log("   0.1s 全幅 %s | 1.9s 左上角 %s | 1.9s 右侧 %s", full, cornerLate, rightLate);
  check("zoompan 已进滤镜链", /zoompan=/.test(c.filter) && c.summary.keyframed === 1);
  check("起点满画幅为红", !!full && full[0] > 150, JSON.stringify(full));
  check("缩小后四角变黑（真的在缩）", !!cornerLate && cornerLate[0] < 60, JSON.stringify(cornerLate));
  check("右移后右侧仍有画面", !!rightLate && rightLate[0] > 100, JSON.stringify(rightLate));
}

/* ---------- T9 转场：黑场（中点最暗，不是交叉溶解） ---------- */
console.log("== 10) T9 转场：黑场 ==");
{
  const p = mkProject([{ id: "tk-v", type: "video", name: "主轨", segments: [
    { ...segVideo("s1", "v1", 0, 2 * US), fade: { in: 0, out: 0.5 * US } },
    { ...segVideo("s2", "v2", 1.5 * US, 2 * US), fade: { in: 0.5 * US, out: 0 } },
  ] }]);
  p.materials = {
    videos: [matVideo("v1", RED, "red.mp4", 640, 360), matVideo("v2", BLUE, "blue.mp4", 1280, 720)],
    audios: [], texts: [],
  };
  const out = path.join(W, "fadeblack.mp4");
  const c = buildExport(p, out);
  sh(c.args, "导出（黑场）");
  const before = avgRGB(out, 1.2), mid = avgRGB(out, 1.75), after = avgRGB(out, 2.4);
  const sum = (v) => (v ? v[0] + v[1] + v[2] : -1);
  console.log("   1.2s %s → 1.75s(中点) %s → 2.4s %s", before, mid, after);
  check("黑场两端仍然亮", !!before && sum(before) > 200 && !!after && sum(after) > 200, JSON.stringify([before, after]));
  check("黑场中点明显更暗（≠交叉溶解）", sum(mid) > 0 && sum(mid) < 205, "sum=" + sum(mid));
}

/* ---------- T10 转场：左滑（位移滑入，不是淡化） ---------- */
console.log("== 11) T10 转场：左滑 ==");
{
  const p = mkProject([{ id: "tk-v", type: "video", name: "主轨", segments: [
    segVideo("s1", "v1", 0, 2 * US),
    { ...segVideo("s2", "v2", 1.5 * US, 2 * US), slide: { axis: "x", duration: 0.5 * US } },
  ] }]);
  p.materials = {
    videos: [matVideo("v1", RED, "red.mp4", 640, 360), matVideo("v2", BLUE, "blue.mp4", 1280, 720)],
    audios: [], texts: [],
  };
  const out = path.join(W, "slideleft.mp4");
  const c = buildExport(p, out);
  sh(c.args, "导出（左滑）");
  const left = avgRGB(out, 1.75, { w: 800, h: 600, x: 40, y: 240 });
  const right = avgRGB(out, 1.75, { w: 800, h: 600, x: 1080, y: 240 });
  const mid = avgRGB(out, 1.95), after = avgRGB(out, 2.4);
  console.log("   滑动中点：左 %s / 右 %s ｜ 1.95s %s ｜ 2.4s %s", left, right, mid, after);
  check("滑动中点：左半仍是前段（红）", !!left && left[0] > 120 && left[2] < 80, JSON.stringify(left));
  check("滑动中点：右半是后段（蓝）", !!right && right[2] > 120 && right[0] < 80, JSON.stringify(right));
  check("滑完之后满幅为蓝", !!after && after[2] > 150 && after[0] < 60, JSON.stringify(after));
}

/* ---------- T11 旋转关键帧：角度真的在转 ---------- */
console.log("== 12) T11 旋转关键帧 ==");
{
  const seg = {
    ...segVideo("s1", "v1", 0, 2 * US, {}, {
      keyframes: [{ t: 0, x: 0, y: 0, scale: 1, rotation: 0 },
        { t: 2 * US, x: 0, y: 0, scale: 1, rotation: 180 }],
    }),
  };
  const p = mkProject([{ id: "tk-v", type: "video", name: "主轨", segments: [seg] }]);
  p.materials = { videos: [matVideo("v1", SPLIT, "split.mp4", 640, 360)], audios: [], texts: [] };
  const out = path.join(W, "rotkf.mp4");
  const c = buildExport(p, out);
  console.log("   滤镜含 rotate 表达式:", /rotate='/.test(c.filter), "| keyframed =", c.summary.keyframed);
  sh(c.args, "导出（旋转关键帧）");
  const L0 = avgRGB(out, 0.1, { w: 900, h: 1000, x: 0, y: 40 });
  const R0 = avgRGB(out, 0.1, { w: 900, h: 1000, x: 1020, y: 40 });
  const T1 = avgRGB(out, 1.0, { w: 1800, h: 500, x: 60, y: 0 });
  const B1 = avgRGB(out, 1.0, { w: 1800, h: 500, x: 60, y: 580 });
  const L19 = avgRGB(out, 1.9, { w: 900, h: 1000, x: 0, y: 40 });
  const R19 = avgRGB(out, 1.9, { w: 900, h: 1000, x: 1020, y: 40 });
  console.log("   0.1s 左 %s 右 %s ｜ 1.0s 上 %s 下 %s ｜ 1.9s 左 %s 右 %s", L0, R0, T1, B1, L19, R19);
  check("旋转关键帧进了滤镜链", /rotate='/.test(c.filter));
  check("起点：竖切（左蓝右红）", !!L0 && !!R0 && L0[2] > L0[0] + 40 && R0[0] > R0[2] + 40, JSON.stringify([L0, R0]));
  // 判据用上/下：转到 90° 时竖切变横切（原来的左蓝转到上方）。
  // 不能用"左右相等"来判 —— 90° 时旋转后的画面比画布窄，左右区域各自被裁掉的黑边不同，本来就不相等。
  check("转到 90°：竖切变横切（上蓝下红）", !!T1 && !!B1 && T1[2] > T1[0] + 40 && B1[0] > B1[2] + 40, JSON.stringify([T1, B1]));
  check("转到 ~180°：竖切翻过来（左红右蓝）", !!L19 && !!R19 && L19[0] > L19[2] + 60 && R19[2] > R19[0] + 60, JSON.stringify([L19, R19]));
}

/* ---------- T12 不透明度关键帧（geq 逐帧 alpha） ---------- */
console.log("== 13) T12 不透明度关键帧 ==");
{
  const seg = {
    ...segVideo("s1", "v1", 0, 2 * US, {}, {
      keyframes: [{ t: 0, x: 0, y: 0, scale: 1, alpha: 1 },
        { t: 2 * US, x: 0, y: 0, scale: 1, alpha: 0 }],
    }),
  };
  const p = mkProject([{ id: "tk-v", type: "video", name: "主轨", segments: [seg] }]);
  p.materials = { videos: [matVideo("v1", RED, "red.mp4", 640, 360)], audios: [], texts: [] };
  const out = path.join(W, "alphakf.mp4");
  const t0 = Date.now();
  const c = buildExport(p, out);
  console.log("   滤镜含 geq:", /geq=/.test(c.filter), "| alphaKf =", c.summary.alphaKf);
  sh(c.args, "导出（不透明度关键帧）");
  const enc = ((Date.now() - t0) / 1000).toFixed(1);
  const a01 = avgRGB(out, 0.1), a10 = avgRGB(out, 1.0), a19 = avgRGB(out, 1.9);
  console.log("   0.1s %s → 1.0s %s → 1.9s %s ｜ 编码耗时 %ss（geq 逐帧求值，比常规慢）", a01, a10, a19, enc);
  check("alpha 关键帧走 geq", /geq=/.test(c.filter) && c.summary.alphaKf === 1);
  check("起点不透明（红）", !!a01 && a01[0] > 200, JSON.stringify(a01));
  check("中点约半透明", !!a10 && a10[0] > 60 && a10[0] < 190, JSON.stringify(a10));
  check("末点接近全透明（黑）", !!a19 && a19[0] < 45, JSON.stringify(a19));
}

/* ---------- T13 字幕淡入的时基：片段不从 0 秒开始时不能错位 ---------- */
console.log("== 14) T13 字幕淡入（片段起点 3s） ==");
{
  const p = mkProject([{ id: "tk-t", type: "text", name: "文字", segments: [
    { id: "s1", material_id: "t1", visible: true, fade: { in: 1 * US, out: 0 },
      target_timerange: { start: 3 * US, duration: 2 * US }, source_timerange: { start: 0, duration: 2 * US },
      clip: { alpha: 1, scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 }, rotation: 0 } }] }]);
  p.materials = { videos: [], audios: [], texts: [{ id: "t1", content: "时基校验", size: 140, color: "#FFFFFF" }] };
  const out = path.join(W, "textfade_late.mp4");
  const c = buildExport(p, out);
  sh(c.args, "导出（字幕淡入·晚起点）");
  const early = brightPixels(out, 3.1, 1400, 300, 260, 390);
  const late = brightPixels(out, 4.0, 1400, 300, 260, 390);
  console.log("   亮像素 t=3.1s（淡入 10%%）: %d | t=4.0s（淡入完成）: %d", early, late);
  check("字幕淡入按绝对时间：3.1s 基本没字", early >= 0 && late > 200 && early < late / 3, `${early} → ${late}`);
}

console.log("\n== 结果: %d 通过 / %d 失败 ==", pass, fail);
process.exit(fail ? 1 : 0);