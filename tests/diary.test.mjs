import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Store } from "../server/store.mjs";
import { MemoryService } from "../server/memory-service.mjs";
import { organizeTurn } from "../server/memory-turn.mjs";
import { saveEntry, removeEntry, listEntries, getEntry } from "../server/diary.mjs";
import { SyncStore } from "../server/sync-store.mjs";
import { createApplication } from "../server/app.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "douli-diary-")), store = new Store(directory);
  const settings = store.settings();
  settings.memory.semantic = false; settings.memory.maintenance = false;
  settings.models.memory = { baseUrl: "https://fixture.invalid/v1", model: "fixture" };
  store.saveSettings(settings);
  t.after(() => {
    if (!store.closed) store.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, directory };
}
const entry = (extra = {}) => ({ text: "晚上去公园散步", kind: "event", occurredAt: "2026-10-25", topics: ["exercise", "life"], ...extra });
async function extracted(store, complete) {
  const session = store.session(), user = store.message(session.id, "user", "昨天和朋友散步");
  const assistant = store.message(session.id, "assistant", "听起来不错。");
  const output = () => JSON.stringify({ facts: [], episodes: [{ text: "和朋友散步", kind: "event", occurredAt: "2026-10-25", quote: user.text, topics: ["exercise", "social", "invented"] }] });
  await organizeTurn(store, user, null, { assistantId: assistant.id, complete: complete || (async () => output()) });
  return { user, assistant, output };
}

test("manual diary keeps event time, recording time and source separate and survives reopen", t => {
  const { store, directory } = fixture(t);
  const saved = saveEntry(store, entry());
  assert.equal(saved.origin, "manual"); assert.equal(saved.kind, "event");
  assert.deepEqual(saved.topics, ["exercise", "life"]);
  assert.notEqual(saved.occurred_at, saved.recorded_at);
  assert.equal(store.db.prepare("SELECT quote FROM episode_sources WHERE episode_id=?").get(saved.id).quote, saved.text);
  assert.equal(store.all("memories").length, 0, "a diary entry is not automatically a stable fact");
  store.close(); const reopened = new Store(directory);
  try { assert.deepEqual(getEntry(reopened, saved.id), saved); } finally { reopened.close(); }
});

test("upgrading a database with the previous episode schema preserves records and is repeatable", async t => {
  const { store, directory } = fixture(t); await extracted(store);
  const before = store.db.prepare("SELECT id,source_id,text,kind,occurred_at,recorded_at FROM memory_episodes").get();
  store.db.exec("DROP INDEX diary_date; DROP TRIGGER diary_invalidate_update; DROP TRIGGER diary_invalidate_delete;");
  for (const column of ["topics", "origin", "revision", "deleted"]) store.db.exec(`ALTER TABLE memory_episodes DROP COLUMN ${column}`);
  store.close();
  for (let i = 0; i < 2; i++) {
    const reopened = new Store(directory);
    try {
      const row = getEntry(reopened, before.id);
      for (const [key, value] of Object.entries(before)) assert.equal(row[key], value);
      assert.deepEqual(row.topics, []); assert.equal(row.origin, "automatic"); assert.equal(row.revision, 1);
    } finally { reopened.close(); }
  }
});

test("diary filters combine date, topic and kind with stable pagination", t => {
  const { store } = fixture(t);
  saveEntry(store, entry({ kind: "plan", text: "明天散步", occurredAt: "2026-10-26" }));
  const expected = saveEntry(store, entry());
  saveEntry(store, entry({ topics: ["work"], text: "完成报告" }));
  const result = listEntries(store, { from: "2026-10-25", to: "2026-10-26", topic: "exercise", kind: "event" });
  assert.deepEqual(result.items.map(e => e.id), [expected.id]);
  assert.equal(listEntries(store, { limit: 1, offset: 1 }).items.length, 1);
  assert.equal(listEntries(store, {}).total, 3);
  assert.throws(() => listEntries(store, { topic: "arbitrary" }));
});

test("invalid dates, ranges, content and topics leave no partially created source", t => {
  const { store } = fixture(t);
  for (const change of [{ occurredAt: "2026-02-30" }, { text: " " }, { kind: "fact" }, { topics: ["unknown"] }, { endedAt: "2025-01-01" }])
    assert.throws(() => saveEntry(store, entry(change)));
  assert.equal(store.sessions().length, 0);
});

test("edits reject stale revisions and invalidate summaries and vectors immediately", t => {
  const { store } = fixture(t), saved = saveEntry(store, entry());
  const worker = new MemoryService(store); worker.refreshEpisodeSummaries();
  store.db.prepare("INSERT INTO memory_vectors VALUES (?,?,?,?,?)").run("episode", saved.id, "old", "fixture", "[]");
  const changed = saveEntry(store, { ...entry(), id: saved.id, revision: saved.revision, text: "实际是去图书馆", topics: ["study"] });
  assert.equal(changed.revision, saved.revision + 1);
  assert.equal(store.db.prepare("SELECT count(*) n FROM memory_vectors WHERE record_id=?").get(saved.id).n, 0);
  assert.equal(store.db.prepare("SELECT count(*) n FROM memory_summaries").get().n, 0);
  assert.throws(() => saveEntry(store, { ...entry(), id: saved.id, revision: saved.revision }), e => e.statusCode === 409);
  assert.throws(() => removeEntry(store, saved.id, saved.revision), e => e.statusCode === 409);
});

