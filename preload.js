// 预加载：把主进程能力安全地暴露给渲染进程
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lc", {
  info: () => ipcRenderer.invoke("app:info"),
  openMedia: () => ipcRenderer.invoke("media:open"),
  probe: (f) => ipcRenderer.invoke("media:probe", f),
  saveProject: (data) => ipcRenderer.invoke("project:save", data),
  openProject: () => ipcRenderer.invoke("project:open"),
  reveal: (p) => ipcRenderer.invoke("shell:reveal", p),
  importSubtitle: () => ipcRenderer.invoke("subtitle:import"),
  exportSubtitle: (payload) => ipcRenderer.invoke("subtitle:export", payload),
  asrInfo: () => ipcRenderer.invoke("asr:info"),
  runAsr: (payload) => ipcRenderer.invoke("asr:run", payload),
  onAsrProgress: (cb) => ipcRenderer.on("asr:progress", (_e, p) => cb(p)),
  pickExport: () => ipcRenderer.invoke("export:pick"),
  runExport: (payload) => ipcRenderer.invoke("export:run", payload),
  onExportProgress: (cb) => ipcRenderer.on("export:progress", (_e, d) => cb(d)),
  onExportFrame: (cb) => ipcRenderer.on("export:frame", (_e, n) => cb(n)),
});