// LiteCut 主进程入口：窗口 + 生命周期（IPC 处理器在 ipc.js）
const { app, BrowserWindow } = require("electron");
const path = require("path");
const { registerIpc, setWindow } = require("./ipc");

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1500, height: 940, minWidth: 1100, minHeight: 700,
    backgroundColor: "#1b1b1c",
    title: "LiteCut 轻剪",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  setWindow(win);
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, "index.html"));
  if (process.env.LC_DEVTOOLS) win.webContents.openDevTools({ mode: "detach" });
  win.webContents.on("render-process-gone", (_e, d) => console.error("[renderer gone]", d));
  win.webContents.on("console-message", (_e, level, msg) => { if (level >= 2) console.error("[renderer]", msg); });
  win.on("closed", () => { win = null; });
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });