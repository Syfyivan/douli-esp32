import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { complete, streamChat, synthesize } from "../server/providers.mjs";
import { createApplication } from "../server/app.mjs";
import { mergeSettings } from "../server/config.mjs";

const profile = { baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro", apiKey: "fixture-key" };
const frame = delta => `data: ${JSON.stringify({ model: profile.model, choices: [{ delta }] })}\n\n`;
const streamed = (...deltas) => new Response(deltas.map(frame).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });

test("stream usage preserves the last content and exposes only numeric counters", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response('data: ' + JSON.stringify({
    choices: [{ delta: { content: "完成。" } }],
    usage: { prompt_tokens: 1200, prompt_cache_hit_tokens: 1024, completion_tokens: 3,
      total_tokens: -1, prompt_cache_miss_tokens: "private-provider-body", secret: "not-public" },
  }) + '\n\ndata: [DONE]\n\n'));
  const events = [];
  for await (const event of streamChat(profile, [])) events.push(event);
  assert.deepEqual(events.find(e => e.type === "usage").usage,
    { prompt_tokens: 1200, completion_tokens: 3, prompt_cache_hit_tokens: 1024 });
  assert.equal(events.find(e => e.type === "text").text, "完成。");
  assert.ok(!JSON.stringify(events).includes("private-provider-body"));
  assert.ok(!JSON.stringify(events).includes("not-public"));
});

test("prepared speech is bounded in memory and rejects incomplete PCM samples", async t => {
  let cancelled = false;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(Buffer.alloc(20)); },
    cancel() { cancelled = true; },
  })));
  await assert.rejects(synthesize(profile, "测试", undefined, { maxBytes: 32 }), /音频过长/);
  assert.equal(cancelled, true, "an oversized response must stop being downloaded");
  t.mock.method(globalThis, "fetch", async () => new Response(Buffer.alloc(3)));
  await assert.rejects(synthesize(profile, "测试"), /不完整 PCM/);
});

test("official DeepSeek disables thinking in completion and streaming even with old thinking flags", async t => {
  const received = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const body = JSON.parse(options.body);
    received.push(body);
    assert.equal(url, profile.baseUrl + "/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer fixture-key");
    return body.stream ? streamed({ content: "连接成功" }) : Response.json({ choices: [{ message: { content: "连接成功" } }] });
  });
  for (const thinking of [false, true]) {
    await complete({ ...profile, thinking }, [{ role: "user", content: "测试" }]);
    for await (const event of streamChat({ ...profile, thinking }, [{ role: "user", content: "测试" }])) {
      if (event.type === "text") assert.equal(event.text, "连接成功");
    }
  }
  assert.deepEqual(received.map(r => r.thinking), Array.from({ length: 4 }, () => ({ type: "disabled" })));
  assert.ok(received.every(r => !("enable_thinking" in r) && !("thinking_budget" in r)));
});

test("SiliconFlow disables thinking and unrelated endpoints receive neither vendor's controls", async t => {
  const received = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    received.push(JSON.parse(options.body));
    return Response.json({ choices: [{ message: { content: "ok" } }] });
  });
  await complete({ ...profile, baseUrl: "https://api.siliconflow.cn/v1", model: "deepseek-ai/DeepSeek-V4-Pro", thinking: true }, []);
  await complete({ ...profile, baseUrl: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen3.5-35B-A3B", thinking: false }, []);
  for (const baseUrl of ["https://compatible.example/v1", "https://api.deepseek.com.example/v1"])
    await complete({ ...profile, baseUrl, thinking: true }, []);
  assert.equal(received[0].enable_thinking, false);
  assert.ok(!("thinking_budget" in received[0]));
  assert.equal(received[1].enable_thinking, false);
  assert.ok(!("thinking_budget" in received[1]));
  assert.ok(received.every(r => !("thinking" in r)));
  assert.ok(received.slice(2).every(r => !("enable_thinking" in r)));
});

test("tool rounds retain streamed reasoning internally without publishing or storing it", async t => {
  const root = resolve(tmpdir()), dir = mkdtempSync(join(root, "douli-deepseek-test-"));
  const app = await createApplication({ dataDir: dir, distDir: join(dir, "no-dist") });
  t.after(async () => {
    await app.close();
    if (!resolve(dir).startsWith(root + sep)) throw new Error("Unsafe cleanup");
    rmSync(dir, { recursive: true, force: true });
  });
  app.store.saveSettings(mergeSettings(app.store.settings(), {
    models: { daily: profile, strong: { ...profile, thinking: true } },
    privacy: { autoMemory: false },
    memory: { semantic: false, maintenance: false, autoSummaries: false },
  }));
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, profile.baseUrl + "/chat/completions");
    const body = JSON.parse(options.body);
    requests.push(body);
    if (!body.stream) return Response.json({ choices: [{ message: { content: "连接成功" } }] });
    if (requests.length === 1) return streamed(
      { reasoning_content: "private-reasoning-" },
      { reasoning_content: "fixture" },
      { tool_calls: [{ index: 0, id: "history-call", type: "function", function: { name: "history_search", arguments: '{"query":' } }] },
      { tool_calls: [{ index: 0, function: { arguments: '"测试暗号"}' } }] },
    );
    return streamed({ reasoning_content: "private-final-fixture" }, { content: "没有找到记录。" });
  });
  const response = await app.admin.inject({ method: "POST", url: "/api/chat", payload: { route: "learning", text: "以前的测试暗号是什么？" } });
  const events = response.body.trim().split("\n").map(JSON.parse);
  const done = events.find(e => e.type === "done");
  assert.ok(done, response.body);
  assert.equal(requests.length, 2);
  const continuation = requests[1].messages.find(m => m.tool_calls);
  assert.equal(continuation.reasoning_content, "private-reasoning-fixture");
  assert.equal(continuation.tool_calls[0].function.arguments, '{"query":"测试暗号"}');
  assert.equal(requests[1].messages.at(-1).tool_call_id, "history-call");
  assert.ok(requests.every(r => r.thinking.type === "disabled"));
  assert.ok(!response.body.includes("private-"));
  assert.ok(!JSON.stringify(app.store.messages(done.message.session_id)).includes("private-"));
  const check = await app.admin.inject({ method: "POST", url: "/api/models/test", payload: { kind: "daily" } });
  assert.equal(check.statusCode, 200);
  assert.equal(check.json().output, "连接成功");
  assert.equal(requests.at(-1).thinking.type, "disabled");
  assert.equal(app.store.settings().models.daily.thinking, false);
  assert.equal(app.store.settings().models.strong, undefined);
});
