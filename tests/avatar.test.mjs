import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.mjs";
import { SimliService } from "../server/avatar.mjs";
import { createApplication } from "../server/app.mjs";
import { AvatarVoice } from "../web/avatar-voice.mjs";
import { normalizeAvatarVolume, SimliTransport } from "../web/simli.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "douli-avatar-")), store = new Store(dir);
  const settings = store.settings(); settings.avatar.apiKey = "fixture-secret"; store.saveSettings(settings);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return store;
}
test("avatar API masks encrypted keys, preserves them on blank saves, and only sends short credentials", async t => {
  const dir = mkdtempSync(join(tmpdir(), "douli-avatar-app-")), requests = [];
  const app = await createApplication({ dataDir: dir, avatarOptions: { fetch: async (url, options) => {
    requests.push({ url, options });
    return Response.json(url.endsWith("/ice") ? [{ urls: "stun:fixture.invalid" }] : { session_token: "temporary-token" });
  } } });
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const put = payload => app.admin.inject({ method: "PUT", url: "/api/settings", payload });
  let result = await put({ avatar: { apiKey: "fixture-secret" } });
  assert.equal(result.statusCode, 200);
  assert.deepEqual([result.json().avatar.apiKey, result.json().avatar.hasKey], ["", true]);
  assert.ok(!app.store.db.prepare("SELECT value FROM settings WHERE id='config'").get().value.includes("fixture-secret"));
  result = await put({ avatar: { apiKey: "", faceName: "我的豆梨" } });
  assert.equal(result.statusCode, 200);
  assert.equal(app.store.settings().avatar.apiKey, "fixture-secret");
  const session = await app.admin.inject({ method: "POST", url: "/api/avatar/session" });
  assert.equal(session.statusCode, 200);
  assert.equal(session.json().sessionToken, "temporary-token");
  assert.equal(session.json().enableSFU, true);
  assert.ok(!session.body.includes("fixture-secret"));
  assert.equal(requests.length, 2);
  assert.equal(requests[1].options.headers["x-simli-api-key"], "fixture-secret");
  assert.equal(JSON.parse(requests[1].options.body).audioInputFormat, "pcm16");
  const hostile = await put({ avatar: { faceId: "https://evil.invalid" } });
  assert.equal(hostile.statusCode, 400);
  assert.equal((await put({ avatar: { connectionMode: "unknown" } })).statusCode, 400);
  await put({ avatar: { connectionMode: "direct" } });
  assert.equal((await app.admin.inject({ method: "POST", url: "/api/avatar/session" })).json().enableSFU, false);
  await put({ avatar: { apiKey: "" }, clearKeys: ["avatar"] });
  assert.equal(app.store.settings().avatar.apiKey, "");
});

