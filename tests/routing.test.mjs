import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import WebSocket from "ws";
import { routeRequest } from "../server/routing.mjs";
import { defaults, mergeSettings, normalizeSettings, validateSettings, routes } from "../server/config.mjs";
import { createApplication } from "../server/app.mjs";
import { Store } from "../server/store.mjs";

const profile = model => ({ ...defaults.models.daily, baseUrl: "http://fixture/v1", model, apiKey: "fixture" });
const settings = () => mergeSettings(defaults, { models: { daily: profile("fast") } });
const previous = route => [{ role: "assistant", status: "complete", route,
  metadata: { routing: { route, tier: "strong", personalDecision: route === "health" } } }];

test("all topics, long questions and old strong-model preferences use one non-thinking profile without network routing", async () => {
  const s = settings();
  s.models.daily.thinking = true;
  for (const key of ["router", "strong", ...routes.filter(r => r !== "daily")])
    s.models[key] = { ...profile(key), thinking: true };
  s.routing = { enabled: true, qualityFirst: true };
  const classify = () => { assert.fail("classification must never run"); };
  for (const text of ["你好", "讲讲物理入门", "健康问题", "请证明这个数学结论", "认真分析，用强模型深度思考", "谁对谁错", "比较两种生活方式的优缺点".repeat(100)]) {
    for (const requested of ["auto", ...routes]) {
      const result = await routeRequest({ text, requested, settings: s, classify });
      assert.equal(result.profile.model, "fast");
      assert.equal(result.profile.thinking, false);
      assert.equal(result.metadata.profileKey, "daily");
      assert.equal(result.metadata.classifierStatus, "disabled");
      assert.equal(result.metadata.routingMs, 0);
    }
  }
  assert.equal(s.models.daily.thinking, true, "selection does not mutate caller settings");
});

test("local topic continuity keeps health privacy and source checks without switching models", async () => {
  const s = settings();
  const follow = await routeRequest({ text: "继续讲", history: previous("health"), settings: s });
  assert.equal(follow.metadata.route, "health");
  assert.equal(follow.metadata.continuation, true);
  assert.equal(follow.metadata.needsSearch, true);
  assert.equal(follow.profile.model, "fast");
  const changed = await routeRequest({ text: "你好", history: previous("health"), settings: s });
  assert.equal(changed.metadata.route, "daily");
  assert.equal(changed.metadata.continuation, false);
  const medical = await routeRequest({ text: "我该不该停药", history: previous("learning"), settings: s });
  assert.equal(medical.metadata.route, "health");
  assert.equal(medical.metadata.needsSearch, true);
  await assert.rejects(routeRequest({ text: "你好", settings: s, signal: AbortSignal.abort(new Error("cancelled")) }), /cancelled/);
});

test("legacy settings discard routing profiles and disable thinking in every model", () => {
  const legacy = settings();
  legacy.routing = { enabled: true, qualityFirst: true };
  legacy.models.strong = profile("strong");
  legacy.models.router = profile("classifier");
  legacy.models.health = profile("specialist");
  for (const model of Object.values(legacy.models)) model.thinking = true;
  const normalized = normalizeSettings(legacy);
  validateSettings(normalized);
  assert.equal(normalized.routing, undefined);
  for (const key of ["strong", "router", "health"]) assert.equal(normalized.models[key], undefined);
  assert.ok(Object.values(normalized.models).every(m => m.thinking === false));
  assert.equal(normalized.models.daily.apiKey, "fixture");
});

test("HTTP and voice share one model without classification; persistence, forgotten history and source-check failures remain honest", async t => {
  const received = [];
  const mock = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    if (req.url === "/v1/audio/speech") {
      res.setHeader("Content-Type", "application/octet-stream");
      return res.end(Buffer.alloc(4800));
    }
    const body = JSON.parse(Buffer.concat(chunks)); received.push(body);
    res.setHeader("Content-Type", body.stream ? "text/event-stream" : "application/json");
    if (!body.stream) return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(
      body.messages[0].content.includes("转换为查资料") ? { zh: "用药", en: "medication", drugs: [] } :
      { spoken: "这是测试回答，未能核实的资料不能用于个人停药决定。", explanation: "测试回答", nextSteps: [], questions: [], urgency: "uncertain", citations: [] }
    ) } }] }));
    res.end('data: {"model":"flash-actual","choices":[{"delta":{"content":"这是测试回答。"}}]}\n\ndata: [DONE]\n\n');
  });
  mock.listen(0, "127.0.0.1"); await once(mock, "listening");
  const root = resolve(tmpdir()), dir = mkdtempSync(join(root, "douli-routing-"));
  const app = await createApplication({ dataDir: dir, distDir: join(dir, "no-dist") });
  t.after(async () => { await app.close(); mock.closeAllConnections(); await new Promise(r => mock.close(r));
    if (!resolve(dir).startsWith(root + sep)) throw new Error("Unsafe cleanup"); rmSync(dir, { recursive: true, force: true }); });
  const s = settings();
  s.models.tts = profile("tts");
  for (const k of ["daily", "tts"]) s.models[k].baseUrl = `http://127.0.0.1:${mock.address().port}/v1`;
  s.privacy.autoMemory = false; s.memory.semantic = false; s.memory.maintenance = false; s.memory.autoSummaries = false;
  app.store.saveSettings(s);
  const session = app.store.session();
  const hidden = app.store.message(session.id, "user", "已遗忘的私人资料");
  app.store.db.prepare("INSERT INTO memory_exclusions VALUES (?)").run(hidden.id);
  const response = await app.admin.inject({ method: "POST", url: "/api/chat", headers: { host: "localhost" }, payload: { sessionId: session.id, text: "给我讲讲物理入门" } });
  const events = response.body.trim().split("\n").map(JSON.parse);
  const done = events.find(e => e.type === "done"); assert.ok(done, response.body);
  assert.equal(received.length, 1, "the answer starts without a classification request");
  assert.equal(received.find(r => r.stream).model, "fast");
  const textPrompt = received.find(r => r.stream).messages[0].content;
  assert.match(textPrompt, /"interaction":"文字"/);
  assert.doesNotMatch(textPrompt, /本轮回答将被朗读/);
  assert.ok(!JSON.stringify(received).includes("已遗忘的私人资料"));
  assert.equal(done.message.metadata.routing.model, "flash-actual");
  assert.equal(done.message.metadata.routing.route, "learning");
  assert.ok(events.some(e => e.type === "route" && e.routing.model === "flash-actual"));
  const reopened = new Store(dir);
  assert.equal(reopened.messages(session.id).at(-1).metadata.routing.model, "flash-actual"); reopened.close();
  const before = received.length;
  const follow = await app.engine.run({ sessionId: session.id, text: "继续讲" });
  assert.equal(follow.message.metadata.routing.continuation, true); assert.equal(received.length, before + 1);

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
  assert.equal(voiceDone.message.metadata.routing.model, "flash-actual");
  assert.ok(voice.some(e => e.type === "route" && e.routing.profileKey === "daily" && e.routing.thinking === false));
  assert.ok(audio.length > 0);
  assert.ok(received.every(r => r.model === "fast"), "health planning, answers and voice all use the same model");
  ws.close(); await once(ws, "close");
});
