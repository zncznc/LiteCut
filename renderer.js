// LiteCut 渲染进程：状态机 / 时间轴 / 画布预览 / 属性 / 导出接线
const US = 1e6;                       // 微秒
const $ = (s) => document.querySelector(s);

/* ============ 状态 ============ */
const state = {
  project: null,
  media: [],            // 素材库（未上轨道的导入项）
  sel: null,            // { trackId, segId } —— 主选中
  multi: [],            // 多选集合 [{ trackId, segId }]，空=只认主选中
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
    d.ondblclick = () => addToTrackBest(m, null);   // 双击=追加到该轨道末尾
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
    target_timerange: T(startUs == null ? freeStartOn(track, dur) : Math.max(0, startUs), dur),
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
    row.className = "track" + (trackHidden(track) ? " off" : track.muted === true ? " off" : "");
    row.dataset.tid = track.id;
    const th = document.createElement("div");
    th.className = "thead";
    const vis = track.visible !== false, mut = track.muted === true;
    th.innerHTML =
      `<span class="tname">${track.type === "video" ? "🎬" : track.type === "audio" ? "🎵" : "🅣"} ${escapeHtml(track.name || track.type)}</span>` +
      `<button class="tbtn" data-act="vis" title="${vis ? "隐藏该轨（画面与声音都不出）" : "显示该轨"}">${vis ? "👁" : "🚫"}</button>` +
      (track.type === "text" ? "" : `<button class="tbtn" data-act="mut" title="${mut ? "取消静音" : "静音该轨"}">${mut ? "🔇" : "🔊"}</button>`);
    th.querySelectorAll(".tbtn").forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        snapshot();
        if (b.dataset.act === "vis") track.visible = track.visible !== false ? false : true;
        else track.muted = track.muted !== true;
        renderAll();
        setStatus(`${track.name || track.type}：画面${track.visible === false ? "已隐藏" : "显示中"} · 声音${track.muted === true ? "已静音" : "正常"}`);
      };
    });
    const lane = document.createElement("div");
    lane.className = "tlane";
    lane.style.width = width - 124 + "px";
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
      const badge = seg.transition ? "⇄ " : seg.group_id ? "⧉ " : "";
      const isSel = (state.sel && state.sel.segId === seg.id) || state.multi.some((m) => m.segId === seg.id);
      if (isSel) el.classList.add("sel");
      el.style.left = px(seg.target_timerange.start) + "px";
      el.style.width = Math.max(14, px(seg.target_timerange.duration)) + "px";
      el.innerHTML = `<div class="hdl l"></div><div class="lbl">${badge}${escapeHtml(mat ? (mat.name || mat.content || "") : "?")}</div><div class="hdl r"></div>`;
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

/* ============ 选择（单选 / 多选 / 成组） ============ */
/** 当前选中的片段列表（含主选中；多选为空时就是主选中一个） */
function selList() {
  const list = state.multi.length ? state.multi : (state.sel ? [state.sel] : []);
  const seen = new Set(), out = [];
  for (const s of list) {
    if (!s || seen.has(s.segId)) continue;
    seen.add(s.segId);
    const hit = findSeg(s.trackId, s.segId);
    if (hit && hit.seg) out.push({ trackId: hit.track.id, track: hit.track, seg: hit.seg });
  }
  return out;
}
/** mode: "set" 单选 | "toggle" 加减选（Ctrl/Shift）| "group" 选中整组 */
function setSelection(trackId, segId, mode = "set") {
  const hit = findSeg(trackId, segId);
  if (!hit || !hit.seg) return;
  const seg = hit.seg;
  if (mode === "toggle") {
    // 第一次加选时把当前主选中也带进多选集合（符合"Ctrl+点选=在原选择上追加"的直觉）
    if (!state.multi.length && state.sel && state.sel.segId !== segId) state.multi.push({ ...state.sel });
    const i = state.multi.findIndex((x) => x.segId === segId);
    if (i >= 0) state.multi.splice(i, 1);
    else state.multi.push({ trackId, segId });
    if (!state.multi.length) { state.multi = []; state.sel = { trackId, segId }; }
    else state.sel = state.multi[state.multi.length - 1];
  } else if (mode === "group" && seg.group_id) {
    state.multi = [];
    for (const t of state.project.tracks) {
      for (const s of t.segments) if (s.group_id === seg.group_id) state.multi.push({ trackId: t.id, segId: s.id });
    }
    state.sel = { trackId, segId };
  } else {
    state.multi = [];
    state.sel = { trackId, segId };
  }
}

