// Uses configured providers, with fictional input in an isolated database only.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createDecipheriv } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { Store } from "../server/store.mjs";
import { putMemory, extractMemory } from "../server/memory.mjs";
import { MemoryService } from "../server/memory-service.mjs";
import { ChatEngine } from "../server/engine.mjs";
import { HomeService } from "../server/home.mjs";
import { embed, rerank } from "../server/providers.mjs";
import { embeddingProfile, rerankProfile, cosine } from "../server/memory-search.mjs";
import { createApplication } from "../server/app.mjs";
import { synthesize } from "../server/providers.mjs";
import { resample, rms } from "../server/audio.mjs";
import { WebSocket } from "ws";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(".runtime");
mkdirSync(root, { recursive: true });
const live = new DatabaseSync(resolve(".data/douli.sqlite"), { readOnly: true });
const sealed = live.prepare("SELECT value FROM settings WHERE id='config'").get().value;
live.close();
const [nonce, tag, data] = sealed.split(".").map(x => Buffer.from(x, "base64"));
const decipher = createDecipheriv("aes-256-gcm", readFileSync(resolve(".data/local.key")), nonce);
decipher.setAuthTag(tag);
const settings = JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString());
const directory = mkdtempSync(join(root, "memory-v2-live-"));
let store = new Store(directory), service;
const report = { checkedAt: new Date().toISOString(), isolated: true, checks: [] };
const record = (name, details = {}) => { const item = { name, ...details }; report.checks.push(item); console.log(JSON.stringify(item)); };
try {
  store.saveSettings({ ...store.settings(), ...settings, memory: store.settings().memory });
  if (!store.settings().models.memory.baseUrl && /^https:\/\/api\.siliconflow\.(cn|com)\/v1\/?$/.test(store.settings().models.daily.baseUrl)) {
    const configured = store.settings();
    configured.models.memory = { ...configured.models.daily, model: "Qwen/Qwen3.5-4B", thinking: false };
    store.saveSettings(configured);
  }
  record("memory-model", { model: store.settings().models.memory.model || store.settings().models.daily.model });
  service = new MemoryService(store);
  service.schedule = () => {}; // Deterministic test timing; same worker is explicitly awaited below.
  putMemory(store, { name: "饮食偏好", value: "不吃香菜", predicate: "food:香菜" });
  const indexed = await service.search.index(AbortSignal.timeout(30000));
  assert.ok(indexed.configured && indexed.indexed);
  const diagnosticVectors = await embed(embeddingProfile(store), ["晚饭做什么合适", "这段代码不能运行"], AbortSignal.timeout(15000));
  const storedVector = JSON.parse(store.db.prepare("SELECT embedding FROM memory_vectors WHERE kind='memory'").get().embedding);
  record("embedding-score-diagnostics", { dinner: cosine(diagnosticVectors[0], storedVector), unrelated: cosine(diagnosticVectors[1], storedVector) });
  for (const query of ["晚饭做什么合适", "这段代码不能运行"]) record("rerank-score-diagnostics", { query, results: await rerank(rerankProfile(store), query, ["用户 饮食偏好 food:香菜 不吃香菜"], AbortSignal.timeout(15000)) });
  const dinner = await service.search.memories("晚饭做什么合适", { signal: AbortSignal.timeout(15000) });
  assert.ok(dinner.items.some(m => m.value.includes("香菜")), JSON.stringify(dinner));
  const unrelated = await service.search.memories("这段代码不能运行", { signal: AbortSignal.timeout(15000) });
  assert.equal(unrelated.items.length, 0, JSON.stringify(unrelated));
  record("real-embedding-retrieval", { mode: dinner.mode, score: dinner.items[0].similarity, unrelatedHits: unrelated.items.length });

  const session = store.session();
  const source = store.message(session.id, "user", "我的表哥叫小林。他在苏州工作。");
  const suggestions = await extractMemory(store, source, AbortSignal.timeout(45000));
  assert.ok(suggestions.length && suggestions.every(m => m.status === "suggested" && source.text.includes(m.quote)));
  record("contextual-extraction", { suggestions: suggestions.map(m => ({ subject: m.subject, predicate: m.predicate, value: m.value })) });

  const event = store.message(session.id, "user", "今天到苏州看望了朋友小林，我们约好下周一起爬山。");
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  store.db.prepare("UPDATE messages SET created_at=? WHERE id=?").run(yesterday.toISOString(), event.id);
  const groups = service.summaryGroups();
  for (const group of groups) await service.summarize(group, AbortSignal.timeout(45000));
  await service.search.index(AbortSignal.timeout(30000));
  assert.ok(store.db.prepare("SELECT count(*) AS n FROM memory_summaries WHERE text!=''").get().n);
  const history = await service.search.history("昨天去哪里看望朋友", { signal: AbortSignal.timeout(15000) });
  assert.ok(history.some(m => m.id === event.id));
  record("summaries-and-dated-history", { summaries: groups.length, hits: history.length });

  const engine = new ChatEngine(store, new HomeService(store), service);
  const proposed = await engine.run({ text: "记住，我现在住杭州。", route: "daily" });
  assert.equal(proposed.message.metadata.memoryOperation.operation, "propose");
  const confirmed = await engine.run({ sessionId: proposed.session.id, text: "确认", route: "daily" });
  assert.equal(confirmed.message.metadata.memoryOperation.operation, "remember");
  const corrected = await engine.run({ sessionId: proposed.session.id, text: "更正记忆，我现在住上海。", route: "daily" });
  assert.equal(corrected.message.metadata.memoryOperation.operation, "propose");
  await engine.run({ sessionId: proposed.session.id, text: "确认", route: "daily" });
  assert.ok(store.all("memories").some(m => m.status === "active" && m.value.includes("上海")));
  assert.ok(store.all("memories").some(m => m.status === "superseded" && m.value.includes("杭州")));
  record("spoken-text-confirm-and-correct", { proposal: proposed.text, confirmation: confirmed.text });

  await service.search.index(AbortSignal.timeout(30000));
  await service.stop(); store.close();
  store = new Store(directory); service = new MemoryService(store); service.schedule = () => {};
  const restartedEngine = new ChatEngine(store, new HomeService(store), service);
  const recall = await restartedEngine.run({ text: "我现在住在哪里？", route: "daily" });
  assert.match(recall.text, /上海/);
  record("reopen-cross-session-answer", { answer: recall.text });
  const forget = await restartedEngine.run({ sessionId: recall.session.id, text: "忘掉我的居住地记忆", route: "daily" });
  assert.equal(forget.message.metadata.memoryOperation.operation, "propose");
  await restartedEngine.run({ sessionId: recall.session.id, text: "确认", route: "daily" });
  assert.ok(!store.all("memories").some(m => m.predicate === "residence"));
  record("forget-all-versions");
  await service.stop(); store.close();
  const app = await createApplication({ dataDir: directory, distDir: join(directory, "no-dist") });
  await app.memory.stop(); // Isolate the voice roundtrip from optional background housekeeping.
  await app.admin.listen({ port: 0, host: "127.0.0.1" });
  let ws;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${app.admin.server.address().port}/api/voice?route=daily`, { headers: { Origin: "http://127.0.0.1:8788" } });
    const events = [], audio = [];
    ws.on("message", (raw, binary) => binary ? audio.push(Buffer.from(raw)) : events.push(JSON.parse(raw.toString())));
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "hello", version: 1, audio_params: { format: "pcm", sample_rate: 16000, channels: 1 } }));
    const waitFor = async (predicate, timeout = 90000) => {
      const until = Date.now() + timeout;
      while (!predicate()) { if (Date.now() > until) throw new Error("Voice memory check timed out"); await delay(100); }
      const error = events.find(e => e.type === "error"); if (error) throw new Error(error.message);
    };
    await waitFor(() => events.some(e => e.type === "hello"), 5000);
    for (const [i, phrase] of ["记住，我不吃花生。", "确认"].entries()) {
      const input = await synthesize(app.store.settings().models.tts, phrase, AbortSignal.timeout(30000));
      const pcm = resample(input.pcm, input.sampleRate);
      const stopped = events.filter(e => e.type === "tts" && e.state === "stop" && !e.interrupted).length;
      ws.send(JSON.stringify({ type: "listen", state: "start", mode: "manual" }));
      for (let n = 0; n < pcm.length; n += 640) ws.send(pcm.subarray(n, n + 640));
      ws.send(JSON.stringify({ type: "listen", state: "stop" }));
      await waitFor(() => events.filter(e => e.type === "done").length >= i + 1 && events.filter(e => e.type === "tts" && e.state === "stop" && !e.interrupted).length > stopped);
      if (i === 0) assert.ok(!app.store.all("memories").some(m => m.status === "active" && m.value.includes("花生")));
    }
    assert.ok(app.store.all("memories").some(m => m.status === "active" && m.value.includes("花生")));
    assert.ok(rms(Buffer.concat(audio)) > 0.001);
    record("real-synthetic-voice-memory", { transcripts: events.filter(e => e.type === "stt").map(e => e.text), replies: events.filter(e => e.type === "done").map(e => e.message.text), outputAudioBytes: Buffer.concat(audio).length });
  } finally { if (ws) { ws.close(); await once(ws, "close").catch(() => {}); } await app.close(); }
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.message; process.exitCode = 1;
  console.error(JSON.stringify({ failed: error.message }));
} finally {
  await service?.stop();
  if (!store.closed) store.close();
  writeFileSync(join(root, "memory-v2-live-check.json"), JSON.stringify(report, null, 2));
  if (!resolve(directory).startsWith(root + sep)) throw new Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
}
