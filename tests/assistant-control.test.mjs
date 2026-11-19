import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Store } from "../server/store.mjs";
import { mergeSettings } from "../server/config.mjs";
import { AssistantControl, fastAssistantControl, validateAssistantControl } from "../server/assistant-control.mjs";
import { controlSpeaker } from "../server/speaker-control.mjs";
import { createApplication } from "../server/app.mjs";

function directory() {
  const root = resolve(tmpdir()), dir = mkdtempSync(join(root, "douli-self-control-"));
  return { dir, cleanup: () => { if (!resolve(dir).startsWith(root + sep)) throw new Error("Unsafe cleanup"); rmSync(dir, { recursive: true, force: true }); } };
}
function storeFor(t) {
  const { dir, cleanup } = directory(), store = new Store(dir);
  t.after(() => { store.close(); cleanup(); });
  store.saveSettings(mergeSettings(store.settings(), { models: { daily: { baseUrl: "https://fixture.example", model: "flash", apiKey: "private-fixture" } } }));
  return store;
}

test("whole-utterance controls understand common volume/style requests without matching quotes or ordinary follow-ups", () => {
  for (const text of ["声音大一点", "豆梨，请把音量调大一点。", "调高一点", "大声点"]) assert.equal(fastAssistantControl(text)?.volume?.value, 10, text);
  assert.equal(fastAssistantControl("声音小一点")?.volume?.value, -10);
  for (const text of ["音量调到百分之五十", "音量调到50%", "把音量设为五十"]) assert.equal(fastAssistantControl(text)?.volume?.value, 50, text);
  assert.equal(fastAssistantControl("音量调到200")?.kind, "clarify");
  assert.equal(fastAssistantControl("以后回复简短些")?.replyLength, "简短");
  assert.equal(fastAssistantControl("说话轻松一点")?.tone, "轻松有趣");
  assert.equal(fastAssistantControl("换个回复风格")?.target, "style");
  assert.equal(fastAssistantControl("再大一点", { pendingVolume: true })?.volume?.value, 10);
  for (const text of ["调到百分之五十。", "那就调到50%吧", "设为五十", "百分之五十", "五十"]) {
    assert.equal(fastAssistantControl(text, { pendingVolume: true })?.volume?.value, 50, text);
    assert.equal(fastAssistantControl(text), null, text);
  }
  for (const text of ["不要调到50", "如果调到50会怎样", "刚刚调到50了吗", "那你刚刚咋调到80%的？", "把灯光调到50", "温度调到50", "我考了五十", "他说调到50", "翻译‘调到50’"]) {
    assert.equal(fastAssistantControl(text, { pendingVolume: true }), null, text);
  }
  for (const text of ["再大一点", "详细一点", "这道题讲详细一点", "不要把音量调大", "如何调整音量", "朋友说声音大一点", "如果声音大一点会怎样", "把电视音量调到50", "翻译‘以后回复简短些’", "你能调音量吗"]) assert.equal(fastAssistantControl(text), null, text);
});

test("omitted volume targets require the immediately preceding control in the same recent session", async t => {
  const store = storeFor(t), sessionId = store.session().id;
  const control = new AssistantControl(store, () => assert.fail("numeric follow-ups need no model"));
  const operations = [];
  const volumeControl = async operation => {
    operations.push(operation);
    return { status: "applied", value: operation.value, hardware: true, text: "已核实音量。" };
  };
  const record = (id, result) => store.message(id, "assistant", result.text, { metadata: { assistantControl: result } });
  const first = await control.handle({ text: "音量调到八十", sessionId, volumeControl });
  const previous = record(sessionId, first);
  assert.equal((await control.handle({ text: "调到百分之五十。", sessionId, volumeControl })).volume.value, 50);
  assert.deepEqual(operations.map(o => o.value), [80, 50]);
  const before = operations.length;
  assert.equal(await control.handle({ text: "调到百分之五十。", sessionId: store.session().id, volumeControl }), null);
  store.db.prepare("UPDATE messages SET created_at=? WHERE id=?").run(new Date(Date.now() - 120001).toISOString(), previous.id);
  assert.equal(await control.handle({ text: "调到百分之五十。", sessionId, volumeControl }), null);
  record(sessionId, first);
  store.message(sessionId, "user", "接着聊数学");
  store.message(sessionId, "assistant", "你想聊哪一题？");
  assert.equal(await control.handle({ text: "调到百分之五十。", sessionId, volumeControl }), null);
  assert.equal(operations.length, before);
  const clarification = await control.handle({ text: "音量调到200", sessionId, volumeControl });
  record(sessionId, clarification);
  assert.equal((await control.handle({ text: "那就五十", sessionId, volumeControl })).volume.value, 50);
});

