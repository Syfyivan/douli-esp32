import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { defaults, mergeSettings, validateSettings, deviceConfig } from "../server/config.mjs";
import { routeRequest } from "../server/routing.mjs";
import { createApplication } from "../server/app.mjs";
import { Store } from "../server/store.mjs";
import WebSocket from "ws";

const profile = model => ({ ...defaults.models.daily, baseUrl: "http://localhost/v1", model, apiKey: "test-secret" });
const settings = () => mergeSettings(defaults, { models: { daily: profile("fast"), router: profile("classifier"), strong: { ...profile("strong"), thinking: true } } });
const classification = (patch = {}) => JSON.stringify({ route: "learning", complexity: "moderate", personalDecision: false, needsSearch: false, continuation: false, confidence: 0.95, ...patch });
const previous = (route = "health") => [
  { role: "user", text: "介绍一下免疫系统", status: "complete" },
  { role: "assistant", text: "免疫系统的介绍", status: "complete", route,
    metadata: { routing: { route, tier: "strong", complexity: "moderate", personalDecision: false, needsSearch: false } } },
];

test("semantic routing sees context, uses structured output and separates classification from answering", async () => {
  let calls = 0;
  const result = await routeRequest({ text: "先从最基础的部分开始", history: previous("learning"), settings: settings(),
    classify: async (p, messages, signal, options) => {
      calls++;
      assert.equal(p.model, "classifier"); assert.equal(p.thinking, false);
      assert.deepEqual(options.response_format, { type: "json_object" });
      const input = JSON.parse(messages[1].content);
      assert.equal(input.history.length, 2);
      assert.equal(input.current, "先从最基础的部分开始");
      return classification({ continuation: true });
    } });
  assert.equal(calls, 1);
  assert.equal(result.profile.model, "strong");
  assert.equal(result.metadata.route, "learning");
  assert.equal(result.metadata.source, "classifier");
  assert.equal(result.metadata.degraded, false);
  assert.ok(!JSON.stringify(result.metadata).includes("test-secret"));
});

test("manual modes and clear greetings skip classification; device supports learning", async () => {
  const classify = () => { throw new Error("should not classify"); };
  const manual = await routeRequest({ text: "失眠，先陪我聊聊天", requested: "daily", settings: settings(), classify });
  assert.equal(manual.profile.model, "fast"); assert.equal(manual.metadata.source, "manual");
  const greeting = await routeRequest({ text: "你好", settings: settings(), classify });
  assert.equal(greeting.metadata.classifierStatus, "skipped"); assert.equal(greeting.metadata.tier, "fast");
  assert.equal(deviceConfig({ route: "learning" }).route, "learning");
});

test("unambiguous everyday requests skip the remote classifier without losing manual mode", async () => {
  const s = settings();
  const classify = async () => { assert.fail("A complete everyday request must not wait for classification"); };
  for (const text of ["你是什么模型？", "请问你是什么模型呀？", "你好，你用的是什么大模型？",
    "豆梨，请问你叫什么名字？", "介绍一下你自己。", "你能帮我做什么？", "你有什么功能？",
    "你能听到我说话吗？", "你还在吗？", "陪我聊聊吧。", "我今天想随便聊聊天。", "我想和你聊一会儿。"] ) {
    let calls = 0;
    const result = await routeRequest({ text, settings: s, history: previous("health"),
      classify: async (...args) => { calls++; return classify(...args); } });
    assert.equal(calls, 0, text);
    assert.equal(result.metadata.route, "daily", text);
    assert.equal(result.metadata.tier, "fast", text);
    assert.equal(result.metadata.classifierStatus, "skipped", text);
    assert.equal(result.profile.model, "fast", text);
  }
  s.assistant.name = "小.豆";
  const named = await routeRequest({ text: "你好，小.豆，你是谁？", settings: s, classify });
  assert.equal(named.metadata.tier, "fast");
  const manual = await routeRequest({ text: "你是什么模型？", requested: "learning", settings: s, classify });
  assert.equal(manual.metadata.source, "manual");
  assert.equal(manual.profile.model, "strong");
});

