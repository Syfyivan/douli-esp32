import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { createApplication } from "../server/app.mjs";
import { mergeSettings } from "../server/config.mjs";
import { defaults } from "../server/config.mjs";
import { buildSystemPrompt } from "../server/prompts.mjs";

const runtime = messages => JSON.parse(messages[0].content.split("\n").find(line => line.startsWith('{"assistantName":')));

test("changing time and recalled facts leaves all fixed instructions in a reusable prefix", () => {
  const options = { settings: defaults, outputMode: "voice", model: "deepseek-flash", now: new Date("2026-10-21T02:00:00Z") };
  const before = buildSystemPrompt({ ...options, memoryContext: { facts: [{ value: "old fact" }] } });
  const after = buildSystemPrompt({ ...options, now: new Date("2026-10-21T02:00:07Z"), memoryContext: { facts: [{ value: "corrected fact" }] } });
  const cut = before.indexOf("## 相关记忆\n");
  assert.ok(cut > 1000);
  assert.equal(before.slice(0, cut), after.slice(0, cut));
  assert.ok(after.includes("corrected fact") && !after.includes("old fact"));
  assert.ok(after.includes("2026-10-21T02:00:07.000Z"));
  assert.ok(before.indexOf("## 结束本次语音聊天") < cut);
});

test("all chat topics describe the shared model without exposing provider credentials", async t => {
  const received = [];
  const mock = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); received.push(body);
    res.setHeader("Content-Type", "text/event-stream");
    res.end('data: {"model":"provider-reported-version","choices":[{"delta":{"content":"协议测试回答。"}}]}\n\ndata: [DONE]\n\n');
  });
  mock.listen(0, "127.0.0.1"); await once(mock, "listening");
  const root = resolve(tmpdir()), dir = mkdtempSync(join(root, "douli-prompts-"));
  const app = await createApplication({ dataDir: dir, distDir: join(dir, "no-dist") });
  t.after(async () => {
    await app.close(); mock.closeAllConnections(); await new Promise(r => mock.close(r));
    if (!resolve(dir).startsWith(root + sep)) throw new Error("Unsafe cleanup");
    rmSync(dir, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${mock.address().port}/private-provider/v1`;
  const profile = model => ({ baseUrl, model, apiKey: "provider-secret-must-stay-out-of-context" });
  const settings = mergeSettings(app.store.settings(), {
    models: { daily: profile("fast-alias"), strong: { ...profile("strong-alias"), thinking: true } },
    assistant: { name: "测试豆梨" }, privacy: { autoMemory: false },
    memory: { semantic: false, maintenance: false, autoSummaries: false },
  });
  app.store.saveSettings(settings);
  const cases = [
    { text: "你是什么模型？", route: "auto", expected: "fast-alias" },
    { text: "介绍一下你自己", route: "learning", expected: "fast-alias" },
    { text: "介绍一下你自己", route: "learning", expected: "fast-alias", patch: { models: { learning: profile("specialist-alias") } } },
    { text: "介绍一下你自己", route: "learning", expected: "fast-alias", patch: { models: { learning: { model: "", baseUrl: "" }, strong: { model: "", baseUrl: "" } } } },
  ];
  for (const item of cases) {
    if (item.patch) app.store.saveSettings(mergeSettings(app.store.settings(), item.patch));
    const before = received.length;
    const response = await app.admin.inject({ method: "POST", url: "/api/chat", payload: { text: item.text, route: item.route } });
    const events = response.body.trim().split("\n").map(JSON.parse);
    const done = events.find(e => e.type === "done"); assert.ok(done, response.body);
    assert.equal(received.length, before + 1, "no extra model call is required to describe the model");
    const request = received.at(-1), facts = runtime(request.messages);
    assert.equal(request.model, item.expected);
    assert.equal(facts.requestedModel, request.model);
    assert.equal(facts.assistantName, "测试豆梨");
    assert.equal(facts.interaction, "文字");
    assert.equal(facts.modelKind, "语言模型");
    assert.equal(facts.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
    assert.ok(Math.abs(Date.now() - Date.parse(facts.utcTime)) < 5000);
    assert.deepEqual(facts.availableTools, request.tools.map(tool => tool.function.name));
    assert.ok(!JSON.stringify(request.messages).includes("provider-secret-must-stay-out-of-context"));
    assert.ok(!JSON.stringify(request.messages).includes("private-provider"));
    assert.equal(done.message.metadata.routing.model, "provider-reported-version", "response metadata still records what the provider reports, separately from its request alias");
  }
  assert.equal((await app.engine.run({ text: "你是什么模型？" })).message.metadata.routing.classifierStatus, "disabled");

  // Native audio may be offered, but the prompt must describe the path actually
  // selected for this turn, including the shared chat model for text-only workflows.
  app.store.saveSettings(settings);
  let nativeMessages, nativeCalls = 0, cancellations = 0;
  const realtime = {
    model: "native-voice-alias", cancel() { cancellations++; },
    async *stream(profile, messages) { nativeCalls++; nativeMessages = messages; yield { type: "text", text: "原生协议测试。" }; },
  };
  await app.engine.run({ text: "你是什么模型？", outputMode: "voice", realtime });
  assert.equal(runtime(nativeMessages).requestedModel, realtime.model);
  assert.equal(runtime(nativeMessages).modelKind, "原生实时语音模型");
  assert.equal(runtime(nativeMessages).interaction, "语音");
  assert.equal(cancellations, 0);
  await app.engine.run({ text: "介绍一下你自己", route: "learning", outputMode: "voice", realtime });
  assert.equal(nativeCalls, 1);
  assert.ok(cancellations > 0);
  assert.equal(runtime(received.at(-1).messages).requestedModel, "fast-alias");
  assert.equal(runtime(received.at(-1).messages).modelKind, "语言模型");
  assert.equal(runtime(received.at(-1).messages).interaction, "语音");
});