/* ============ 成组 / 解组 ============ */
function groupSelected() {
  const sel = selList();
  if (sel.length < 2) return setStatus("成组需要先选中至少两个片段（Ctrl/Shift 点选）");
  snapshot();
  const gid = nextId("g");
  for (const { seg } of sel) seg.group_id = gid;
  renderAll();
  setStatus(`已把 ${sel.length} 个片段成组`);
}
function ungroupSelected() {
  const sel = selList().filter((x) => x.seg.group_id);
  if (!sel.length) return setStatus("选中的片段不属于任何组");
  snapshot();
  for (const { seg } of sel) delete seg.group_id;
  renderAll();
  setStatus(`已解组 ${sel.length} 个片段`);
}

/* ============ 片段间转场（溶解） ============
   做法：把后一个片段左移 D 与前者重叠，**只让上层片段头部淡入 D**（前者保持不透明）。
   叠在上层的 B 以 alpha=a 覆盖不透明的 A，得到 out = a*B + (1-a)*A —— 这正是交叉溶解。
   若改成"前者也淡出"，前半段会同时向黑底淡出、中途亮度掉一截（淡经黑底），那是错的做法。
   预览与导出共用同一套 fade 语义，不需要额外的 xfade 滤镜。 */
function addTransition(durUs = 5e5, type = "dissolve") {
  const sel = selList();
  if (sel.length !== 1) return setStatus("转场需要先选中一个片段（单选）");
  const { track, seg } = sel[0];
  if (seg.transition) removeTransition();          // 重复点=按新类型/时长重来
  const sorted = [...track.segments].sort((a, b) => a.target_timerange.start - b.target_timerange.start);
  const i = sorted.findIndex((s) => s.id === seg.id);
  const next = sorted[i + 1];
  if (!next) return setStatus("这个片段后面没有相邻片段，无法加转场");
  const D = Math.min(durUs, Math.floor(seg.target_timerange.duration / 3), Math.floor(next.target_timerange.duration / 3));
  if (D < 1e5) return setStatus("片段太短，转场至少需要 0.1s");
  snapshot();
  // 记下受影响的原值，去掉转场时原样还回去（不吞掉用户自己设的淡入淡出）
  const prev = { segFadeOut: seg.fade?.out || 0, nextFadeIn: next.fade?.in || 0, nextSlide: next.slide || null };
  next.target_timerange.start = Math.max(0, next.target_timerange.start - D);
  next.fade = { in: next.fade?.in || 0, out: next.fade?.out || 0 };
  next.slide = null;
  if (type === "fadeblack") {
    // 前者淡出到黑 + 后者淡入：中点最暗，是"黑场"而不是溶解
    next.fade.in = D;
    seg.fade = { in: seg.fade?.in || 0, out: D };
  } else if (type === "slideleft" || type === "slideup") {
    next.slide = { axis: type === "slideup" ? "y" : "x", duration: D };   // 滑入靠位移表达式，不动 alpha
  } else {
    next.fade.in = D;                              // 叠化：只动上层，前者不淡出
    type = "dissolve";
  }
  seg.transition = { type, duration: D, next_id: next.id, prev };
  track.segments.sort((a, b) => a.target_timerange.start - b.target_timerange.start);
  renderAll();
  const NAMES = { dissolve: "叠化", fadeblack: "黑场", slideleft: "左滑", slideup: "上滑" };
  setStatus(`已加${NAMES[type] || "叠化"}转场 ${(D / US).toFixed(2)}s（后一片段左移重叠）`);
}
function removeTransition() {
  const sel = selList();
  if (sel.length !== 1) return setStatus("先选中带转场的片段");
  const { track, seg } = sel[0];
  if (!seg.transition) return setStatus("这个片段没有转场");
  const D = seg.transition.duration;
  const saved = seg.transition.prev || {};
  const sorted = [...track.segments].sort((a, b) => a.target_timerange.start - b.target_timerange.start);
  const next = (seg.transition.next_id && track.segments.find((s) => s.id === seg.transition.next_id))
    || sorted[sorted.findIndex((s) => s.id === seg.id) + 1];
  snapshot();
  if (next) {
    next.target_timerange.start += D;                // 把重叠还回去
    if (next.fade) next.fade.in = saved.nextFadeIn || 0;
    next.slide = saved.nextSlide || null;
  }
  seg.fade = { in: seg.fade?.in || 0, out: saved.segFadeOut || 0 };
  delete seg.transition;
  track.segments.sort((a, b) => a.target_timerange.start - b.target_timerange.start);
  renderAll();
  setStatus("已去掉转场（重叠与淡入淡出都已还原）");
}