test("chat receives actual control outcomes even if the acknowledgement was interrupted, without storing them as personal memory", async t => {
  const { dir, cleanup } = directory(), app = await createApplication({ dataDir: dir, remoteAccess: null });
  t.after(async () => { await app.close(); cleanup(); });
  app.store.saveSettings(mergeSettings(app.store.settings(), {
    models: { daily: { baseUrl: "https://fixture.example/v1", model: "fixture", apiKey: "private-fixture" } },
    input: { refine: false }, privacy: { autoMemory: false },
    memory: { semantic: false, maintenance: false, autoSummaries: false },
  }));
  const requests = [], operations = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.ok(String(url).endsWith("/chat/completions"));
    const body = JSON.parse(options.body); assert.equal(body.stream, true); requests.push(body);
    return new Response('data: {"choices":[{"delta":{"content":"根据已核实的操作记录回答。"}}]}\n\ndata: [DONE]\n\n');
  });
  const volumeControl = async operation => {
    operations.push(operation);
    return { status: "applied", value: operation.value, hardware: true, text: `音量已核实为${operation.value}。` };
  };
  const first = await app.engine.run({ text: "音量调到八十", volumeControl });
  const second = await app.engine.run({ text: "调到百分之五十。", sessionId: first.session.id, volumeControl });
  app.store.db.prepare("UPDATE messages SET status='interrupted',metadata=? WHERE id=?").run(JSON.stringify({
    ...second.message.metadata, voicePlayback: { status: "interrupted", spokenText: "", playedMs: 0 },
  }), second.message.id);
  await app.engine.run({ text: "那你刚刚咋调到50%的？", sessionId: first.session.id, volumeControl });
  assert.deepEqual(operations.map(o => o.value), [80, 50], "asking about a past operation must not execute another write");
  const prompt = requests.at(-1).messages[0].content;
  const outcomes = JSON.parse(prompt.split("## 本次会话设置操作记录\n")[1].split("\n")[0]);
  assert.deepEqual(outcomes.map(o => [o.volume.status, o.volume.value]), [["applied", 80], ["applied", 50]]);
  assert.match(prompt, /"speakerVolumeControlAvailable":true/);
  assert.ok(!prompt.includes("private-fixture"));
  const controlIds = new Set([first.input.id, first.message.id, second.input.id, second.message.id]);
  assert.ok(app.memory.summaryGroups().every(group => group.messages.every(message => !controlIds.has(message.id))));
  const failed = await app.engine.run({ text: "音量调到三十", volumeControl: async () => ({
    status: "unverified", requested: 30, value: 50, hardware: true, text: "音箱仍报告五十，未核实调整成功。",
  }) });
  await app.engine.run({ text: "刚刚成功了吗？", sessionId: failed.session.id });
  const failurePrompt = requests.at(-1).messages[0].content;
  const failedOutcomes = JSON.parse(failurePrompt.split("## 本次会话设置操作记录\n")[1].split("\n")[0]);
  assert.equal(failedOutcomes.length, 1, "other sessions must not share control history");
  assert.equal(failedOutcomes[0].volume.status, "unverified");
  assert.equal(failedOutcomes[0].volume.requested, 30);
  assert.match(failurePrompt, /"speakerVolumeControlAvailable":false/);
});

