// ASR 端到端测试：真实语音 → 时间轴抽音频 → whisper 转写 → 字幕时间码
// 用法：node asrtest.js [语音文件] [模型名]
const fs = require("fs");
const path = require("path");
const A = require("./asr");
const { parseSubtitle } = require("./subtitle");

const US = 1e6;
const AUDIO = process.argv[2] || "C:\\Users\\chaoc\\AppData\\Local\\hermes\\cache\\scratch\\litecut_test\\speech_zh.wav";
const MODEL = process.argv[3] || "small";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log((cond ? "PASS " : "FAIL ") + name + " " + extra); };

(async () => {
  console.log("== 0) 环境 ==");
  console.log("   whisper-cli:", A.cliPath());
  const models = A.listModels();
  console.log("   模型:", models.map((m) => `${m.name}(${(m.size / 1e6).toFixed(0)}MB)`).join(", ") || "无");
  console.log("   音频:", AUDIO, fs.existsSync(AUDIO) ? (fs.statSync(AUDIO).size / 1024).toFixed(0) + "KB" : "不存在");
  ok("whisper-cli 存在", !!A.cliPath());
  ok("至少有一个模型", models.length > 0);
  ok("测试音频存在", fs.existsSync(AUDIO));
  if (fail) { console.log("\n环境不全，终止"); process.exit(1); }

  // 造一个"时间轴"：音频从 0.5s 开始，验证识别结果的时间码是否跟随时间轴
  const OFFSET = 0.5 * US;
  const project = {
    id: "ASR-TEST", fps: 30, canvas_config: { width: 1280, height: 720, background: "black" },
    materials: {
      videos: [], images: [], texts: [],
      audios: [{ id: "a1", path: AUDIO, name: path.basename(AUDIO), kind: "audio", duration: 9 * US, hasAudio: true }],
    },
    tracks: [
      { id: "tk-v", type: "video", name: "主轨", segments: [] },
      { id: "tk-a", type: "audio", name: "音频", segments: [
        { id: "s1", material_id: "a1", target_timerange: { start: OFFSET, duration: 9 * US },
          source_timerange: { start: 0, duration: 9 * US }, volume: 1 },
      ] },
    ],
  };
  ok("时间轴有音频段", !!require("./exporter").buildAudioExtract(project, "x.wav"));

  console.log("\n== 1) 抽时间轴音频 → 转写（模型 " + MODEL + "，可能要几十秒）==");
  const t0 = Date.now();
  const r = await A.transcribe({ project, language: "zh", model: MODEL, maxLen: 20, onProgress: (p) => process.stdout.write("\r   进度 " + p + "%   ") });
  process.stdout.write("\r");
  if (!r.ok) { console.log("FAIL 转写失败: " + r.error); process.exit(1); }
  const cues = parseSubtitle(r.srt || "");
  const text = cues.map((c) => c.text).join("");
  console.log("   用时:", r.seconds + "s", "| 模型:", r.model, "| cue 数:", cues.length,
    "| 前导静音回补:", ((r.shiftedUs || 0) / US).toFixed(3) + "s");
  console.log("   转写全文:", text);
  cues.forEach((c, i) => console.log(`   [${i + 1}] ${(c.startUs / US).toFixed(2)}s → ${(c.endUs / US).toFixed(2)}s  ${c.text}`));

  console.log("\n== 2) 断言 ==");
  ok("转写出字幕", cues.length >= 1, "cue 数 " + cues.length);
  ok("文本长度足够", text.replace(/\s/g, "").length >= 8, "字数 " + text.replace(/\s/g, "").length);
  const kws = ["视频", "剪辑", "素材", "字幕", "导入", "画面"];
  const hit = kws.filter((k) => text.includes(k));
  ok("命中关键词 ≥2", hit.length >= 2, "命中 " + JSON.stringify(hit));
  ok("首条不早于时间轴起点", cues[0].startUs >= OFFSET - 0.3 * US, (cues[0].startUs / US).toFixed(2) + "s");
  ok("末条不超出总时长", cues[cues.length - 1].endUs <= 9 * US + 1.5 * US, (cues[cues.length - 1].endUs / US).toFixed(2) + "s");
  ok("时间码单调递增", cues.every((c, i) => i === 0 || c.startUs >= cues[i - 1].startUs));
  ok("每条时长合理(0.2~25s)", cues.every((c) => { const d = (c.endUs - c.startUs) / US; return d > 0.2 && d < 25; }));

  console.log(`\n== ASR 结果: ${pass} 通过 / ${fail} 失败 ==（总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  process.exit(fail ? 1 : 0);
})();