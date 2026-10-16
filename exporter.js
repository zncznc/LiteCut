// LiteCut 导出器：把剪映式工程（微秒时间轴）编译成 ffmpeg 命令
// 纯逻辑模块，不依赖 Electron/DOM，可被 selftest.js 直接调用。
const path = require("path");
const os = require("os");
const fs = require("fs");

const sec = (us) => (us / 1e6).toFixed(6);

/* 找一个能用中文的字体（drawtext 需要真实字体文件） */
function findCJKFont() {
  const cands = [
    "C:\\Windows\\Fonts\\msyh.ttc", "C:\\Windows\\Fonts\\msyhbd.ttc",
    "C:\\Windows\\Fonts\\simhei.ttf", "C:\\Windows\\Fonts\\simsun.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  ];
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (_) {} }
  return null;
}
const FONT = findCJKFont();

/* filtergraph 里的路径/文本转义
   注意：ffmpeg 是直接以 argv 启动的，没有 shell 层，所以只需处理
   filter 解析器自己的转义规则 —— 盘符冒号用单反斜杠转义、反斜杠换成正斜杠。 */
function escPath(p) {
  return String(p).replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}
function escText(s) {
  return String(s)
    .replace(/\\/g, "\\\\").replace(/:/g, "\\:")
    .replace(/'/g, "\u2019").replace(/%/g, "\\%").replace(/\n/g, "\\n");
}

const DEFAULT_FPS = 30;
const DEFAULT_W = 1920;
const DEFAULT_H = 1080;

/** 工程总时长（微秒）：所有轨道片段的最右端 */
function projectDuration(p) {
  let end = 0;
  for (const t of p.tracks || []) {
    for (const s of t.segments || []) {
      const e = (s.target_timerange?.start || 0) + (s.target_timerange?.duration || 0);
      if (e > end) end = e;
    }
  }
  return end;
}

function materialOf(p, id) {
  const m = p.materials || {};
  for (const key of ["videos", "audios", "images", "texts", "stickers", "canvases"]) {
    const hit = (m[key] || []).find((x) => x.id === id);
    if (hit) return { ...hit, _kind: key };
  }
  return null;
}

/** 轨道绘制顺序：数组靠后的轨道在上层（与剪映 UI 一致：主轨在最下） */
function orderedTracks(p) {
  const order = { video: 0, text: 1, audio: 2 };
  return (p.tracks || [])
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (order[a.t.type] - order[b.t.type]) || (a.i - b.i))
    .map((x) => x.t);
}

/**
 * 编译导出命令。
 * @returns {{args:string[], durationUs:number, summary:object, outPath:string}}
 */
