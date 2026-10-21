// Explicit paid-service check. Synthetic prompts stay in an isolated database.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDecipheriv } from "node:crypto";
import { Store } from "../server/store.mjs";
import { normalizeSettings } from "../server/config.mjs";
import { HomeService } from "../server/home.mjs";
import { ChatEngine } from "../server/engine.mjs";
import { routeRequest } from "../server/routing.mjs";

const actual = new DatabaseSync(resolve(".data/douli.sqlite"), { readOnly: true });
const encrypted = actual.prepare("SELECT value FROM settings WHERE id='config'").get(); actual.close();
const [nonce, tag, data] = encrypted.value.split(".").map(x => Buffer.from(x, "base64"));
const decipher = createDecipheriv("aes-256-gcm", readFileSync(resolve(".data/local.key")), nonce); decipher.setAuthTag(tag);
const settings = normalizeSettings(JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString()));
settings.privacy.autoMemory = false;
settings.memory.semantic = false; settings.memory.autoSummaries = false; settings.memory.maintenance = false;
const root = resolve(".runtime"); mkdirSync(root, { recursive: true });
const directory = mkdtempSync(join(root, "routing-check-"));
const store = new Store(directory);
const history = route => [{ role: "user", status: "complete", text: route === "health" ? "我在咨询用药问题" : "我想系统学习物理" },
  { role: "assistant", status: "complete", text: "我们继续讨论这个主题。", route,
    metadata: { routing: { route, tier: "strong", complexity: "moderate", personalDecision: route === "health", needsSearch: route === "health" } } }];
const cases = [
  { text: "你好", route: "daily" },
  { text: "我今天想随便聊聊天", route: "daily" },
  { text: "我想系统学习物理，从基础开始", route: "learning" },
  { text: "给我讲讲医学知识", route: "health" },
  { text: "我该不该停药", route: "health" },
  { text: "数学题：2x+3=11，求x", route: "reasoning" },
  { text: "两个人各执一词，没有证据，谁对谁错？", route: "debate" },
  { text: "继续讲", history: history("learning"), route: "learning" },
  { text: "为什么呢", history: history("health"), route: "health" },
  { text: "换个话题吧，今天想轻松聊聊天", history: history("health"), route: "daily" },
  { text: "失眠，先别分析，陪我聊聊", requested: "daily", route: "daily" },
  { text: "认真分析一下这件事", route: "reasoning" },
];
const report = { isolated: true, clinicalValidation: false, qualityBenchmark: false, passed: false, topics: [], requests: [], conversations: [] };
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (String(url) === settings.models.daily.baseUrl.replace(/\/$/, "") + "/chat/completions") {
    const body = JSON.parse(options.body);
    report.requests.push({ model: body.model, stream: body.stream === true, thinking: body.thinking, enable_thinking: body.enable_thinking });
  }
  return originalFetch(url, options);
};
let engine;
try {
  store.saveSettings(settings);
  for (const c of cases) {
    const { metadata } = await routeRequest({ text: c.text, history: c.history || [], requested: c.requested, settings, signal: AbortSignal.timeout(20000) });
    const passed = metadata.route === c.route && metadata.source === "fixed" && metadata.thinking === false && metadata.model === settings.models.daily.model;
    report.topics.push({ text: c.text, expected: { route: c.route }, passed, ...metadata });
    console.log(JSON.stringify({ text: c.text, passed, route: metadata.route, tier: metadata.tier, source: metadata.source, ms: metadata.routingMs }));
  }
  engine = new ChatEngine(store, new HomeService(store));
  let sessionId;
  for (const text of ["我想学习物理，先用两句话解释什么是惯性。", "继续讲，举一个例子，两句话就好。", "换个话题，简单陪我说一句晚安就好。"] ) {
    const result = await engine.run({ text, sessionId, signal: AbortSignal.timeout(150000) }); sessionId = result.session.id;
    report.conversations.push({ text, answer: result.text, routing: result.message.metadata.routing, timings: result.message.metadata.timings });
    console.log(JSON.stringify({ conversation: text, routing: result.message.metadata.routing, timings: result.message.metadata.timings }));
  }
  assert.ok(report.conversations.every(c => c.answer.trim() && c.routing.source === "fixed" && !c.routing.thinking));
  assert.ok(report.topics.every(c => c.passed), "Some local topic cases failed; inspect the report");
  assert.ok(report.requests.length >= 3);
  assert.ok(report.requests.every(r => r.stream && r.model === settings.models.daily.model), "No classifier or secondary chat model may be called");
  if (new URL(settings.models.daily.baseUrl).hostname === "api.deepseek.com")
    assert.ok(report.requests.every(r => r.thinking?.type === "disabled"));
  report.passed = true;
} catch (error) {
  report.failure = { name: error.name, message: error.message };
  throw error;
} finally {
  globalThis.fetch = originalFetch;
  report.checkedAt = new Date().toISOString();
  writeFileSync(join(root, "routing-check.json"), JSON.stringify(report, null, 2));
  await engine?.memory.stop(); store.close();
  if (!resolve(directory).startsWith(root + sep)) throw new Error("Unsafe cleanup path");
  rmSync(directory, { recursive: true, force: true });
}
