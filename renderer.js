// LiteCut 渲染进程：状态机 / 时间轴 / 画布预览 / 属性 / 导出接线
const US = 1e6;                       // 微秒
const $ = (s) => document.querySelector(s);

/* ============ 状态 ============ */
const state = {
  project: null,
  media: [],            // 素材库（未上轨道的导入项）
  sel: null,            // { trackId, segId }
  playhead: 0,          // 微秒
  playing: false,
  pxPerSec: 120,
  undo: [], redo: [],
  info: null,
  exportUs: 0,
};

function newProject() {
  return {
    id: crypto.randomUUID().toUpperCase(),
    name: "未命名工程",
    fps: 30, version: 360000, new_version: "144.0.0",
    canvas_config: { width: 1920, height: 1080, background: "black", ratio: "16:9" },
    materials: { videos: [], audios: [], images: [], texts: [] },
    tracks: [
      { id: "tk-main", type: "video", name: "主轨", segments: [] },
      { id: "tk-audio", type: "audio", name: "音频", segments: [] },
    ],
  };
}
const T = (s, d) => ({ start: s, duration: d });
const nextId = (p) => p + "-" + Math.random().toString(36).slice(2, 10);

/* ============ 撤销/重做 ============ */
function snapshot() {
  state.undo.push(JSON.stringify(state.project));
  if (state.undo.length > 80) state.undo.shift();
  state.redo.length = 0;
}
function undo() {
  if (!state.undo.length) return;
  state.redo.push(JSON.stringify(state.project));
  state.project = JSON.parse(state.undo.pop());
  state.sel = null; renderAll();
}
function redo() {
  if (!state.redo.length) return;
  state.undo.push(JSON.stringify(state.project));
  state.project = JSON.parse(state.redo.pop());
  state.sel = null; renderAll();
}

/* ============ 工具 ============ */
const usToStr = (us) => {
  const t = Math.max(0, us) / US, h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60),
    s = t % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
};
function projectDuration() {
  let e = 0;
  for (const t of state.project.tracks)
    for (const s of t.segments) e = Math.max(e, s.target_timerange.start + s.target_timerange.duration);
  return e;
}
function findSeg(trackId, segId) {
  const t = state.project.tracks.find((x) => x.id === trackId);
  return t ? { track: t, seg: (t.segments || []).find((s) => s.id === segId) } : null;
}
function materialOf(id) {
  const m = state.project.materials;
  for (const k of ["videos", "audios", "images", "texts"]) {
    const hit = (m[k] || []).find((x) => x.id === id);
    if (hit) return { ...hit, _kind: k };
  }
  return null;
}
const isVisual = (mat) => mat && (mat._kind === "videos" || mat._kind === "images");

/* ============ 媒体库 ============ */
async function importMedia() {
  const files = await window.lc.openMedia();
  if (!files || !files.length) return;
  for (const f of files) {
    const kindKey = f.kind === "image" ? "images" : f.kind === "audio" ? "audios" : "videos";
    const mat = {
      id: nextId("m"), path: f.path, name: f.name, kind: f.kind,
      duration: f.duration || (f.kind === "image" ? 5 * US : 0),
      width: f.width, height: f.height, hasVideo: f.hasVideo, hasAudio: f.hasAudio, fps: f.fps,
    };
    state.project.materials[kindKey].push(mat);
    state.media.push(mat);
  }
  renderMedia(); renderProps();
  setStatus(`已导入 ${files.length} 个素材`);
}

function renderMedia() {
  const box = $("#mediaList");
  box.innerHTML = "";
  $("#mediaCount").textContent = state.media.length;
  for (const m of state.media) {
    const d = document.createElement("div");
    d.className = "mitem";
    d.draggable = true;
    d.dataset.mid = m.id;
    const ico = m.kind === "image" ? "🖼" : m.kind === "audio" ? "🎵" : "🎬";
    d.innerHTML = `<div class="ico">${ico}</div>
      <div style="min-width:0"><div class="nm">${escapeHtml(m.name)}</div>
      <div class="mt">${m.kind === "image" ? "图片" : usToStr(m.duration)}${m.width ? " · " + m.width + "×" + m.height : ""}</div></div>`;
    d.ondblclick = () => addToTrackBest(m, 0);
    d.ondragstart = (e) => e.dataTransfer.setData("text/lc-material", m.id);
    box.appendChild(d);
  }
}
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* 把素材加到合适轨道 */
function addToTrackBest(mat, startUs) {
  snapshot();
  const lane = mat.kind === "video" || mat.kind === "image" ? "video"
    : mat.kind === "audio" ? "audio" : "text";
  let track = state.project.tracks.find((t) => t.type === lane)
    || state.project.tracks.find((t) => t.type === "video");
  if (!track) { track = { id: nextId("tk"), type: "video", name: "主轨", segments: [] }; state.project.tracks.unshift(track); }
  const dur = mat.duration || 5 * US;
  const seg = {
    id: nextId("s"), material_id: mat.id, visible: true, speed: 1, volume: 1,
    target_timerange: T(startUs || freeStartOn(track, dur), dur),
    source_timerange: T(0, dur),
    clip: { alpha: 1, scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 }, rotation: 0 },
  };
  track.segments.push(seg);
  track.segments.sort((a, b) => a.target_timerange.start - b.target_timerange.start);
  state.sel = { trackId: track.id, segId: seg.id };
  renderAll();
}
function freeStartOn(track, dur) {
  let end = 0;
  for (const s of track.segments) end = Math.max(end, s.target_timerange.start + s.target_timerange.duration);
  return end;
}

