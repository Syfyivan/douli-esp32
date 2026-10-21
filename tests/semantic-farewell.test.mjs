import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { WebSocket } from "ws";
import { createApplication } from "../server/app.mjs";
import { VoiceConnection } from "../server/gateway.mjs";
import { defaults, mergeSettings } from "../server/config.mjs";
import { conversationEndIntent } from "../server/conversation-intent.mjs";

const response = deltas => new Response(deltas.map(delta =>
  "data: " + JSON.stringify({ choices: [{ delta }] }) + "\n\n").join("") + "data: [DONE]\n\n");

async function fixture(t, { guest = false, speechFailure = false, end = true, answer = "好，下次再聊。", intentGate, onSpeech } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "douli-semantic-farewell-"));
  const app = await createApplication({ dataDir: dir });
  const profile = { baseUrl: "https://fixture.invalid/v1", model: "fixture", pcmSampleRate: 16000 };
  app.store.saveSettings(mergeSettings(app.store.settings(), {
    models: { daily: profile, tts: profile },
    input: { vad: "energy", previewMs: 0 },
    routing: { enabled: false, qualityFirst: false },
    privacy: { autoMemory: false },
    memory: { semantic: false, maintenance: false, autoSummaries: false },
  }));
  if (guest) {
    app.people.create("Private fixture");
    const settings = app.store.settings(); settings.people.voiceIdentification = true; app.store.saveSettings(settings);
    t.mock.method(app.engine, "run", () => { throw new Error("Guest must not use the personal engine"); });
  }
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith("/audio/speech")) {
      onSpeech?.();
      if (speechFailure) throw new Error("fixture TTS unavailable");
      return new Response(Buffer.alloc(640));
    }
    requests.push(body);
    if (!body.stream) {
      await intentGate;
      return Response.json({ choices: [{ message: { content: JSON.stringify({ end }) } }] });
    }
    return response([{ content: answer }]);
  });
  app.store.db.prepare("INSERT INTO devices (id,name,approved,token,metadata) VALUES ('fixture','fixture',1,'test-only','{}')").run();
  const socket = new EventEmitter(), sent = [];
  Object.assign(socket, {
    readyState: WebSocket.OPEN,
    send(value) {
      if (typeof value !== "string") return;
      const message = JSON.parse(value); sent.push(message);
      if (message.type === "session" && message.state === "standby")
        this.emit("message", Buffer.from('{"type":"session","state":"standby"}'), false);
    },
    close() { this.readyState = WebSocket.CLOSED; this.emit("close"); },
    ping() {},
  });
  const device = app.store.db.prepare("SELECT * FROM devices WHERE id='fixture'").get();
  const connection = new VoiceConnection(app.gateway, socket, { device });
  connection.message({ type: "hello", version: 3, features: { persistent_connection: true },
    audio_params: { format: "opus", channels: 1, sample_rate: 16000 } });
  connection.message({ type: "session", state: "standby" });
  connection.message({ type: "listen", state: "start", mode: "auto" });
  t.after(async () => {
    socket.close(); await app.close();
    if (!resolve(dir).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe cleanup");
    rmSync(dir, { recursive: true, force: true });
  });
  return { app, connection, socket, sent, requests };
}

