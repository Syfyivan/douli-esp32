import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { searchWeb, searchStatus, resolveSearchConfig, needsWebSearch } from "../server/web-search.mjs";
import { normalizeSettings, validateSettings, mergeSettings } from "../server/config.mjs";
import { createApplication } from "../server/app.mjs";
import { HealthEvidence } from "../server/health-evidence.mjs";

const rss = items => new Response(`<?xml version="1.0"?><rss version="2.0"><channel><title>Search</title>${items}</channel></rss>`);
const item = (url = "https://docs.espressif.com/test", title = "ESP32 官方文档", description = "测试搜索摘要") =>
  `<item><title>${title}</title><link>${url}</link><description>${description}</description></item>`;
const streamed = delta => new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);

test("default search needs no key and old Brave credentials retain their provider", () => {
  const settings = normalizeSettings({ search: { apiKey: "old-key" } });
  assert.equal(searchStatus(settings.search).provider, "brave");
  assert.equal(searchStatus({}).provider, "bing");
  assert.equal(searchStatus({ enabled: false }).available, false);
  assert.equal(searchStatus({ provider: "brave" }).available, false);
  for (const search of [{ enabled: "true" }, { provider: "other" }, { apiKey: 123 }])
    assert.throws(() => validateSettings(mergeSettings(settings, { search })), /联网搜索设置/);
});

test("automatic search prefers DeepSeek and only reuses official model credentials", () => {
  for (const baseUrl of ["https://api.deepseek.com", "https://api.deepseek.com/v1/"]) {
    const settings = normalizeSettings({ models: { daily: { baseUrl, apiKey: "official-key" } }, search: { apiKey: "brave-key" } });
    const config = resolveSearchConfig(settings);
    assert.equal(searchStatus(config).provider, "deepseek");
    assert.equal(config.deepseekApiKey, "official-key");
    assert.equal(settings.search.deepseekApiKey, "", "reuse does not copy credentials into settings");
  }
  for (const baseUrl of ["http://api.deepseek.com", "https://api.deepseek.com.other.example", "https://compatible.example/v1", "https://api.deepseek.com:444", "https://user:pass@api.deepseek.com"]) {
    const config = resolveSearchConfig(normalizeSettings({ models: { daily: { baseUrl, apiKey: "other-provider-secret" } } }));
    assert.equal(searchStatus(config).provider, "bing");
    assert.equal(config.deepseekApiKey, "");
  }
  const explicit = resolveSearchConfig(normalizeSettings({ search: { provider: "brave", apiKey: "brave-key", deepseekApiKey: "dedicated-key" } }));
  assert.equal(searchStatus(explicit).provider, "brave");
  assert.equal(searchStatus({ provider: "deepseek" }).available, false);
  assert.throws(() => validateSettings(normalizeSettings({ search: { deepseekApiKey: 42 } })), /联网搜索设置/);
});

test("DeepSeek uses authenticated POST, preserves dates and summaries, and enforces Unicode query limits", async () => {
  const config = { provider: "deepseek", deepseekApiKey: "search-secret", apiKey: "brave-secret" };
  const query = "🔎".repeat(128);
  const results = await searchWeb(config, query, undefined, { fetchImpl: async (url, options) => {
    assert.equal(String(url), "https://api.deepseek.com/v1/tools/search");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, "Bearer search-secret");
    assert.equal(options.headers["X-Subscription-Token"], undefined);
    assert.deepEqual(JSON.parse(options.body), { query, count: 5, need_content: false });
    return Response.json({ results: [{ title: "文档", url: "https://docs.espressif.com/", snippet: "短摘要", summary: "较长的模型阅读摘要", date: "2026-10-22T02:00:00+00:00", content: "full-page-must-not-enter-context" }] });
  } });
  assert.equal(results[0].provider, "deepseek");
  assert.equal(results[0].summary, "较长的模型阅读摘要");
  assert.equal(results[0].publishedAt, "2026-10-22T02:00:00.000Z");
  assert.ok(!JSON.stringify(results).includes("must-not-enter"));
  await assert.rejects(searchWeb(config, "🔎".repeat(129), undefined, { fetchImpl: () => assert.fail("overlong query must not be sent") }), /128/);
  await assert.rejects(searchWeb(config, "query", undefined, { fetchImpl: async () => Response.json({}) }), /无效数据/);
  await assert.rejects(searchWeb(config, "query", undefined, { fetchImpl: async () => new Response("search-secret", { status: 402 }) }), error => error.message.includes("402") && !error.message.includes("search-secret"));
  let attempts = 0;
  await assert.rejects(searchWeb(config, "query", undefined, { fetchImpl: async () => {
    attempts++; return new Response(null, { status: 302, headers: { location: "https://other.example/" } });
  } }), /无效数据/);
  assert.equal(attempts, 1);
});

