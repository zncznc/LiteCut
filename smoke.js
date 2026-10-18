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

    // 4.6) 进阶能力：轨道开关 / 波纹删除 / 淡入淡出 / 同素材多实例 / 暂停拖播放头
    const adv = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const US = 1e6;
      const avg = (x, y, w, h) => {
        const d = document.querySelector("#preview").getContext("2d").getImageData(x, y, w, h).data;
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
        return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
      };
      const clipOf = (id, mid, start, dur, scale) => ({ id, material_id: mid, visible: true, speed: 1, volume: 1,
        target_timerange: { start, duration: dur }, source_timerange: { start: 0, duration: dur },
        clip: { alpha: 1, scale: { x: scale, y: scale }, transform: { x: 0, y: 0 }, rotation: 0 } });
      state.project.tracks = [
        { id: "tk-v", type: "video", name: "主轨", segments: [clipOf("s1", "mv-red", 0, 2 * US, 1), clipOf("s2", "mv-blue", 2 * US, 2 * US, 1)] },
        { id: "tk-a", type: "audio", name: "音频", segments: [
          { id: "s3", material_id: "ma-tone", visible: true, speed: 1, volume: 0.5,
            target_timerange: { start: 0, duration: 4 * US }, source_timerange: { start: 0, duration: 4 * US } }] },
      ];
      renderAll(); await wait(900);

      // (a) 轨道头开关
      const hasBtns = document.querySelectorAll('.track[data-tid="tk-v"] .thead .tbtn').length === 2;

      // (b) 隐藏 → 预览变黑；显示 → 回红
      setPlayhead(1 * US); await wait(700); drawFrame(1 * US);
      const before = avg(700, 400, 500, 260);
      document.querySelector('.track[data-tid="tk-v"] .thead .tbtn[data-act="vis"]').click();
      await wait(150); drawFrame(1 * US);
      const hidden = avg(700, 400, 500, 260);
      document.querySelector('.track[data-tid="tk-v"] .thead .tbtn[data-act="vis"]').click();
      await wait(150); setPlayhead(1 * US); await wait(700); drawFrame(1 * US);
      const shown = avg(700, 400, 500, 260);
      const visFlag = state.project.tracks[0].visible !== false;

      // (c) 静音开关
      const muteBtn = document.querySelector('.track[data-tid="tk-a"] .thead .tbtn[data-act="mut"]');
      muteBtn.click(); await wait(80);
      const muted = state.project.tracks[1].muted === true;
      document.querySelector('.track[data-tid="tk-a"] .thead .tbtn[data-act="mut"]').click(); await wait(80);
      const unmuted = state.project.tracks[1].muted !== true;

      // (d) 暂停状态下拖播放头 → 元素 seek 跟随（老版本这里画面不跟）
      setPlayhead(3 * US); await wait(900); drawFrame(3 * US);
      const t3 = avg(700, 400, 500, 260);
      const seeked = activeSegments(3 * US).map((a) => {
        const el = els.get(a.seg.id);
        return { id: a.seg.id, ct: el ? +el.currentTime.toFixed(2) : -1 };
      });

      // (e) 同一素材两个片段同时活动 → 各用各的元素
      state.project.tracks[0].segments.push(clipOf("s5", "mv-blue", 2 * US, 2 * US, 0.4));
      renderAll(); setPlayhead(3 * US); await wait(900); drawFrame(3 * US);
      const act3 = activeSegments(3 * US);
      const allOk = act3.every((a) => !!els.get(a.seg.id));
      const distinct = new Set(act3.map((a) => els.get(a.seg.id))).size === act3.length;
      state.project.tracks[0].segments = state.project.tracks[0].segments.filter((s) => s.id !== "s5");
      renderAll(); await wait(200);

      // (f) 波纹删除：删掉 s1(0-2s) 后，s2 应从 2s 左移到 0s
      state.sel = { trackId: "tk-v", segId: "s1" };
      rippleDeleteSel(); await wait(80);
      const s2start = state.project.tracks[0].segments.find((s) => s.id === "s2").target_timerange.start / US;
      const rippleStatus = document.querySelector("#status").textContent;

      // (g) 淡入淡出：属性面板有输入项，预览 alpha 随时间 ramp
      state.sel = { trackId: "tk-v", segId: "s2" };
      renderProps();
      const hasFadeInputs = !!document.querySelector('#propBody input[data-k="fadeIn"]')
        && !!document.querySelector('#propBody input[data-k="fadeOut"]');
      state.project.tracks[0].segments.find((s) => s.id === "s2").fade = { in: 1 * US, out: 0 };
      setPlayhead(0.1 * US); await wait(800); drawFrame(0.1 * US);
      const fadeLow = avg(700, 400, 500, 260);
      setPlayhead(1.0 * US); await wait(800); drawFrame(1.0 * US);
      const fadeFull = avg(700, 400, 500, 260);

      return { hasBtns, before, hidden, shown, visFlag, muted, unmuted, t3, seeked, allOk, distinct,
               s2start, rippleStatus, hasFadeInputs, fadeLow, fadeFull, elCount: els.size };
    })()`);
    check("轨道头有 显示/静音 两个开关", adv.hasBtns === true);
    check("隐藏主轨后预览变黑", adv.hidden[0] + adv.hidden[1] + adv.hidden[2] < 60, JSON.stringify(adv.hidden));
    check("恢复显示后预览回红", adv.shown[0] > adv.shown[2] + 40 && adv.visFlag === true, JSON.stringify(adv.shown));
    check("静音开关可切换", adv.muted === true && adv.unmuted === true);
    check("暂停拖播放头：画面跟到 3s（偏蓝）", adv.t3[2] > adv.t3[0] + 40, JSON.stringify(adv.t3));
    check("seek 后元素时间码跟随源时间", adv.seeked.every((s) => s.ct >= 0) && adv.seeked.some((s) => s.ct > 0.5), JSON.stringify(adv.seeked));
    check("同素材多实例各自独立元素", adv.allOk === true && adv.distinct === true, "元素数 " + adv.elCount);
    check("波纹删除：后续片段左移到 0s", Math.abs(adv.s2start) < 0.001, "s2 start=" + adv.s2start);
    check("波纹删除有状态提示", /波纹删除/.test(adv.rippleStatus), adv.rippleStatus);
    check("属性面板有淡入/淡出输入", adv.hasFadeInputs === true);
    check("预览淡入：0.1s 暗于 1.0s", adv.fadeLow[2] < adv.fadeFull[2] - 30, JSON.stringify([adv.fadeLow, adv.fadeFull]));

    // 4.7) 转场 / 多选成组 / 关键帧（界面级）
    const adv2 = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const US = 1e6;
      const clipOf = (id, mid, start, dur) => ({ id, material_id: mid, visible: true, speed: 1, volume: 1,
        target_timerange: { start, duration: dur }, source_timerange: { start: 0, duration: dur },
        clip: { alpha: 1, scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 }, rotation: 0 } });
      state.project.tracks = [{ id: "tk-v", type: "video", name: "主轨",
        segments: [clipOf("s1", "mv-red", 0, 2 * US), clipOf("s2", "mv-blue", 2 * US, 2 * US)] }];
      state.sel = null; state.multi = []; renderAll(); await wait(600);

      // (a) 转场
      setSelection("tk-v", "s1"); addTransition();
      const g1 = state.project.tracks[0].segments;
      const s1 = g1.find((s) => s.id === "s1"), s2 = g1.find((s) => s.id === "s2");
      const tr = { s2start: s2.target_timerange.start / US, fadeIn: (s2.fade && s2.fade.in) / US || 0,
                   s1out: (s1.fade && s1.fade.out) || 0, marked: !!(s1.transition && s1.transition.duration) };
      setPlayhead(1.75 * US); await wait(900); drawFrame(1.75 * US);
      const dt = document.querySelector("#preview").getContext("2d").getImageData(700, 400, 500, 260).data;
      let rr = 0, bb = 0, nn = 0;
      for (let i = 0; i < dt.length; i += 4) { rr += dt[i]; bb += dt[i + 2]; nn++; }
      const mid = [Math.round(rr / nn), Math.round(bb / nn)];

      // (b) 去转场还原
      setSelection("tk-v", "s1"); removeTransition();
      const back = state.project.tracks[0].segments.find((s) => s.id === "s2").target_timerange.start / US;

      // (c) 多选 → 成组 → 点选一个=整组
      setSelection("tk-v", "s1"); setSelection("tk-v", "s2", "toggle");
      const nSel = selList().length;
      groupSelected();
      const gid = state.project.tracks[0].segments[0].group_id;
      state.sel = null; state.multi = [];
      setSelection("tk-v", "s2", "group");
      const groupSel = selList().length;
      ungroupSelected();
      const ungrouped = !state.project.tracks[0].segments[0].group_id;

      // (d) 关键帧：记录两点后中间时刻应插值
      setSelection("tk-v", "s1");
      setPlayhead(0.2 * US); keyframeHere();
      const seg1 = state.project.tracks[0].segments.find((s) => s.id === "s1");
      setPlayhead(1.8 * US); kfWrite(seg1, "scale", 0.4);
      const midScale = +kfValueAt(seg1, 1.0 * US).scale.toFixed(3);
      renderProps();
      const hasKfRow = !!document.querySelector('#propBody [data-act="kfAdd"]');
      const kfRows = document.querySelectorAll("#propBody .kfrow").length;
      return { tr, mid, back, nSel, gid: !!gid, groupSel, ungrouped,
               kfCount: seg1.keyframes.length, midScale, hasKfRow, kfRows,
               status: document.querySelector("#status").textContent };
    })()`);
    check("转场：后段左移 0.5s、只有上层淡入、前者不淡出", adv2.tr.s2start === 1.5 && adv2.tr.fadeIn === 0.5 && adv2.tr.s1out === 0 && adv2.tr.marked, JSON.stringify(adv2.tr));
    check("转场中点预览=红蓝混合", adv2.mid[0] > 60 && adv2.mid[1] > 60, JSON.stringify(adv2.mid));
    check("去转场后重叠还原到 2.0s", Math.abs(adv2.back - 2) < 0.001, "s2 start=" + adv2.back);
    check("Ctrl 点选=选中 2 个片段", adv2.nSel === 2, String(adv2.nSel));
    check("成组后点选一个=选中整组", adv2.gid === true && adv2.groupSel === 2, JSON.stringify({ gid: adv2.gid, groupSel: adv2.groupSel }));
    check("解组生效", adv2.ungrouped === true);
    check("关键帧：两点插值落在中间", adv2.kfCount === 2 && adv2.midScale > 0.65 && adv2.midScale < 0.75, JSON.stringify({ n: adv2.kfCount, mid: adv2.midScale }));
    check("属性面板关键帧按钮+列表", adv2.hasKfRow === true && adv2.kfRows === 2, "行数 " + adv2.kfRows);

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