/* 新增文字 */
function addText(content = "点这里改文字") {
  snapshot();
  const mat = { id: nextId("t"), content, size: 72, color: "#FFFFFF" };
  state.project.materials.texts.push(mat);
  let track = state.project.tracks.find((t) => t.type === "text");
  if (!track) { track = { id: nextId("tk"), type: "text", name: "文字", segments: [] }; state.project.tracks.push(track); }
  const dur = 3 * US;
  const seg = {
    id: nextId("s"), material_id: mat.id, visible: true,
    target_timerange: T(freeStartOn(track, dur), dur), source_timerange: T(0, dur),
    clip: { alpha: 1, scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 }, rotation: 0 },
  };
  track.segments.push(seg);
  state.sel = { trackId: track.id, segId: seg.id };
  renderAll();
}

/* ============ 时间轴渲染 ============ */
function trackOrder() {
  const rank = { video: 0, text: 1, audio: 2 };
  return state.project.tracks
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (rank[a.t.type] - rank[b.t.type]) || (a.i - b.i))
    .map((x) => x.t);
}
const px = (us) => (us / US) * state.pxPerSec;

function renderTimeline() {
  const dur = Math.max(projectDuration(), 10 * US);
  const width = px(dur) + 400;
  $("#ruler").style.width = width + "px";
  $("#tracks").style.width = width + "px";

  // 刻度
  const stepChoices = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  let step = stepChoices.find((s) => s * state.pxPerSec >= 70) || 300;
  let ruler = "";
  for (let t = 0; t * US <= dur; t += step) {
    ruler += `<div class="tick" style="left:${px(t * US)}px">${step >= 1 ? usToStr(t * US).slice(3, 8) : t.toFixed(1) + "s"}</div>`;
  }
  $("#ruler").innerHTML = ruler;

  // 轨道
  const box = $("#tracks");
  box.innerHTML = "";
  for (const track of trackOrder()) {
    const row = document.createElement("div");
    row.className = "track";
    row.dataset.tid = track.id;
    const th = document.createElement("div");
    th.className = "thead";
    th.innerHTML = `${track.type === "video" ? "🎬" : track.type === "audio" ? "🎵" : "🅣"} ${escapeHtml(track.name || track.type)}`;
    const lane = document.createElement("div");
    lane.className = "tlane";
    lane.style.width = width - 96 + "px";
    lane.dataset.tid = track.id;
    lane.onpointerdown = (e) => {
      if (e.target !== lane) return;
      setPlayhead(pxToUs(e.offsetX));
      state.sel = null; renderProps(); renderTimeline();
    };
    lane.ondragover = (e) => e.preventDefault();
    lane.ondrop = (e) => {
      e.preventDefault();
      const mid = e.dataTransfer.getData("text/lc-material");
      if (!mid) return;
      const rect = lane.getBoundingClientRect();
      const us = pxToUs(e.clientX - rect.left + lane.scrollLeft);
      const mat = materialOf(mid);
      if (mat) addToTrackBest(mat, Math.max(0, us));
    };
    for (const seg of track.segments) {
      const mat = materialOf(seg.material_id);
      const el = document.createElement("div");
      el.className = "clip" + (track.type === "audio" ? " audio" : track.type === "text" ? " text" : "");
      if (state.sel && state.sel.segId === seg.id) el.classList.add("sel");
      el.style.left = px(seg.target_timerange.start) + "px";
      el.style.width = Math.max(14, px(seg.target_timerange.duration)) + "px";
      el.innerHTML = `<div class="hdl l"></div><div class="lbl">${escapeHtml(mat ? (mat.name || mat.content || "") : "?")}</div><div class="hdl r"></div>`;
      el.dataset.tid = track.id; el.dataset.sid = seg.id;
      el.onpointerdown = (e) => startClipDrag(e, track.id, seg.id, el);
      lane.appendChild(el);
    }
    row.appendChild(th); row.appendChild(lane);
    box.appendChild(row);
  }
  positionPlayhead();
  $("#tlInfo").textContent = `${state.project.tracks.length} 轨 · ${state.project.tracks.reduce((a, t) => a + t.segments.length, 0)} 片段`;
}
const pxToUs = (x) => (x / state.pxPerSec) * US;

