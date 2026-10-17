// Explicit paid-service check. Synthetic prompts stay in an isolated database.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDecipheriv } from "node:crypto";
import { Store } from "../server/store.mjs";
import { defaults, mergeSettings } from "../server/config.mjs";
import { HomeService } from "../server/home.mjs";
import { ChatEngine } from "../server/engine.mjs";
import { routeRequest } from "../server/routing.mjs";

const actual = new DatabaseSync(resolve(".data/douli.sqlite"), { readOnly: true });
const encrypted = actual.prepare("SELECT value FROM settings WHERE id='config'").get(); actual.close();
const [nonce, tag, data] = encrypted.value.split(".").map(x => Buffer.from(x, "base64"));
const decipher = createDecipheriv("aes-256-gcm", readFileSync(resolve(".data/local.key")), nonce); decipher.setAuthTag(tag);
const settings = mergeSettings(defaults, JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString()));
settings.privacy.autoMemory = false;
settings.memory.semantic = false; settings.memory.autoSummaries = false; settings.memory.maintenance = false;
const root = resolve(".runtime"); mkdirSync(root, { recursive: true });
const directory = mkdtempSync(join(root, "routing-check-"));
const store = new Store(directory);
const history = route => [{ role: "user", status: "complete", text: route === "health" ? "我在咨询用药问题" : "我想系统学习物理" },
  { role: "assistant", status: "complete", text: "我们继续讨论这个主题。", route,
    metadata: { routing: { route, tier: "strong", complexity: "moderate", personalDecision: route === "health", needsSearch: route === "health" } } }];
const cases = [
  { text: "你好", route: "daily", tier: "fast", source: "rule" },
  { text: "我今天想随便聊聊天", route: "daily", tier: "fast", source: "rule" },
  { text: "我想系统学习物理，从基础开始", route: "learning", tier: "strong", source: "classifier" },
  { text: "给我讲讲免疫系统的工作原理", route: "health", tier: "strong", source: "classifier" },
  { text: "我该不该停药", route: "health", tier: "strong", source: "classifier" },
  { text: "数学题：2x+3=11，求x", route: "reasoning", tier: "strong", source: "classifier" },
  { text: "两个人各执一词，没有证据，谁对谁错？", route: "debate", tier: "strong", source: "classifier" },
  { text: "继续讲", history: history("learning"), route: "learning", tier: "strong", source: "continuation" },
  { text: "那它为什么会这样呢", history: history("learning"), route: "learning", tier: "strong", source: "classifier" },
  { text: "换个话题吧，今天想轻松聊聊天", history: history("health"), route: "daily", tier: "fast", source: "classifier" },
  { text: "失眠，先别分析，陪我聊聊", requested: "daily", route: "daily", tier: "fast", source: "manual" },
  { text: "认真分析一下这件事", route: "reasoning", tier: "strong", source: "classifier" },
];
const report = { isolated: true, clinicalValidation: false, qualityBenchmark: false, passed: false, classification: [], conversations: [] };
let engine;
try {
  store.saveSettings(settings);
  for (const c of cases) {
    const { metadata } = await routeRequest({ text: c.text, history: c.history || [], requested: c.requested, settings, signal: AbortSignal.timeout(20000) });
    const passed = metadata.route === c.route && metadata.tier === c.tier && metadata.source === c.source;
    report.classification.push({ text: c.text, expected: { route: c.route, tier: c.tier, source: c.source }, passed, ...metadata });
    console.log(JSON.stringify({ text: c.text, passed, route: metadata.route, tier: metadata.tier, source: metadata.source, ms: metadata.routingMs }));
  }
  engine = new ChatEngine(store, new HomeService(store));
  let sessionId;
  for (const text of ["我想学习物理，先用两句话解释什么是惯性。", "继续讲，举一个例子，两句话就好。", "换个话题，简单陪我说一句晚安就好。"] ) {
    const result = await engine.run({ text, sessionId, signal: AbortSignal.timeout(150000) }); sessionId = result.session.id;
    report.conversations.push({ text, answer: result.text, routing: result.message.metadata.routing, timings: result.message.metadata.timings });
    console.log(JSON.stringify({ conversation: text, routing: result.message.metadata.routing, timings: result.message.metadata.timings }));
  }
  assert.equal(report.conversations[0].routing.tier, "strong");
  assert.equal(report.conversations[1].routing.route, "learning");
  assert.equal(report.conversations[1].routing.tier, "strong");
  assert.equal(report.conversations[2].routing.route, "daily");
  assert.equal(report.conversations[2].routing.tier, "fast");
  assert.ok(report.conversations.every(c => c.answer.trim() && !c.routing.degraded));
  assert.ok(report.classification.every(c => c.passed), "Some live classification cases failed; inspect the report");
  report.passed = true;
} catch (error) {
  report.failure = { name: error.name, message: error.message };
  throw error;
} finally {
  report.checkedAt = new Date().toISOString();
  writeFileSync(join(root, "routing-check.json"), JSON.stringify(report, null, 2));
  await engine?.memory.stop(); store.close();
  if (!resolve(directory).startsWith(root + sep)) throw new Error("Unsafe cleanup path");
  rmSync(directory, { recursive: true, force: true });
}
