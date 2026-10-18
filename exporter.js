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

/** 变速片段要把音频拉回目标时长。atempo 单段限 0.5~2，超出就串联（覆盖 0.25x~4x）。 */
function atempoChain(speed) {
  let s = speed;
  const parts = [];
  while (s > 2) { parts.push("atempo=2"); s /= 2; }
  while (s < 0.5) { parts.push("atempo=0.5"); s /= 0.5; }
  parts.push(`atempo=${s.toFixed(6)}`);
  return parts.join(",");
}

/** 淡入/淡出的 alpha 表达式（绝对时间轴秒）。
 *  视频走 fade 滤镜、字幕走 drawtext 的 alpha、不透明度关键帧走 geq —— 三条路都用这一份时基，
 *  否则字幕片段不在 0 秒开始时会错位（早期的相对时基版本就有这个坑）。 */
function fadeAlphaExprAbs(startUs, durUs, inUs, outUs, base = 1, tVar = "t") {
  const s = (us) => (us / 1e6).toFixed(6);
  const parts = [];
  if (inUs > 0) parts.push(`min(1,max(0,(${tVar}-${s(startUs)})/${s(inUs)}))`);
  if (outUs > 0) parts.push(`min(1,max(0,((${s(startUs + durUs)}-${tVar})/${s(outUs)})))`);
  if (!parts.length) return base !== 1 ? String(base) : null;
  const e = parts.join("*");
  return base !== 1 ? `(${e})*${base}` : e;
}

/** 淡入/淡出的 alpha 表达式（与预览同一语义：线性 ramp，时间基于片段自身）。
 *  @returns {string|null} 无淡入淡出时返回 null；base 为片段本来的不透明度 */
function fadeAlphaExpr(durationUs, fade, base = 1) {
  const f = fade || {};
  const din = (f.in || 0) / 1e6, dout = (f.out || 0) / 1e6, dur = durationUs / 1e6;
  const terms = [];
  if (din > 0) terms.push(`min(1,max(0,t/${din.toFixed(6)}))`);
  if (dout > 0) terms.push(`min(1,max(0,((${dur.toFixed(6)}-t)/${dout.toFixed(6)})))`);
  if (!terms.length) return null;
  const expr = terms.join("*");
  return base !== 1 ? `(${expr})*${base.toFixed(4)}` : expr;
}

/** 关键帧的分段线性时间表达式。
 *  @param tVar  在表达式里代表时间的变量：zoompan 用 it（片段自身时间轴），overlay 用 t（输出时间轴）
 *  @param offsetSec 片段起点在时间轴上的秒数：tVar=t 时必须给，否则关键帧时刻会错位 */
function kfExpr(kfs, field, tVar = "it", offsetSec = 0) {
  const n = (v) => String(Number(v));
  const k = kfs;
  const T = (us) => (offsetSec + us / 1e6).toFixed(6);
  let expr = n(k[k.length - 1][field]);
  for (let i = k.length - 1; i >= 1; i--) {
    const a = k[i - 1], b = k[i];
    const ta = T(a.t), tb = T(b.t), dt = ((b.t - a.t) / 1e6).toFixed(6);
    const seg = Number(dt) > 0
      ? `(${n(a[field])}+(${n(b[field])}-${n(a[field])})*(${tVar}-${ta})/${dt})`
      : n(b[field]);
    expr = `if(lte(${tVar},${tb}),${seg},${expr})`;
  }
  return `if(lte(${tVar},${T(k[0].t)}),${n(k[0][field])},${expr})`;
}

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

/** 轨道隐藏：不出画面，也不出声音 */
const trackHidden = (t) => !!t && t.visible === false;
/** 轨道静音：只掐声音，画面照常 */
const trackMuted = (t) => !!t && t.muted === true;