/* 片段拖动 / 修剪 */
function startClipDrag(e, trackId, segId, el) {
  e.stopPropagation();
  const hit = findSeg(trackId, segId);
  if (!hit) return;
  state.sel = { trackId, segId };
  renderProps(); renderTimeline();
  const isL = e.target.classList.contains("l"), isR = e.target.classList.contains("r");
  const mode = isL ? "trimL" : isR ? "trimR" : "move";
  const x0 = e.clientX;
  const orig = JSON.parse(JSON.stringify(hit.seg));
  const others = hit.track.segments.filter((s) => s.id !== segId)
    .flatMap((s) => [s.target_timerange.start, s.target_timerange.start + s.target_timerange.duration]);
  snapshot();
  const onMove = (ev) => {
    const dx = ev.clientX - x0;
    let delta = pxToUs(dx);
    const snap = (v) => {
      const cands = [0, state.playhead, ...others];
      const tol = pxToUs(8);
      for (const c of cands) if (Math.abs(v - c) < tol) return c;
      return v;
    };
    const seg = hit.seg;
    if (mode === "move") {
      seg.target_timerange.start = Math.max(0, snap(orig.target_timerange.start + delta));
    } else if (mode === "trimR") {
      let d = Math.max(2e5, orig.target_timerange.duration + delta);
      d = Math.min(d, (orig.source_timerange.duration / (seg.speed || 1)) * 1e6 ? d : d);
      seg.target_timerange.duration = d;
      seg.source_timerange.duration = Math.round(d * (seg.speed || 1));
    } else if (mode === "trimL") {
      const maxL = orig.target_timerange.duration - 2e5;
      let shift = Math.min(Math.max(delta, -orig.target_timerange.start), maxL);
      seg.target_timerange.start = orig.target_timerange.start + shift;
      seg.target_timerange.duration = orig.target_timerange.duration - shift;
      seg.source_timerange.start = Math.max(0, orig.source_timerange.start + Math.round(shift * (seg.speed || 1)));
      seg.source_timerange.duration = Math.round(seg.target_timerange.duration * (seg.speed || 1));
    }
    renderTimeline(); renderProps();
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    hit.track.segments.sort((a, b) => a.target_timerange.start - b.target_timerange.start);
    renderAll();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function splitAtPlayhead() {
  if (!state.sel) return setStatus("先选中一个片段再分割");
  const hit = findSeg(state.sel.trackId, state.sel.segId);
  if (!hit) return;
  const { seg, track } = hit;
  const t = state.playhead;
  const s0 = seg.target_timerange.start, d0 = seg.target_timerange.duration;
  if (t <= s0 + 5e4 || t >= s0 + d0 - 5e4) return setStatus("播放头不在片段内部");
  snapshot();
  const sp = seg.speed || 1;
  const right = JSON.parse(JSON.stringify(seg));
  const leftDur = t - s0, rightDur = s0 + d0 - t;
  seg.target_timerange.duration = leftDur;
  seg.source_timerange.duration = Math.round(leftDur * sp);
  right.id = nextId("s");
  right.target_timerange = T(t, rightDur);
  right.source_timerange = T(seg.source_timerange.start + Math.round(leftDur * sp), Math.round(rightDur * sp));
  track.segments.push(right);
  track.segments.sort((a, b) => a.target_timerange.start - b.target_timerange.start);
  state.sel = { trackId: track.id, segId: right.id };
  renderAll(); setStatus("已分割");
}

function deleteSel() {
  if (!state.sel) return;
  const hit = findSeg(state.sel.trackId, state.sel.segId);
  if (!hit) return;
  snapshot();
  hit.track.segments = hit.track.segments.filter((s) => s.id !== state.sel.segId);
  state.sel = null;
  renderAll(); setStatus("已删除片段");
}

/* ============ 属性面板 ============ */
function renderProps() {
  const body = $("#propBody");
  if (!state.sel) { $("#selTag").textContent = "未选中"; body.innerHTML = `<p class="hint">选中时间轴上的片段后可调参数</p>`; return; }
  const hit = findSeg(state.sel.trackId, state.sel.segId);
  if (!hit) { state.sel = null; return renderProps(); }
  const seg = hit.seg, mat = materialOf(seg.material_id);
  $("#selTag").textContent = hit.track.type === "text" ? "文字" : hit.track.type === "audio" ? "音频" : "视频";
  const clip = seg.clip = seg.clip || { alpha: 1, scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 }, rotation: 0 };
  clip.scale = clip.scale || { x: 1, y: 1 }; clip.transform = clip.transform || { x: 0, y: 0 };

  const R = (label, key, val, min, max, step, cb, fmt) => `
    <div class="row"><label>${label}</label>
      <input type="range" data-k="${key}" min="${min}" max="${max}" step="${step}" value="${val}">
      <span class="val">${fmt ? fmt(val) : val}</span></div>`;
  let html = `<div class="row"><label>时间</label><input type="text" value="${usToStr(seg.target_timerange.start)} → ${usToStr(seg.target_timerange.start + seg.target_timerange.duration)}" readonly></div>`;

  if (mat && mat._kind === "texts") {
    html += `<div class="row"><label>文字</label><input type="text" data-k="content" value="${escapeHtml(mat.content || "")}"></div>`;
    html += R("字号", "size", mat.size || 72, 16, 240, 1, null, (v) => v + "px");
    html += `<div class="row"><label>颜色</label><input type="text" data-k="color" value="${mat.color || "#FFFFFF"}"></div>`;
  }
  if (hit.track.type !== "audio") {
    html += R("缩放", "scale", clip.scale.x, 0.1, 3, 0.01, null, (v) => Math.round(v * 100) + "%");
    html += R("位置 X", "tx", clip.transform.x, -1600, 1600, 1, null, (v) => v);
    html += R("位置 Y", "ty", clip.transform.y, -900, 900, 1, null, (v) => v);
    html += R("旋转", "rot", clip.rotation || 0, -180, 180, 1, null, (v) => v + "°");
    html += R("不透明度", "alpha", clip.alpha, 0, 1, 0.01, null, (v) => Math.round(v * 100) + "%");
  }
  html += R("速度", "speed", seg.speed || 1, 0.25, 4, 0.05, null, (v) => v.toFixed(2) + "x");
  if (mat && mat._kind !== "images") html += R("音量", "volume", seg.volume ?? 1, 0, 2, 0.01, null, (v) => Math.round(v * 100) + "%");
  if (mat) html += `<div class="row"><label>素材</label><span class="tag">${escapeHtml(mat.name || mat.content || "")}</span></div>`;
  body.innerHTML = html;

  body.querySelectorAll("input").forEach((inp) => {
    inp.oninput = () => {
      const k = inp.dataset.k, v = parseFloat(inp.value);
      if (k === "content" || k === "color") { mat[k] = inp.value; }
      else if (k === "size") mat.size = v;
      else if (k === "scale") { clip.scale.x = clip.scale.y = v; }
      else if (k === "tx") clip.transform.x = v;
      else if (k === "ty") clip.transform.y = v;
      else if (k === "rot") clip.rotation = v;
      else if (k === "alpha") clip.alpha = v;
      else if (k === "speed") {
        const sp = v, sp0 = seg.speed || 1;
        seg.speed = sp;
        seg.source_timerange.duration = Math.round(seg.target_timerange.duration * sp);
        syncEl(seg);
      } else if (k === "volume") seg.volume = v;
      const valEl = inp.parentElement.querySelector(".val");
      if (valEl) valEl.textContent = (k === "scale" || k === "alpha") ? Math.round(v * 100) + "%"
        : k === "speed" ? v.toFixed(2) + "x" : k === "size" ? v + "px" : k === "rot" ? v + "°" : v;
      drawFrame(state.playhead);
    };
  });
}

/* ============ 播放器 ============ */
const els = new Map();   // materialId -> HTMLMediaElement
function elFor(mat) {
  let el = els.get(mat.id);
  if (!el) {
    el = document.createElement(mat._kind === "audios" ? "audio" : "video");
    el.src = "file:///" + encodeURI(String(mat.path).replace(/\\/g, "/"));
    el.preload = "auto";
    el.crossOrigin = "anonymous";
    el.style.display = "none";
    document.body.appendChild(el);
    els.set(mat.id, el);
  }
  return el;
}
function syncEl(seg) {
  const mat = materialOf(seg.material_id);
  if (!mat) return;
  const el = elFor(mat);
  el.playbackRate = Math.min(4, Math.max(0.25, seg.speed || 1));
  if (el.volume !== undefined) el.volume = Math.min(1, seg.volume ?? 1);
}
function activeSegments(tUs) {
  const out = [];
  for (const track of trackOrder()) {
    for (const s of track.segments) {
      const { start, duration } = s.target_timerange;
      if (tUs >= start && tUs < start + duration) out.push({ track, seg: s, mat: materialOf(s.material_id) });
    }
  }
  return out;
}
function srcTimeUs(seg, tUs) {
  const dt = tUs - seg.target_timerange.start;
  return seg.source_timerange.start + dt * (seg.speed || 1);
}

function drawFrame(tUs) {
  const cv = $("#preview"), ctx = cv.getContext("2d", { willReadFrequently: true });
  const { width: W, height: H, background } = state.project.canvas_config;
  if (cv.width !== W) { cv.width = W; cv.height = H; }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = background === "black" ? "#000" : background;
  ctx.fillRect(0, 0, W, H);
  const act = activeSegments(tUs);
  for (const { track, seg, mat } of act) {
    if (!isVisual(mat)) continue;
    const el = elFor(mat);
    const clip = seg.clip || {};
    const scale = clip.scale || { x: 1, y: 1 };
    const tf = clip.transform || { x: 0, y: 0 };
    ctx.save();
    ctx.globalAlpha = clip.alpha ?? 1;
    ctx.translate(W / 2 + (tf.x || 0), H / 2 + (tf.y || 0));
    if (clip.rotation) ctx.rotate((clip.rotation * Math.PI) / 180);
    const vw = el.videoWidth || mat.width || W, vh = el.videoHeight || mat.height || H;
    const k = Math.min((W * scale.x) / vw, (H * scale.y) / vh);
    const dw = vw * k, dh = vh * k;
    if (el.readyState >= 2) ctx.drawImage(el, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  }
  // 文字层
  for (const { track, seg, mat } of act) {
    if (!mat || mat._kind !== "texts") continue;
    const clip = seg.clip || {}, tf = clip.transform || { x: 0, y: 0 };
    ctx.save();
    ctx.globalAlpha = clip.alpha ?? 1;
    ctx.font = `600 ${((mat.size || 72) * (clip.scale?.x || 1)) | 0}px "Microsoft YaHei", sans-serif`;
    ctx.fillStyle = mat.color || "#FFFFFF";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0,0,0,.55)"; ctx.shadowBlur = 8;
    ctx.fillText(mat.content || "", W / 2 + (tf.x || 0), H / 2 + (tf.y || 0));
    ctx.restore();
  }
  $("#timeLabel").textContent = `${usToStr(tUs)} / ${usToStr(projectDuration())}`;
  const s = $("#seek");
  const d = Math.max(projectDuration(), 1);
  if (document.activeElement !== s) s.value = String(Math.round((tUs / d) * 1000));
}

/* 播放时钟 */
let rafId = null, anchorWall = 0, anchorUs = 0;
function play() {
  if (state.playing) return;
  const total = projectDuration();
  if (state.playhead >= total) state.playhead = 0;
  state.playing = true; $("#btnPlay").textContent = "⏸";
  anchorWall = performance.now(); anchorUs = state.playhead;
  for (const { seg, mat } of activeSegments(state.playhead)) { if (mat) { syncEl(seg); elFor(mat).play().catch(() => {}); } }
  const loop = () => {
    if (!state.playing) return;
    const t = anchorUs + (performance.now() - anchorWall) * 1000;
    if (t >= total) { state.playhead = total; pause(); drawFrame(state.playhead); return; }
    state.playhead = t;
    const act = activeSegments(t);
    const live = new Set(act.map((a) => a.mat && a.mat.id));
    for (const [id, el] of els) {
      const a = act.find((x) => x.mat && x.mat.id === id);
      if (a) {
        const want = srcTimeUs(a.seg, t) / US;
        if (Math.abs(el.currentTime - want) > 0.28) el.currentTime = want;
        syncEl(a.seg);
        if (el.paused) el.play().catch(() => {});
      } else if (!el.paused) el.pause();
    }
    drawFrame(t);
    positionPlayhead();
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);
}
function pause() {
  state.playing = false; $("#btnPlay").textContent = "▶";
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  for (const el of els.values()) if (!el.paused) el.pause();
}
function setPlayhead(us) {
  state.playhead = Math.max(0, Math.min(us, projectDuration()));
  drawFrame(state.playhead); positionPlayhead();
}
function positionPlayhead() {
  $("#playhead").style.left = (px(state.playhead) + 96) + "px";
  $("#playhead").style.height = ($("#tracks").scrollHeight || 0) + "px";
}

/* ============ 顶层渲染 ============ */
function renderAll() {
  renderTimeline(); renderProps(); renderMedia(); drawFrame(state.playhead); renderCueList();
  $("#projName").value = state.project.name || "未命名工程";
  $("#btnUndo").disabled = !state.undo.length;
  $("#btnRedo").disabled = !state.redo.length;
}
function setStatus(s) { $("#status").textContent = s; }

/* ============ 工程读写 / 导出 ============ */
async function saveProject() {
  state.project.name = $("#projName").value.trim() || "未命名工程";
  const r = await window.lc.saveProject(state.project);
  setStatus(r.ok ? "工程已保存：" + r.path : "已取消保存");
}
async function openProject() {
  const r = await window.lc.openProject();
  if (!r.ok) return setStatus(r.error || "已取消");
  snapshot();
  state.project = r.project;
  state.media = [...(state.project.materials.videos || []), ...(state.project.materials.audios || []), ...(state.project.materials.images || [])];
  state.sel = null;
  renderAll(); setStatus("已打开：" + r.path);
}
async function exportVideo() {
  const outPath = await window.lc.pickExport();
  if (!outPath) return;
  pause();
  setStatus("正在导出…");
  $("#exportBar").style.width = "0%";
  const r = await window.lc.runExport({ project: state.project, outPath });   // 命令由主进程编译
  $("#exportBar").style.width = r.ok ? "100%" : "0%";
  if (r.ok) { setStatus("导出完成：" + r.outPath); window.lc.reveal(r.outPath); }
  else { setStatus("导出失败：" + r.error); console.error(r.log); }
}

/* ============ 事件绑定 ============ */
$("#btnImport").onclick = importMedia;
$("#btnSave").onclick = saveProject;
$("#btnOpen").onclick = openProject;
$("#btnExport").onclick = exportVideo;
$("#btnPlay").onclick = () => (state.playing ? pause() : play());
$("#btnSplit").onclick = splitAtPlayhead;
$("#btnDelete").onclick = deleteSel;
$("#btnUndo").onclick = undo;
$("#btnRedo").onclick = redo;
$("#btnAddVideoTrack").onclick = () => { snapshot(); state.project.tracks.push({ id: nextId("tk"), type: "video", name: "画中画", segments: [] }); renderAll(); };
$("#btnAddTextTrack").onclick = () => { snapshot(); state.project.tracks.push({ id: nextId("tk"), type: "text", name: "文字", segments: [] }); renderAll(); };
$("#btnAddAudioTrack").onclick = () => { snapshot(); state.project.tracks.push({ id: nextId("tk"), type: "audio", name: "音频", segments: [] }); renderAll(); };
$("#btnSubImport").onclick = importSubtitleFile;
$("#btnSubExport").onclick = exportSubtitleFile;
$("#btnSubAdd").onclick = addCueAtPlayhead;
$("#btnSubGen").onclick = batchGenerateCues;
$("#btnSubAsr").onclick = runAsr;
document.querySelectorAll(".tab").forEach((b) => {
  b.onclick = () => {
    const k = b.dataset.tab;
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === b));
    $("#tabProp").classList.toggle("hidden", k !== "prop");
    $("#tabSub").classList.toggle("hidden", k !== "sub");
    if (k === "sub") renderCueList();
  };
});
$("#seek").oninput = (e) => { pause(); setPlayhead((e.target.value / 1000) * projectDuration()); };
$("#zoom").oninput = (e) => { state.pxPerSec = +e.target.value; renderTimeline(); };
$("#projName").oninput = (e) => { state.project.name = e.target.value; };