test("semantic settings are restricted, uncertain requests clarify, and cancellation never writes", async t => {
  const store = storeFor(t), sessionId = store.session().id, before = store.settings();
  for (const raw of [
    { kind: "change", confidence: 1, apiKey: "not-allowed", tone: "温柔" },
    { kind: "change", confidence: 1, volume: { mode: "set", value: 101 } },
    { kind: "change", confidence: 0.5, tone: "温柔" },
    { kind: "change", confidence: 1, humor: -10 },
  ]) {
    const control = new AssistantControl(store, async () => JSON.stringify(raw));
    assert.equal((await control.handle({ text: "以后像朋友一样聊天", sessionId })).status, "clarify");
    assert.deepEqual(store.settings(), before);
  }
  const no = new AssistantControl(store, async () => '{"kind":"none","confidence":1}');
  assert.equal(await no.handle({ text: "你能调音量吗", sessionId }), null);
  const aborted = new AbortController();
  const control = new AssistantControl(store, async () => { aborted.abort(new Error("cancelled")); return '{"kind":"change","confidence":1,"tone":"轻松"}'; });
  await assert.rejects(control.handle({ text: "以后像朋友一样聊天", sessionId, signal: aborted.signal }), /cancelled/);
  assert.deepEqual(store.settings(), before);
  assert.throws(() => validateAssistantControl({ kind: "query", volume: { mode: "query" }, tone: "温柔" }));
});

test("semantic style changes preserve concurrent settings and credentials", async t => {
  const store = storeFor(t), sessionId = store.session().id;
  const control = new AssistantControl(store, async (profile, messages) => {
    assert.equal(profile.thinking, false);
    assert.equal(JSON.parse(messages[1].content).current, "以后像朋友一样聊天");
    store.saveSettings(mergeSettings(store.settings(), { assistant: { name: "新名字" }, models: { daily: { model: "updated" } } }));
    return '{"kind":"change","confidence":0.99,"tone":"像朋友一样自然聊天","replyLength":"适中"}';
  });
  const result = await control.handle({ text: "以后像朋友一样聊天", sessionId });
  assert.equal(result.status, "applied");
  assert.equal(store.settings().assistant.name, "新名字");
  assert.equal(store.settings().assistant.tone, "像朋友一样自然聊天");
  assert.equal(store.settings().models.daily.model, "updated");
  assert.equal(store.settings().models.daily.apiKey, "private-fixture");
  assert.ok(!JSON.stringify(result).includes("private-fixture"));
});

test("hardware volume is read before adjustment, verified afterwards, bounded, and isolated to the speaking device", async t => {
  const store = storeFor(t), id = "speaker-fixture";
  store.db.prepare("INSERT INTO devices VALUES (?,?,1,?,?,?,?)").run(id, "test", "token", "", "", JSON.stringify({ config: { volume: 0.8 }, marker: "preserve" }));
  let actual = 70, refuse = false;
  const calls = [];
  const connection = { store, options: { device: { id } }, config: { route: "auto", volume: 0.8, rmsThreshold: null },
    tools: [{ name: "self.get_device_status" }, { name: "self.audio_speaker.set_volume" }],
    gateway: { call: async (deviceId, tool, args) => {
      assert.equal(deviceId, id); calls.push({ tool, args });
      if (tool.endsWith("set_volume") && !refuse) actual = args.volume;
      return { result: { content: [{ type: "text", text: JSON.stringify({ audio_speaker: { volume: actual } }) }] } };
    } },
  };
  assert.equal((await controlSpeaker(connection, { mode: "delta", value: 10 })).value, 80);
  assert.deepEqual(calls.map(c => c.tool), ["self.get_device_status", "self.audio_speaker.set_volume", "self.get_device_status"]);
  assert.equal(connection.config.volume, 0.8, "hardware volume must not be multiplied into playback gain again");
  assert.equal((await controlSpeaker(connection, { mode: "delta", value: 50 })).value, 100);
  const count = calls.length;
  assert.equal((await controlSpeaker(connection, { mode: "delta", value: 10 })).value, 100);
  assert.equal(calls.length, count + 1, "no repeat set when already at maximum");
  await controlSpeaker(connection, { mode: "set", value: 0 });
  assert.equal((await controlSpeaker(connection, { mode: "unmute" })).value, 100);
  refuse = true;
  const failed = await controlSpeaker(connection, { mode: "set", value: 40 });
  assert.equal(failed.status, "unverified"); assert.equal(failed.value, 100);
  assert.equal(JSON.parse(store.db.prepare("SELECT metadata FROM devices WHERE id=?").get(id).metadata).marker, "preserve");
  connection.tools = [];
  connection.features = { mcp: true };
  await assert.rejects(controlSpeaker(connection, { mode: "set", value: 35 }), /尚未准备好/);
  assert.equal(connection.config.volume, 0.8);
  connection.features = {};
  const fallback = await controlSpeaker(connection, { mode: "set", value: 35 });
  assert.equal(fallback.hardware, false); assert.equal(connection.config.volume, 0.35);
  assert.equal(JSON.parse(store.db.prepare("SELECT metadata FROM devices WHERE id=?").get(id).metadata).config.volume, 0.35);
  for (const invalid of [{ mode: "set", value: null }, { mode: "set", value: "" }, { mode: "set", value: 100.5 }, { mode: "unknown", value: 50 }])
    await assert.rejects(controlSpeaker(connection, invalid), /无效的音量/);
});