/**
 * 编译导出命令。
 * @returns {{args:string[], durationUs:number, summary:object, outPath:string, filter:string}}
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
  const summary = {
    segments: 0, images: 0, texts: 0, audios: 0,
    rotations: 0, fades: 0, hiddenTracks: 0, mutedTracks: 0, keyframed: 0, durationUs: durUs,
  };

  // 1) 视频层：黑底画布 + 逐个片段叠加
  let base = "base0";
  chains.push(`color=c=${bg}:s=${W}x${H}:r=${FPS}:d=${sec(durUs)},format=rgba[${base}]`);
  let vIdx = 0;

  for (const track of orderedTracks(project)) {
    if (track.type !== "video") continue;
    if (trackHidden(track)) { summary.hiddenTracks++; continue; }
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
      const rot = s.clip?.rotation || 0;
      const fade = s.fade || {};

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
      // 画面尺寸：走了关键帧就以"最小缩放值"为静态基准，动画交给 zoompan（zoompan 的 zoom 只能 ≥1）
      const kfList = Array.isArray(s.keyframes) && s.keyframes.length
        ? [...s.keyframes].sort((a, b) => a.t - b.t) : null;
      const kfMin = kfList ? Math.max(0.05, Math.min(...kfList.map((k) => k.scale))) : 1;
      // 关键帧里只要出现过该字段，就按关键帧插值（缺该字段的帧回落到静态值）
      const kfOf = (field, fallback) => (kfList && kfList.some((k) => typeof k[field] === "number"))
        ? kfList.map((k) => ({ t: k.t, v: typeof k[field] === "number" ? k[field] : fallback }))
        : null;
      const kfRot = kfOf("rotation", rot), kfAlpha = kfOf("alpha", alpha);
      const sw = Math.max(2, Math.round((W * (kfList ? kfMin : scale.x)) / 2) * 2);
      const sh = Math.max(2, Math.round((H * (kfList ? kfMin : scale.y)) / 2) * 2);
      f += `,scale=${sw}:${sh}:force_original_aspect_ratio=decrease`;
      if (kfList) {
        // 关键帧：先缩到最小缩放值并居中铺满画布（四周透明），再用 zoompan 按时间表达式做缩放/位移。
        // 实测 zoompan 保留 alpha，所以透明留白不会用黑底盖住下层轨道。
        f += `,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0`;
        if (alpha < 1) f += `,format=rgba,colorchannelmixer=aa=${alpha}`;
        f += `,setsar=1,fps=${FPS},format=rgba`;
        const zExpr = `(${kfExpr(kfList, "scale")})/${kfMin.toFixed(6)}`;
        // 位移【不】放这里：zoompan 的 x/y 是"裁剪窗口左上角"，会被钳在输入范围内，
        // 位移一大就被夹住（预览动了、导出没动）。缩放交给 zoompan，位移交给 overlay 的时间表达式。
        f += `,zoompan=z='${zExpr}':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2'` +
          `:d=1:s=${W}x${H}:fps=${FPS}`;
      } else {
        f += `,pad=${sw}:${sh}:(ow-iw)/2:(oh-ih)/2:color=black@0`;
        if (alpha < 1) f += `,format=rgba,colorchannelmixer=aa=${alpha}`;
        f += `,setsar=1,fps=${FPS},format=rgba`;
      }
      // 旋转：与预览一致 —— 绕片段中心、四周透明，越出画布的部分由画布边界截断。
      // 实测校准：ffmpeg rotate(+) 与 canvas rotate(+) 的旋向相反，故直接把角度取负后再取负 = 原角
      if (kfRot) {
        // 旋转关键帧：角度用时间表达式；ow/oh 不接受时间变量，所以取"最大绝对角"的静态包围盒，
        // 保证转到任何角度都不会被裁掉。
        // 旋转关键帧：角度用时间表达式。rotate 的表达式变量是 t（没有 it，实测），而这一环在
        // PTS 平移【之前】，所以 t 就是片段自身时间轴，正好与关键帧的 t 一致。
        const aMax = (Math.max(...kfRot.map((k) => Math.abs(k.v))) * Math.PI) / 180;
        f += `,rotate='((${kfExpr(kfRot, "v", "t")})*PI/180)':` +
          `ow=rotw(${aMax.toFixed(6)}):oh=roth(${aMax.toFixed(6)}):c=none`;
        summary.rotations++;
      } else if (rot) {
        const a = (rot * Math.PI) / 180;
        f += `,rotate=${a.toFixed(6)}:ow=rotw(${a.toFixed(6)}):oh=roth(${a.toFixed(6)}):c=none`;
        summary.rotations++;
      }
      // 淡入/淡出：alpha ramp，时间基于片段自身，必须在平移 PTS 之前（有 alpha 关键帧时走下面的 geq）
      if (!kfAlpha) {
        if (s.fade?.in > 0) { f += `,fade=t=in:st=0:d=${sec(s.fade.in)}:alpha=1`; summary.fades++; }
        if (s.fade?.out > 0) {
          f += `,fade=t=out:st=${sec(Math.max(0, tt.duration - s.fade.out))}:d=${sec(s.fade.out)}:alpha=1`;
          summary.fades++;
        }
      }
      // 把片段的 PTS 平移到时间轴位置，overlay 只在区间内生效
      f += `,setpts=PTS+${sec(tt.start)}/TB`;
      // 不透明度关键帧：fade 只能做单向 ramp，多点必须逐帧求值。
      // 实测 geq 在 1080p 上比普通编码慢约 9 倍（2s 片 0.3s→3.0s），所以只在真的用了 alpha 关键帧时才走这条路；
      // 放在 PTS 平移之后求值，时间变量用 geq 的大写 T（小写 t 是未定义常量，实测报错）。
      if (kfAlpha) {
        const parts = [kfExpr(kfAlpha, "v", "T", tt.start / 1e6)];
        const fe = fadeAlphaExprAbs(tt.start, tt.duration, s.fade?.in || 0, s.fade?.out || 0, 1, "T");
        if (fe) parts.push(fe);
        if (alpha !== 1) parts.push(String(alpha));
        const expr = parts.length > 1 ? parts.map((x) => `(${x})`).join("*") : parts[0];
        f += `,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='clip(255*(${expr}),0,255)'`;
        summary.alphaKf = (summary.alphaKf || 0) + 1;
      }
      const label = `v${vIdx++}`;
      chains.push(`${f}[${label}]`);
      videoOut.push({
        label, start: tt.start, end: tt.start + tt.duration, sw, sh, rot,
        dx: kfList ? 0 : tf.x, dy: kfList ? 0 : tf.y,
        // 关键帧的位移用 overlay 的绝对时间表达式（zoompan 的窗口坐标会被钳制，不能拿来位移）
        dxExpr: kfList ? kfExpr(kfList, "x", "t", tt.start / 1e6) : null,
        dyExpr: kfList ? kfExpr(kfList, "y", "t", tt.start / 1e6) : null,
        // 滑动类转场：本段开头 D 秒内从画布外滑到位（与预览同一套 ramp）
        slide: s.slide && s.slide.duration > 0
          ? { axis: s.slide.axis || "x", start: tt.start, duration: s.slide.duration } : null,
      });
      summary.segments++;
      if (kfList) summary.keyframed++;            // 按"片段"计一次，不按插入的滤镜个数
    }
  }

  // 2) 叠加链
  let cur = base;
  let oIdx = 0;
  for (const v of videoOut) {
    const next = `ov${oIdx}`;
    // 有表达式时必须整体加单引号：表达式里的逗号会被 filter 解析器当成参数分隔符
    let xs = v.dxExpr ? `(W-w)/2+(${v.dxExpr})` : `(W-w)/2+${Math.round(v.dx)}`;
    let ys = v.dyExpr ? `(H-h)/2+(${v.dyExpr})` : `(H-h)/2+${Math.round(v.dy)}`;
    let ramp = null;
    if (v.slide) {
      ramp = `(1-min(1,max(0,(t-${sec(v.slide.start)})/${sec(v.slide.duration)})))`;
      if (v.slide.axis === "y") ys = `${ys}+(H)*${ramp}`;
      else xs = `${xs}+(W)*${ramp}`;
    }
    const quoted = !!(v.dxExpr || v.dyExpr || ramp);
    chains.push(
      `[${cur}][${v.label}]overlay=x=${quoted ? `'${xs}'` : xs}:y=${quoted ? `'${ys}'` : ys}:` +
      `enable='between(t,${sec(v.start)},${sec(v.end)})':eof_action=pass:repeatlast=0[${next}]`);
    cur = next;
    oIdx++;
  }

  // 3) 文字层（drawtext，带时间区间；支持不透明度与淡入淡出 alpha）
  for (const track of orderedTracks(project)) {
    if (track.type !== "text") continue;
    if (trackHidden(track)) { summary.hiddenTracks++; continue; }
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
      // 字幕 alpha 用【绝对时间轴】表达式：drawtext 的 alpha 在合成流上求值，用相对时间会在
      // 片段不从 0 秒开始时错位。带 alpha 关键帧时再乘上关键帧表达式。
      const baseA = s.clip?.alpha ?? 1;
      const kfA = (Array.isArray(s.keyframes) && s.keyframes.some((k) => typeof k.alpha === "number"))
        ? [...s.keyframes].sort((a, b) => a.t - b.t)
          .map((k) => ({ t: k.t, v: typeof k.alpha === "number" ? k.alpha : baseA }))
        : null;
      const aParts = [];
      if (kfA) aParts.push(kfExpr(kfA, "v", "t", tt.start / 1e6));
      const feT = fadeAlphaExprAbs(tt.start, tt.duration, s.fade?.in || 0, s.fade?.out || 0);
      if (feT) aParts.push(feT);
      if (baseA !== 1) aParts.push(String(baseA));
      const alphaExpr = aParts.length ? aParts.map((x) => (aParts.length > 1 ? `(${x})` : x)).join("*") : null;
      if (alphaExpr) summary.fades++;
      chains.push(
        `[${cur}]drawtext=${fontPart}text='${escText(mat.content)}':fontsize=${size}:` +
        `fontcolor=0x${color}:` +
        (alphaExpr ? `alpha='${alphaExpr}':` : "") +
        `x=${x}:y=${y}:` +
        `enable='between(t,${sec(tt.start)},${sec(tt.start + tt.duration)})'[${next}]`);
      cur = next;
      summary.texts++;
    }
  }

  // 4) 音频层（多段混合；隐藏轨不出声、静音轨被掐掉、变速片段等时长拉伸）
  const audios = [];
  for (const track of orderedTracks(project)) {
    if (track.type !== "audio" && track.type !== "video") continue;
    if (trackHidden(track)) continue;
    if (trackMuted(track)) { summary.mutedTracks++; continue; }
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
      const speed = s.speed && s.speed > 0 ? s.speed : 1;
      let i = inputs.findIndex((a) => a[a.length - 1] === mat.path);
      if (i < 0) { inputs.push(["-i", mat.path]); i = inputs.length - 1; }
      const label = `a${audios.length}`;
      const ms = Math.round(tt.start / 1000);
      const af = s.fade || {};
      const afParts =
        (af.ain > 0 ? `afade=t=in:st=0:d=${sec(af.ain)},` : "") +
        (af.aout > 0 ? `afade=t=out:st=${sec(Math.max(0, tt.duration - af.aout))}:d=${sec(af.aout)},` : "");
      if (afParts) summary.audioFades = (summary.audioFades || 0) + 1;
      chains.push(
        `[${i}:a]atrim=start=${sec(st.start)}:end=${sec(st.start + st.duration)},` +
        `asetpts=PTS-STARTPTS,volume=${vol},` +
        (speed !== 1 ? `${atempoChain(speed)},` : "") +
        afParts +
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
 *  与导出同口径：隐藏轨不出声、静音轨被掐掉、变速片段等时长拉伸。
 *  @returns {string[]|null} ffmpeg 参数，没有音频则返回 null */