test("Simli prerequisites overlap and a failed prerequisite aborts its sibling", async t => {
  const store = fixture(t), pending = [], signals = [];
  const service = new SimliService(store, { fetch: (_url, options) => {
    signals.push(options.signal);
    return new Promise((resolve, reject) => {
      pending.push(resolve);
      options.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    });
  } });
  const first = service.session();
  assert.equal(pending.length, 2, "token must start before ICE completes");
  pending[1](Response.json({ session_token: "one-use" }));
  pending[0](Response.json([]));
  assert.equal((await first).sessionToken, "one-use");
  pending.length = 0; signals.length = 0;
  const failed = service.session();
  pending[0](Response.json({ invalid: true }));
  await assert.rejects(failed, /网络连接配置异常/);
  assert.ok(signals[1].aborted, "the unfinished token request is cancelled");
});
test("photo submission is multipart, suppresses duplicates, and tracks the requested generation", async t => {
  const store = fixture(t); let calls = 0;
  const service = new SimliService(store, { fetch: async (url, options) => {
    calls++;
    if (options.method === "POST") {
      assert.equal(new URL(url).searchParams.get("gsVersion"), "GSA_1.0");
      assert.equal(options.body.get("image").type, "image/png");
      return Response.json({ face_id: "new-avatar", warnings: [] });
    }
    assert.equal(new URL(url).searchParams.get("face_id"), "new-avatar");
    return Response.json({ status: "pending", face_id: "other-avatar", generations: [{ face_id: "new-avatar", status: "completed", queue_position: 0 }] });
  } });
  await assert.rejects(service.create({ image: "data:image/png;base64,YmFk", name: "照片" }), /图片格式/);
  assert.equal(calls, 0);
  const image = "data:image/png;base64," + Buffer.from([137,80,78,71,13,10,26,10,0]).toString("base64");
  const job = await service.create({ image, name: "照片" });
  assert.equal(job.faceId, "new-avatar");
  await assert.rejects(service.create({ image, name: "重复" }), /已有形象/);
  assert.equal((await service.progress()).status, "completed");
  assert.equal(calls, 2);
  assert.ok(!JSON.stringify(service.job()).includes(image));
  assert.notEqual(store.settings().avatar.faceId, "new-avatar", "a finished job must not silently replace the selected face");
});
test("provider errors cannot echo credentials; uncertain creation cannot be blindly retried", async t => {
  const store = fixture(t);
  const service = new SimliService(store, { fetch: async () => new Response("fixture-secret provider debug", { status: 403 }) });
  await assert.rejects(service.faces(), error => /额度不足/.test(error.message) && !error.message.includes("fixture-secret"));
  service.fetch = async () => { throw new Error("fixture-secret network debug"); };
  const image = "data:image/png;base64," + Buffer.from([137,80,78,71,13,10,26,10,0]).toString("base64");
  await assert.rejects(service.create({ image, name: "照片" }), /网络不可用/);
  assert.equal(service.job().status, "unknown");
  await assert.rejects(service.create({ image, name: "照片" }), /已有形象/);
  await assert.rejects(async () => service.resolveUnknown({}), /请填写/);
  assert.equal(service.resolveUnknown({ faceId: "recovered-face" }).status, "pending");
  assert.equal(service.job().faceId, "recovered-face");
});
test("avatar output never double-plays locally or acknowledges unheard audio; interrupt clears remote output", t => {
  const prior = globalThis.WebSocket; globalThis.WebSocket = { OPEN: 1 };
  t.after(() => { globalThis.WebSocket = prior; });
  class Transport {
    sent = []; clears = 0;
    send(bytes) { this.sent.push(bytes); }
    clear() { this.clears++; }
    setPlaybackGain(value) { this.playbackGain = value; }
    stop() { this.closed = true; }
  }
  const events = [], voice = new AvatarVoice({ Transport, onEvent: e => events.push(e) });
  voice.ws = { readyState: 1, send: data => events.push(JSON.parse(data)), close() {} };
  voice.context = { resume: async () => {}, close: async () => {}, createBuffer() { assert.fail("local audio must not play during Simli output"); } };
  voice.receive({ type: "hello", features: { turn_ids: true } });
  voice.receive({ type: "tts", state: "start", turn_id: 1 });
  voice.receive({ type: "tts", state: "sentence_start", turn_id: 1, segment_id: 0, playback_gain: 0.1 });
  assert.equal(voice.avatar.playbackGain, 0.1);
  voice.play(new Int16Array(320).buffer);
  assert.equal(voice.avatar.sent.length, 1);
  voice.interrupt();
  voice.receive({ type: "tts", state: "start", turn_id: 1 });
  voice.play(new Int16Array(320).buffer);
  assert.equal(voice.avatar.sent.length, 1, "late audio from the aborted turn must not reach Simli");
  voice.receive({ type: "tts", state: "sentence_start", turn_id: 1, segment_id: 0, playback_gain: 1 });
  assert.equal(voice.avatar.playbackGain, 0.1, "a rejected sentence cannot change output gain");
  assert.ok(voice.avatar.clears >= 2);
  voice.receive({ type: "tts", state: "start", turn_id: 2 });
  voice.receive({ type: "tts", state: "sentence_start", turn_id: 2, segment_id: 0 });
  voice.control("pause");
  voice.play(new Int16Array(320).buffer);
  assert.equal(voice.avatar.sent.length, 1);
  assert.equal(voice.playbackAcknowledged, false);
  assert.ok(!events.some(e => e.type === "playback"));
  voice.stop(); assert.equal(voice.avatar.closed, true);
});
test("cancelling Simli startup aborts credentials fetch and clears media without starting a new connection", async t => {
  const prior = globalThis.fetch;
  globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
  t.after(() => { globalThis.fetch = prior; });
  const element = () => ({ srcObject: {}, pause() {}, muted: false });
  const video = element(), audio = element(), transport = new SimliTransport({ video, audio });
  const starting = transport.start(); transport.stop();
  await assert.rejects(starting, /通话已取消/);
  assert.equal(video.srcObject, null); assert.equal(audio.srcObject, null); assert.equal(audio.muted, true);
  assert.equal(transport.pc, undefined);
});

