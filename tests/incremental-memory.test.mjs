import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Store } from "../server/store.mjs";
import { MemoryService } from "../server/memory-service.mjs";
import { putMemory, evidenceFor, forgetMemory, canonicalFact } from "../server/memory.mjs";
import { organizeTurn } from "../server/memory-turn.mjs";
import { mergeSettings } from "../server/config.mjs";
import { SyncStore } from "../server/sync-store.mjs";
import { memoryQuery, dateRange, localDay } from "../server/memory-search.mjs";

function fixture(t, patch = {}) {
  const directory = mkdtempSync(join(tmpdir(), "douli-incremental-")), store = new Store(directory);
  store.saveSettings(mergeSettings(store.settings(), { models: { memory: { baseUrl: "https://memory.invalid/v1", model: "fixture" } },
    memory: { semantic: false, maintenance: false }, ...patch }));
  t.after(() => {
    if (!store.closed) store.close();
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe cleanup");
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, directory };
}
function service(t, store, respond) {
  const worker = new MemoryService(store, { complete: async (_p, messages) => JSON.stringify(await respond(JSON.parse(messages[1].content), messages[0].content)) });
  worker.schedule = () => {};
  t.after(() => worker.stop());
  return worker;
}
function turn(store, text, reply = "好的。", session = store.session()) {
  const user = store.message(session.id, "user", text), assistant = store.message(session.id, "assistant", reply);
  return { user, assistant, session };
}
const fact = (quote, predicate, value = quote, fields = {}) => ({ action: "add", name: predicate, value, object: value,
  subject: "user", predicate, kind: "fact", quote, evidence: [], ...fields });
const episode = (quote, at, fields = {}) => ({ text: quote, kind: "event", occurredAt: at, quote, evidence: [], ...fields });

test("redundant model attribute labels normalize without collapsing distinct attributes", () => {
  assert.equal(canonicalFact({ predicate: "residence:常住地" }).predicate, "residence");
  assert.equal(canonicalFact({ predicate: "work_location:工作城市" }).predicate, "work_location");
  assert.equal(canonicalFact({ predicate: "name:英文名" }).predicate, "name:英文名");
  assert.equal(canonicalFact({ predicate: "food:香菜" }).predicate, "food:香菜");
});

test("a complete turn extracts more than three facts, keeps assistant context and separates dated experiences", async t => {
  const { store } = fixture(t), session = store.session();
  store.message(session.id, "user", "我的表哥叫小林。");
  const prompt = store.message(session.id, "assistant", "他在哪里工作？你有什么饮食偏好？");
  const text = "小林在苏州工作。我不吃香菜。我喜欢面条。我养了一只猫。我是程序员。我住上海。昨天和朋友吃了火锅。";
  const current = turn(store, text, "了解了，我建议你下次去北京旅游。", session);
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1); yesterday.setHours(18, 0, 0, 0);
  const worker = service(t, store, input => {
    assert.equal(input.turn.assistant, current.assistant.text);
    assert.ok(input.earlierMessages.some(m => m.id === prompt.id && m.role === "assistant"));
    return { facts: [fact("小林在苏州工作", "work_location", "小林在苏州工作", { subject: "小林" }),
      fact("我不吃香菜", "food:香菜", "用户不吃香菜", { kind: "preference" }), fact("我喜欢面条", "food:面条", "用户喜欢面条", { kind: "preference" }),
      fact("我养了一只猫", "pet"), fact("我是程序员", "occupation"), fact("我住上海", "residence")],
      episodes: [episode("昨天和朋友吃了火锅", yesterday.toISOString())] };
  });
  worker.enqueue(current.user, current.assistant);
  const report = await worker.run();
  assert.equal(report.extracted, 6);
  assert.ok(store.all("memories").every(m => m.status === "suggested" && m.kind !== "event"));
  assert.equal(store.db.prepare("SELECT count(*) n FROM memory_episodes").get().n, 1);
  assert.ok(store.all("memories").every(m => evidenceFor(store, m.id).some(e => e.message_id === current.user.id)));
  assert.equal(store.db.prepare("SELECT count(*) n FROM memory_jobs").get().n, 0);
  const context = await worker.context("我昨天都做了什么？");
  assert.equal(context.intent, "episodes");
  assert.equal(context.episodes.length, 1);
  assert.match(context.episodes[0].summary, /火锅/);
  assert.equal(context.episodes[0].day, localDay(yesterday));
  assert.equal(context.facts.length, 0, "Unconfirmed facts remain out of the prompt");
});

