// LiteCut 语音识别（ASR）模块：ffmpeg 抽时间轴音频 → whisper.cpp 转写 → SRT
// 依赖：tools/whisper/Release/whisper-cli.exe + tools/whisper/models/*.bin
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, spawnSync } = require("child_process");
const { FFMPEG } = require("./tools");
const { buildAudioExtract } = require("./exporter");

const WHISPER_DIR = process.env.LC_WHISPER_DIR || path.join(__dirname, "tools", "whisper");
const MODELS_DIR = path.join(WHISPER_DIR, "models");

function cliPath() {
  const cands = [
    path.join(WHISPER_DIR, "Release", "whisper-cli.exe"),
    path.join(WHISPER_DIR, "Release", "main.exe"),
    path.join(WHISPER_DIR, "whisper-cli.exe"),
    path.join(WHISPER_DIR, "whisper-cli"),
  ];
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (_) {} }
  return null;
}

/** 可用模型（按质量从高到低排序返回） */
function listModels() {
  const rank = ["large-v3", "large-v2", "large", "medium", "small", "base", "tiny"];
  let files = [];
  try {
    files = fs.readdirSync(MODELS_DIR).filter((f) => /\.bin$/i.test(f) && !/\.part$/i.test(f));
  } catch (_) { return []; }
  const score = (f) => {
    const i = rank.findIndex((r) => f.toLowerCase().includes(r));
    return i < 0 ? rank.length : i;
  };
  return files.map((f) => ({
    name: f, path: path.join(MODELS_DIR, f),
    size: (() => { try { return fs.statSync(path.join(MODELS_DIR, f)).size; } catch (_) { return 0; } })(),
  })).sort((a, b) => score(a.name) - score(b.name));
}

function pickModel(wanted) {
  const ms = listModels();
  if (!ms.length) return null;
  if (wanted) {
    const hit = ms.find((m) => m.name === wanted || m.name.includes(wanted));
    if (hit) return hit;
  }
  return ms[0];   // 质量最高的
}

/** 时间轴音频 → 16k 单声道 wav。返回 {ok,wav,durationUs} 或 {ok:false,error} */
function extractTimelineAudio(project, wavPath) {
  return new Promise((resolve) => {
    if (!FFMPEG) return resolve({ ok: false, error: "ffmpeg 未找到" });
    const args = buildAudioExtract(project, wavPath);
    if (!args) return resolve({ ok: false, error: "时间轴上没有带声音的片段" });
    const p = spawn(FFMPEG, args, { windowsHide: true });
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => {
      if (code !== 0 || !fs.existsSync(wavPath)) return resolve({ ok: false, error: "抽音频失败: " + err.slice(-400) });
      const st = fs.statSync(wavPath);
      resolve({ ok: true, wav: wavPath, bytes: st.size, durationUs: Math.round(((st.size - 44) / 2 / 16000) * 1e6) });
    });
    p.on("error", (e) => resolve({ ok: false, error: String(e) }));
  });
}

/**
 * 转写一个音频/视频文件为 SRT 文本。
 * @param {object} o { mediaPath, project, language, model, maxLen, threads, onProgress }
 */