test("chat applies controls before model routing, resumes style clarification and excludes them from personal memory", async t => {
  const { dir, cleanup } = directory(), app = await createApplication({ dataDir: dir, distDir: join(dir, "no-dist") });
  t.after(async () => { await app.close(); cleanup(); });
  app.store.saveSettings(mergeSettings(app.store.settings(), { privacy: { autoMemory: false }, memory: { semantic: false, maintenance: false, autoSummaries: false } }));
  const first = await app.engine.run({ text: "换个回复风格", route: "health" });
  assert.equal(first.message.metadata.assistantControl.status, "clarify");
  const second = await app.engine.run({ sessionId: first.session.id, text: "轻松幽默一点", route: "health" });
  assert.equal(second.message.metadata.assistantControl.status, "applied");
  assert.equal(app.store.settings().assistant.tone, "轻松有趣");
  assert.equal(app.store.settings().assistant.humor, 60);
  assert.equal(app.memory.summaryGroups().length, 0);
  assert.equal(app.store.db.prepare("SELECT count(*) AS n FROM memory_jobs").get().n, 0);
  assert.deepEqual(JSON.parse(app.engine.context(first.session.id)).recent, []);
  const volume = await app.engine.run({ sessionId: first.session.id, text: "音量调到五十" });
  assert.equal(volume.message.metadata.assistantControl.status, "unavailable");
  assert.match(volume.text, /对要调节的音箱/);
  const reopened = new Store(dir);
  assert.equal(reopened.settings().assistant.tone, "轻松有趣"); reopened.close();
});

test("device volume API reads actual speaker volume, validates changes and reports unverified writes", async t => {
  const { dir, cleanup } = directory(), app = await createApplication({ dataDir: dir, distDir: join(dir, "no-dist") });
  t.after(async () => { await app.close(); cleanup(); });
  const id = "volume-api-fixture";
  app.store.db.prepare("INSERT INTO devices (id,name,approved,token,metadata) VALUES (?,?,1,?,?)")
    .run(id, "fixture", "test-only", "{}");
  let actual = 70, refuse = false;
  const calls = [];
  const connection = { store: app.store, options: { device: { id } }, config: { volume: 1 },
    tools: [{ name: "self.get_device_status" }, { name: "self.audio_speaker.set_volume" }],
    gateway: { call: async (target, name, args) => {
      assert.equal(target, id); calls.push(name);
      if (name.endsWith("set_volume") && !refuse) actual = args.volume;
      return { result: { structuredContent: { audio_speaker: { volume: actual } } } };
    } } };
  app.gateway.connections.set(id, connection);
  const url = `/api/devices/${id}/volume`;
  const read = await app.admin.inject(url);
  assert.equal(read.statusCode, 200); assert.equal(read.json().value, 70); assert.equal(read.json().hardware, true);
  const changed = await app.admin.inject({ method: "PUT", url, payload: { value: 55 } });
  assert.equal(changed.json().status, "applied"); assert.equal(changed.json().value, 55);
  assert.equal(connection.config.volume, 1, "hardware volume is not also applied as software gain");
  const count = calls.length;
  for (const value of [-1, 101, 1.5, "50", null]) {
    const bad = await app.admin.inject({ method: "PUT", url, payload: { value } });
    assert.equal(bad.statusCode, 400);
  }
  assert.equal(calls.length, count);
  const foreign = await app.admin.inject({ method: "PUT", url, headers: { origin: "https://untrusted.example" }, payload: { value: 90 } });
  assert.equal(foreign.statusCode, 403); assert.equal(calls.length, count);
  refuse = true;
  const denied = await app.admin.inject({ method: "PUT", url, payload: { value: 30 } });
  assert.equal(denied.json().status, "unverified"); assert.equal(denied.json().value, 55);
  app.gateway.connections.delete(id);
  assert.match((await app.admin.inject(url)).json().error, /未连接/);
});