test("RSS handles Chinese queries, single items, entities, duplicates and unsafe links", async () => {
  const results = await searchWeb({}, "乐鑫 官方文档", undefined, { fetchImpl: async (url, options) => {
    assert.equal(url.searchParams.get("q"), "乐鑫 官方文档");
    assert.equal(url.searchParams.get("format"), "rss");
    assert.equal(options.headers["X-Subscription-Token"], undefined);
    return rss(item("https://example.com/?a=1&amp;b=2", "&lt;b&gt;文档&lt;/b&gt; &amp; 指南", "摘要&#x4E2D;文") +
      item("https://example.com/?a=1&amp;b=2#part") + item("javascript:alert(1)") + item("https://user:pass@example.com/"));
  } });
  assert.equal(results.length, 1);
  assert.equal(results[0].title, "文档 & 指南");
  assert.equal(results[0].url, "https://example.com/?a=1&b=2");
  assert.equal(results[0].snippet, "摘要中文");
  assert.equal(results[0].provider, "bing");
  assert.ok(Number.isFinite(Date.parse(results[0].retrievedAt)));
  assert.equal((await searchWeb({}, "query", undefined, { fetchImpl: async () => rss(item()) })).length, 1);
  assert.deepEqual(await searchWeb({}, "query", undefined, { fetchImpl: async () => rss("") }), []);
});

test("Bing regional redirects stay within fixed search hosts and never forward Brave keys", async () => {
  let calls = 0;
  const results = await searchWeb({}, "ESP32", undefined, { fetchImpl: async (url, options) => {
    assert.equal(options.redirect, "manual");
    if (++calls === 1) return new Response(null, { status: 302, headers: { location: "https://cn.bing.com/search?format=rss&q=ESP32" } });
    assert.equal(url.hostname, "cn.bing.com"); return rss(item());
  } });
  assert.equal(results.length, 1);
  for (const config of [{}, { apiKey: "private-key" }]) {
    let attempts = 0;
    await assert.rejects(searchWeb(config, "query", undefined, { fetchImpl: async () => {
      attempts++; return new Response(null, { status: 302, headers: { location: "https://example.com/steal" } });
    } }), /无效数据/);
    assert.equal(attempts, 1);
  }
});

test("Brave keys travel only in headers; bad payloads, HTTP errors and huge responses fail safely", async () => {
  const results = await searchWeb({ apiKey: "private-key" }, "query", undefined, { fetchImpl: async (url, options) => {
    assert.equal(url.hostname, "api.search.brave.com");
    assert.ok(!String(url).includes("private-key"));
    assert.equal(options.headers["X-Subscription-Token"], "private-key");
    return Response.json({ web: { results: [{ title: "Source", url: "https://example.com", description: "<b>excerpt</b>" }] } });
  } });
  assert.equal(results[0].snippet, "excerpt");
  assert.equal(results[0].provider, "brave");
  for (const response of [new Response("secret upstream body", { status: 429 }), new Response("<html>captcha</html>"),
    rss('<!DOCTYPE rss [<!ENTITY x "bad">]>'), new Response("x".repeat(1024 * 1024 + 1))]) {
    await assert.rejects(searchWeb({}, "query", undefined, { fetchImpl: async () => response }), error => {
      assert.ok(!error.message.includes("secret")); return true;
    });
  }
  let called = false;
  for (const query of [null, {}, " ", "a".repeat(601), "word ".repeat(76)])
    await assert.rejects(searchWeb({}, query, undefined, { fetchImpl: async () => { called = true; } }), /搜索词/);
  assert.equal(called, false);
});

test("timeouts report failure and cancellation preserves the caller's abort reason", async () => {
  const fetchImpl = async (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  // AbortSignal.timeout timers do not keep Node alive on their own.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(searchWeb({}, "query", undefined, { fetchImpl, timeoutMs: 20 }), /超时/);
    const control = new AbortController(), reason = new Error("user stopped");
    const pending = searchWeb({}, "query", control.signal, { fetchImpl });
    control.abort(reason);
    await assert.rejects(pending, error => error === reason);
    await assert.rejects(searchWeb({}, "query", control.signal), error => error === reason);
  } finally { clearTimeout(keepAlive); }
});

