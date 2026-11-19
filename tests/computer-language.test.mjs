import test from "node:test";
import assert from "node:assert/strict";
import { correctComputerTranscript, COMPUTER_VOCABULARY } from "../server/computer-language.mjs";
import { processInput } from "../server/input.mjs";
import { asrCorpus } from "../server/volcengine-asr.mjs";
import { defaults } from "../server/config.mjs";

const observed = "请查看 ESP32项目现在有多少个奥卡绘画？只查询，不修改文件。";
const expected = "请查看 ESP32项目现在有多少个奥卡会话？只查询，不修改文件。";

test("Orca homophone correction preserves constraints and unrelated art requests", () => {
  assert.equal(correctComputerTranscript(observed), expected);
  for (const [before, after] of [
    ["Orca里面现在有几个绘画？", "Orca里面现在有几个会话？"],
    ["欧卡的绘画数量是多少？", "欧卡的会话数量是多少？"],
    ["请列出 Orca 绘画。", "请列出 Orca 会话。"],
    ["Orca有多少个绘画？另一个问题，我想学绘画。", "Orca有多少个会话？另一个问题，我想学绘画。"],
  ]) assert.equal(correctComputerTranscript(before), after);
  for (const text of [
    "我想学绘画。", "ESP32项目现在有几个绘画？", "Orca有几幅绘画？",
    "Orca项目有多少个绘画文件？", "Orca绘画作品有多少个？", "请列出Orca绘画任务。",
    "Orca项目有多少个绘画教程？", "Orca有几个绘画风格？", "让Orca创建绘画。",
    "Orca有几个会话，我想在其中一个学习绘画。", "Orca绘画了多少次？",
    "翻译：Orca有多少个绘画？", "他说Orca有几个绘画？", "请复述“Orca有多少个绘画”。",
    "转写把Orca会话识别成绘画了。", "MyOrca有多少个绘画？",
  ]) assert.equal(correctComputerTranscript(text), text);
});

test("transcript fallback only runs on voice input with computer control enabled and retains raw text", async () => {
  const settings = structuredClone(defaults); settings.input.refine = false;
  const store = { settings: () => settings, all: () => [] };
  const corrected = await processInput(store, observed, "", null, { voice: true, computerEnabled: true });
  assert.equal(corrected.text, expected);
  assert.equal(corrected.raw, observed);
  assert.equal(corrected.changed, true);
  for (const options of [{}, { voice: true }, { computerEnabled: true }, { voice: true, computerEnabled: false }]) {
    const result = await processInput(store, observed, "", null, options);
    assert.equal(result.text, observed); assert.equal(result.changed, false);
  }
});

test("ASR gets correct Orca session vocabulary and public context only when enabled", () => {
  const corpus = JSON.parse(asrCorpus(defaults, JSON.stringify({
    vocabulary: COMPUTER_VOCABULARY, computerEnabled: true, recent: [],
  })).context);
  assert.ok(corpus.hotwords.some(item => item.word === "Orca 会话"));
  assert.ok(corpus.hotwords.some(item => item.word === "会话"));
  assert.ok(!JSON.stringify(corpus).includes("绘画"));
  assert.ok(corpus.context_data.some(item => item.text.includes("会话数量")));
  const disabled = JSON.parse(asrCorpus(defaults, JSON.stringify({ vocabulary: [], computerEnabled: false })).context);
  assert.ok(!JSON.stringify(disabled).includes("Orca"));
});