window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  if (e.code === "Space") { e.preventDefault(); state.playing ? pause() : play(); }
  else if (e.key === "s" || e.key === "S") splitAtPlayhead();
  else if (e.key === "Delete" || e.key === "Backspace") deleteSel();
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveProject(); }
  else if (e.key === "t" || e.key === "T") addText();
});
window.addEventListener("pointerdown", (e) => {
  if (!e.target.closest(".clip") && !e.target.closest(".lane")) { /* 点空白清选 */ }
});
window.lc.onExportProgress((d) => {
  const pct = d.total ? Math.min(100, (d.us / d.total) * 100) : 0;
  $("#exportBar").style.width = pct.toFixed(1) + "%";
  setStatus(`正在导出… ${pct.toFixed(0)}%`);
});

/* ============ 字幕 ============ */
const SUB_NAME = "字幕";
function subTrack(create = true) {
  let t = state.project.tracks.find((x) => x.type === "text" && x.name === SUB_NAME);
  if (!t && create) { t = { id: nextId("tk"), type: "text", name: SUB_NAME, segments: [] }; state.project.tracks.push(t); }
  return t;
}
/** 时间轴上所有字幕条（按时间排序） */
function listCues() {
  const out = [];
  for (const t of state.project.tracks) {
    if (t.type !== "text") continue;
    for (const s of t.segments) {
      const m = materialOf(s.material_id);
      if (m && m._kind === "texts" && m.subtitle) {
        const tt = s.target_timerange;
        out.push({ track: t, seg: s, mat: m, startUs: tt.start, endUs: tt.start + tt.duration });
      }
    }
  }
  return out.sort((a, b) => a.startUs - b.startUs);
}
function addCue(text, startUs, endUs, opts = {}) {
  const t = subTrack();
  const dur = Math.max(2e5, (endUs ?? startUs + 2 * US) - startUs);
  const H = state.project.canvas_config.height;
  const mat = { id: nextId("t"), content: text, size: opts.size || 54, color: opts.color || "#FFFFFF", subtitle: true };
  state.project.materials.texts.push(mat);
  const seg = {
    id: nextId("s"), material_id: mat.id, visible: true, speed: 1, volume: 1,
    target_timerange: T(startUs, dur), source_timerange: T(0, dur),
    clip: { alpha: 1, scale: { x: 1, y: 1 }, transform: { x: 0, y: opts.y ?? Math.round(H * 0.34) }, rotation: 0 },
  };
  t.segments.push(seg);
  t.segments.sort((a, b) => a.target_timerange.start - b.target_timerange.start);
  return { track: t, seg, mat };
}
/** 清空所有字幕条（连同其文字素材） */
function clearCues() {
  for (const t of state.project.tracks) {
    if (t.type !== "text") continue;
    const keep = [];
    for (const s of t.segments) {
      const m = materialOf(s.material_id);
      if (m && m._kind === "texts" && m.subtitle) {
        state.project.materials.texts = state.project.materials.texts.filter((x) => x.id !== m.id);
      } else keep.push(s);
    }
    t.segments = keep;
  }
}
/** 批量导入字幕 [{startUs,endUs,text}] */
function importCues(cues, replace = true) {
  snapshot();
  if (replace) clearCues();
  for (const c of cues) addCue(c.text, c.startUs, c.endUs);
  renderAll();
  return cues.length;
}
/** 导出用的 SRT 文本（纯函数，便于测试） */
function buildSRT() {
  return LCSub.toSRT(listCues().map((c) => ({ startUs: c.startUs, endUs: c.endUs, text: c.mat.content })));
}