test("assistant-only evidence, unrelated targets and invented evidence cannot enter memory", async t => {
  const { store } = fixture(t), current = turn(store, "我不吃香菜", "你住北京，我猜的。");
  const worker = service(t, store, () => ({ facts: [fact("你住北京", "residence"),
    fact("我不吃香菜", "food:香菜", "不吃香菜", { action: "update", targetId: "made-up" }),
    fact("我不吃香菜", "food:香菜", "不吃香菜", { evidence: [{ messageId: current.assistant.id, quote: current.assistant.text }] })],
    episodes: [episode("你住北京", new Date().toISOString())] }));
  worker.enqueue(current.user, current.assistant); const report = await worker.run();
  assert.equal(report.failures, 1, "A wholly rejected nonempty extraction must remain retryable");
  assert.equal(store.db.prepare("SELECT attempts FROM memory_jobs WHERE message_id=?").get(current.user.id).attempts, 1);
  assert.equal(store.all("memories").length, 0);
  assert.equal(store.db.prepare("SELECT count(*) n FROM memory_episodes").get().n, 0);
});

test("updates and expiry are reviewable changes and preserve the old validity interval", async t => {
  const { store } = fixture(t);
  const old = putMemory(store, { name: "居住地", value: "用户住杭州", predicate: "residence", validFrom: "2020-01-01" });
  const current = turn(store, "我从杭州搬到上海了，现在住上海。");
  const worker = service(t, store, input => {
    assert.ok(input.existingMemories.some(m => m.id === old.id));
    return { facts: [fact(current.user.text, "residence", "用户住上海", { action: "update", targetId: old.id, validFrom: "2026-01-01" })], episodes: [] };
  });
  worker.enqueue(current.user, current.assistant); await worker.run();
  let pending = store.all("memories").find(m => m.target_id === old.id);
  assert.equal(pending.change_action, "update");
  assert.equal(store.all("memories").find(m => m.id === old.id).status, "active");
  const updated = putMemory(store, { ...pending, status: "active", replace: true });
  assert.equal(updated.status, "active");
  assert.equal(store.all("memories").find(m => m.id === old.id).valid_until, new Date("2026-01-01T00:00:00").toISOString());
  const end = turn(store, "我已经不住上海了，昨天搬走了。");
  const endAt = new Date(); endAt.setDate(endAt.getDate() - 1);
  worker.complete = async () => JSON.stringify({ facts: [fact(end.user.text, "residence", "用户住上海", { action: "expire", targetId: updated.id, validUntil: endAt.toISOString() })], episodes: [] });
  worker.enqueue(end.user, end.assistant); await worker.run();
  pending = store.all("memories").find(m => m.target_id === updated.id && m.status === "conflict");
  assert.equal(pending.change_action, "expire");
  const expired = putMemory(store, { ...pending, status: "active", replace: true });
  assert.equal(expired.status, "expired");
  assert.equal(expired.valid_from, updated.valid_from);
  assert.equal(expired.valid_until, endAt.toISOString());
  assert.ok(evidenceFor(store, expired.id).some(e => e.message_id === end.user.id));
});

test("a stale proposal cannot replace an intervening manual correction", async t => {
  const { store } = fixture(t), old = putMemory(store, { name: "居住地", value: "杭州", predicate: "residence" });
  const current = turn(store, "我从杭州搬到上海了。");
  const worker = service(t, store, () => ({ facts: [fact(current.user.text, "residence", "上海", { action: "update", targetId: old.id })], episodes: [] }));
  worker.enqueue(current.user, current.assistant); await worker.run();
  const pending = store.all("memories").find(m => m.target_id);
  putMemory(store, { ...old, value: "苏州", replace: true });
  assert.throws(() => putMemory(store, { ...pending, status: "active", replace: true }), /已经变化/);
  assert.equal(store.all("memories").find(m => m.status === "active").value, "苏州");
});

test("source edits invalidate dependent experiences, summaries and facts and queue a new extraction", async t => {
  const { store } = fixture(t), current = turn(store, "我不吃香菜，今天去上海见朋友了。");
  const worker = service(t, store, () => ({ facts: [fact("我不吃香菜", "food:香菜", "不吃香菜", { kind: "preference" })],
    episodes: [episode("今天去上海见朋友了", current.user.created_at)] }));
  worker.enqueue(current.user, current.assistant); await worker.run();
  const saved = store.all("memories")[0]; putMemory(store, { ...saved, status: "active", pinned: true });
  store.db.prepare("UPDATE messages SET text=? WHERE id=?").run("我吃香菜，今天没出门。", current.user.id);
  assert.equal(store.all("memories")[0].status, "needs_review");
  assert.equal(store.db.prepare("SELECT count(*) n FROM memory_episodes").get().n, 0);
  assert.equal(store.db.prepare("SELECT count(*) n FROM memory_summaries").get().n, 0);
  assert.ok(store.db.prepare("SELECT 1 FROM memory_jobs WHERE message_id=?").get(current.user.id));
  assert.equal(store.messages(current.session.id)[0].text, "我吃香菜，今天没出门。");
});

