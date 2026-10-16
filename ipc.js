// LiteCut IPC 处理器（main.js 与 smoke.js 共用，避免两套逻辑）
const { ipcMain, dialog, shell, app } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");
const { FFMPEG, FFPROBE } = require("./tools");
const { buildExport } = require("./exporter");

let win = null;
function setWindow(w) { win = w; }

function probe(file) {
  return new Promise((resolve) => {
    if (!FFPROBE) return resolve({ ok: false, error: "ffprobe 未找到" });
    const p = spawn(FFPROBE, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", () => {
      try {
        const j = JSON.parse(out);
        const v = (j.streams || []).find((s) => s.codec_type === "video");
        const a = (j.streams || []).find((s) => s.codec_type === "audio");
        resolve({
          ok: true,
          duration: Math.round((parseFloat((j.format || {}).duration) || 0) * 1e6),
          width: v ? v.width : 0, height: v ? v.height : 0,
          fps: v && v.r_frame_rate ? evalFps(v.r_frame_rate) : 0,
          hasVideo: !!v, hasAudio: !!a,
          audioChannels: a ? a.channels : 0,
          sampleRate: a ? parseInt(a.sample_rate || "0", 10) : 0,
          size: parseInt((j.format || {}).size || "0", 10),
        });
      } catch (e) { resolve({ ok: false, error: "解析失败: " + err.slice(0, 300) }); }
    });
    p.on("error", (e) => resolve({ ok: false, error: String(e) }));
  });
}
function evalFps(rate) {
  try {
    if (rate.includes("/")) { const [n, d] = rate.split("/").map(Number); return d ? Math.round((n / d) * 1000) / 1000 : 0; }
    return Math.round(parseFloat(rate) * 1000) / 1000;
  } catch (_) { return 0; }
}

/** 注册全部 IPC 处理器（幂等：重复调用不会重复注册） */
function registerIpc() {
  if (registerIpc._done) return;
  registerIpc._done = true;

  ipcMain.handle("app:info", () => ({
    ffmpeg: FFMPEG, ffprobe: FFPROBE,
    versions: { electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome },
    home: os.homedir(),
  }));

  ipcMain.handle("media:open", async () => {
    const r = await dialog.showOpenDialog(win, {
      title: "导入媒体", properties: ["openFile", "multiSelections"],
      filters: [
        { name: "媒体文件", extensions: ["mp4", "mov", "mkv", "webm", "avi", "m4v", "mp3", "wav", "aac", "m4a", "flac", "png", "jpg", "jpeg", "webp", "bmp", "gif"] },
        { name: "全部文件", extensions: ["*"] },
      ],
    });
    if (r.canceled) return [];
    const files = [];
    for (const f of r.filePaths) {
      const info = await probe(f);
      files.push({
        path: f, name: path.basename(f),
        kind: /\.(png|jpe?g|webp|bmp|gif)$/i.test(f) ? "image" : /\.(mp3|wav|aac|m4a|flac|ogg)$/i.test(f) ? "audio" : "video",
        ...info,
      });
    }
    return files;
  });

  ipcMain.handle("media:probe", async (_e, file) => probe(file));

  ipcMain.handle("project:save", async (_e, data) => {
    const r = await dialog.showSaveDialog(win, {
      title: "保存工程",
      defaultPath: path.join(app.getPath("documents"), "litecut_draft.json"),
      filters: [{ name: "LiteCut 工程", extensions: ["json"] }],
    });
    if (r.canceled || !r.filePath) return { ok: false };
    fs.writeFileSync(r.filePath, JSON.stringify(data, null, 2), "utf8");
    return { ok: true, path: r.filePath };
  });

  ipcMain.handle("project:open", async () => {
    const r = await dialog.showOpenDialog(win, {
      title: "打开工程", properties: ["openFile"],
      filters: [{ name: "LiteCut 工程", extensions: ["json"] }],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false };
    try { return { ok: true, path: r.filePaths[0], project: JSON.parse(fs.readFileSync(r.filePaths[0], "utf8")) }; }
    catch (e) { return { ok: false, error: String(e) }; }
  });

  ipcMain.handle("shell:reveal", async (_e, p) => { shell.showItemInFolder(p); return true; });

  ipcMain.handle("asr:info", () => {
    const A = require("./asr");
    return { cli: A.cliPath(), models: A.listModels(), dir: A.WHISPER_DIR };
  });

  ipcMain.handle("asr:run", async (_e, payload) => {
    const A = require("./asr");
    const { project, mediaPath, language, model, maxLen } = payload || {};
    const r = await A.transcribe({
      project, mediaPath, language, model, maxLen,
      onProgress: (p) => { if (win && !win.isDestroyed()) win.webContents.send("asr:progress", p); },
    });
    if (win && !win.isDestroyed()) win.webContents.send("asr:progress", 100);
    return r;
  });

  ipcMain.handle("subtitle:import", async () => {
    const r = await dialog.showOpenDialog(win, {
      title: "导入字幕", properties: ["openFile"],
      filters: [{ name: "字幕文件", extensions: ["srt", "vtt", "txt"] }, { name: "全部文件", extensions: ["*"] }],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false };
    try { return { ok: true, path: r.filePaths[0], text: fs.readFileSync(r.filePaths[0], "utf8") }; }
    catch (e) { return { ok: false, error: String(e) }; }
  });

  ipcMain.handle("subtitle:export", async (_e, payload) => {
    const { text, defaultName, ext } = payload || {};
    const r = await dialog.showSaveDialog(win, {
      title: "导出字幕",
      defaultPath: path.join(app.getPath("videos"), defaultName || ("litecut_subtitle." + (ext || "srt"))),
      filters: [{ name: "SRT 字幕", extensions: ["srt"] }, { name: "VTT 字幕", extensions: ["vtt"] }],
    });
    if (r.canceled || !r.filePath) return { ok: false };
    try { fs.writeFileSync(r.filePath, text, "utf8"); return { ok: true, path: r.filePath }; }
    catch (e) { return { ok: false, error: String(e) }; }
  });

  ipcMain.handle("export:pick", async () => {
    const r = await dialog.showSaveDialog(win, {
      title: "导出视频",
      defaultPath: path.join(app.getPath("videos"), "litecut_export.mp4"),
      filters: [{ name: "MP4 视频", extensions: ["mp4"] }],
    });
    return r.canceled ? null : r.filePath;
  });

  // 导出：命令在 main 侧编译（渲染进程无 require），进度回传
  ipcMain.handle("export:run", async (_e, payload) => {
    const { project, outPath, opts } = payload;
    if (!FFMPEG) return { ok: false, error: "ffmpeg 未找到，请安装 ffmpeg 并确保在 PATH 中" };
    const compiled = buildExport(project, outPath, opts || {});
    const { args, durationUs } = compiled;
    return new Promise((resolve) => {
      const p = spawn(FFMPEG, args, { windowsHide: true });
      let tail = "";
      p.stdout.on("data", (d) => {
        const s = d.toString();
        tail = (tail + s).slice(-4000);
        const m = /out_time_us=(\d+)/.exec(s);
        if (m && win && !win.isDestroyed()) win.webContents.send("export:progress", { us: parseInt(m[1], 10), total: durationUs || 0 });
      });
      p.stderr.on("data", (d) => { tail = (tail + d.toString()).slice(-6000); });
      p.on("close", (code) => resolve(code === 0 ? { ok: true, outPath } : { ok: false, error: "ffmpeg 退出码 " + code, log: tail }));
      p.on("error", (e) => resolve({ ok: false, error: String(e) }));
    });
  });
}

module.exports = { registerIpc, setWindow, probe };