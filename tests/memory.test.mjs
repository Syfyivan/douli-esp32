import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../server/store.mjs";
import { mergeSettings } from "../server/config.mjs";
import { putMemory, forgetMemory, retrieveMemories, evidenceFor, extractMemory, hash } from "../server/memory.mjs";
import { MemorySearch, estimateTokens, dateRange } from "../server/memory-search.mjs";
import { MemoryService } from "../server/memory-service.mjs";
import { MemoryDialogue, memoryIntent } from "../server/memory-dialogue.mjs";
import { recordCorrection } from "../server/input.mjs";

function fixture(t, patch = {}) {
  const directory = mkdtempSync(join(tmpdir(), "douli-memory-v2-"));
  const store = new Store(directory);
  store.saveSettings(mergeSettings(store.settings(), patch));
  t.after(() => {
    if (!store.closed) store.close();
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test cleanup");
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, directory };
}
const profile = { baseUrl: "http://embedding.invalid/v1", model: "test-vector" };
const syntheticEmbed = async (_profile, inputs) => inputs.map(text => /香菜|晚饭/.test(text) ? [1, 0, 0] : /上海|杭州/.test(text) ? [0, 1, 0] : [0, 0, 1]);

test("additive migration preserves legacy review state and is repeatable", t => {
  const { store, directory } = fixture(t);
  const m = putMemory(store, { name: "称呼", value: "小南", pinned: true, status: "suggested" });
  store.close();
  const reopened = new Store(directory);
  assert.equal(reopened.all("memories")[0].status, "suggested");
  assert.equal(reopened.all("memories")[0].pinned, 1);
  assert.equal(reopened.all("memories")[0].id, m.id);
  reopened.close();
  const legacyDir = mkdtempSync(join(tmpdir(), "douli-legacy-"));
  t.after(() => { if (!resolve(legacyDir).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe cleanup"); rmSync(legacyDir, { recursive: true, force: true }); });
  const old = new DatabaseSync(join(legacyDir, "douli.sqlite"));
  old.exec("CREATE TABLE memories (id TEXT PRIMARY KEY,name TEXT NOT NULL,value TEXT NOT NULL,quote TEXT NOT NULL DEFAULT '',source_id TEXT,status TEXT NOT NULL,pinned INTEGER NOT NULL DEFAULT 0,previous_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)");
  old.prepare("INSERT INTO memories VALUES (?,?,?,?,?,?,?,?,?,?)").run("old", "饮食", "不吃香菜", "", null, "active", 1, null, "2025-01-01", "2025-01-01");
  old.close();
  const migrated = new Store(legacyDir);
  assert.equal(migrated.all("memories")[0].value, "不吃香菜");
  assert.equal(migrated.all("memories")[0].subject, "user");
  assert.equal(retrieveMemories(migrated, "香菜")[0].id, "old");
  migrated.close();
});

test("hybrid retrieval fixes missing lexical overlap; negation alone is not a match; vectors survive reopen", async t => {
  const { store, directory } = fixture(t, { models: { embedding: profile } });
  const fact = putMemory(store, { name: "饮食偏好", value: "不吃香菜" });
  assert.equal(retrieveMemories(store, "这段代码不能运行").length, 0);
  assert.equal(retrieveMemories(store, "晚饭做什么合适").length, 0);
  const search = new MemorySearch(store, { embed: syntheticEmbed });
  await search.index();
  const result = await search.memories("晚饭做什么合适");
  assert.equal(result.mode, "hybrid");
  assert.equal(result.items[0].id, fact.id);
  store.close();
  const next = new Store(directory);
  const restored = new MemorySearch(next, { embed: syntheticEmbed });
  assert.equal((await restored.memories("晚饭做什么合适")).items[0].id, fact.id);
  next.close();
});

test("model changes invalidate vectors; semantic failures fall back without losing keyword results", async t => {
  const { store } = fixture(t, { models: { embedding: profile } });
  putMemory(store, { name: "饮食", value: "不吃香菜" });
  const search = new MemorySearch(store, { embed: syntheticEmbed });
  await search.index();
  store.saveSettings(mergeSettings(store.settings(), { models: { embedding: { model: "different" } } }));
  assert.equal(search.status().indexed, 0);
  assert.equal((await search.memories("香菜")).mode, "keyword");
  await search.index();
  search.embed = async () => { throw new Error("offline"); };
  assert.equal((await search.memories("香菜")).items.length, 1);
  assert.match(search.lastError, /关键词/);
});

test("independent attributes coexist, time-scoped replacements retain past truth, future facts stay out", async t => {
  const { store } = fixture(t);
  const coriander = putMemory(store, { name: "饮食偏好", value: "不吃香菜" });
  const noodles = putMemory(store, { name: "饮食偏好", value: "喜欢面条" });
  assert.equal(noodles.status, "active");
  assert.notEqual(coriander.predicate, noodles.predicate);
  const old = putMemory(store, { name: "居住地", value: "杭州", validFrom: "2025-01-01" });
  const newer = putMemory(store, { name: "居住地", value: "上海", validFrom: "2026-01-01", replace: true });
  assert.equal(newer.status, "active");
  const search = new MemorySearch(store);
  assert.equal((await search.memories("居住地", { at: "2025-06-01T00:00:00.000Z" })).items[0].id, old.id);
  assert.equal((await search.memories("居住地")).items[0].id, newer.id);
  putMemory(store, { name: "计划", value: "火星旅行", validFrom: "2099-01-01" });
  assert.equal((await search.memories("火星旅行")).items.length, 0);
});

test("duplicates preserve multiple original quotes; correcting either source invalidates the fact", t => {
  const { store } = fixture(t), session = store.session();
  const a = store.message(session.id, "user", "我不吃香菜"), b = store.message(session.id, "user", "我一直不吃香菜");
  const first = putMemory(store, { name: "饮食", value: "不吃香菜", quote: a.text, sourceId: a.id, pinned: true });
  const second = putMemory(store, { name: "饮食", value: "不吃香菜", quote: b.text, sourceId: b.id, status: "suggested", origin: "automatic" });
  assert.equal(first.id, second.id);
  assert.equal(evidenceFor(store, first.id).length, 2);
  recordCorrection(store, b.id, "我其实吃香菜");
  assert.equal(store.all("memories")[0].status, "needs_review");
  assert.equal(retrieveMemories(store, "香菜").length, 0);
});

test("source deletion and forgetting invalidate summaries and embeddings and suppress historical retrieval", async t => {
  const { store } = fixture(t, { models: { memory: profile, embedding: profile } });
  const session = store.session(), source = store.message(session.id, "user", "昨天去上海看望朋友");
  const service = new MemoryService(store, { embed: syntheticEmbed, complete: async () => JSON.stringify({ points: [{ text: "用户去上海看望朋友", evidence: [{ messageId: source.id, quote: source.text }] }] }) });
  t.after(() => service.stop());
  await service.summarize(service.summaryGroups()[0]);
  await service.search.index();
  const memory = putMemory(store, { name: "经历", value: "去上海看朋友", kind: "event", sourceId: source.id, quote: source.text });
  assert.ok((await service.search.history("上海")).length);
  forgetMemory(store, memory.id);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM memory_summaries").get().n, 0);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM memory_vectors WHERE kind='summary'").get().n, 0);
  assert.equal((await service.search.history("上海")).length, 0);
  assert.equal(store.messages(session.id).length, 1, "Original chat remains user-accessible");
});

test("summary validation rejects fabricated quotes and a correction during generation prevents stale writes", async t => {
  const { store } = fixture(t, { models: { memory: profile } });
  const session = store.session(), source = store.message(session.id, "user", "今天去了苏州");
  const service = new MemoryService(store, { complete: async () => ({}) });
  t.after(() => service.stop());
  service.complete = async () => JSON.stringify({ points: [{ text: "虚构内容", evidence: [{ messageId: source.id, quote: "没说过" }] }] });
  await service.summarize(service.summaryGroups()[0]);
  assert.equal(store.db.prepare("SELECT text FROM memory_summaries").get().text, "");
  service.complete = async () => {
    recordCorrection(store, source.id, "今天去了无锡");
    return JSON.stringify({ points: [{ text: "去了苏州", evidence: [{ messageId: source.id, quote: source.text }] }] });
  };
  assert.equal(await service.summarize(service.summaryGroups()[0]), false);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM memory_summaries").get().n, 0);
});

test("voice remember/correct/forget uses scoped expiring confirmation, never modifies another session", async t => {
  const { store } = fixture(t);
  const service = new MemoryService(store), a = store.session(), b = store.session();
  t.after(() => service.stop());
  const dialogue = new MemoryDialogue(service, { extractFacts: async (_s, m) => [{ name: "居住地", value: m.text.includes("上海") ? "上海" : "杭州", predicate: "residence", quote: m.text, sourceId: m.id }] });
  const speak = (s, text) => dialogue.handle(store.message(s.id, "user", text));
  assert.equal((await speak(a, "记住，我住杭州")).operation, "propose");
  assert.equal(store.all("memories").length, 0);
  assert.equal(await speak(b, "确认"), null);
  assert.equal((await speak(a, "确认")).operation, "remember");
  assert.equal(store.all("memories")[0].value, "杭州");
  await speak(a, "更正记忆，我现在住上海");
  assert.equal((await speak(a, "取消")).operation, "cancel");
  assert.equal(store.all("memories")[0].value, "杭州");
  await speak(a, "更正记忆，我现在住上海");
  await speak(a, "确认");
  assert.equal(store.all("memories").find(m => m.status === "active").value, "上海");
  assert.equal((await speak(a, "忘掉上海")).operation, "propose");
  await speak(a, "确认");
  assert.equal(store.all("memories").length, 0, "All versions of the fact are forgotten");
  assert.equal(memoryIntent("不要忘记这件事"), null);
  assert.equal(memoryIntent("如何删除记忆"), null);
});

test("stale confirmation cannot overwrite a concurrent edit and pending confirmation survives reopening", async t => {
  const { store, directory } = fixture(t);
  const service = new MemoryService(store), session = store.session();
  const original = putMemory(store, { name: "居住地", value: "杭州" });
  const dialogue = new MemoryDialogue(service, { extractFacts: async (_s, m) => [{ name: "居住地", value: "上海", predicate: "residence", sourceId: m.id, quote: m.text }] });
  await dialogue.handle(store.message(session.id, "user", "更正记忆，我现在住上海"));
  await service.stop(); store.close();
  const reopened = new Store(directory), next = new MemoryService(reopened), d = new MemoryDialogue(next);
  assert.ok(d.pending(session.id));
  putMemory(reopened, { ...reopened.all("memories")[0], value: "苏州", object: "苏州", replace: true });
  const result = await d.handle(reopened.message(session.id, "user", "确认"));
  assert.equal(result.operation, "stale");
  assert.equal(reopened.all("memories").find(m => m.status === "active").value, "苏州");
  assert.equal(reopened.all("memories").find(m => m.id === original.id).value, "杭州");
  await next.stop(); reopened.close();
});

test("background expiry, equivalent consolidation, source retention, profile and context budgets", async t => {
  const { store } = fixture(t, { models: { memory: profile }, memory: { contextTokens: 500, autoSummaries: false } });
  const session = store.session();
  const a = store.message(session.id, "user", "我不吃香菜"), b = store.message(session.id, "user", "我吃东西不要香菜");
  const first = putMemory(store, { name: "饮食", value: a.text, predicate: "food:香菜", sourceId: a.id, quote: a.text });
  const second = putMemory(store, { name: "饮食", value: b.text, predicate: "food:香菜", sourceId: b.id, quote: b.text, status: "suggested" });
  // Two already-confirmed equivalent imports are a consolidation case, not authorization to confirm a suggestion.
  store.db.prepare("UPDATE memories SET status='suggested' WHERE id=?").run(second.id);
  putMemory(store, { name: "临时状态", value: "出差", kind: "state", validFrom: "2020-01-01", validUntil: "2020-01-02" });
  const service = new MemoryService(store, { complete: async () => JSON.stringify({ duplicates: [{ keep: first.id, remove: second.id }] }) });
  t.after(() => service.stop());
  const report = await service.run();
  assert.equal(report.expired, 1);
  assert.equal(report.merged, 1);
  assert.equal(evidenceFor(store, first.id).length, 2);
  assert.equal(store.all("memories").find(m => m.id === second.id).status, "superseded");
  for (let i = 0; i < 20; i++) putMemory(store, { name: "固定" + i, value: "资料".repeat(100), pinned: true });
  const context = await service.context("香菜");
  assert.ok(context.estimatedTokens <= 500);
  assert.ok(estimateTokens({ core: context.core, facts: context.facts, episodes: context.episodes }) <= 500);
});

test("yesterday and last-week date ranges are local-calendar aware", () => {
  const now = new Date(2026, 9, 15, 10);
  const yesterday = dateRange("昨天", now);
  assert.equal(new Date(yesterday.from).getDate(), 14);
  assert.equal(new Date(yesterday.to).getDate(), 15);
  const week = dateRange("上周", now);
  assert.equal(new Date(week.from).getDay(), 1);
  assert.equal((Date.parse(week.to) - Date.parse(week.from)) / 86400000, 7);
});

test("a scheduled replacement retains current truth until its effective date", async t => {
  const { store } = fixture(t);
  const original = putMemory(store, { name: "居住地", value: "杭州", validFrom: "2020-01-01" });
  const future = putMemory(store, { name: "居住地", value: "上海", validFrom: "2099-01-01", replace: true });
  const search = new MemorySearch(store);
  assert.deepEqual((await search.memories("居住地")).items.map(m => m.id), [original.id]);
  assert.deepEqual((await search.memories("居住地", { at: "2099-01-02T00:00:00.000Z" })).items.map(m => m.id), [future.id]);
});

test("forgetting during summary retrieval removes both pinned and ordinary prompt facts", async t => {
  const { store } = fixture(t);
  const core = putMemory(store, { name: "固定资料", value: "猫叫小白", pinned: true });
  const fact = putMemory(store, { name: "饮食偏好", value: "不吃香菜" });
  const service = new MemoryService(store);
  t.after(() => service.stop());
  const rank = service.search.rank.bind(service.search);
  service.search.rank = async (...args) => {
    if (args[2] === "summary") { forgetMemory(store, core.id); forgetMemory(store, fact.id); }
    return rank(...args);
  };
  const context = await service.context("香菜");
  assert.equal(context.core.length, 0);
  assert.equal(context.facts.length, 0);
});

test("expired confirmation cannot write and a multi-fact failure rolls back every write", async t => {
  const { store } = fixture(t), session = store.session(), service = new MemoryService(store);
  t.after(() => service.stop());
  const dialogue = new MemoryDialogue(service, { extractFacts: async (_s, m) => [
    { name: "称呼", value: "小南", predicate: "name", sourceId: m.id, quote: m.text },
    { name: "居住地", value: "杭州", predicate: "residence", sourceId: m.id, quote: "不存在的证据" },
  ] });
  await dialogue.handle(store.message(session.id, "user", "记住，我叫小南，住杭州"));
  store.db.prepare("UPDATE memory_pending SET expires_at='2000-01-01T00:00:00.000Z'").run();
  assert.equal(await dialogue.handle(store.message(session.id, "user", "确认")), null);
  assert.equal(store.all("memories").length, 0);
  await dialogue.handle(store.message(session.id, "user", "记住，我叫小南，住杭州"));
  await assert.rejects(() => dialogue.handle(store.message(session.id, "user", "确认")), /证据/);
  assert.equal(store.all("memories").length, 0);
});

test("relevance verification removes semantic distractors and fails closed while preserving lexical hits", async t => {
  const { store } = fixture(t, { models: { memory: profile, embedding: profile } });
  const food = putMemory(store, { name: "饮食", value: "不吃香菜" });
  putMemory(store, { name: "居住地", value: "住在杭州" });
  const search = new MemorySearch(store, { embed: async (_p, inputs) => inputs.map(() => [1, 0]),
    verify: async (_p, messages) => JSON.stringify({ relevant: JSON.parse(messages[1].content).query.includes("晚饭") ? [food.id] : [] }) });
  await search.index();
  assert.deepEqual((await search.memories("晚饭做什么合适")).items.map(m => m.id), [food.id]);
  assert.equal((await search.memories("这段代码不能运行")).items.length, 0);
  search.verify = async () => { throw new Error("offline"); };
  assert.equal((await search.memories("晚饭做什么合适")).items.length, 0);
  assert.deepEqual((await search.memories("香菜")).items.map(m => m.id), [food.id]);
  assert.match(search.lastError, /核验暂不可用/);
});

test("matching a multi-topic summary does not return unrelated source messages", async t => {
  const { store } = fixture(t, { models: { memory: profile, embedding: profile } });
  const session = store.session(), food = store.message(session.id, "user", "我不吃香菜"), trip = store.message(session.id, "user", "去苏州见小林");
  const service = new MemoryService(store, { embed: async (_p, inputs) => inputs.map(() => [1, 0]),
    complete: async () => JSON.stringify({ points: [{ text: "用户不吃香菜，也提过苏州的行程", evidence: [{ messageId: food.id, quote: food.text }, { messageId: trip.id, quote: trip.text }] }] }),
    verify: async (_p, messages) => JSON.stringify({ relevant: JSON.parse(messages[1].content).records.filter(r => r.text.includes("香菜")).map(r => r.id) }) });
  t.after(() => service.stop());
  await service.summarize(service.summaryGroups()[0]);
  await service.search.index();
  assert.deepEqual((await service.search.history("晚饭做什么合适")).map(m => m.id), [food.id]);
});