test("a correction during extraction commits no stale or partial output and survives restart", async t => {
  const { store, directory } = fixture(t), current = turn(store, "我不吃香菜。");
  const worker = service(t, store, () => {
    store.db.prepare("UPDATE messages SET text=? WHERE id=?").run("我其实吃香菜。", current.user.id);
    return { facts: [fact("我不吃香菜", "food:香菜")], episodes: [] };
  });
  worker.enqueue(current.user, current.assistant);
  const report = await worker.run();
  assert.equal(report.failures, 1); assert.equal(store.all("memories").length, 0);
  await worker.stop(); store.close();
  const reopened = new Store(directory);
  assert.equal(reopened.db.prepare("SELECT count(*) n FROM memory_jobs").get().n, 1);
  reopened.close();
});

test("idle maintenance does not reread chat or invoke extraction and unrelated experiences stay out", async t => {
  const { store } = fixture(t), current = turn(store, "今天去上海看展了。"); let calls = 0;
  const worker = service(t, store, () => { calls++; return { facts: [], episodes: [episode("今天去上海看展了", current.user.created_at)] }; });
  worker.summaryGroups = () => { throw new Error("Must not scan all history"); };
  worker.enqueue(current.user, current.assistant); await worker.run();
  await worker.run(); await worker.run();
  assert.equal(calls, 1);
  assert.equal(store.db.prepare("SELECT count(*) n FROM memory_summary_jobs").get().n, 0);
  putMemory(store, { name: "饮食偏好", value: "不吃香菜", predicate: "food:香菜", kind: "preference" });
  const context = await worker.context("我有什么忌口？");
  assert.equal(context.intent, "facts");
  assert.equal(context.facts.length, 1);
  assert.equal(context.episodes.length, 0);
});

test("episodes remain independent of automatic fact extraction and health/control turns are excluded", async t => {
  const { store } = fixture(t, { privacy: { autoMemory: false } });
  const current = turn(store, "今天去爬山了。");
  const worker = service(t, store, input => {
    assert.equal(input.collectFacts, false);
    return { facts: [fact(current.user.text, "hobby", "喜欢爬山")], episodes: [episode("今天去爬山了", current.user.created_at)] };
  });
  worker.enqueue(current.user, current.assistant); await worker.run();
  assert.equal(store.all("memories").length, 0);
  assert.equal(store.db.prepare("SELECT count(*) n FROM memory_episodes").get().n, 1);
  for (const metadata of [{ healthPrivate: true }, { assistantControl: "change" }, { memoryOperation: "remember" }]) {
    const message = store.message(current.session.id, "user", "private", { metadata });
    worker.enqueue(message, current.assistant);
  }
  assert.equal(store.db.prepare("SELECT count(*) n FROM memory_jobs").get().n, 0);
});

test("episodes and context dependencies sync, and forgetting removes them without deleting chat", async t => {
  const { store: a } = fixture(t), { store: b } = fixture(t), sa = new SyncStore(a), sb = new SyncStore(b);
  const current = turn(a, "我不吃香菜，今天和朋友吃火锅。");
  const worker = service(t, a, () => ({ facts: [fact("我不吃香菜", "food:香菜")], episodes: [episode("今天和朋友吃火锅", current.user.created_at)] }));
  worker.enqueue(current.user, current.assistant); await worker.run();
  sb.apply(sa.snapshot());
  assert.equal(b.db.prepare("SELECT count(*) n FROM memory_episodes").get().n, 1);
  assert.equal(b.db.prepare("SELECT count(*) n FROM episode_dependencies").get().n, 2);
  forgetMemory(a, a.all("memories")[0].id);
  sb.apply(sa.snapshot());
  assert.equal(b.db.prepare("SELECT count(*) n FROM memory_episodes").get().n, 0);
  assert.equal(b.messages(current.session.id).length, 2);
});

test("explicit date ranges and relative broad recall use local event dates", () => {
  assert.equal(memoryQuery("我昨天都做了什么？").dateOnly, true);
  const range = dateRange("2026-09-01 到 2026-09-03 做了什么");
  assert.equal(localDay(new Date(range.from)), "2026-09-01");
  assert.equal(localDay(new Date(range.to)), "2026-09-04");
  assert.equal(memoryQuery("2026-09-01 到 2026-09-03 做了什么").dateOnly, true);
  const month = dateRange("上个月", new Date(2026, 0, 15));
  assert.equal(localDay(new Date(month.from)), "2025-12-01");
  assert.equal(localDay(new Date(month.to)), "2026-01-01");
});