async function transcribe(o = {}) {
  const cli = cliPath();
  if (!cli) return { ok: false, error: "未找到 whisper-cli（tools/whisper/Release/）" };
  const model = pickModel(o.model);
  if (!model) return { ok: false, error: "tools/whisper/models/ 里没有模型文件" };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "litecut_asr_"));
  const wav = path.join(tmp, "audio.wav");
  const base = path.join(tmp, "asr");
  let audio = null;
  if (o.project) audio = await extractTimelineAudio(o.project, wav);
  else if (o.mediaPath) {
    audio = await new Promise((resolve) => {
      const p = spawn(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-i", o.mediaPath,
        "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav], { windowsHide: true });
      let err = ""; p.stderr.on("data", (d) => (err += d.toString()));
      p.on("close", (c) => resolve(c === 0 && fs.existsSync(wav) ? { ok: true, wav, durationUs: 0 } : { ok: false, error: err.slice(-400) }));
      p.on("error", (e) => resolve({ ok: false, error: String(e) }));
    });
  } else return { ok: false, error: "没有音频输入" };
  if (!audio.ok) return audio;

  const args = ["-m", model.path, "-f", audio.wav, "-l", o.language || "zh",
    "-osrt", "-of", base, "-np", "-t", String(o.threads || Math.max(4, (os.cpus() || []).length - 1))];
  if (o.maxLen) args.push("-ml", String(o.maxLen));
  if (o.printProgress !== false) args.push("-pp");

  const started = Date.now();
  const res = await new Promise((resolve) => {
    const p = spawn(cli, args, { cwd: WHISPER_DIR, windowsHide: true });
    let out = "", err = "";
    p.stdout.on("data", (d) => {
      out += d.toString();
      const m = /progress\s*=\s*(\d+)%/.exec(out.slice(-300));
      if (m && o.onProgress) o.onProgress(parseInt(m[1], 10));
    });
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("close", (code) => resolve({ code, out, err }));
    p.on("error", (e) => resolve({ code: -1, out: "", err: String(e) }));
  });
  if (res.code !== 0) return { ok: false, error: "whisper 退出码 " + res.code + " " + res.err.slice(-400) };

  const srtFile = base + ".srt";
  let srt = "";
  try { srt = fs.readFileSync(srtFile, "utf8"); } catch (_) {}

  // 时间轴对齐修正：whisper 折叠前导静音 → 用实测静音长度把时间码平移回去
  let shiftedUs = 0;
  if (o.project) {
    const lead = leadSilenceUs(audio.wav);
    if (lead > 100000 && srt) {
      const { parseSubtitle, toSRT } = require("./subtitle");
      const cues = parseSubtitle(srt);
      if (cues.length) {
        srt = toSRT(cues.map((c) => ({ ...c, startUs: c.startUs + lead, endUs: c.endUs + lead })));
        shiftedUs = lead;
      }
    }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  return {
    ok: true, srt, model: model.name, language: o.language || "zh",
    seconds: Math.round((Date.now() - started) / 100) / 10,
    cueCount: (srt.match(/-->/g) || []).length,
    shiftedUs,
  };
}

/** 一次性便捷接口：时间轴 → 字幕 [{startUs,endUs,text}] */
async function transcribeProject(project, o = {}) {
  const r = await transcribe({ ...o, project });
  if (!r.ok) return r;
  const { parseSubtitle } = require("./subtitle");
  return { ...r, cues: parseSubtitle(r.srt) };
}

/** 读 16bit 单声道 WAV，返回前导静音时长（微秒）——whisper 会把前导静音折叠成 0.00s，
 *  用它把识别结果的时间码平移回真实时间轴位置。读取失败返回 0 */
function leadSilenceUs(wavPath, threshold = 500) {
  try {
    const buf = fs.readFileSync(wavPath);
    if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") return 0;
    let p = 12, sr = 16000, data = null;
    while (p < buf.length - 8) {
      const id = buf.toString("ascii", p, p + 4);
      const sz = buf.readUInt32LE(p + 4);
      if (id === "fmt ") sr = buf.readUInt32LE(p + 12) || 16000;
      if (id === "data") { data = buf.subarray(p + 8, p + 8 + sz); break; }
      p += 8 + sz + (sz % 2);
    }
    if (!data) return 0;
    for (let i = 0; i + 1 < data.length; i += 2) {
      if (Math.abs(data.readInt16LE(i)) > threshold) return Math.round((i / 2 / sr) * 1e6);
    }
    return 0;
  } catch (_) { return 0; }
}

module.exports = { listModels, pickModel, cliPath, transcribe, transcribeProject, extractTimelineAudio, leadSilenceUs, WHISPER_DIR, MODELS_DIR };