test("amplified avatar playback stays muted after interruption, volume changes, and teardown", t => {
  const prior = globalThis.WebSocket; globalThis.WebSocket = { OPEN: 1 };
  t.after(() => { globalThis.WebSocket = prior; });
  const param = () => ({
    value: 0, cancelScheduledValues() {},
    setValueAtTime(value) { this.value = value; }, setTargetAtTime(value) { this.value = value; },
  });
  const node = () => ({ connect(to) { this.connected = to; }, disconnect() { this.connected = null; } });
  const context = {
    currentTime: 1, destination: {},
    createGain: () => ({ ...node(), gain: param() }),
    createDynamicsCompressor: () => ({ ...node(), ...Object.fromEntries(["threshold", "knee", "ratio", "attack", "release"].map(k => [k, param()])) }),
  };
  const element = () => ({ pause() {} });
  const audio = element(), transport = new SimliTransport({ video: element(), audio });
  transport.prepareAudio(context);
  const { volumeGain, compressor, outputGate } = transport;
  assert.equal(volumeGain.gain.value, 2, "new users receive 200% playback gain");
  assert.equal(outputGate.gain.value, 0);
  assert.equal(volumeGain.connected, compressor);
  assert.equal(compressor.connected, outputGate);
  assert.equal(outputGate.connected, context.destination);
  transport.started = true;
  transport.ws = { readyState: 1, bufferedAmount: 0, send() {}, close() {} };
  transport.send(new Int16Array(320).buffer);
  assert.equal(outputGate.gain.value, 1);
  assert.equal(audio.muted, true, "the original media element must never double-play");
  transport.setVolume(0);
  assert.equal(volumeGain.gain.value, 0, "0% mutes immediately");
  transport.setVolume(3);
  assert.equal(volumeGain.gain.value, 3);
  transport.setPlaybackGain(0.1);
  assert.ok(Math.abs(volumeGain.gain.value - 0.3) < 1e-8, "night volume only affects local playback");
  transport.setPlaybackGain(0);
  assert.equal(volumeGain.gain.value, 0);
  transport.setPlaybackGain(undefined);
  assert.equal(volumeGain.gain.value, 3, "older servers without metadata retain normal playback");
  transport.clear();
  transport.setVolume(4);
  assert.equal(outputGate.gain.value, 0, "changing volume cannot revive interrupted output");
  transport.send(new Int16Array(320).buffer);
  assert.equal(outputGate.gain.value, 1, "the next answer can play at the chosen volume");
  transport.stop();
  transport.setVolume(2);
  assert.equal(outputGate.gain.value, 0);
  for (const audioNode of [volumeGain, compressor, outputGate]) assert.equal(audioNode.connected, null);
  assert.equal(audio.srcObject, null);
  assert.deepEqual([null, "", "bad", "0", "3.5", 999, -1].map(normalizeAvatarVolume), [2, 2, 2, 0, 3.5, 4, 0]);
});

