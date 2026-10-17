import test from "node:test";
import assert from "node:assert/strict";
import { once, EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { WebSocketServer } from "ws";
import { RealtimeVoice } from "../server/realtime-voice.mjs";
import { Store } from "../server/store.mjs";
import { ChatEngine } from "../server/engine.mjs";
import { VoiceConnection } from "../server/gateway.mjs";
import { mergeSettings } from "../server/config.mjs";

async function until(check) {
  for (let i = 0; i < 300; i++) { if (check()) return; await delay(10); }
  throw new Error("fixture condition timed out");
}
async function cloud(t) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const seen = [], sentAt = [], headers = [];
  let socket;
  server.on("connection", (ws, request) => {
    socket = ws; headers.push(request.headers);
    ws.on("message", data => {
      const e = JSON.parse(data); seen.push(e);
      if (e.type === "session.create") ws.send(JSON.stringify({ type: "session.created", session: { id: "fixture" } }));
      if (e.type === "session.close") ws.send(JSON.stringify({ type: "session.closed" }));
      if (e.type === "input_audio_buffer.append") sentAt.push(Date.now());
    });
  });
  t.after(() => { for (const ws of server.clients) ws.terminate(); server.close(); });
  return { seen, sentAt, headers, send: e => socket.send(JSON.stringify(e)),
    profile: { baseUrl: `http://127.0.0.1:${server.address().port}/api/v3/duplex/realtime/dialogue`, apiKey: "fixture-private-key", model: "1.2.6.1" } };
}
function storeFor(t) {
  const root = resolve(tmpdir()), dir = mkdtempSync(join(root, "douli-realtime-")), store = new Store(dir);
  t.after(() => { store.close(); if (!resolve(dir).startsWith(root + sep)) throw new Error("Unsafe cleanup"); rmSync(dir, { force: true, recursive: true }); });
  store.saveSettings(mergeSettings(store.settings(), { routing: { enabled: false, qualityFirst: false }, privacy: { autoMemory: false }, memory: { semantic: false, maintenance: false, autoSummaries: false } }));
  return store;
}
function engineFor(t, store, home = { publicActions: () => [] }) {
  const engine = new ChatEngine(store, home);
  t.after(() => engine.memory.stop());
  return engine;
}
const started = { type: "conversation.item.input_audio_transcription.started" };
const completed = (text, id = "input-1") => ({ type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript: text });
const output = (type, rest = {}) => ({ type: `response.output_${type}`, question_id: "q1", response_id: "r1", ...rest });

test("Seeduplex JSON auth, paced input, mute, manual endpoint and output quarantine", async t => {
  const c = await cloud(t), partials = [];
  let transcript;
  const client = new RealtimeVoice(c.profile, { instructions: "test", onPartial: value => partials.push(value), onTranscript: (text, turn) => { transcript = { text, turn }; } });
  t.after(() => client.close()); await client.open();
  client.push(Buffer.alloc(640 * 4, 2)); client.commit();
  await until(() => c.seen.some(e => e.type === "input_audio_buffer.commit"));
  assert.equal(c.headers[0]["x-api-key"], "fixture-private-key");
  assert.equal(c.seen[0].session.audio.output.format.type, "pcm_s16le");
  assert.equal(c.sentAt.length, 4); assert.ok(c.sentAt[3] - c.sentAt[0] >= 45, "buffered input must not burst");
  assert.ok(c.seen.filter(e => e.audio).every(e => Buffer.from(e.audio, "base64").length === 640));
  client.setMuted(true); client.push(Buffer.alloc(640)); client.setMuted(false);
  c.send(started); c.send({ type: "conversation.item.input_audio_transcription.delta", delta: "你" });
  c.send({ type: "conversation.item.input_audio_transcription.delta", delta: "好" }); c.send(completed("你好"));
  c.send(output("text.delta", { delta: "我在。" })); c.send(output("audio.delta", { delta: Buffer.alloc(960).toString("base64") }));
  // The final audio packet can arrive before the final text event.
  c.send(output("audio.done")); c.send(output("text.done", { text: "我在。" }));
  await until(() => transcript && transcript.turn.queue.items.length === 3);
  assert.deepEqual(partials, ["你", "你好"]);
  assert.equal(transcript.text, "你好");
  const events = [];
  for await (const e of client.stream(transcript.turn, {}, [{ role: "system", content: "verified" }], new AbortController().signal, [])) events.push(e);
  assert.deepEqual(events.map(e => e.type), ["model", "text", "audio", "audio_end"]);
  assert.equal(events[2].audio.length, 960);
  await until(() => c.seen.some(e => e.type === "input_audio_mute.commit"));
  client.close(); await until(() => c.seen.some(e => e.type === "session.close"));
});

test("Seeduplex tool rounds preserve call IDs, suppress duplicates and reject old response audio", async t => {
  const c = await cloud(t), client = new RealtimeVoice(c.profile, { instructions: "test" });
  t.after(() => client.close()); await client.open();
  c.send(started); c.send(completed("开灯"));
  const call = { id: "x", type: "function_call", call_id: "call-1", name: "home_action", arguments: '{"id":"lamp"}' };
  c.send({ type: "response.function_call_arguments.done", items: [call] });
  c.send({ type: "response.function_call_arguments.done", items: [call] });
  await until(() => client.turn?.queue.items.length);
  const first = [];
  for await (const e of client.stream(client.turn, {}, [], new AbortController().signal, [])) first.push(e);
  assert.equal(first.at(-1).calls.length, 1);
  const next = (async () => { const values = []; for await (const e of client.stream(client.turn, {}, [{ role: "tool", tool_call_id: "call-1", content: '{"acknowledged":true}' }], new AbortController().signal, [])) values.push(e); return values; })();
  await until(() => c.seen.some(e => e.items?.[0]?.call_id === "call-1"));
  c.send(output("text.delta", { delta: "设备已返回。" })); c.send(output("text.done")); c.send(output("audio.done"));
  assert.equal((await next).filter(e => e.type === "tools").length, 0);
  c.send(started); c.send(completed("下一句", "input-2"));
  c.send(output("audio.delta", { delta: Buffer.alloc(960).toString("base64") }));
  c.send({ ...output("text.delta", { delta: "新回答" }), question_id: "q2", response_id: "r2" });
  await until(() => client.turn?.question === "q2");
  assert.deepEqual(client.turn.queue.items.map(e => e.value.type), ["text"]);
});