function renderCueList() {
  const box = $("#cueList");
  const cues = listCues();
  $("#cueCount").textContent = cues.length;
  if (!cues.length) { box.innerHTML = `<p class="hint">还没有字幕。导入 SRT/VTT、批量生成，或在播放头处加一条。</p>`; return; }
  box.innerHTML = "";
  cues.forEach((c, i) => {
    const row = document.createElement("div");
    row.className = "cue" + (state.playhead >= c.startUs && state.playhead < c.endUs ? " cur" : "");
    const pad = (n) => String(n).padStart(2, "0");
    const fmt = (us) => {
      const t = us / US;
      return `${pad(Math.floor(t / 60))}:${(t % 60).toFixed(1).padStart(4, "0")}`;
    };
    row.innerHTML = `<div class="idx">${i + 1}</div>
      <div class="body"><input value="${escapeHtml(c.mat.content)}" />
      <div class="tm">${fmt(c.startUs)} → ${fmt(c.endUs)}　${((c.endUs - c.startUs) / US).toFixed(1)}s</div></div>
      <button class="del" title="删除这条">✕</button>`;
    row.onclick = (e) => { if (e.target.tagName === "INPUT" || e.target.classList.contains("del")) return; pause(); setPlayhead(c.startUs); renderCueList(); };
    const inp = row.querySelector("input");
    inp.oninput = () => { c.mat.content = inp.value; drawFrame(state.playhead); };
    row.querySelector(".del").onclick = () => {
      snapshot();
      c.track.segments = c.track.segments.filter((s) => s.id !== c.seg.id);
      state.project.materials.texts = state.project.materials.texts.filter((x) => x.id !== c.mat.id);
      renderAll();
    };
    box.appendChild(row);
  });
}

