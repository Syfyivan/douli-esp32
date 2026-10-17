// Explicit live check with synthetic questions, isolated from personal history.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { Store } from "../server/store.mjs";
import { HomeService } from "../server/home.mjs";
import { ChatEngine } from "../server/engine.mjs";

const actual = new Store(resolve(".data"));
const settings = actual.settings();
actual.close();
settings.privacy.autoMemory = false;
const root = resolve(".runtime");
mkdirSync(root, { recursive: true });
const directory = mkdtempSync(join(root, "route-check-"));
const store = new Store(directory);
const cases = [
  {
    id: "reasoning",
    expected: "reasoning",
    text: "数学题：2x+3=11，x等于几？先给答案，再用一句话解释。",
  },
  {
    id: "health",
    expected: "health",
    text: "我明天去看病，想提前整理给医生的信息。通常应该记录哪些内容？不要替我诊断。",
  },
  {
    id: "debate",
    expected: "debate",
    text: "请你当判官：甲说乙答应今天还钱，乙说约的是下周。双方没有聊天记录，也没有其他证据。你能判断谁在说谎吗？",
  },
  {
    id: "manual-daily",
    route: "daily",
    expected: "daily",
    text: "我最近失眠，今晚先别分析原因，也不要给建议。简单陪我说两句话就好。",
  },
];
const report = { isolated: true, clinicalValidation: false, cases: [] };
try {
  store.saveSettings(settings);
  const engine = new ChatEngine(store, new HomeService(store));
  for (const item of cases) {
    const result = await engine.run({
      text: item.text,
      route: item.route || "auto",
      signal: AbortSignal.timeout(60000),
    });
    assert.equal(result.message.route, item.expected);
    assert.ok(result.text.trim());
    if (item.id === "reasoning") assert.match(result.text, /4|四/);
    const selected = settings.models[item.expected];
    report.cases.push({
      id: item.id,
      route: result.message.route,
      model: result.message.metadata.routing?.model || (selected.baseUrl ? selected.model : settings.models.daily.model),
      prompt: item.text,
      answer: result.text,
      timings: result.message.metadata.timings,
    });
    console.log(JSON.stringify(report.cases.at(-1)));
  }
  report.checkedAt = new Date().toISOString();
  writeFileSync(
    join(root, "route-check.json"),
    JSON.stringify(report, null, 2),
  );
} finally {
  store.close();
  if (!resolve(directory).startsWith(root + sep))
    throw new Error("Unsafe cleanup path");
  rmSync(directory, { recursive: true, force: true });
}
