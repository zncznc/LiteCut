// ffmpeg / ffprobe 定位（主进程与自测共用）
const path = require("path");
const fs = require("fs");
const os = require("os");

function findTool(name) {
  const exe = process.platform === "win32" ? name + ".exe" : name;
  const candidates = [];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, exe));
  }
  try {
    const base = path.join(os.homedir(), "AppData", "Local", "Microsoft", "WinGet", "Packages");
    for (const pkg of fs.readdirSync(base)) {
      if (!/FFmpeg/i.test(pkg)) continue;
      const pkgDir = path.join(base, pkg);
      for (const sub of fs.readdirSync(pkgDir)) candidates.push(path.join(pkgDir, sub, "bin", exe));
    }
  } catch (_) {}
  candidates.push("C:\\ffmpeg\\bin\\" + exe, "/usr/bin/" + name, "/usr/local/bin/" + name);
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch (_) {} }
  return null;
}

module.exports = { findTool, FFMPEG: findTool("ffmpeg"), FFPROBE: findTool("ffprobe") };