test("source checks trigger for explicit search and timely questions, respecting opt-out", () => {
  for (const query of ["上网查一下 ESP32 官方文档", "上海明天天气如何", "最新科技新闻", "帮我查一下乐鑫官网", "search the web for ESP32"])
    assert.equal(needsWebSearch(query), true, query);
  for (const query of ["今天很开心", "讲讲三角函数", "不要联网，解释搜索原理", "不用上网查，凭常识回答", "解释原理 without browsing", "帮我查一下之前的聊天记录", "你能联网吗"])
    assert.equal(needsWebSearch(query), false, query);
});

async function fixture(t) {
  const root = resolve(tmpdir()), dir = mkdtempSync(join(root, "douli-web-search-"));
  const app = await createApplication({ dataDir: dir, distDir: join(dir, "no-dist") });
  t.after(async () => {
    await app.close();
    if (!resolve(dir).startsWith(root + sep)) throw new Error("Unsafe cleanup");
    rmSync(dir, { recursive: true, force: true });
  });
  app.store.saveSettings(mergeSettings(app.store.settings(), {
    models: { daily: { model: "fixture", baseUrl: "https://model.example/v1", apiKey: "model-private" } },
    privacy: { autoMemory: false }, memory: { semantic: false, autoSummaries: false, maintenance: false },
  }));
  return app;
}

test("search test API uses unsaved settings, preserves masked keys and exposes no secrets", async t => {
  const app = await fixture(t);
  app.store.saveSettings(mergeSettings(app.store.settings(), { search: { apiKey: "saved-secret" } }));
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url.hostname, "api.search.brave.com");
    assert.equal(options.headers["X-Subscription-Token"], "saved-secret");
    return Response.json({ web: { results: [{ title: "Source", url: "https://example.com", description: "excerpt" }] } });
  });
  const response = await app.admin.inject({ method: "POST", url: "/api/search/test", payload: { search: { provider: "brave", apiKey: "" } } });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().results.length, 1);
  assert.ok(!response.body.includes("saved-secret"));
  assert.equal(app.store.settings().search.provider, "auto", "test does not save the form");
  const disabled = await app.admin.inject({ method: "POST", url: "/api/search/test", payload: { search: { enabled: false } } });
  assert.equal(disabled.statusCode, 400);
  const state = await app.admin.inject({ url: "/api/state" });
  assert.equal(state.json().settings.search.apiKey, "");
  assert.equal(state.json().settings.search.hasKey, true);
});

test("DeepSeek search credentials are masked, retained by blank saves, and explicitly clearable", async t => {
  const app = await fixture(t);
  const put = payload => app.admin.inject({ method: "PUT", url: "/api/settings", payload });
  const saved = await put({ search: { provider: "deepseek", deepseekApiKey: "dedicated-secret" } });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().search.deepseekApiKey, "");
  assert.equal(saved.json().search.hasDeepseekKey, true);
  await put({ search: { deepseekApiKey: "" } });
  assert.equal(app.store.settings().search.deepseekApiKey, "dedicated-secret");
  const state = await app.admin.inject({ url: "/api/state" });
  assert.ok(!state.body.includes("dedicated-secret"));
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(String(url), "https://api.deepseek.com/v1/tools/search");
    assert.equal(options.headers.Authorization, "Bearer dedicated-secret");
    return Response.json({ results: [] });
  });
  const tested = await app.admin.inject({ method: "POST", url: "/api/search/test", payload: { search: { deepseekApiKey: "" } } });
  assert.equal(tested.statusCode, 200, tested.body);
  assert.equal(tested.json().provider, "deepseek");
  assert.ok(!tested.body.includes("dedicated-secret"));
  await put({ search: { deepseekApiKey: "" }, clearKeys: ["searchDeepseek"] });
  assert.equal(app.store.settings().search.deepseekApiKey, "");
  assert.equal(searchStatus(resolveSearchConfig(app.store.settings())).available, false);
});