/** 播放头处插入一条字幕 */
function addCueAtPlayhead() {
  pause();
  const text = ($("#subText").value.split("\n").find((x) => x.trim())) || "新字幕";
  snapshot();
  addCue(text.trim(), state.playhead, state.playhead + 2 * US);
  renderAll();
  const cues = listCues();
  setStatus("已在播放头处加入字幕（共 " + cues.length + " 条）");
}
/** 把文本框内容按标点/行批量打轴 */
function batchGenerateCues() {
  const raw = $("#subText").value;
  if (!raw.trim()) return setStatus("先在文本框里粘台词（每句一行）");
  const maxChars = Math.max(6, parseInt($("#subMax").value, 10) || 18);
  const secs = parseFloat($("#subTotal").value) || 0;
  const rest = Math.max(0, projectDuration() - state.playhead);
  const totalUs = secs > 0 ? secs * US : rest;
  const cues = LCSub.autoSplitText(raw, state.playhead, { maxChars, totalUs: totalUs || 0 });
  if (!cues.length) return setStatus("没有可生成的文本");
  const n = importCues(cues, true);
  setStatus(`已生成 ${n} 条字幕（起点 ${usToStr(state.playhead)}）`);
}
async function importSubtitleFile() {
  const r = await window.lc.importSubtitle();
  if (!r.ok) return setStatus(r.error || "已取消导入");
  const cues = LCSub.parseSubtitle(r.text);
  if (!cues.length) return setStatus("这个文件里没解析到字幕");
  const n = importCues(cues, true);
  setStatus(`已从 ${r.path.split(/[\\/]/).pop()} 导入 ${n} 条字幕`);
}
async function exportSubtitleFile() {
  const cues = listCues();
  if (!cues.length) return setStatus("还没有字幕可导出");
  const r = await window.lc.exportSubtitle({ text: buildSRT(), defaultName: (state.project.name || "litecut") + ".srt" });
  setStatus(r.ok ? `已导出 SRT：${r.path}（${cues.length} 条）` : (r.error || "已取消导出"));
}