for (const guest of [false, true]) for (const speechFailure of [false, true]) {
  test(`semantic end enters acknowledged standby (guest=${guest}, TTS failure=${speechFailure})`, async t => {
    const { app, connection, socket, sent, requests } = await fixture(t, { guest, speechFailure });
    const sessionId = connection.session.id;
    await connection.process(null, "我去忙了，回头再聊。", null, { status: "unknown" });
    assert.equal(requests.length, 2, "one short decision alongside the normal answer");
    const intent = requests.find(r => !r.stream), reply = requests.find(r => r.stream);
    assert.equal(intent.tools, undefined);
    assert.equal(intent.messages.length, 2);
    assert.deepEqual(JSON.parse(intent.messages[1].content),
      { assistantName: app.store.settings().assistant.name, transcript: "我去忙了，回头再聊。" });
    assert.equal(connection.standby, true);
    assert.equal(connection.standbyConfirmed, true);
    assert.equal(connection.state, "idle");
    assert.equal(connection.call.acceptingAudio, false);
    assert.equal(socket.readyState, WebSocket.OPEN);
    assert.ok(sent.some(e => e.type === "session" && e.reason === "farewell"));
    if (guest) {
      assert.equal(reply.tools, undefined);
      assert.equal(reply.messages.length, 2);
      for (const table of ["sessions", "messages", "memories"])
        assert.equal(app.store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
    } else {
      assert.equal(app.store.messages(sessionId).at(-1).text, "好，下次再聊。");
    }
    connection.message({ type: "listen", state: "start", mode: "auto" });
    assert.equal(connection.standby, false);
    assert.notEqual(connection.session.id, sessionId);
  });
}

test("a spoken goodbye alone never becomes a control command", async t => {
  const { connection } = await fixture(t, { end: false, answer: "拜拜的意思就是再见。" });
  await connection.process(null, "拜拜是什么意思？");
  assert.equal(connection.standby, false);
  assert.equal(connection.state, "listening");
});

test("invalid or unavailable intent results never close a conversation, and literal farewells need no provider", async t => {
  const settings = structuredClone(defaults);
  Object.assign(settings.models.daily, { baseUrl: "https://fixture.invalid/v1", model: "fixture" });
  for (const content of ["{}", "null", '{"end":"true"}', "bad json"]) {
    const mock = t.mock.method(globalThis, "fetch", async () => Response.json({ choices: [{ message: { content } }] }));
    assert.equal(await conversationEndIntent(settings, "我去忙了，回头再聊。"), null);
    mock.mock.restore();
  }
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("offline"); });
  assert.equal(await conversationEndIntent(settings, "嗯，好的，再见豆梨。"), true);
  assert.equal(await conversationEndIntent(settings, "音量调到百分之五十"), false);
  assert.equal(await conversationEndIntent(settings, "再大一点"), false);
  assert.equal(calls, 0);
  assert.equal(await conversationEndIntent(settings, "我去忙了，回头再聊。"), null);
});

test("first speech preparation does not wait for the parallel intent decision", async t => {
  let decide, heard;
  const intentGate = new Promise(resolve => { decide = resolve; });
  const speech = new Promise(resolve => { heard = resolve; });
  const { connection } = await fixture(t, { guest: true, intentGate, onSpeech: heard });
  const turn = connection.process(null, "我去忙了，回头再聊。", null, { status: "unknown" });
  await speech;
  assert.equal(connection.standby, false);
  decide(); await turn;
  assert.equal(connection.standbyConfirmed, true);
});

test("an ending intent survives a later response error, but a canceled turn cannot end the next conversation", async t => {
  const { app, connection, sent } = await fixture(t);
  const firstMock = t.mock.method(app.gateway.engine, "run", async () => {
    throw new Error("fixture response failed");
  });
  await connection.process(null, "我去忙了，回头再聊。");
  assert.equal(connection.standbyConfirmed, true);
  connection.message({ type: "listen", state: "start", mode: "auto" });
  let release, started;
  const pending = new Promise(resolve => { release = resolve; });
  const called = new Promise(resolve => { started = resolve; });
  firstMock.mock.restore();
  t.mock.method(app.gateway.engine, "run", async () => {
    started(); await pending;
    return { farewell: false };
  });
  const before = sent.filter(e => e.type === "session" && e.reason === "farewell").length;
  const old = connection.process(null, "我去忙了，回头再聊。");
  await called;
  connection.endConversation("manual");
  connection.message({ type: "listen", state: "start", mode: "auto" });
  release(); await old;
  assert.equal(connection.standby, false);
  assert.equal(sent.filter(e => e.type === "session" && e.reason === "farewell").length, before);
});
