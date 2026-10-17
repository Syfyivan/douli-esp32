import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { WebSocket } from "ws";
import { Store } from "../server/store.mjs";
import { VoiceConnection } from "../server/gateway.mjs";
import { LiveTranscriber } from "../server/providers.mjs";
import { codec, packAudio } from "../server/audio.mjs";

const minute = 60_000;

function setup(t, { browser = false, rmsThreshold = null, persistent = false, acknowledge = true } = {}) {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: Date.UTC(2026, 9, 16) });
  // Recognition is deliberately empty: only detected audio, not invented model
  // output, can extend the activity deadline in these accelerated-clock tests.
  t.mock.method(LiveTranscriber.prototype, "finish", async function () {
    this.close();
    return "";
  });
  const directory = mkdtempSync(join(tmpdir(), "douli-standby-"));
  const store = new Store(directory);
  // Synthetic tones exercise standby timing, not WebRTC's speech classifier.
  const settings = store.settings();
  Object.assign(settings.input, { vad: "energy", previewMs: 0 });
  store.saveSettings(settings);
  const gateway = {
    store,
    connections: new Map(),
    engine: { context: () => "", run: async () => ({ farewell: false }) },
  };
  store.db.prepare("INSERT INTO devices (id,name,approved,token,metadata) VALUES (?,?,?,?,?)")
    .run("standby-fixture", "Test device", 1, "test-only", JSON.stringify({ config: { rmsThreshold } }));
  const sockets = [];
  const encoders = [];
  t.after(() => {
    for (const socket of sockets) socket.close();
    for (const encoder of encoders) encoder.delete();
    store.close();
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe cleanup");
    rmSync(directory, { recursive: true, force: true });
  });
  function connect({ wake = true } = {}) {
    const sent = [];
    const socket = new EventEmitter();
    Object.assign(socket, {
      readyState: WebSocket.OPEN,
      closeCount: 0,
      send(value) {
        const message = typeof value === "string" ? JSON.parse(value) : value;
        sent.push(message);
        if (message.type === "ping")
          this.emit("message", Buffer.from('{"type":"pong"}'), false);
        if (acknowledge && message.type === "session" && message.state === "standby")
          this.emit("message", Buffer.from('{"type":"session","state":"standby"}'), false);
      },
      ping() { this.emit("pong"); },
      close() {
        if (this.readyState === WebSocket.CLOSED) return;
        this.readyState = WebSocket.CLOSED;
        this.closeCount++;
        this.emit("close");
      },
    });
    sockets.push(socket);
    const options = browser ? { browser: true } : {
      device: store.db.prepare("SELECT * FROM devices WHERE id=?").get("standby-fixture"),
    };
    const connection = new VoiceConnection(gateway, socket, options);
    if (!browser) gateway.connections.set(options.device.id, connection);
    const send = message => socket.emit("message", Buffer.from(JSON.stringify(message)), false);
    send({ type: "hello", version: 3, features: { persistent_connection: persistent }, audio_params: {
      format: browser ? "pcm" : "opus", channels: 1, sample_rate: 16000,
    } });
    if (persistent) send({ type: "session", state: "standby" });
    if (wake) send({ type: "listen", state: "start", mode: "auto" });
    const encoder = codec();
    encoders.push(encoder);
    const sound = (durationMs = 20, amplitude = 0) => {
      const pcm = Buffer.alloc(640);
      for (let i = 0; i < 320; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 4) * amplitude), i * 2);
      for (let ms = 0; ms < durationMs; ms += 20) {
        const data = browser ? pcm : Buffer.from(encoder.encode(pcm, 320));
        socket.emit("message", packAudio(data, 3), true);
      }
    };
    const advance = async (durationMs, activity = () => sound()) => {
      for (let remaining = durationMs; remaining > 0;) {
        activity();
        const step = Math.min(30_000, remaining);
        t.mock.timers.tick(step);
        remaining -= step;
        await nextTurn();
      }
    };
    return { connection, socket, sent, send, sound, advance };
  }
  return { gateway, store, connect, ...connect() };
}