/* ============ 语音识别（whisper.cpp）============ */
let ASR = { cli: null, models: [], dir: "" };
async function initAsr() {
  try {
    const info = await window.lc.asrInfo();
    ASR = info || { models: [] };
    const sel = $("#subModel");
    sel.innerHTML = "";
    if (!info || !info.cli || !(info.models || []).length) {
      sel.innerHTML = "<option>无可用模型</option>";
      $("#btnSubAsr").disabled = true;
      $("#asrProg").textContent = (info && info.cli) ? "缺模型" : "缺 whisper";
      $("#asrProg").title = "把 ggml-*.bin 放到 " + ((info && info.dir) || "tools/whisper/models");
      return;
    }
    for (const m of info.models) {
      const o = document.createElement("option");
      o.value = m.name;
      o.textContent = m.name.replace(/^ggml-/, "").replace(/\.bin$/i, "") + " · " + (m.size / 1e6).toFixed(0) + "MB";
      sel.appendChild(o);
    }
    $("#asrProg").textContent = "待命";
    $("#asrProg").title = info.cli;
  } catch (e) { $("#asrProg").textContent = "ASR 不可用"; }
}
async function runAsr() {
  if (!projectDuration()) return setStatus("时间轴上还没有内容");
  const btn = $("#btnSubAsr");
  btn.disabled = true;
  $("#asrProg").textContent = "0%";
  setStatus("正在抽取时间轴音频并识别…（首次加载模型稍慢）");
  try {
    const r = await window.lc.runAsr({
      project: state.project,
      language: $("#subLang").value,
      model: $("#subModel").value,
    });
    if (!r.ok) { setStatus("识别失败：" + r.error); $("#asrProg").textContent = "失败"; return; }
    const cues = LCSub.parseSubtitle(r.srt || "");
    if (!cues.length) { setStatus("识别完成，但没听到可成句的内容"); $("#asrProg").textContent = "0 条"; return; }
    const n = importCues(cues, true);
    setStatus(`语音识别完成：${n} 条字幕（${r.model}，${r.seconds}s）`);
    $("#asrProg").textContent = n + " 条";
  } catch (e) {
    setStatus("识别异常：" + e);
  } finally { btn.disabled = false; }
}
window.lc.onAsrProgress((p) => { $("#asrProg").textContent = p + "%"; });

/* ============ 启动 ============ */
(async () => {
  state.info = await window.lc.info();
  $("#envInfo").textContent = `Electron ${state.info.versions.electron} · ffmpeg ${state.info.ffmpeg ? "已就绪" : "缺失"}`;
  state.project = newProject();
  renderAll();
  initAsr();
  setStatus("就绪：导入媒体 → 拖到时间轴 → 编辑 → 导出");
})();