test("native stream shares engine action authorization/deduplication and confirmed memory tools", async t => {
  const store = storeFor(t); let executions = 0;
  const engine = engineFor(t, store, { publicActions: () => [{ id: "lamp" }], execute: async () => { executions++; return { acknowledged: true, verified: false }; } });
  let round = 0;
  const realtime = { model: "native-test", cancel: () => assert.fail("daily action should remain native"), stream: async function* (profile, messages, signal, tools) {
    assert.ok(tools.some(t => t.function.name === "memory_search"));
    if (!round++) yield { type: "tools", calls: ["a", "b"].map(id => ({ id, function: { name: "home_action", arguments: '{"id":"lamp"}' } })) };
    else { assert.equal(messages.filter(m => m.role === "tool").length, 2); yield { type: "text", text: "设备已返回执行结果。" }; }
  } };
  const result = await engine.run({ text: "打开灯", realtime });
  assert.equal(executions, 1); assert.equal(result.message.metadata.routing.profileKey, "realtime");
  round = 0; executions = 0;
  await engine.run({ text: "不要打开灯", route: "daily", realtime });
  assert.equal(executions, 0, "model tool calls cannot override a negative user request");
});

test("native settings and health turns cancel early and never enter native response generation", async t => {
  const store = storeFor(t), engine = engineFor(t, store);
  let canceled = 0;
  const realtime = { cancel: () => canceled++, stream: () => assert.fail("private/system turn entered speech-model generation") };
  await engine.run({ text: "以后回复简短些", realtime });
  assert.ok(canceled);
  engine.health = { vault: { get: () => null, list: () => [] }, consult: async ({ question }) => {
    assert.ok(canceled >= 2, "native auto-generation must be canceled before health consultation");
    assert.equal(question, "我的头痛测试内容");
    return { answer: { spoken: "私密健康回答测试" }, evidence: { sources: [] }, consultationId: "private-vault", at: "now" };
  } };
  const result = await engine.run({ text: "我的头痛测试内容", realtime });
  assert.equal(result.text, "私密健康回答测试");
  const rows = store.db.prepare("SELECT text,raw_text,metadata FROM messages").all();
  assert.ok(!JSON.stringify(rows).includes("私密健康回答测试"));
  assert.ok(!JSON.stringify(rows).includes("我的头痛测试内容"));
});

test("gateway native audio reaches playback, receipts update cloud context and farewell closes the session", async t => {
  const c = await cloud(t), store = storeFor(t), engine = engineFor(t, store);
  store.saveSettings(mergeSettings(store.settings(), { input: { voiceMode: "realtime" }, models: { realtime: c.profile } }));
  class Socket extends EventEmitter {
    readyState = 1; events = []; audio = [];
    send(value) { if (Buffer.isBuffer(value)) this.audio.push(value); else this.events.push(JSON.parse(value)); }
    ping() {} close() { if (this.readyState === 1) { this.readyState = 3; this.emit("close"); } }
  }
  const socket = new Socket(), connection = new VoiceConnection({ store, engine, connections: new Map() }, socket, { browser: true, route: "auto" });
  t.after(() => connection.close());
  connection.message({ type: "hello", version: 1, features: { playback_ack: true, voice_controls: true }, audio_params: { format: "pcm", channels: 1, sample_rate: 16000 } });
  connection.message({ type: "listen", state: "start" });
  await until(() => connection.realtime?.ready);
  const initialPrompt = c.seen.find(e => e.type === "session.create").session.instructions;
  assert.match(initialPrompt, /"requestedModel":"1\.2\.6\.1"/);
  assert.match(initialPrompt, /"interaction":"语音"/);
  assert.doesNotMatch(initialPrompt, /fixture-private-key|不是原始声音/);
  c.send(started); c.send(completed("你好"));
  c.send(output("text.delta", { delta: "我在，你好。" })); c.send(output("text.done"));
  c.send(output("audio.delta", { delta: Buffer.alloc(960 * 4, 1).toString("base64") })); c.send(output("audio.done"));
  await until(() => socket.events.some(e => e.type === "tts" && e.state === "sentence_end"));
  assert.equal(socket.audio.length, 4);
  await until(() => socket.events.some(e => e.type === "done"));
  const turn = connection.turns.get(connection.call.turnId);
  connection.playback({ turn_id: turn.id, segment_id: 0, played_ms: 80, state: "finished" });
  const saved = store.messages(connection.session.id).find(m => m.role === "assistant");
  assert.equal(saved.metadata.voicePlayback.spokenText, "我在，你好。");
  assert.equal(saved.metadata.voicePlayback.status, "complete");
  await until(() => c.seen.some(e => e.type === "conversation.item.create" && e.items?.some(i => i.content?.[0]?.text === "我在，你好。")));
  c.send(started); c.send(completed("结束对话", "input-2"));
  await until(() => socket.readyState === 3);
  assert.equal(connection.realtime, null);
});