test("ESP32 returns to standby after 30 minutes even while silent Opus packets arrive", async t => {
  const { connection, socket, sent, advance, store, connect } = setup(t);
  await advance(30 * minute - 1);
  assert.equal(socket.readyState, WebSocket.OPEN);
  await advance(1);
  assert.equal(socket.readyState, WebSocket.CLOSED);
  assert.equal(connection.call.connection, "closed");
  assert.equal(socket.closeCount, 1);
  assert.equal(store.messages(connection.session.id).length, 0);
  assert.ok(!sent.some(e => e.type === "tts" && e.state === "start"));
  const again = connect();
  assert.notEqual(again.connection.session.id, connection.session.id);
  assert.equal(store.sessions().length, 0, "silent connections must not create history rows");
  await again.advance(29 * minute);
  assert.equal(again.socket.readyState, WebSocket.OPEN);
  await again.advance(minute);
  assert.equal(again.socket.readyState, WebSocket.CLOSED);
  assert.equal(socket.closeCount, 1, "the closed session must not run another standby callback");
});

test("network pings alone cannot extend the ESP32 standby deadline", async t => {
  const { socket, send, advance } = setup(t);
  await advance(30 * minute, () => send({ type: "ping" }));
  assert.equal(socket.readyState, WebSocket.CLOSED);
});

test("valid speech renews standby while low background sound and short clicks do not", async t => {
  const { socket, sound, advance } = setup(t, { rmsThreshold: 0.05 });
  await advance(29 * minute);
  sound(200, 12000);
  await advance(29 * minute);
  assert.equal(socket.readyState, WebSocket.OPEN, "speaking must start a fresh 30-minute wait");
  sound(20, 12000);
  // A 200 ms sound below this device's threshold should not count as speech.
  await advance(minute, () => sound(200, 600));
  assert.equal(socket.readyState, WebSocket.CLOSED);
});

test("standby waits for model and playback completion then grants another 30 minutes", async t => {
  const { connection, socket, gateway, advance, store } = setup(t);
  // Speech is prepared before speak(); keep this timer test independent of ASR/TTS services.
  const settings = store.settings();
  settings.models.tts.baseUrl = "https://speech.fixture";
  settings.models.tts.model = "fixture";
  store.saveSettings(settings);
  t.mock.method(globalThis, "fetch", async () => new Response(Buffer.alloc(640)));
  let finishModel, finishPlayback, playbackStarted;
  const model = new Promise(resolve => { finishModel = resolve; });
  const playback = new Promise(resolve => { finishPlayback = resolve; });
  const started = new Promise(resolve => { playbackStarted = resolve; });
  gateway.engine.run = async ({ emit }) => {
    await model;
    emit({ type: "delta", text: "这是一次待机计时的测试回答。" });
    return { farewell: false };
  };
  t.mock.method(connection, "speak", async () => {
    connection.state = "speaking";
    playbackStarted();
    await playback;
  });
  const turn = connection.process(null, "请回答一个问题");
  await advance(31 * minute);
  assert.equal(socket.readyState, WebSocket.OPEN, "do not interrupt a pending model response");
  finishModel();
  await started;
  await advance(31 * minute);
  assert.equal(socket.readyState, WebSocket.OPEN, "do not interrupt playback");
  finishPlayback();
  await turn;
  await advance(30 * minute - 1);
  assert.equal(socket.readyState, WebSocket.OPEN);
  await advance(1);
  assert.equal(socket.readyState, WebSocket.CLOSED);
});

test("standby does not change browser voice sessions or replace network timeout checks", async t => {
  const browser = setup(t, { browser: true });
  await browser.advance(31 * minute);
  assert.equal(browser.socket.readyState, WebSocket.OPEN);
  await browser.advance(4 * minute, () => {});
  assert.equal(browser.socket.readyState, WebSocket.CLOSED, "no incoming data still triggers the transport timeout");
});

test("persistent ESP32 stays connected in standby for hours and resumes on the same socket", async t => {
  const { socket, connection, send, sound, advance, sent } = setup(t, { persistent: true });
  const sessionId = connection.session.id;
  await advance(30 * minute);
  assert.equal(socket.readyState, WebSocket.OPEN);
  assert.equal(connection.standby, true);
  assert.ok(sent.some(e => e.type === "session" && e.reason === "inactivity"));
  const standbyCommands = sent.filter(e => e.type === "session").length;
  await advance(180 * minute, () => {});
  assert.equal(socket.readyState, WebSocket.OPEN, "JSON heartbeats keep idle transport alive");
  assert.equal(sent.filter(e => e.type === "session").length, standbyCommands);
  sound(200, 12000);
  assert.equal(connection.live, null, "standby audio must never reach ASR");
  send({ type: "listen", state: "start", mode: "auto" });
  sound(200, 12000);
  assert.equal(connection.standby, false);
  assert.equal(connection.state, "listening");
  assert.ok(connection.live);
  assert.notEqual(connection.session.id, sessionId);
  await advance(29 * minute);
  assert.equal(connection.standby, false);
  assert.equal(socket.readyState, WebSocket.OPEN);
});