/* 片段拖动 / 修剪 */
function startClipDrag(e, trackId, segId, el) {
  e.stopPropagation();
  const hit = findSeg(trackId, segId);
  if (!hit || !hit.seg) return;
  // 点击时的选择语义：Ctrl/Shift 加减选；成组片段一点选整组；否则单选
  const multiKey = e.ctrlKey || e.metaKey || e.shiftKey;
  setSelection(trackId, segId, multiKey ? "toggle" : (hit.seg.group_id ? "group" : "set"));
  renderProps(); renderTimeline();

  const isL = e.target.classList.contains("l"), isR = e.target.classList.contains("r");
  const sel = selList();
  // 多选时不做边缘裁剪（避免同时改多个片段的源范围），只整体移动
  const mode = (sel.length > 1 && (isL || isR)) ? "move" : (isL ? "trimL" : isR ? "trimR" : "move");
  const x0 = e.clientX;
  const orig = sel.map((s) => ({ ref: s, o: JSON.parse(JSON.stringify(s.seg)) }));
  const primary = orig.find((x) => x.ref.seg.id === segId) || orig[0];
  const others = hit.track.segments.filter((s) => !orig.some((x) => x.ref.seg.id === s.id))
    .flatMap((s) => [s.target_timerange.start, s.target_timerange.start + s.target_timerange.duration]);
  snapshot();
  const onMove = (ev) => {
    const delta = pxToUs(ev.clientX - x0);
    const snap = (v) => {
      const cands = [0, state.playhead, ...others];
      const tol = pxToUs(8);
      for (const c of cands) if (Math.abs(v - c) < tol) return c;
      return v;
    };
    if (mode === "move") {
      // 先按主片段吸附，再把同一个位移施加给全部选中片段（保持相对位置）
      const snapped = Math.max(0, snap(primary.o.target_timerange.start + delta));
      const d = snapped - primary.o.target_timerange.start;
      for (const { ref, o } of orig) {
        const st = o.target_timerange.start + d;
        ref.seg.target_timerange.start = st < 0 ? 0 : st;
      }
    } else {
      const seg = hit.seg, o = orig[0].o;
      if (mode === "trimR") {
        const d = Math.max(2e5, o.target_timerange.duration + delta);
        seg.target_timerange.duration = d;
        seg.source_timerange.duration = Math.round(d * (seg.speed || 1));
      } else {
        const maxL = o.target_timerange.duration - 2e5;
        const shift = Math.min(Math.max(delta, -o.target_timerange.start), maxL);
        seg.target_timerange.start = o.target_timerange.start + shift;
        seg.target_timerange.duration = o.target_timerange.duration - shift;
        seg.source_timerange.start = Math.max(0, o.source_timerange.start + Math.round(shift * (seg.speed || 1)));
        seg.source_timerange.duration = Math.round(seg.target_timerange.duration * (seg.speed || 1));
      }
    }
    renderTimeline(); renderProps();
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    const tracks = new Set(orig.map((x) => x.ref.track));
    for (const t of tracks) t.segments.sort((a, b) => a.target_timerange.start - b.target_timerange.start);
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
  const sel = selList();
  if (!sel.length) return;
  snapshot();
  for (const { track, seg } of sel) track.segments = track.segments.filter((s) => s.id !== seg.id);
  state.sel = null; state.multi = [];
  renderAll();
  setStatus(`已删除 ${sel.length} 个片段（留空）`);
}

/* 波纹删除：删掉选中的片段，并把同轨其后片段整体左移，补上腾出的时长。
   多选时按起点从后往前逐个处理，避免前一次左移影响后面的判断。 */
function rippleDeleteSel() {
  let sel = selList();
  if (!sel.length) return setStatus("先选中片段");
  snapshot();
  sel = [...sel].sort((a, b) => b.seg.target_timerange.start - a.seg.target_timerange.start);
  let moved = 0;
  for (const { trackId, seg } of sel) {
    const hit = findSeg(trackId, seg.id);
    if (!hit || !hit.seg) continue;
    const t = hit.track, s = hit.seg;
    const gap = s.target_timerange.duration, from = s.target_timerange.start;
    t.segments = t.segments.filter((x) => x.id !== s.id);
    for (const x of t.segments) {
      if (x.target_timerange.start >= from) { x.target_timerange.start = Math.max(0, x.target_timerange.start - gap); moved++; }
    }
    t.segments.sort((a, b) => a.target_timerange.start - b.target_timerange.start);
  }
  state.sel = null; state.multi = [];
  renderAll();
  setStatus(`波纹删除 ${sel.length} 个片段：同轨其后共 ${moved} 次左移`);
}

/* ============ 关键帧（位置 / 缩放） ============
   模型：seg.keyframes = [{ t(片段内相对微秒), x, y, scale }]，线性插值。
   导出侧用 zoompan 的 z/x/y 时间表达式实现（实测 zoompan 保留 alpha，不会用黑底盖住下层轨道）。
   边界：旋转仍是静态属性；不透明度仍是线性淡入淡出 —— ffmpeg 没有便宜的时间可变 alpha 乘子
   （colorchannelmixer 只支持 enable，不支持按时间的命令；geq 是逐像素求值，太慢）。 */
function kfSorted(seg) {
  return Array.isArray(seg.keyframes) ? [...seg.keyframes].sort((a, b) => a.t - b.t) : [];
}
function kfBase(seg) {
  const clip = seg.clip || {};
  return {
    x: clip.transform?.x || 0, y: clip.transform?.y || 0, scale: clip.scale?.x ?? 1,
    rotation: clip.rotation || 0, alpha: clip.alpha ?? 1,
  };
}
/** 片段内相对时间 relUs 处的变换（没有关键帧就回落到静态值；缺哪个字段就回落哪个） */
function kfValueAt(seg, relUs) {
  const k = kfSorted(seg), base = kfBase(seg);
  const norm = (o) => ({
    x: o.x ?? base.x, y: o.y ?? base.y, scale: o.scale ?? base.scale,
    rotation: o.rotation ?? base.rotation, alpha: o.alpha ?? base.alpha,
  });
  if (!k.length) return base;
  if (relUs <= k[0].t) return norm(k[0]);
  const last = k[k.length - 1];
  if (relUs >= last.t) return norm(last);
  for (let i = 1; i < k.length; i++) {
    if (relUs <= k[i].t) {
      const a = k[i - 1], b = k[i], f = (relUs - a.t) / Math.max(1, b.t - a.t);
      const L = (p, q) => p + (q - p) * f;
      const A = norm(a), B = norm(b);
      return {
        x: L(A.x, B.x), y: L(A.y, B.y), scale: L(A.scale, B.scale),
        rotation: L(A.rotation, B.rotation), alpha: L(A.alpha, B.alpha),
      };
    }
  }
  return base;
}
/** 滑动类转场在 tUs 时刻的位移（与导出侧 overlay 的 ramp 同一公式） */
function slideOffsetAt(seg, tUs) {
  const sl = seg && seg.slide;
  if (!sl || !sl.duration) return { x: 0, y: 0 };
  const tt = seg.target_timerange;
  const ramp = Math.max(0, Math.min(1, (tUs - tt.start) / sl.duration));
  const { width: W, height: H } = state.project.canvas_config;
  const left = 1 - ramp;
  return sl.axis === "y" ? { x: 0, y: left * H } : { x: left * W, y: 0 };
}
/** 把某个字段写进"播放头所在时刻"的关键帧（不存在则新建；其余字段取当前插值，避免被改掉） */
function kfWrite(seg, field, value) {
  const tt = seg.target_timerange;
  const t = Math.max(0, Math.min(tt.duration, Math.round(state.playhead - tt.start)));
  const v = kfValueAt(seg, t);
  seg.keyframes = (seg.keyframes || []).filter((k) => Math.abs(k.t - t) > US / 30);
  const nv = { x: v.x, y: v.y, scale: v.scale, rotation: v.rotation, alpha: v.alpha, [field]: value };
  seg.keyframes.push({ t, x: nv.x, y: nv.y, scale: nv.scale, rotation: nv.rotation, alpha: nv.alpha });
  seg.keyframes.sort((a, b) => a.t - b.t);
}
/** 播放头处记录一个关键帧（值取当前插值结果，便于"定点微调"） */
function keyframeHere() {
  const sel = selList();
  if (sel.length !== 1) return setStatus("关键帧需要先单选一个片段");
  const { seg } = sel[0];
  const tt = seg.target_timerange;
  if (state.playhead < tt.start || state.playhead > tt.start + tt.duration) return setStatus("播放头不在这个片段内");
  snapshot();
  kfWrite(seg, "x", kfValueAt(seg, Math.round(state.playhead - tt.start)).x);
  renderAll();
  setStatus(`已在 ${((state.playhead - tt.start) / US).toFixed(2)}s 记录关键帧（共 ${seg.keyframes.length} 个）`);
}
function clearKeyframes() {
  const sel = selList();
  if (!sel.length) return;
  snapshot();
  for (const { seg } of sel) delete seg.keyframes;
  renderAll();
  setStatus("已清除关键帧");
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
    const kfOn = Array.isArray(seg.keyframes) && seg.keyframes.length > 0;
    const cur = kfValueAt(seg, state.playhead - seg.target_timerange.start);   // 开了关键帧就显示播放头处的插值
    html += R("缩放", "scale", kfOn ? cur.scale : clip.scale.x, 0.1, 3, 0.01, null, (v) => Math.round(v * 100) + "%");
    html += R("位置 X", "tx", kfOn ? cur.x : clip.transform.x, -1600, 1600, 1, null, (v) => v);
    html += R("位置 Y", "ty", kfOn ? cur.y : clip.transform.y, -900, 900, 1, null, (v) => v);
    html += R("旋转", "rot", kfOn ? cur.rotation : (clip.rotation || 0), -180, 180, 1, null, (v) => v + "°");
    html += R("不透明度", "alpha", kfOn ? cur.alpha : clip.alpha, 0, 1, 0.01, null, (v) => Math.round(v * 100) + "%");
    const fade = (seg.fade = seg.fade || { in: 0, out: 0 });
    html += `<div class="row"><label>淡入(秒)</label><input type="number" data-k="fadeIn" min="0" step="0.1" value="${((fade.in || 0) / US).toFixed(2)}"><span class="val">≤ 片段时长</span></div>`;
    html += `<div class="row"><label>淡出(秒)</label><input type="number" data-k="fadeOut" min="0" step="0.1" value="${((fade.out || 0) / US).toFixed(2)}"><span class="val">≤ 片段时长</span></div>`;
    html += `<div class="row"><label>关键帧</label>
      <button class="btn small" data-act="kfAdd" title="在播放头处记录当前位置/缩放">◆ 记录</button>
      <button class="btn small" data-act="kfDel" title="清除该片段的全部关键帧">✕ 清除</button>
      <span class="val">${kfOn ? seg.keyframes.length + " 个" : "无"}</span></div>`;
    if (kfOn) {
      html += `<div class="kflist">` + seg.keyframes.map((k, i) =>
        `<div class="kfrow"><span class="kt">${(k.t / US).toFixed(2)}s</span>` +
        `<span class="kv">x=${Math.round(k.x)} y=${Math.round(k.y)} ${Math.round(k.scale * 100)}%</span>` +
        `<button class="del" data-kf="${i}" title="删掉这个关键帧">✕</button></div>`).join("") + `</div>`;
    }
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
      else if (k === "scale") {
        if (Array.isArray(seg.keyframes) && seg.keyframes.length) kfWrite(seg, "scale", v);
        else clip.scale.x = clip.scale.y = v;
      }
      else if (k === "tx") {
        if (Array.isArray(seg.keyframes) && seg.keyframes.length) kfWrite(seg, "x", v);
        else clip.transform.x = v;
      }
      else if (k === "ty") {
        if (Array.isArray(seg.keyframes) && seg.keyframes.length) kfWrite(seg, "y", v);
        else clip.transform.y = v;
      }
      else if (k === "rot") {
        if (Array.isArray(seg.keyframes) && seg.keyframes.length) kfWrite(seg, "rotation", v);
        else clip.rotation = v;
      }
      else if (k === "alpha") {
        if (Array.isArray(seg.keyframes) && seg.keyframes.length) kfWrite(seg, "alpha", v);
        else clip.alpha = v;
      }
      else if (k === "fadeIn" || k === "fadeOut") {
        const us = Math.max(0, Math.min(seg.target_timerange.duration, Math.round(v * US)));
        seg.fade = seg.fade || { in: 0, out: 0 };
        if (k === "fadeIn") seg.fade.in = us; else seg.fade.out = us;
      }
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
  body.querySelectorAll("button[data-act]").forEach((b) => {
    b.onclick = () => (b.dataset.act === "kfAdd" ? keyframeHere() : clearKeyframes());
  });
  body.querySelectorAll(".kfrow .del").forEach((b) => {
    b.onclick = () => { snapshot(); seg.keyframes.splice(+b.dataset.kf, 1); renderAll(); };
  });
}

/* ============ 播放器 ============ */
// 元素按【片段】而不是按素材缓存：同一素材在同一时刻被多个片段引用时，
// 各片段各用各的元素，源时间 / 变速 / 音量 / 静音互不干扰。
const els = new Map();   // segId -> HTMLMediaElement
function elForSeg(seg, mat) {
  if (!mat || !mat.path) return null;
  const want = "file:///" + encodeURI(String(mat.path).replace(/\\/g, "/"));
  let el = els.get(seg.id);
  if (!el) {
    el = document.createElement(mat._kind === "audios" ? "audio" : "video");
    el.preload = "auto";
    el.crossOrigin = "anonymous";
    el.style.display = "none";
    // seek 完成后重画：暂停状态下拖播放头，画面才会跟着走
    el.onseeked = () => { if (!state.playing) drawFrame(state.playhead); };
    document.body.appendChild(el);
    els.set(seg.id, el);
  }
  if (el.dataset.src !== want) { el.dataset.src = want; el.src = want; }
  return el;
}
/** 丢掉时间轴上已不存在的片段元素（撤销/重做/打开工程/删除之后） */
function pruneEls() {
  const live = new Set();
  for (const t of state.project.tracks) for (const s of t.segments) live.add(s.id);
  for (const [k, el] of els) {
    if (live.has(k)) continue;
    try { el.pause(); el.removeAttribute("src"); el.load(); } catch (_) {}
    el.remove();
    els.delete(k);
  }
}
function syncEl(seg, track) {
  const mat = materialOf(seg.material_id);
  if (!mat) return null;
  const el = elForSeg(seg, mat);
  if (!el) return null;
  el.playbackRate = Math.min(4, Math.max(0.25, seg.speed || 1));
  const muted = (track && track.muted === true) || seg.volume === 0;
  el.muted = muted;
  if (el.volume !== undefined) el.volume = muted ? 0 : Math.min(1, seg.volume ?? 1);
  return el;
}
/** 轨道被隐藏：不出画面也不出声 */
const trackHidden = (t) => !!t && t.visible === false;
function activeSegments(tUs) {
  const out = [];
  for (const track of trackOrder()) {
    if (trackHidden(track)) continue;
    for (const s of track.segments) {
      const { start, duration } = s.target_timerange;
      if (tUs >= start && tUs < start + duration) out.push({ track, seg: s, mat: materialOf(s.material_id) });
    }
  }
  return out;
}
/** 淡入淡出对 alpha 的系数（与导出侧 fade 滤镜同一语义：线性 ramp） */
function fadeFactor(seg, tUs) {
  const f = seg.fade || {};
  const { start, duration } = seg.target_timerange;
  const rel = tUs - start;
  let a = 1;
  if (f.in > 0) a = Math.min(a, Math.max(0, Math.min(1, rel / f.in)));
  if (f.out > 0) a = Math.min(a, Math.max(0, Math.min(1, (duration - rel) / f.out)));
  return a;
}
/** 把各活动片段的元素 seek 到对应源时间（暂停时拖播放头画面才会跟着走） */
function seekEls(tUs) {
  const act = activeSegments(tUs);
  const live = new Set(act.map((a) => a.seg.id));
  for (const { track, seg } of act) {
    const el = syncEl(seg, track);
    if (!el) continue;
    const want = Math.max(0, srcTimeUs(seg, tUs) / US);
    if (Math.abs(el.currentTime - want) > 0.04) el.currentTime = want;
    if (!state.playing && !el.paused) el.pause();
  }
  for (const [k, el] of els) if (!live.has(k) && !el.paused) el.pause();
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
    const el = syncEl(seg, track);
    if (!el) continue;
    const clip = seg.clip || {};
    const kf = kfValueAt(seg, tUs - seg.target_timerange.start);   // 关键帧优先，无关键帧=静态值
    const slide = slideOffsetAt(seg, tUs);                         // 滑动类转场的位移
    const scale = { x: kf.scale, y: kf.scale };
    const tf = { x: kf.x + slide.x, y: kf.y + slide.y };
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, kf.alpha)) * fadeFactor(seg, tUs);
    ctx.translate(W / 2 + (tf.x || 0), H / 2 + (tf.y || 0));
    if (kf.rotation) ctx.rotate((kf.rotation * Math.PI) / 180);
    const vw = el.videoWidth || mat.width || W, vh = el.videoHeight || mat.height || H;
    const k = Math.min((W * scale.x) / vw, (H * scale.y) / vh);
    const dw = vw * k, dh = vh * k;
    if (el.readyState >= 2) ctx.drawImage(el, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  }
  // 文字层
  for (const { track, seg, mat } of act) {
    if (!mat || mat._kind !== "texts") continue;
    const kf = kfValueAt(seg, tUs - seg.target_timerange.start);
    const slide = slideOffsetAt(seg, tUs);
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, kf.alpha)) * fadeFactor(seg, tUs);
    ctx.font = `600 ${((mat.size || 72) * kf.scale) | 0}px "Microsoft YaHei", sans-serif`;
    ctx.fillStyle = mat.color || "#FFFFFF";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0,0,0,.55)"; ctx.shadowBlur = 8;
    ctx.fillText(mat.content || "", W / 2 + kf.x + slide.x, H / 2 + kf.y + slide.y);
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
  for (const { track, seg } of activeSegments(state.playhead)) {
    const el = syncEl(seg, track);
    if (el) el.play().catch(() => {});
  }
  const loop = () => {
    if (!state.playing) return;
    const t = anchorUs + (performance.now() - anchorWall) * 1000;
    if (t >= total) { state.playhead = total; pause(); drawFrame(state.playhead); return; }
    state.playhead = t;
    const act = activeSegments(t);
    const live = new Set();
    for (const { track, seg } of act) {
      const el = syncEl(seg, track);
      if (!el) continue;
      live.add(seg.id);
      const want = srcTimeUs(seg, t) / US;
      if (Math.abs(el.currentTime - want) > 0.28) el.currentTime = want;
      if (el.paused) el.play().catch(() => {});
    }
    for (const [k, el] of els) if (!live.has(k) && !el.paused) el.pause();
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
  seekEls(state.playhead);      // 暂停状态下也要让画面跟到该时刻
  drawFrame(state.playhead); positionPlayhead();
}
function positionPlayhead() {
  $("#playhead").style.left = (px(state.playhead) + 124) + "px";
  $("#playhead").style.height = ($("#tracks").scrollHeight || 0) + "px";
}

/* ============ 顶层渲染 ============ */
function renderAll() {
  pruneEls();
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
$("#btnRippleDel").onclick = rippleDeleteSel;
$("#btnTransition").onclick = () => {
  const dur = (parseFloat($("#trDur").value) || 0.5) * US;
  addTransition(dur, $("#trType").value);
};
$("#btnUnTransition").onclick = () => removeTransition();
$("#btnKf").onclick = keyframeHere;
$("#btnGroup").onclick = groupSelected;
$("#btnUngroup").onclick = ungroupSelected;
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
  else if (e.key === "Delete" || e.key === "Backspace") { e.shiftKey ? rippleDeleteSel() : deleteSel(); }
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