test("long turns are extracted in full and a failed later chunk leaves no partial memory", async t => {
  const { store } = fixture(t);
  const current = turn(store, Array.from({ length: 80 }, (_, i) => `我的收藏编号是${i}，这是第${i}个独立的收藏条目。`).join(""));
  let parts = [];
  const complete = async (_p, messages) => {
    const input = JSON.parse(messages[1].content); parts.push(input.segment);
    if (input.part === 2) throw new Error("network failed after first chunk");
    return JSON.stringify({ facts: [fact(input.segment.slice(0, 20), "collection")], episodes: [] });
  };
  await assert.rejects(() => organizeTurn(store, current.user, undefined, { complete, assistantId: current.assistant.id }), /network failed/);
  assert.equal(store.all("memories").length, 0);
  parts = [];
  await organizeTurn(store, current.user, undefined, { assistantId: current.assistant.id, complete: async (_p, messages) => {
    const input = JSON.parse(messages[1].content); parts.push(input.segment);
    return JSON.stringify({ facts: [], episodes: [] });
  } });
  assert.equal(parts.join(""), current.user.text);
  assert.ok(parts.length > 1);
});

test("unambiguous relative experience dates use the source calendar rather than model arithmetic", async t => {
  const { store } = fixture(t), current = turn(store, "昨天和朋友吃了火锅。");
  const timestamp = new Date("2026-01-01T10:00:00").toISOString();
  store.db.prepare("UPDATE messages SET created_at=? WHERE id=?").run(timestamp, current.user.id);
  const worker = service(t, store, () => ({ facts: [], episodes: [episode(current.user.text, "2025-12-30T00:00:00Z")] }));
  worker.enqueue(current.user, current.assistant); await worker.run();
  const saved = store.db.prepare("SELECT * FROM memory_episodes").get();
  assert.equal(localDay(new Date(saved.occurred_at)), "2025-12-31");
  assert.equal(saved.recorded_at, timestamp);
});

test("supplementation keeps confirmation state and preserves pronoun-resolution evidence", async t => {
  const { store } = fixture(t), session = store.session();
  const antecedent = store.message(session.id, "user", "我的表哥叫小林。");
  store.message(session.id, "assistant", "他在哪里工作？");
  const old = putMemory(store, { name: "工作城市", value: "小林在苏州工作", object: "苏州", subject: "小林", predicate: "work_location" });
  const current = turn(store, "他在苏州工作。", "明白了。", session);
  const worker = service(t, store, input => {
    assert.ok(input.existingMemories.some(m => m.id === old.id));
    return { facts: [fact(current.user.text, "work_location", old.value, { action: "supplement", targetId: old.id,
      subject: "小林", object: "苏州", evidence: [{ messageId: antecedent.id, quote: antecedent.text }] })], episodes: [] };
  });
  worker.enqueue(current.user, current.assistant); await worker.run();
  assert.equal(store.all("memories").length, 1);
  assert.equal(store.all("memories")[0].status, "active");
  assert.ok(evidenceFor(store, old.id).some(e => e.message_id === antecedent.id));
  store.db.prepare("UPDATE messages SET text=? WHERE id=?").run("我说的是另一个小林。", antecedent.id);
  assert.equal(store.all("memories")[0].status, "needs_review");
});

test("background comparison pages reach later records and leave confirmed and future facts separate", async t => {
  const { store } = fixture(t);
  store.saveSettings(mergeSettings(store.settings(), { memory: { maintenance: true, autoSummaries: false } }));
  for (let i = 0; i < 24; i++) putMemory(store, { name: "关系", subject: "user", predicate: "relationship:朋友", value: "朋友描述" + i, status: "suggested", validFrom: "2020-01-01" });
  const future = putMemory(store, { name: "关系", predicate: "relationship:朋友", value: "未来的朋友", status: "suggested", validFrom: "2099-01-01" });
  const visited = new Set(); let calls = 0;
  const worker = service(t, store, inputs => {
    calls++; for (const m of inputs) visited.add(m.id);
    assert.ok(!inputs.some(m => m.id === future.id));
    return { duplicates: [] };
  });
  for (let i = 0; i < 30 && store.db.prepare("SELECT 1 FROM memory_merge_jobs").get(); i++) await worker.consolidate();
  assert.equal(visited.size, 24);
  assert.equal(store.db.prepare("SELECT count(*) n FROM memory_merge_jobs").get().n, 0);
  const before = calls; await worker.consolidate(); assert.equal(calls, before);
});
