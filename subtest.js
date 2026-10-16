// 字幕模块单元测试：node subtest.js
const { parseSubtitle, toSRT, toVTT, autoSplitText, timeToUs, usToSrtTime } = require("./subtitle");

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : `\n     得到 ${JSON.stringify(got)}\n     期望 ${JSON.stringify(want)}`));
};
const ok = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log((cond ? "PASS " : "FAIL ") + name + " " + extra); };

// 1) 时间换算
eq("timeToUs 逗号毫秒", timeToUs("00:00:01,500"), 1500000);
eq("timeToUs 点毫秒", timeToUs("01:02:03.004"), 3723004000);
eq("usToSrtTime 往返", usToSrtTime(3723004000), "01:02:03,004");

// 2) SRT 解析（带 BOM / CRLF / 缺序号 / 样式标签）
const srt = "\uFEFF1\r\n00:00:00,000 --> 00:00:02,000\r\n第一句字幕\r\n\r\n" +
  "00:00:02,500 --> 00:00:04,000\r\n<i>第二句</i>\r\n跨行第二行\r\n\r\n" +
  "00:00:05,000 --> 00:00:06,000\r\n没序号的一条\r\n";
const cues = parseSubtitle(srt);
eq("SRT 解析条数", cues.length, 3);
eq("SRT 第1条", cues[0], { startUs: 0, endUs: 2000000, text: "第一句字幕" });
eq("SRT 去标签+多行合并", cues[1].text, "第二句\n跨行第二行");
eq("SRT 缺序号也能解析", cues[2].startUs, 5000000);

// 3) VTT 解析
const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nVTT 一条\n";
eq("VTT 解析", parseSubtitle(vtt)[0], { startUs: 1000000, endUs: 2500000, text: "VTT 一条" });

// 4) 生成 SRT / VTT
eq("toSRT 格式", toSRT([{ startUs: 0, endUs: 1500000, text: "甲" }]), "1\n00:00:00,000 --> 00:00:01,500\n甲\n");
ok("toVTT 头正确", toVTT([{ startUs: 0, endUs: 1000000, text: "乙" }]).startsWith("WEBVTT\n\n"));
ok("SRT 往返一致", parseSubtitle(toSRT(cues)).map((c) => c.text).join("|") === cues.map((c) => c.text).join("|"));

// 5) 自动打轴：多行 = 多条
const a = autoSplitText("第一行\n第二行\n第三行");
eq("多行→条数", a.length, 3);
ok("顺序不重叠", a.every((c, i) => i === 0 ? true : c.startUs >= a[i - 1].endUs), JSON.stringify(a.map((c) => [c.startUs, c.endUs])));
eq("首条起点", a[0].startUs, 0);

// 6) 自动打轴：单行长句按标点切 + 指定总时长
const b = autoSplitText("今天我们来做一个视频剪辑器，它要能导入素材、拼时间轴，最后导出成片。", 5e6, { maxChars: 14, totalUs: 8e6 });
ok("长句被切分", b.length >= 3, "条数 " + b.length);
ok("首条从指定起点开始", b[0].startUs === 5e6);
const span = b[b.length - 1].endUs - b[0].startUs;
ok("占用时长≈给定总长", Math.abs(span - 8e6) < 2e6, "span=" + (span / 1e6).toFixed(2) + "s");
ok("每条不超长", b.every((c) => c.text.length <= 16), JSON.stringify(b.map((c) => c.text.length)));

// 7) 边界
eq("空文本→0条", autoSplitText("").length, 0);
eq("杂乱文本不崩", parseSubtitle("这不是字幕\n随便写点").length, 0);

console.log(`\n== 字幕模块: ${pass} 通过 / ${fail} 失败 ==`);
process.exit(fail ? 1 : 0);