test("DeepSeek searches on the model's decision with no separate router or extra request for chat", async t => {
  const app = await fixture(t);
  app.store.saveSettings(mergeSettings(app.store.settings(), { models: { daily: { baseUrl: "https://api.deepseek.com", apiKey: "official-secret" } } }));
  let modelCalls = 0, searchCalls = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const body = JSON.parse(options.body);
    if (String(url) === "https://api.deepseek.com/v1/tools/search") {
      searchCalls++;
      assert.equal(options.headers.Authorization, "Bearer official-secret");
      return Response.json({ results: [{ title: "官方文档", url: "https://docs.espressif.com/", snippet: "摘要", summary: "包含开发环境与烧录的说明" }] });
    }
    assert.equal(String(url), "https://api.deepseek.com/chat/completions");
    assert.equal(body.stream, true);
    assert.equal(body.tool_choice, undefined, "the model decides this search itself");
    assert.ok(!JSON.stringify(body.messages).includes("official-secret"));
    modelCalls++;
    if (body.messages.at(-1).content === "你好") return streamed({ content: "你好，我在。" });
    if (body.messages.at(-1).role !== "tool") return streamed({ tool_calls: [{ index: 0, id: "search-1", type: "function", function: { name: "web_search", arguments: '{"query":"ESP32 官方文档"}' } }] });
    assert.ok(body.messages.at(-1).content.includes("包含开发环境与烧录的说明"));
    return streamed({ content: "官方文档：https://docs.espressif.com/" });
  });
  const ordinary = await app.engine.run({ text: "你好" });
  assert.equal(ordinary.message.metadata.timings.modelCalls, 1);
  assert.equal(ordinary.message.metadata.timings.searchCalls, 0);
  assert.equal(modelCalls, 1); assert.equal(searchCalls, 0);
  const searched = await app.engine.run({ text: "ESP32 官方开发文档在哪里？" });
  assert.equal(searched.message.metadata.routing.classifierStatus, "disabled");
  assert.equal(searched.message.metadata.routing.searchStatus, "retrieved");
  assert.equal(searched.message.metadata.timings.modelCalls, 2);
  assert.equal(searched.message.metadata.timings.searchCalls, 1);
  assert.ok(searched.message.metadata.timings.searchMs >= 0);
  assert.equal(searched.message.metadata.tools[0].result[0].provider, "deepseek");
  assert.equal(modelCalls, 3); assert.equal(searchCalls, 1);
});

test("HTTP search precedes the answer, persists sources, and voice uses the same search path", async t => {
  const app = await fixture(t), requests = [];
  let searches = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (new URL(url).hostname === "www.bing.com") { searches++; return rss(item()); }
    const body = JSON.parse(options.body); requests.push(body);
    if (body.tool_choice) {
      assert.equal(body.tool_choice.function.name, "web_search");
      return streamed({ tool_calls: [{ index: 0, id: "search-1", type: "function", function: { name: "web_search", arguments: '{"query":"ESP32 Espressif"}' } }] });
    }
    assert.ok(body.messages.some(m => m.content?.includes("https://docs.espressif.com/test")));
    assert.ok(body.tools.some(t => t.function.name === "web_search"));
    return streamed({ content: "找到乐鑫官方文档，来源：https://docs.espressif.com/test" });
  });
  const response = await app.admin.inject({ method: "POST", url: "/api/chat", payload: { text: "上网查一下 ESP32 官方文档" } });
  const events = response.body.trim().split("\n").map(JSON.parse);
  const done = events.find(e => e.type === "done");
  assert.ok(done, response.body);
  assert.ok(events.findIndex(e => e.type === "tool") < events.findIndex(e => e.type === "delta"));
  assert.equal(done.message.metadata.routing.searchStatus, "retrieved");
  assert.equal(app.store.messages(done.message.session_id).at(-1).metadata.tools[0].result[0].url, "https://docs.espressif.com/test");
  let cancelled = 0;
  const voice = await app.engine.run({ text: "上网查一下 ESP32 官方文档", outputMode: "voice", realtime: {
    cancel() { cancelled++; }, stream() { assert.fail("timely query must use cascade tools"); },
  } });
  assert.equal(voice.message.metadata.routing.voiceMode, "cascade");
  assert.ok(cancelled > 0);
  assert.equal(searches, 2);
  assert.equal(requests.length, 4);
});

test("model-initiated searches update status and return tool results to the model", async t => {
  const app = await fixture(t);
  let rounds = 0, searches = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (new URL(url).hostname === "www.bing.com") { searches++; return rss(item()); }
    const body = JSON.parse(options.body);
    if (++rounds === 1) return streamed({ tool_calls: [{ index: 0, id: "search-1", type: "function", function: { name: "web_search", arguments: '{"query":"ESP32"}' } }] });
    assert.equal(body.messages.at(-1).role, "tool");
    assert.equal(body.messages.at(-1).tool_call_id, "search-1");
    assert.ok(body.messages.at(-1).content.includes("https://docs.espressif.com/test"));
    return streamed({ content: "找到相关官方文档。" });
  });
  const result = await app.engine.run({ text: "ESP32 的官方资料有哪些" });
  assert.equal(result.message.metadata.routing.searchStatus, "retrieved");
  assert.equal(searches, 1);
});