function buildExport(project, outPath, opts = {}) {
  const W = (project.canvas_config && project.canvas_config.width) || DEFAULT_W;
  const H = (project.canvas_config && project.canvas_config.height) || DEFAULT_H;
  const FPS = project.fps || DEFAULT_FPS;
  const durUs = projectDuration(project);
  const bg = opts.background || (project.canvas_config && project.canvas_config.background) || "black";

  const inputs = [];      // 每个 -i 的参数数组
  const chains = [];      // 滤镜链
  const videoOut = [];    // 视频叠加链
  const audioOut = [];    // 音频流标签
  const summary = { segments: 0, images: 0, texts: 0, audios: 0, durationUs: durUs };

  // 1) 视频层：黑底画布 + 逐个片段叠加
  let base = "base0";
  chains.push(`color=c=${bg}:s=${W}x${H}:r=${FPS}:d=${sec(durUs)},format=rgba[${base}]`);
  let vIdx = 0;

  for (const track of orderedTracks(project)) {
    if (track.type !== "video") continue;
    const segs = [...(track.segments || [])].sort(
      (a, b) => (a.target_timerange?.start || 0) - (b.target_timerange?.start || 0));
    for (const s of segs) {
      if (s.visible === false) continue;
      const mat = materialOf(project, s.material_id);
      if (!mat) continue;
      const kind = mat._kind === "images" ? "image" : "video";
      const tt = s.target_timerange || { start: 0, duration: 0 };
      const st = s.source_timerange || { start: 0, duration: tt.duration };
      const speed = s.speed && s.speed > 0 ? s.speed : 1;
      const alpha = s.clip?.alpha ?? 1;
      const scale = s.clip?.scale || { x: 1, y: 1 };
      const tf = s.clip?.transform || { x: 0, y: 0 };

      const i = inputs.length;
      if (kind === "image") {
        inputs.push(["-loop", "1", "-t", sec(tt.duration), "-i", mat.path]);
        summary.images++;
      } else {
        inputs.push(["-i", mat.path]);
      }

      let f = kind === "image"
        ? `[${i}:v]fps=${FPS}`
        : `[${i}:v]trim=start=${sec(st.start)}:end=${sec(st.start + st.duration)},setpts=PTS-STARTPTS`;
      if (speed !== 1) f += `,setpts=PTS/${speed}`;
      // 画面：按 scale 缩放（保持比例）再居中
      const sw = Math.max(2, Math.round((W * scale.x) / 2) * 2);
      const sh = Math.max(2, Math.round((H * scale.y) / 2) * 2);
      f += `,scale=${sw}:${sh}:force_original_aspect_ratio=decrease`;
      f += `,pad=${sw}:${sh}:(ow-iw)/2:(oh-ih)/2:color=black@0`;
      if (alpha < 1) f += `,format=rgba,colorchannelmixer=aa=${alpha}`;
      f += `,setsar=1,fps=${FPS},format=rgba`;
      // 把片段的 PTS 平移到时间轴位置，overlay 只在区间内生效
      f += `,setpts=PTS+${sec(tt.start)}/TB`;
      const label = `v${vIdx++}`;
      chains.push(`${f}[${label}]`);
      videoOut.push({ label, start: tt.start, end: tt.start + tt.duration, dx: tf.x, dy: tf.y, sw, sh });
      summary.segments++;
    }
  }

  // 2) 叠加链
  let cur = base;
  let oIdx = 0;
  for (const v of videoOut) {
    const next = `ov${oIdx}`;
    const x = `(W-w)/2+${Math.round(v.dx)}`;
    const y = `(H-h)/2+${Math.round(v.dy)}`;
    chains.push(
      `[${cur}][${v.label}]overlay=x=${x}:y=${y}:` +
      `enable='between(t,${sec(v.start)},${sec(v.end)})':eof_action=pass:repeatlast=0[${next}]`);
    cur = next;
    oIdx++;
  }

  // 3) 文字层（drawtext，带时间区间）
  for (const track of orderedTracks(project)) {
    if (track.type !== "text") continue;
    for (const s of [...(track.segments || [])].sort(
      (a, b) => (a.target_timerange?.start || 0) - (b.target_timerange?.start || 0))) {
      if (s.visible === false) continue;
      const mat = materialOf(project, s.material_id);
      if (!mat || !mat.content) continue;
      const tt = s.target_timerange || { start: 0, duration: 0 };
      const size = mat.size || 48;
      const color = (mat.color || "#FFFFFF").replace("#", "");
      const tf = s.clip?.transform || { x: 0, y: 0 };
      const x = `(w-text_w)/2+${Math.round(tf.x)}`;
      const y = `(h-text_h)/2+${Math.round(tf.y)}`;
      const next = `tx${oIdx++}`;
      const fontPart = FONT ? `fontfile='${escPath(FONT)}':` : "";
      chains.push(
        `[${cur}]drawtext=${fontPart}text='${escText(mat.content)}':fontsize=${size}:` +
        `fontcolor=0x${color}:x=${x}:y=${y}:` +
        `enable='between(t,${sec(tt.start)},${sec(tt.start + tt.duration)})'[${next}]`);
      cur = next;
      summary.texts++;
    }
  }

  // 4) 音频层（多段混合）
  const audios = [];
  for (const track of orderedTracks(project)) {
    if (track.type !== "audio" && track.type !== "video") continue;
    for (const s of [...(track.segments || [])].sort(
      (a, b) => (a.target_timerange?.start || 0) - (b.target_timerange?.start || 0))) {
      const mat = materialOf(project, s.material_id);
      if (!mat || mat._kind === "texts" || mat._kind === "images") continue;
      const hasAudio = mat.hasAudio !== false || mat._kind === "audios";
      if (!hasAudio) continue;
      if (track.type === "video" && mat.kind === "video" && !mat.hasAudio) continue;
      const tt = s.target_timerange || { start: 0, duration: 0 };
      const st = s.source_timerange || { start: 0, duration: tt.duration };
      const vol = s.volume ?? 1;
      let i = inputs.findIndex((a) => a[a.length - 1] === mat.path);
      if (i < 0) { inputs.push(["-i", mat.path]); i = inputs.length - 1; }
      const label = `a${audios.length}`;
      const ms = Math.round(tt.start / 1000);
      chains.push(
        `[${i}:a]atrim=start=${sec(st.start)}:end=${sec(st.start + st.duration)},` +
        `asetpts=PTS-STARTPTS,volume=${vol},` +
        `aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
        `adelay=${ms}|${ms}[${label}]`);
      audios.push(label);
      summary.audios++;
    }
  }
  if (audios.length === 1) chains.push(`[${audios[0]}]anull[aout]`);
  else if (audios.length > 1) {
    chains.push(`${audios.map((a) => `[${a}]`).join("")}amix=inputs=${audios.length}:normalize=0:dropout_transition=0[aout]`);
  }

  // 5) 组装命令
  const args = ["-y", "-hide_banner", "-loglevel", "info"];
  for (const inp of inputs) args.push(...inp);
  args.push("-filter_complex", chains.join(";"));
  args.push("-map", `[${cur}]`);
  if (audios.length) args.push("-map", "[aout]", "-c:a", "aac", "-b:a", "192k");
  else args.push("-an");
  args.push("-c:v", "libx264", "-preset", opts.preset || "veryfast", "-crf", String(opts.crf || 20),
    "-pix_fmt", "yuv420p", "-r", String(FPS),
    "-t", sec(durUs), "-movflags", "+faststart",
    "-progress", "pipe:1", "-nostats", outPath);

  return { args, durationUs: durUs, summary, outPath, filter: chains.join(";") };
}

/** 把时间轴的音频混成 16k 单声道 WAV（给语音识别用；时序与时间轴一致）
 *  @returns {string[]|null} ffmpeg 参数，没有音频则返回 null */
function buildAudioExtract(project, outWav) {
  const durUs = projectDuration(project);
  if (!durUs) return null;
  const inputs = [], chains = [], audios = [];
  for (const track of orderedTracks(project)) {
    if (track.type !== "audio" && track.type !== "video") continue;
    for (const s of [...(track.segments || [])].sort(
      (a, b) => (a.target_timerange?.start || 0) - (b.target_timerange?.start || 0))) {
      const mat = materialOf(project, s.material_id);
      if (!mat || mat._kind === "texts" || mat._kind === "images") continue;
      if (mat._kind === "videos" && mat.hasAudio === false) continue;
      if (mat.hasAudio === false && mat._kind !== "audios") continue;
      const tt = s.target_timerange || { start: 0, duration: 0 };
      const st = s.source_timerange || { start: 0, duration: tt.duration };
      let i = inputs.findIndex((a) => a[a.length - 1] === mat.path);
      if (i < 0) { inputs.push(["-i", mat.path]); i = inputs.length - 1; }
      const label = `a${audios.length}`;
      const ms = Math.round(tt.start / 1000);
      chains.push(`[${i}:a]atrim=start=${sec(st.start)}:end=${sec(st.start + st.duration)},` +
        `asetpts=PTS-STARTPTS,volume=${s.volume ?? 1},` +
        `aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${ms}|${ms}[${label}]`);
      audios.push(label);
    }
  }
  if (!audios.length) return null;
  if (audios.length === 1) chains.push(`[${audios[0]}]anull[aout]`);
  else chains.push(`${audios.map((a) => `[${a}]`).join("")}amix=inputs=${audios.length}:normalize=0:dropout_transition=0[aout]`);

  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  for (const inp of inputs) args.push(...inp);
  args.push("-filter_complex", chains.join(";"), "-map", "[aout]",
    "-t", sec(durUs), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", outWav);
  return args;
}

module.exports = { buildExport, buildAudioExtract, projectDuration, materialOf, findCJKFont, escText, escPath, FONT };