test("persistent ESP32 farewell stops the conversation without closing its connection", async t => {
  const { socket, connection, advance, sent } = setup(t, { persistent: true });
  await connection.process(null, "再见豆梨");
  assert.equal(connection.standby, true);
  assert.equal(connection.state, "idle");
  assert.ok(sent.some(e => e.type === "session" && e.reason === "farewell"));
  await advance(60 * minute, () => {});
  assert.equal(socket.readyState, WebSocket.OPEN);
});

test("persistent standby falls back to disconnect if microphone stop is not acknowledged", async t => {
  const { socket, connection, advance } = setup(t, { persistent: true, acknowledge: false });
  await connection.process(null, "再见豆梨");
  await advance(4999);
  assert.equal(socket.readyState, WebSocket.OPEN);
  await advance(1);
  assert.equal(socket.readyState, WebSocket.CLOSED);
});

test("ESP32 wake greeting opens the realtime session after its paired listen/start", async t => {
  const { connection, store, send } = setup(t, { persistent: true });
  const settings = store.settings(); settings.input.voiceMode = "realtime"; store.saveSettings(settings);
  let releaseGreeting, opened = 0;
  t.mock.method(connection, "speak", () => new Promise(resolve => { releaseGreeting = resolve; }));
  t.mock.method(connection, "startRealtime", async () => { opened++; });
  connection.resumeConversation();
  const greeting = connection.greet();
  send({ type: "listen", state: "start", mode: "auto" });
  assert.equal(opened, 0, "opening must wait for the wake greeting");
  assert.equal(connection.controller.signal.aborted, false);
  releaseGreeting(); await greeting;
  assert.equal(opened, 1);
  assert.equal(connection.state, "listening");
});

test("one wake keeps multiple turns, interruptions and short pauses in one history session", async t => {
  const { connection, store, gateway, send, advance } = setup(t, { persistent: true });
  gateway.engine.run = async ({ sessionId, text }) => {
    store.message(sessionId, "user", text);
    store.message(sessionId, "assistant", "收到");
    return { farewell: false };
  };
  const first = connection.session.id;
  assert.equal(store.sessions().length, 0);
  await connection.process(null, "今天聊一聊");
  send({ type: "listen", state: "stop" });
  await advance(5 * minute);
  send({ type: "abort" });
  send({ type: "listen", state: "start" });
  await connection.process(null, "接着刚才的话题");
  assert.equal(connection.session.id, first);
  assert.equal(store.sessions().length, 1);
  assert.deepEqual(store.messages(first).map(m => m.text), ["今天聊一聊", "收到", "接着刚才的话题", "收到"]);
  await connection.process(null, "再见豆梨");
  send({ type: "listen", state: "start" });
  const second = connection.session.id;
  assert.notEqual(second, first);
  assert.equal(store.sessions().length, 1, "the next wake alone does not create a row");
  await connection.process(null, "这次聊个新话题");
  assert.equal(store.sessions().length, 2);
  assert.deepEqual(store.messages(second).map(m => m.text), ["这次聊个新话题", "收到"]);
  assert.equal(store.messages(first).at(-1).text, "再见豆梨");
});

test("a false wake and empty recognition leave no session or messages", async t => {
  const { connection, store, send } = setup(t, { persistent: true });
  t.mock.method(connection, "speak", async () => {});
  await connection.greet();
  await connection.process(null, "   ");
  send({ type: "session", state: "standby" });
  assert.equal(store.sessions().length, 0);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM messages").get().n, 0);
  const first = connection.session.id;
  send({ type: "listen", state: "start" });
  assert.notEqual(connection.session.id, first);
});

