// LiteCut 字幕模块：SRT/VTT 解析与生成、长文本自动打轴（纯函数，可单测）
const US_T = 1e6;

/* "00:00:01,500" / "00:00:01.500" → 微秒 */
function timeToUs(s) {
  const m = String(s).trim().match(/(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})/);
  if (!m) return null;
  const h = parseInt(m[1] || "0", 10), mi = parseInt(m[2], 10), se = parseInt(m[3], 10);
  const ms = parseInt(m[4].padEnd(3, "0"), 10);
  return ((h * 3600 + mi * 60 + se) * 1000 + ms) * 1000;
}
const pad = (n, w = 2) => String(n).padStart(w, "0");
/** 微秒 → "HH:MM:SS,mmm" */
function usToSrtTime(us) {
  us = Math.max(0, Math.round(us));
  const ms = Math.floor((us % US_T) / 1000);
  const t = Math.floor(us / US_T);
  return `${pad(Math.floor(t / 3600))}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)},${pad(ms, 3)}`;
}
/** 微秒 → "HH:MM:SS.mmm"（VTT） */
const usToVttTime = (us) => usToSrtTime(us).replace(",", ".");

/** 解析 SRT / VTT → [{startUs,endUs,text}]（容忍 BOM、CRLF、缺序号、中文标点） */
function parseSubtitle(raw) {
  let s = String(raw).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  s = s.replace(/^WEBVTT.*\n/i, "");                 // VTT 头
  const blocks = s.split(/\n{2,}/);
  const out = [];
  for (const b of blocks) {
    const lines = b.split("\n").map((x) => x.trim()).filter((x) => x.length);
    if (!lines.length) continue;
    let i = 0;
    if (/^\d+$/.test(lines[0])) i = 1;               // 序号行
    const tm = lines[i] && lines[i].match(/(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/);
    if (!tm) continue;
    const startUs = timeToUs(tm[1]), endUs = timeToUs(tm[2]);
    if (startUs == null || endUs == null) continue;
    const text = lines.slice(i + 1).join("\n").replace(/<[^>]+>/g, "").trim();
    if (!text) continue;
    out.push({ startUs, endUs: Math.max(endUs, startUs + 100000), text });
  }
  return out.sort((a, b) => a.startUs - b.startUs);
}

/** [{startUs,endUs,text}] → SRT 文本 */
function toSRT(cues) {
  return cues.slice().sort((a, b) => a.startUs - b.startUs).map((c, i) =>
    `${i + 1}\n${usToSrtTime(c.startUs)} --> ${usToSrtTime(c.endUs)}\n${c.text}\n`).join("\n");
}

/** [{startUs,endUs,text}] → VTT 文本 */
function toVTT(cues) {
  return "WEBVTT\n\n" + cues.slice().sort((a, b) => a.startUs - b.startUs)
    .map((c) => `${usToVttTime(c.startUs)} --> ${usToVttTime(c.endUs)}\n${c.text}\n`).join("\n");
}

/**
 * 长文本自动打轴：把一段文本切成若干条字幕，按当前起点顺序排布。
 * - 多行文本 → 每行一条
 * - 单行长文本 → 按标点/长度切句
 * @param {string} raw 原始文本
 * @param {number} startUs 起始时间（默认 0）
 * @param {object} o {maxChars, minDurUs, gapUs, totalUs}
 */
function autoSplitText(raw, startUs = 0, o = {}) {
  const maxChars = o.maxChars || 18;           // 单条字幕建议字数（中文偏短）
  const minDurUs = o.minDurUs || 1.2 * US_T;     // 单条最短时长
  const gapUs = o.gapUs ?? 0.02 * US_T;          // 条间空隙
  const lines = String(raw).replace(/\r\n?/g, "\n").split("\n").map((x) => x.trim()).filter(Boolean);
  const chunks = [];
  for (const line of lines.length ? lines : [""]) {
    if (line.length <= maxChars) { if (line) chunks.push(line); continue; }
    // 先按标点切，再按长度硬切
    const parts = line.split(/(?<=[。！？；，、,.!?;])/).filter(Boolean);
    let buf = "";
    for (const p of parts) {
      if ((buf + p).length > maxChars && buf) { chunks.push(buf); buf = p; }
      else buf += p;
    }
    if (buf) chunks.push(buf);
  }
  if (!chunks.length) return [];
  // 时长：给了 totalUs 就按字数占比分配，否则按每字 ≈0.28s 的朗读速度估算
  const totalChars = chunks.reduce((a, c) => a + c.length, 0) || 1;
  const perCharUs = o.totalUs ? (o.totalUs / totalChars) : 0.28 * US_T;
  const cues = [];
  let t = startUs;
  for (const c of chunks) {
    const d = Math.max(minDurUs, Math.round(c.length * perCharUs));
    cues.push({ startUs: t, endUs: t + d, text: c });
    t += d + gapUs;
  }
  return cues;
}

// 浏览器端（<script> 引入）挂到 window.LCSub；Node 端走 module.exports
const API = { parseSubtitle, toSRT, toVTT, autoSplitText, timeToUs, usToSrtTime, usToVttTime };
if (typeof module !== "undefined" && module.exports) module.exports = API;
if (typeof window !== "undefined") window.LCSub = API;