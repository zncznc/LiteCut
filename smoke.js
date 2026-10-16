// LiteCut 冒烟测试：真启动 Electron → 注入素材与片段 → 校验预览画布像素 → 截图
// Windows 上 Electron 不往控制台输出，结果同时写进 smoke.log
// 用法：npx electron smoke.js
const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");
const { registerIpc, setWindow } = require("./ipc");

const SCRATCH = "C:\\Users\\chaoc\\AppData\\Local\\hermes\\cache\\scratch\\litecut_test";
// 用独立 userData，避免和正式运行抢缓存
try { app.setPath("userData", path.join(SCRATCH, "lc_userdata")); } catch (_) {}
const RED = path.join(SCRATCH, "red.mp4");
const BLUE = path.join(SCRATCH, "blue.mp4");
const TONE = path.join(SCRATCH, "tone.wav");
const LOGF = path.join(SCRATCH, "smoke.log");
const SHOT = path.join(SCRATCH, "shot.png");

try { fs.mkdirSync(SCRATCH, { recursive: true }); } catch (_) {}
try { fs.writeFileSync(LOGF, "== LiteCut smoke " + new Date().toISOString() + " ==\n"); } catch (_) {}
const say = (m) => { console.log(m); try { fs.appendFileSync(LOGF, m + "\n"); } catch (_) {} };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = "") => { results.push({ name, ok, extra }); say((ok ? "PASS " : "FAIL ") + name + " " + extra); };