test("persistent reconnect resumes an active session through its initial standby acknowledgement", async t => {
  const { connection, socket, store, connect, advance } = setup(t, { persistent: true });
  // End-of-turn persistence must survive replacing the entire connection object.
  await connection.process(null, "今天聊一聊");
  store.message(connection.session.id, "user", "今天聊一聊");
  const first = connection.session.id;
  await advance(5 * minute);
  socket.close();
  const again = connect({ wake: false });
  assert.equal(again.connection.session.id, first);
  assert.equal(again.connection.conversationEnded, false);
  again.send({ type: "listen", state: "start" });
  assert.equal(again.connection.session.id, first);
  assert.equal(store.messages(first)[0].text, "今天聊一聊");
  again.connection.endConversation("manual");
  again.socket.close();
  assert.notEqual(connect().connection.session.id, first, "explicitly ended sessions cannot resume");
});

test("reconnection heartbeats do not renew the conversation deadline", async t => {
  const { connection, socket, connect, advance } = setup(t, { persistent: true });
  const first = connection.session.id;
  await advance(20 * minute);
  socket.close();
  const again = connect({ wake: false });
  assert.equal(again.connection.session.id, first);
  await again.advance(11 * minute, () => {});
  again.send({ type: "listen", state: "start" });
  assert.notEqual(again.connection.session.id, first);
  again.socket.close();
  t.mock.timers.tick(31 * minute);
  assert.notEqual(connect().connection.session.id, again.connection.session.id, "long offline gaps start fresh");
});

test("device standby and manual end close sessions without overwriting other device metadata", async t => {
  const { connection, store, send } = setup(t, { persistent: true });
  const first = connection.session.id;
  const metadata = JSON.parse(store.db.prepare("SELECT metadata FROM devices").get().metadata);
  metadata.config = { volume: 0.35 }; metadata.fixture = "keep";
  store.db.prepare("UPDATE devices SET metadata=?").run(JSON.stringify(metadata));
  send({ type: "session", state: "standby" });
  send({ type: "listen", state: "start" });
  assert.notEqual(connection.session.id, first);
  const second = connection.session.id;
  connection.endConversation("manual");
  send({ type: "listen", state: "start" });
  assert.notEqual(connection.session.id, second);
  const saved = JSON.parse(store.db.prepare("SELECT metadata FROM devices").get().metadata);
  assert.deepEqual(saved.config, metadata.config);
  assert.equal(saved.fixture, "keep");
});

test("legacy history and deleted sessions are never revived on a new connection", async t => {
  const { socket, store, connect } = setup(t, { persistent: true });
  socket.close();
  const old = store.session(null, "standby-fixture");
  store.message(old.id, "user", "旧版历史记录");
  store.db.prepare("UPDATE devices SET metadata=?").run(JSON.stringify({ sessionId: old.id }));
  const current = connect();
  assert.notEqual(current.connection.session.id, old.id);
  assert.equal(store.messages(old.id)[0].text, "旧版历史记录");
  await current.connection.process(null, "新对话");
  const deletedId = current.connection.session.id;
  current.socket.close();
  store.db.prepare("DELETE FROM sessions WHERE id=?").run(deletedId);
  assert.notEqual(connect().connection.session.id, deletedId);
  assert.equal(store.sessions().length, 1);
});

test("late recognition from an ended conversation cannot populate the next wake", async t => {
  const { connection, store, send } = setup(t, { persistent: true });
  let recognized;
  connection.live = { finish: () => new Promise(resolve => { recognized = resolve; }), close() {} };
  const pending = connection.process(Buffer.alloc(640));
  const first = connection.session.id;
  connection.endConversation("manual");
  send({ type: "listen", state: "start" });
  assert.notEqual(connection.session.id, first);
  recognized("上一段还没识别完的话");
  await pending;
  assert.equal(store.sessions().length, 0);
  assert.equal(store.messages(connection.session.id).length, 0);
});

test("a saved first turn survives a missing metadata checkpoint", async t => {
  const { connection, socket, store, connect } = setup(t, { persistent: true });
  const first = connection.session.id;
  socket.close();
  // Simulate stopping between creating the history row and marking it persisted.
  store.createSession("standby-fixture", first);
  store.message(first, "user", "已经保存的第一句话");
  const again = connect();
  assert.equal(again.connection.session.id, first);
  await again.connection.process(null, "再见豆梨");
  assert.deepEqual(store.messages(first).map(m => m.text), ["已经保存的第一句话", "再见豆梨"]);
});