test("failed and empty searches stay visible; disabled and declined searches never fetch", async t => {
  const app = await fixture(t);
  let searches = 0, response = () => new Response("upstream-private", { status: 503 });
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (new URL(url).hostname === "www.bing.com") { searches++; return response(); }
    const body = JSON.parse(options.body);
    assert.ok(!JSON.stringify(body.messages).includes("upstream-private"));
    if (body.tool_choice) return streamed({ tool_calls: [{ index: 0, id: "search-1", type: "function", function: { name: "web_search", arguments: '{"query":"ESP32"}' } }] });
    return streamed({ content: "暂时未能联网核实。" });
  });
  for (const getResponse of [response, () => rss("")]) {
    response = getResponse;
    const result = await app.engine.run({ text: "上网查一下 ESP32" });
    assert.equal(result.message.metadata.routing.searchStatus, "failed");
  }
  await app.engine.run({ text: "不要联网，解释 ESP32 原理" });
  app.store.saveSettings(mergeSettings(app.store.settings(), { search: { enabled: false } }));
  assert.ok(!app.engine.voiceTools().some(t => t.function.name === "web_search"));
  const disabled = await app.engine.run({ text: "上网查一下 ESP32" });
  assert.equal(disabled.message.metadata.routing.searchStatus, "disabled");
  assert.equal(searches, 2);
});

test("medical web evidence shares providers and still filters to trusted domains", async t => {
  const app = await fixture(t);
  const evidence = new HealthEvidence(app.health.vault, { fetcher: async url => {
    assert.ok(url.searchParams.get("q").includes("site:who.int"));
    return rss(item("https://who.int/topic", "Trusted") + item("https://who.int.evil.example/topic", "Impostor"));
  } });
  const sources = await evidence.trustedWeb("健康");
  assert.equal(sources.length, 1);
  assert.equal(sources[0].organization, "who.int");
  assert.equal(sources[0].coverage, "search_snippet");
});

test("DeepSeek medical domain queries respect 128-character limits and deduplicate sources", async t => {
  const app = await fixture(t);
  app.store.saveSettings(mergeSettings(app.store.settings(), { search: { provider: "deepseek", deepseekApiKey: "medical-secret" } }));
  let calls = 0;
  const evidence = new HealthEvidence(app.health.vault, { fetcher: async (url, options) => {
    calls++;
    assert.equal(String(url), "https://api.deepseek.com/v1/tools/search");
    const body = JSON.parse(options.body);
    assert.ok([...body.query].length <= 128);
    assert.match(body.query, /site:/);
    assert.ok(body.query.startsWith("健康"));
    return Response.json({ results: [{ title: "Trusted", url: "https://who.int/topic", snippet: "摘要" }, { title: "Fake", url: "https://who.int.evil.example/topic" }] });
  } });
  const sources = await evidence.trustedWeb("健康".repeat(150));
  assert.equal(calls, 4);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].organization, "who.int");
  assert.equal(app.health.state().searchConfigured, true);
});

test("a model ignoring required search cannot publish an ungrounded answer", async t => {
  const app = await fixture(t), events = [];
  t.mock.method(globalThis, "fetch", async () => streamed({ content: "假装已经搜到了" }));
  await assert.rejects(app.engine.run({ text: "上网查一下 ESP32", emit: e => events.push(e) }), /未执行联网搜索/);
  assert.ok(!events.some(e => e.type === "delta" || e.type === "done"));
});

test("repeated tool queries share one fetch and an unsolicited call cannot bypass opt-out", async t => {
  const app = await fixture(t);
  let searches = 0, rounds = 0, expectedError = false;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (new URL(url).hostname === "www.bing.com") { searches++; return rss(item()); }
    const body = JSON.parse(options.body);
    if (++rounds % 2) return streamed({ tool_calls: [0, 1].map(index => ({ index, id: "query-" + index, type: "function",
      function: { name: "web_search", arguments: JSON.stringify({ query: index ? " ESP32 " : "ESP32" }) } })) });
    const results = body.messages.filter(m => m.role === "tool").map(m => JSON.parse(m.content));
    assert.equal(results.length, 2);
    assert.ok(results.every(r => expectedError ? r.error?.includes("不联网") : Array.isArray(r)));
    return streamed({ content: expectedError ? "本轮没有联网。" : "找到官方资料。" });
  });
  await app.engine.run({ text: "ESP32 官方资料有哪些" });
  assert.equal(searches, 1);
  expectedError = true;
  await app.engine.run({ text: "不要联网，介绍 ESP32" });
  assert.equal(searches, 1);
});