app.commandLine.appendSwitch("disable-gpu-vsync");
// 看门狗：卡住也要退出并留证据
const WATCH = setTimeout(() => {
  say("!! 看门狗触发（90s），结果: " + results.filter((r) => r.ok).length + "/" + results.length);
  app.exit(3);
}, 90000);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1500, height: 940, show: false, backgroundColor: "#1b1b1c",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false,
    },
  });
  const errs = [];
  win.webContents.on("console-message", (_e, level, msg) => { if (level >= 2) errs.push(msg); });
  setWindow(win);
  registerIpc();

  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    say("页面已加载");
    await sleep(1200);

    // 1) 基础环境
    const boot = await win.webContents.executeJavaScript(`(async () => {
      const info = await window.lc.info();
      return { hasLc: !!window.lc, ffmpeg: info.ffmpeg, tracks: state.project.tracks.length, canvas: state.project.canvas_config };
    })()`);
    check("preload 桥可用 (window.lc)", boot.hasLc);
    check("ffmpeg 已定位", !!boot.ffmpeg, boot.ffmpeg ? path.basename(boot.ffmpeg) : "无");
    check("初始 2 条轨道", boot.tracks === 2, String(boot.tracks));
    check("画布 1920x1080", boot.canvas.width === 1920 && boot.canvas.height === 1080);

    // 1.5) 语音识别 UI 就绪（不真跑识别，只验接线）
    await sleep(600);
    const asr = await win.webContents.executeJavaScript(`(() => {
      const sel = document.querySelector("#subModel");
      return {
        opts: [...sel.options].map(o => o.textContent),
        disabled: document.querySelector("#btnSubAsr").disabled,
        prog: document.querySelector("#asrProg").textContent,
        hasLCSub: typeof LCSub !== "undefined",
      };
    })()`);
    check("字幕模块已加载 (LCSub)", asr.hasLCSub === true);
    check("语音识别模型列表非空且按钮可用", asr.opts.length >= 1 && !asr.disabled, JSON.stringify(asr));

    // 2) 注入素材与片段（模拟导入结果，绕开文件对话框）
    const injected = await win.webContents.executeJavaScript(`(() => {
      const US = 1e6, T = (s, d) => ({ start: s, duration: d });
      const mk = (id, p, name, kind, dur, w, h, hasA) => ({ id, path: p, name, kind, duration: dur, width: w, height: h, hasVideo: kind !== "audio", hasAudio: hasA });
      state.project.materials.videos.push(mk("mv-red", ${JSON.stringify(RED)}, "red.mp4", "video", 3 * US, 640, 360, false));
      state.project.materials.videos.push(mk("mv-blue", ${JSON.stringify(BLUE)}, "blue.mp4", "video", 3 * US, 1280, 720, false));
      state.project.materials.audios.push(mk("ma-tone", ${JSON.stringify(TONE)}, "tone.wav", "audio", 4 * US, 0, 0, true));
      state.project.materials.texts.push({ id: "mt1", content: "LiteCut 轻剪", size: 96, color: "#FFFFFF" });
      state.media = [...state.project.materials.videos, ...state.project.materials.audios];
      state.project.tracks[0].segments.push({ id: "s1", material_id: "mv-red", visible: true, speed: 1, volume: 1,
        target_timerange: T(0, 2 * US), source_timerange: T(0, 2 * US), clip: { alpha: 1, scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 }, rotation: 0 } });
      state.project.tracks[0].segments.push({ id: "s2", material_id: "mv-blue", visible: true, speed: 1, volume: 1,
        target_timerange: T(2 * US, 2 * US), source_timerange: T(0, 2 * US), clip: { alpha: 1, scale: { x: 0.5, y: 0.5 }, transform: { x: 0, y: 0 }, rotation: 0 } });
      state.project.tracks[1].segments.push({ id: "s3", material_id: "ma-tone", visible: true, speed: 1, volume: 0.5,
        target_timerange: T(0, 4 * US), source_timerange: T(0, 4 * US), clip: { alpha: 1, scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 } } });
      state.project.tracks.push({ id: "tk-text", type: "text", name: "文字", segments: [
        { id: "s4", material_id: "mt1", visible: true, target_timerange: T(0, 4 * US), source_timerange: T(0, 4 * US), clip: { alpha: 1, scale: { x: 1, y: 1 }, transform: { x: 0, y: -320 }, rotation: 0 } }] });
      renderAll();
      return { tracks: state.project.tracks.length, segs: state.project.tracks.reduce((a, t) => a + t.segments.length, 0), dur: projectDuration() / US };
    })()`);
    check("注入后 3 轨 4 片段", injected.tracks === 3 && injected.segs === 4, JSON.stringify(injected));

    // 3) 预览画布像素采样
    await sleep(2500);
    const px = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const avg = () => {
        const g = document.querySelector("#preview").getContext("2d");
        const d = g.getImageData(700, 400, 500, 260).data; let r = 0, gg = 0, b = 0, n = 0;
        for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; }
        return [Math.round(r / n), Math.round(gg / n), Math.round(b / n)];
      };
      setPlayhead(1 * 1e6); await wait(700); drawFrame(1 * 1e6);
      const t1 = avg();
      setPlayhead(3 * 1e6); await wait(700); drawFrame(3 * 1e6);
      const t3 = avg();
      return { t1, t3, ready: [...els.values()].map(e => e.readyState) };
    })()`);
    check("t=1s 预览偏红", px.t1[0] > px.t1[2] + 50, JSON.stringify(px.t1));
    check("t=3s 预览偏蓝", px.t3[2] > px.t3[0] + 10, JSON.stringify(px.t3));
    check("视频元素就绪", px.ready.some((r) => r >= 2), JSON.stringify(px.ready));

    // 4) 分割 / 撤销 / 删除
    const edit = await win.webContents.executeJavaScript(`(() => {
      state.sel = { trackId: state.project.tracks[0].id, segId: "s1" };
      setPlayhead(1 * 1e6);
      const before = state.project.tracks[0].segments.length;
      splitAtPlayhead();
      const afterSplit = state.project.tracks[0].segments.length;
      undo();
      const afterUndo = state.project.tracks[0].segments.length;
      state.sel = { trackId: state.project.tracks[0].id, segId: "s1" };
      deleteSel();
      return { before, afterSplit, afterUndo, afterDel: state.project.tracks[0].segments.length };
    })()`);
    check("分割 1→2 段", edit.afterSplit === edit.before + 1, JSON.stringify(edit));
    check("撤销回 1 段", edit.afterUndo === edit.before);
    check("删除生效", edit.afterDel === edit.before - 1);

    // 4.5) 字幕：SRT 解析 / 导入渲染 / 批量打轴 / 往返 / 预览可见
    const sub = await win.webContents.executeJavaScript(`(() => {
      const srt = "1\\n00:00:00,200 --> 00:00:01,800\\n第一条字幕\\n\\n2\\n00:00:02,000 --> 00:00:03,600\\n第二条字幕\\n";
      const parsed = LCSub.parseSubtitle(srt);
      const n1 = importCues(parsed, true);
      const rendered = document.querySelectorAll("#cueList .cue").length;
      const roundTrip = LCSub.parseSubtitle(buildSRT()).map(c => c.text).join("|");
      const srtHasHeader = buildSRT().startsWith("1\\n00:00:00,200 --> 00:00:01,800");
      document.querySelector("#subText").value = "第一句台词。\\n第二句台词，稍微长一点的句子。";
      document.querySelector("#subMax").value = "10";
      document.querySelector("#subTotal").value = "6";
      const phBefore = state.playhead;
      batchGenerateCues();
      const afterGen = listCues().length;
      const firstStart = listCues()[0].startUs;
      setPlayhead(listCues()[0].startUs + 1e5);
      drawFrame(state.playhead);
      const d = document.querySelector("#preview").getContext("2d").getImageData(510, 860, 900, 160).data;
      let bright = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) bright++;
      return { parsed: parsed.length, n1, rendered, roundTrip, srtHasHeader, afterGen, firstStart, phBefore, bright };
    })()`);
    check("SRT 解析出 2 条", sub.parsed === 2, JSON.stringify(sub));
    check("导入后字幕列表 2 行", sub.n1 === 2 && sub.rendered === 2, "渲染行数 " + sub.rendered);
    check("SRT 往返文本一致", sub.roundTrip === "第一条字幕|第二条字幕", sub.roundTrip);
    check("SRT 头部时间码正确", sub.srtHasHeader === true);
    check("批量生成按行+标点断句", sub.afterGen >= 3, "条数 " + sub.afterGen);
    check("批量生成从播放头起（非 0）", sub.firstStart === sub.phBefore && sub.phBefore >= 0, "播放头 " + sub.phBefore + " → 首条 " + sub.firstStart);
    check("预览里字幕可见", sub.bright > 100, "字幕带亮像素 " + sub.bright);

    // 5) 截图（顺带验证不是黑屏）
    const img = await win.webContents.capturePage();
    fs.writeFileSync(SHOT, img.toPNG());
    const size = img.getSize();
    const bmp = img.toBitmap();
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < bmp.length; i += 40) { b += bmp[i]; g += bmp[i + 1]; r += bmp[i + 2]; n++; }
    const avg = [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    check("截图已保存", fs.existsSync(SHOT) && fs.statSync(SHOT).size > 5000, SHOT + " " + fs.statSync(SHOT).size + "B");
    // 窗口尺寸含标题栏，且高分屏缩放会放大设备像素，只做合理区间校验
    const okSize = size.width >= 1400 && size.width <= 2500 && size.height >= 800 && size.height <= 1600;
    check("截图尺寸符合窗口比例", okSize, JSON.stringify(size));
    check("截图非黑屏", avg[0] + avg[1] + avg[2] > 40, "平均色 " + JSON.stringify(avg));
    check("渲染进程无报错", errs.length === 0, errs.slice(0, 3).map((s) => s.slice(0, 90)).join(" | "));
  } catch (e) {
    say("!! 异常: " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : String(e)));
    check("脚本未抛异常", false, String(e).slice(0, 120));
  }

  clearTimeout(WATCH);
  const pass = results.filter((x) => x.ok).length;
  say("");
  say("== 冒烟结果: " + pass + "/" + results.length + " 通过 ==");
  say("截图: " + SHOT);
  app.exit(pass === results.length && results.length > 0 ? 0 : 1);
});