test("removed records stay out of listing, retrieval, summaries and index documents", async t => {
  const { store } = fixture(t), saved = saveEntry(store, entry());
  const worker = new MemoryService(store); worker.refreshEpisodeSummaries();
  removeEntry(store, saved.id, saved.revision); worker.refreshEpisodeSummaries();
  assert.equal(listEntries(store, {}).total, 0);
  assert.equal((await worker.search.episodes("", { from: "2026-10-25", to: "2026-10-26" })).items.length, 0);
  assert.equal(worker.search.documents().length, 0);
  assert.ok(store.db.prepare("SELECT 1 FROM messages WHERE id=?").get(saved.source_id), "original source remains available");
});

test("manual diary reviews rebuild locally when automatic extraction is disabled", async t => {
  const { store } = fixture(t), settings = store.settings();
  settings.privacy.autoMemory = false; settings.memory.autoSummaries = false; store.saveSettings(settings);
  const worker = new MemoryService(store, { complete: () => { throw Error("must not call model"); } });
  let saved = saveEntry(store, entry());
  await worker.run();
  assert.equal(store.db.prepare("SELECT count(*) n FROM memory_summaries").get().n, 2);
  saved = saveEntry(store, { ...entry(), id: saved.id, revision: saved.revision, text: "实际是去图书馆" });
  await worker.run();
  for (const row of store.db.prepare("SELECT text FROM memory_summaries").all()) {
    assert.ok(row.text.includes("实际是去图书馆")); assert.ok(!row.text.includes("公园散步"));
  }
  removeEntry(store, saved.id, saved.revision); await worker.run();
  assert.equal(store.db.prepare("SELECT count(*) n FROM memory_summaries").get().n, 0);
});

test("automatic topics use the allowlist; human edits win over extraction already in flight", async t => {
  const { store } = fixture(t), current = await extracted(store);
  let saved = listEntries(store, {}).items[0];
  assert.deepEqual(saved.topics, ["exercise", "social"]);
  let release, entered;
  const ready = new Promise(r => { entered = r; });
  const pending = organizeTurn(store, current.user, null, { assistantId: current.assistant.id, complete: () => { entered(); return new Promise(r => { release = r; }); } });
  await ready;
  saved = saveEntry(store, { ...entry(), id: saved.id, revision: saved.revision, text: "与家人散步", topics: ["family"] });
  release(current.output()); await pending;
  assert.equal(listEntries(store, {}).total, 1);
  assert.equal(getEntry(store, saved.id).text, "与家人散步");
  removeEntry(store, saved.id, saved.revision);
  await organizeTurn(store, current.user, null, { assistantId: current.assistant.id, complete: async () => current.output() });
  assert.equal(listEntries(store, {}).total, 0, "re-extraction cannot resurrect a removed entry");
});

test("source correction invalidates derived diary records and health turns never enter diary", async t => {
  const { store } = fixture(t), current = await extracted(store);
  store.db.prepare("UPDATE messages SET text=? WHERE id=?").run("昨天没有散步", current.user.id);
  assert.equal(listEntries(store, {}).total, 0);
  const session = store.session(), user = store.message(session.id, "user", "private health", { metadata: { healthPrivate: true } });
  await organizeTurn(store, user, null, { complete: () => { throw Error("must not call model"); } });
  assert.equal(listEntries(store, {}).total, 0);
});

test("an edit arriving during retrieval cannot reintroduce a removed record", async t => {
  const { store } = fixture(t), saved = saveEntry(store, entry());
  const worker = new MemoryService(store);
  worker.search.rank = async (_q, rows) => { removeEntry(store, saved.id, saved.revision); return { items: rows, mode: "fixture" }; };
  assert.equal((await worker.search.episodes("散步")).items.length, 0);
});

test("sync carries topics and invalidates open editors even at equal revisions", t => {
  const a = fixture(t).store, b = fixture(t).store, sa = new SyncStore(a), sb = new SyncStore(b);
  const saved = saveEntry(a, entry()); sb.apply(sa.snapshot());
  const before = getEntry(b, saved.id);
  saveEntry(a, { ...entry(), id: saved.id, revision: saved.revision, topics: ["sleep"] });
  sb.apply(sa.snapshot());
  assert.deepEqual(getEntry(b, saved.id).topics, ["sleep"]);
  assert.throws(() => saveEntry(b, { ...entry(), id: saved.id, revision: before.revision }), e => e.statusCode === 409);
});

test("diary API isolates people and reports edit conflicts", async t => {
  const directory = mkdtempSync(join(tmpdir(), "douli-diary-api-"));
  const app = await createApplication({ dataDir: directory, remoteAccess: null });
  t.after(async () => {
    await app.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    rmSync(directory, { recursive: true, force: true });
  });
  const request = (url, method = "GET", payload, person = "") => app.admin.inject({ url: "/api" + url, method, payload,
    headers: { host: "localhost", "x-douli-person": person } });
  const a = (await request("/people", "POST", { name: "A" })).json();
  const created = await request("/memory/diary", "POST", entry(), a.id);
  assert.equal(created.statusCode, 200); const saved = created.json();
  assert.equal((await request("/memory/diary")).json().total, 0);
  assert.equal((await request("/memory/diary", "GET", undefined, a.id)).json().total, 1);
  assert.equal((await request(`/memory/diary/${saved.id}`, "PUT", { ...entry(), revision: 99 }, a.id)).statusCode, 409);
  assert.equal((await request(`/memory/diary/${saved.id}`, "DELETE", { revision: saved.revision })).statusCode, 404);
});