test("everyday prefixes cannot bypass substantive questions, quoted text or depth requests", async () => {
  const cases = [
    ["你好，你是什么模型？另外我该不该停药？", "health"],
    ["陪我聊聊胸痛怎么办", "health"],
    ["你能帮我做什么？我想学习物理", "learning"],
    ["你是什么模型，认真分析一下它的工作原理", "reasoning"],
    ["分析一下‘你是谁’这个哲学问题", "reasoning"],
    ["翻译这句话：你是什么模型？", "learning"],
    ["我想和你聊聊离职的利弊", "reasoning"],
    ["你能做什么药物分析", "health"],
    ["不要只是陪我聊聊，帮我制定投资计划", "reasoning"],
    ["给我讲讲模型原理", "learning"],
  ];
  for (const [text, route] of cases) {
    let calls = 0;
    const result = await routeRequest({ text, settings: settings(), classify: async () => {
      calls++; return classification({ route, complexity: "complex" });
    } });
    assert.equal(calls, 1, text);
    assert.equal(result.metadata.route, route, text);
    assert.equal(result.metadata.tier, "strong", text);
  }
});

test("short follow-ups keep the previous topic and tier, but a new topic is reclassified", async () => {
  let calls = 0;
  const classify = async () => { calls++; return classification({ route: "daily", complexity: "simple" }); };
  const follow = await routeRequest({ text: "继续讲", history: previous(), settings: settings(), classify });
  assert.equal(calls, 0); assert.equal(follow.metadata.route, "health"); assert.equal(follow.profile.model, "strong");
  const fresh = await routeRequest({ text: "换个话题，陪我聊聊今天的趣事", history: previous(), settings: settings(), classify });
  assert.equal(calls, 1); assert.equal(fresh.metadata.route, "daily"); assert.equal(fresh.profile.model, "fast");
});

test("personal decisions, complex tasks and explicit depth requests have a quality floor", async () => {
  for (const [text, patch] of [["需要你帮我比较这两种选择", { personalDecision: true }], ["帮我处理这件事情", { complexity: "complex" }], ["认真分析这个问题", {}]]) {
    const r = await routeRequest({ text, settings: settings(), classify: async () => classification({ route: "daily", complexity: "simple", ...patch }) });
    assert.equal(r.metadata.tier, "strong"); assert.equal(r.profile.model, "strong");
  }
  const r = await routeRequest({ text: "我该不该停药", settings: settings(), history: previous("learning"),
    classify: async () => classification({ route: "daily", continuation: true }) });
  assert.equal(r.metadata.route, "health"); assert.equal(r.metadata.needsSearch, true);
});