test("P2P waits for ICE, negotiates receive-only tracks, and clears audio on interruption and disconnect", async t => {
  const originals = new Map(["fetch", "WebSocket", "RTCPeerConnection"].map(k => [k, globalThis[k]]));
  t.after(() => { for (const [k, v] of originals) globalThis[k] = v; });
  globalThis.fetch = async () => Response.json({ sessionToken: "short-lived", iceServers: [] });
  let socket, peer;
  globalThis.WebSocket = class {
    static OPEN = 1; readyState = 1; bufferedAmount = 0; sent = [];
    constructor(url) { socket = this; this.url = url; queueMicrotask(() => this.onopen?.()); }
    send(value) { this.sent.push(value); }
    close() { this.readyState = 3; }
  };
  globalThis.RTCPeerConnection = class {
    iceGatheringState = "gathering"; transceivers = [];
    constructor() { peer = this; }
    addTransceiver(type, options) { this.transceivers.push([type, options.direction]); }
    async createOffer() { return { type: "offer", sdp: "fixture" }; }
    async setLocalDescription(offer) { this.localDescription = offer; }
    async setRemoteDescription(answer) { this.answer = answer; }
    close() { this.closed = true; }
  };
  const element = () => ({ play: async () => {}, pause() { this.paused = true; }, muted: false });
  const audio = element(), video = element(), errors = [];
  const transport = new SimliTransport({ audio, video, onError: e => errors.push(e) });
  const starting = transport.start();
  await new Promise(setImmediate);
  assert.equal(socket.sent.length, 0, "must not send an offer before gathering candidates");
  assert.match(socket.url, /\/compose\/webrtc\/p2p\?/);
  assert.deepEqual(peer.transceivers, [["audio", "recvonly"], ["video", "recvonly"]]);
  peer.iceGatheringState = "complete"; peer.onicegatheringstatechange();
  await new Promise(setImmediate);
  assert.equal(JSON.parse(socket.sent[0]).type, "offer");
  socket.onmessage({ data: JSON.stringify({ type: "answer", sdp: "answer-fixture" }) });
  assert.equal(peer.answer.sdp, "answer-fixture");
  peer.ontrack({ track: { kind: "audio" }, streams: [{}] });
  peer.ontrack({ track: { kind: "video" }, streams: [{}] }); video.onloadeddata();
  await starting;
  transport.send(new Int16Array(320).buffer);
  assert.ok(socket.sent.at(-1) instanceof Uint8Array);
  assert.equal(audio.muted, false);
  transport.clear();
  assert.equal(socket.sent.at(-1), "SKIP"); assert.equal(audio.muted, true);
  socket.onclose({ code: 1006 });
  assert.equal(errors.length, 1); assert.equal(peer.closed, true);
  assert.match(errors[0], /网络连接中断/);
  assert.ok(!errors[0].includes("余额"), "an abnormal socket closure does not prove a billing problem");
  assert.equal(audio.srcObject, null); assert.equal(video.srcObject, null);
  const count = socket.sent.length; transport.send(new Int16Array(320).buffer);
  assert.equal(socket.sent.length, count);
});

test("ending a call during SDP setup cannot create a new ICE wait after cleanup", async t => {
  const originals = new Map(["fetch", "WebSocket", "RTCPeerConnection"].map(k => [k, globalThis[k]]));
  t.after(() => { for (const [k, v] of originals) globalThis[k] = v; });
  globalThis.fetch = async () => Response.json({ sessionToken: "temporary", iceServers: [] });
  let finishDescription;
  globalThis.WebSocket = class {
    static OPEN = 1; readyState = 0;
    close() { this.readyState = 3; }
  };
  globalThis.RTCPeerConnection = class {
    iceGatheringState = "new";
    addTransceiver() {}
    async createOffer() { return { type: "offer", sdp: "fixture" }; }
    setLocalDescription() { return new Promise(resolve => { finishDescription = resolve; }); }
    close() { this.closed = true; }
  };
  const element = () => ({ pause() {} });
  const transport = new SimliTransport({ video: element(), audio: element() });
  const starting = transport.start();
  await new Promise(setImmediate);
  assert.equal(typeof finishDescription, "function");
  transport.stop(); finishDescription();
  await assert.rejects(starting, /通话已取消/);
  assert.equal(transport.pc.closed, true);
  assert.equal(transport.iceTimer, undefined);
});
