import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { createApplication } from "../server/app.mjs";
import { mergeSettings } from "../server/config.mjs";

const runtime = messages => JSON.parse(messages[0].content.split("\n").find(line => line.startsWith('{"assistantName":')));

test("answer requests describe the selected, overridden or fallback model without exposing provider credentials", async t => {
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
    { text: "介绍一下你自己", route: "learning", expected: "strong-alias" },
    { text: "介绍一下你自己", route: "learning", expected: "specialist-alias", patch: { models: { learning: profile("specialist-alias") } } },
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
  assert.equal((await app.engine.run({ text: "你是什么模型？" })).message.metadata.routing.classifierStatus, "skipped");

  // Native audio may be offered, but the prompt must describe the path actually
  // selected after routing, including falling back to a normal scene model.
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
  assert.equal(runtime(received.at(-1).messages).requestedModel, "strong-alias");
  assert.equal(runtime(received.at(-1).messages).modelKind, "语言模型");
  assert.equal(runtime(received.at(-1).messages).interaction, "语音");
});