test("malformed, uncertain and timed-out classifications degrade explicitly; caller abort never answers", async () => {
  for (const raw of ["not JSON", classification({ confidence: 2 }), classification({ personalDecision: "false" })]) {
    const r = await routeRequest({ text: "帮我考虑一下", settings: settings(), classify: async () => raw });
    assert.equal(r.metadata.source, "fallback"); assert.equal(r.metadata.classifierStatus, "invalid"); assert.equal(r.profile.model, "strong");
  }
  const low = await routeRequest({ text: "有点拿不准", settings: settings(), classify: async () => classification({ route: "daily", confidence: 0.3 }) });
  assert.equal(low.metadata.tier, "strong");
  const waiting = (_p, _m, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  const keepAlive = setInterval(() => {}, 50);
  try {
    const s = settings(); s.routing.timeoutMs = 30;
    const timed = await routeRequest({ text: "帮我考虑一下", settings: s, classify: waiting });
    assert.equal(timed.metadata.classifierStatus, "timeout"); assert.equal(timed.profile.model, "strong");
    const controller = new AbortController();
    const pending = routeRequest({ text: "帮我考虑一下", settings: settings(), signal: controller.signal, classify: waiting });
    controller.abort(new Error("user cancelled"));
    await assert.rejects(pending, /user cancelled/);
  } finally { clearInterval(keepAlive); }
});

test("profile priority, missing strong settings, identical model and invalid policy remain visible", async () => {
  const s = settings(); s.models.health = profile("health-specialist");
  assert.equal((await routeRequest({ text: "健康", requested: "health", settings: s })).profile.model, "health-specialist");
  s.models.health = defaults.models.health; s.models.strong = defaults.models.strong;
  const missing = await routeRequest({ text: "健康", requested: "health", settings: s });
  assert.equal(missing.metadata.degraded, true); assert.equal(missing.profile.model, "fast");
  s.models.strong = s.models.daily;
  assert.equal((await routeRequest({ text: "健康", requested: "health", settings: s })).metadata.degraded, true);
  for (const patch of [{ timeoutMs: -1 }, { historyMessages: 100 }, { confidenceThreshold: 0 }, { qualityFirst: "yes" }])
    assert.throws(() => validateSettings(mergeSettings(s, { routing: patch })), /路由/);
});

test("HTTP and voice share routing; persistence, forgotten history and source-check failures remain honest", async t => {
  const received = [];
  let decision = classification();
  const mock = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    if (req.url === "/v1/audio/speech") {
      res.setHeader("Content-Type", "application/octet-stream");
      return res.end(Buffer.alloc(4800));
    }
    const body = JSON.parse(Buffer.concat(chunks)); received.push(body);
    res.setHeader("Content-Type", body.stream ? "text/event-stream" : "application/json");
    if (body.model === "classifier") return res.end(JSON.stringify({ choices: [{ message: { content: decision } }] }));
    if (!body.stream) return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(
      body.messages[0].content.includes("转换为查资料") ? { zh: "用药", en: "medication", drugs: [] } :
      { spoken: "这是测试回答，未能核实的资料不能用于个人停药决定。", explanation: "测试回答", nextSteps: [], questions: [], urgency: "uncertain", citations: [] }
    ) } }] }));
    res.end('data: {"model":"strong-actual","choices":[{"delta":{"content":"这是测试回答。"}}]}\n\ndata: [DONE]\n\n');
  });
  mock.listen(0, "127.0.0.1"); await once(mock, "listening");
  const root = resolve(tmpdir()), dir = mkdtempSync(join(root, "douli-routing-"));
  const app = await createApplication({ dataDir: dir, distDir: join(dir, "no-dist") });
  t.after(async () => { await app.close(); mock.closeAllConnections(); await new Promise(r => mock.close(r));
    if (!resolve(dir).startsWith(root + sep)) throw new Error("Unsafe cleanup"); rmSync(dir, { recursive: true, force: true }); });
  const s = settings();
  s.models.tts = profile("tts");
  for (const k of ["daily", "router", "strong", "tts"]) s.models[k].baseUrl = `http://127.0.0.1:${mock.address().port}/v1`;
  s.privacy.autoMemory = false; s.memory.semantic = false; s.memory.maintenance = false; s.memory.autoSummaries = false;
  app.store.saveSettings(s);
  const session = app.store.session();
  const hidden = app.store.message(session.id, "user", "已遗忘的私人资料");
  app.store.db.prepare("INSERT INTO memory_exclusions VALUES (?)").run(hidden.id);
  const response = await app.admin.inject({ method: "POST", url: "/api/chat", headers: { host: "localhost" }, payload: { sessionId: session.id, text: "给我讲讲物理入门" } });
  const events = response.body.trim().split("\n").map(JSON.parse);
  const done = events.find(e => e.type === "done"); assert.ok(done, response.body);
  assert.equal(received[0].model, "classifier");
  assert.equal(received.find(r => r.stream).model, "strong");
  const textPrompt = received.find(r => r.stream).messages[0].content;
  assert.match(textPrompt, /"interaction":"文字"/);
  assert.doesNotMatch(textPrompt, /本轮回答将被朗读/);
  assert.ok(!JSON.stringify(received).includes("已遗忘的私人资料"));
  assert.equal(done.message.metadata.routing.model, "strong-actual");
  assert.equal(done.message.metadata.routing.route, "learning");
  assert.ok(events.some(e => e.type === "route" && e.routing.model === "strong-actual"));
  const reopened = new Store(dir);
  assert.equal(reopened.messages(session.id).at(-1).metadata.routing.model, "strong-actual"); reopened.close();
  const before = received.length;
  const follow = await app.engine.run({ sessionId: session.id, text: "继续讲" });
  assert.equal(follow.message.metadata.routing.source, "continuation"); assert.equal(received.length, before + 1);

  decision = classification({ route: "health", personalDecision: true, needsSearch: true });
  app.health.evidence.search = async () => ({ sources: [], services: [{ name: "权威网站", status: "failed", message: "尚未配置联网搜索" }] });
  const unchecked = await app.engine.run({ text: "我该不该停药" });
  assert.equal(unchecked.message.metadata.routing.searchStatus, "failed");
  assert.match(received.at(-1).messages.at(-1).content, /尚未配置联网搜索/);
  s.search.apiKey = "test-search-key"; app.store.saveSettings(s);
  app.health.evidence.search = async () => ({ sources: [], services: [{ name: "PubMed", status: "failed", message: "检索未完成" }] });
  const failed = await app.engine.run({ text: "我该不该停药" });
  assert.equal(failed.message.metadata.routing.searchStatus, "failed");
  assert.ok(!JSON.stringify(failed.message).includes("private upstream error"));
  app.health.evidence.search = async () => ({ sources: [{ id: "fixture", title: "Test source", url: "https://example.com/source", text: "Fixture, not clinical evidence" }], services: [] });
  const searched = await app.engine.run({ text: "我该不该停药" });
  assert.equal(searched.message.metadata.routing.searchStatus, "retrieved");
  assert.equal(searched.message.metadata.health.evidence.sources[0].url, "https://example.com/source");
  assert.ok(received.at(-1).messages.some(m => m.content?.includes("https://example.com/source")));

  decision = classification();
  await app.admin.listen({ port: 0, host: "127.0.0.1" });
  const ws = new WebSocket(`ws://127.0.0.1:${app.admin.server.address().port}/api/voice?route=auto`, { headers: { Origin: "http://127.0.0.1:8788" } });
  t.after(() => ws.terminate());
  await once(ws, "open");
  const hello = once(ws, "message");
  ws.send(JSON.stringify({ type: "hello", version: 1, audio_params: { format: "pcm", channels: 1, sample_rate: 16000 } }));
  assert.equal(JSON.parse((await hello)[0]).type, "hello");
  const voice = [], audio = [];
  const finished = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Voice routing timed out")), 5000);
    ws.on("message", (data, binary) => {
      if (binary) audio.push(data);
      else voice.push(JSON.parse(data));
      if (voice.some(e => e.type === "done") && voice.some(e => e.type === "tts" && e.state === "stop")) {
        clearTimeout(timer); resolve();
      }
    });
  });
  ws.send(JSON.stringify({ type: "text", text: "教我物理基础" }));
  await finished;
  const voiceDone = voice.find(e => e.type === "done");
  assert.match(received.at(-1).messages[0].content, /"interaction":"语音"/);
  assert.match(received.at(-1).messages[0].content, /本轮回答将被朗读/);
  assert.equal(voiceDone.message.metadata.routing.route, "learning");
  assert.equal(voiceDone.message.metadata.routing.model, "strong-actual");
  assert.ok(voice.some(e => e.type === "route" && e.routing.tier === "strong"));
  assert.ok(audio.length > 0);
  ws.close(); await once(ws, "close");
});