function buildAudioExtract(project, outWav) {
  const durUs = projectDuration(project);
  if (!durUs) return null;
  const inputs = [], chains = [], audios = [];
  for (const track of orderedTracks(project)) {
    if (track.type !== "audio" && track.type !== "video") continue;
    if (trackHidden(track) || trackMuted(track)) continue;
    for (const s of [...(track.segments || [])].sort(
      (a, b) => (a.target_timerange?.start || 0) - (b.target_timerange?.start || 0))) {
      const mat = materialOf(project, s.material_id);
      if (!mat || mat._kind === "texts" || mat._kind === "images") continue;
      if (mat._kind === "videos" && mat.hasAudio === false) continue;
      if (mat.hasAudio === false && mat._kind !== "audios") continue;
      const tt = s.target_timerange || { start: 0, duration: 0 };
      const st = s.source_timerange || { start: 0, duration: tt.duration };
      const speed = s.speed && s.speed > 0 ? s.speed : 1;
      let i = inputs.findIndex((a) => a[a.length - 1] === mat.path);
      if (i < 0) { inputs.push(["-i", mat.path]); i = inputs.length - 1; }
      const label = `a${audios.length}`;
      const ms = Math.round(tt.start / 1000);
      const afx = s.fade || {};
      const afxParts =
        (afx.ain > 0 ? `afade=t=in:st=0:d=${sec(afx.ain)},` : "") +
        (afx.aout > 0 ? `afade=t=out:st=${sec(Math.max(0, tt.duration - afx.aout))}:d=${sec(afx.aout)},` : "");
      chains.push(`[${i}:a]atrim=start=${sec(st.start)}:end=${sec(st.start + st.duration)},` +
        `asetpts=PTS-STARTPTS,volume=${s.volume ?? 1},` +
        (speed !== 1 ? `${atempoChain(speed)},` : "") +
        afxParts +
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

module.exports = {
  buildExport, buildAudioExtract, projectDuration, materialOf, orderedTracks,
  findCJKFont, escText, escPath, atempoChain, fadeAlphaExpr, fadeAlphaExprAbs, kfExpr, FONT,
};