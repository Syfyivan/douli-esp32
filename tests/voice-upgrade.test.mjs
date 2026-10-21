import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once, EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { PcmResampler, rms } from "../server/audio.mjs";
import { SpeechDetector } from "../server/speech-detector.mjs";
import { VoiceState, audibleContext } from "../server/voice-state.mjs";
import { SpeechSegments } from "../server/voice-segments.mjs";
import { TurnDetector, isBackchannel, isExplicitInterruption, isPlaybackEcho } from "../server/turn-detector.mjs";
import { defaults } from "../server/config.mjs";
import { streamSpeech, LiveTranscriber } from "../server/providers.mjs";
import { VoiceConnection } from "../server/gateway.mjs";
import { Store } from "../server/store.mjs";
import { PassThrough } from "node:stream";

test("WASM speech detector rejects silence and stationary DC that passes an energy threshold", () => {
  const vad = new SpeechDetector();
  try {
    for (let i = 0; i < 20; i++) assert.equal(vad.detect(Buffer.alloc(640)), false);
    const dc = Buffer.alloc(640);
    for (let i = 0; i < 640; i += 2) dc.writeInt16LE(8000, i);
    assert.ok(rms(dc) > 0.012);
    let detected = 0;
    for (let i = 0; i < 100; i++) detected += +vad.detect(dc);
    assert.ok(detected < 30, `stationary input marked speech in ${detected} frames`);
  } finally { vad.close(); }
});

test("streaming resampling preserves boundaries across odd network chunk sizes", () => {
  const pcm = Buffer.alloc(48000);
  for (let i = 0; i < 24000; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 9) * 22000), i * 2);
  for (const rate of [16000, 24000, 48000]) {
    const full = new PcmResampler(rate), split = new PcmResampler(rate);
    const expected = full.push(pcm, true), out = [];
    for (let at = 0; at < pcm.length; at += 137) out.push(split.push(pcm.subarray(at, at + 137)));
    out.push(split.push(Buffer.alloc(0), true));
    assert.deepEqual(Buffer.concat(out), expected);
    assert.equal(expected.length, 48000 * 16000 / rate);
  }
  assert.throws(() => new PcmResampler(24000).push(Buffer.alloc(3), true), /不完整/);
});

test("input/output controls retain their independent state across a whole-call pause", () => {
  const s = new VoiceState();
  s.update({ input: "recognizing", output: "speaking", playbackPaused: true });
  assert.equal(s.acceptingAudio, true);
  s.update({ paused: true });
  assert.equal(s.acceptingAudio, false);
  s.update({ paused: false });
  assert.equal(s.acceptingAudio, true);
  assert.equal(s.holdingPlayback, true);
  s.update({ muted: true, playbackPaused: false });
  assert.equal(s.acceptingAudio, false);
  assert.equal(s.holdingPlayback, false);
  assert.equal(s.output, "speaking");
});

test("adaptive ending retains unfinished expressions and invalidates decisions when speech continues", () => {
  const d = new TurnDetector(structuredClone(defaults));
  d.partial("我想问一下，因为");
  assert.ok(d.threshold() >= 2200);
  d.partial("明天天气怎么样？");
  d.decision = { complete: true };
  assert.equal(d.threshold(), 500);
  const control = d.request = new AbortController();
  d.speech();
  assert.equal(control.signal.aborted, true);
  assert.equal(d.threshold(), defaults.input.silenceMs);
  assert.ok(isBackchannel("嗯，"));
  assert.ok(!isBackchannel("嗯，我还有个问题"));
  assert.ok(isExplicitInterruption("等一下，我说的是明天"));
});

test("early segmentation streams the first clause and cancels delayed output on interruption", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const output = [];
  let active = true;
  const segments = new SpeechSegments({ onSegment: s => output.push(s), isActive: () => active });
  segments.push("先说第一件事情，");
  assert.deepEqual(output, ["先说第一件事情，"]);
  segments.push("第二件事情需要稍微多一点解释。");
  segments.finish();
  assert.equal(output.join(""), "先说第一件事情，第二件事情需要稍微多一点解释。");
  const pending = new SpeechSegments({ onSegment: s => output.push(s), isActive: () => active });
  pending.push("这是还没有标点但应该尽快开始的回答");
  active = false;
  t.mock.timers.tick(1000);
  pending.close();
  assert.equal(output.length, 2);
});

test("first speech deadline flushes at 350 ms and does not restart when early text was too short", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const output = [];
  const segments = new SpeechSegments({ onSegment: s => output.push(s) });
  segments.push("惯性");
  t.mock.timers.tick(350);
  assert.deepEqual(output, []);
  segments.push("就是物体保持原来运动状态的性质");
  assert.equal(output.length, 1, "enough text arriving after the deadline starts immediately");
  segments.finish();
  assert.equal(output.join(""), "惯性就是物体保持原来运动状态的性质");
  const next = new SpeechSegments({ onSegment: s => output.push(s) });
  next.push("这是一句没有标点的完整回答");
  t.mock.timers.tick(349);
  assert.equal(output.length, 1);
  t.mock.timers.tick(1);
  assert.equal(output.length, 2);
  next.close();
});

test("faster endpoint keeps ASR-punctuated hesitation and unfinished clauses open", () => {
  const detector = new TurnDetector(structuredClone(defaults));
  for (const text of ["我想。", "但是，", "因为。", "我还没说完！", "让我想想。"]) {
    detector.partial(text);
    detector.decision = { complete: true };
    assert.equal(detector.threshold(), 2200, text);
  }
  detector.partial("今天过得怎么样？");
  assert.equal(detector.threshold(), 500);
  detector.close();
});

test("speech bytes reach the caller before the provider finishes its HTTP response", async t => {
  let finishResponse;
  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    res.write(Buffer.alloc(640, 1));
    finishResponse = () => res.end(Buffer.alloc(640, 2));
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const speech = streamSpeech({ baseUrl: `http://127.0.0.1:${server.address().port}`, model: "test", pcmSampleRate: 16000 });
  const first = await speech.next();
  assert.equal(first.done, false);
  assert.equal(first.value[0], 1);
  finishResponse();
  const chunks = [];
  for await (const chunk of speech) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).length, 640);
});

function connection(t) {
  const directory = mkdtempSync(join(tmpdir(), "douli-voice-upgrade-")), store = new Store(directory);
  const settings = store.settings();
  Object.assign(settings.input, { vad: "energy", previewMs: 0, semanticEndpoint: false });
  store.saveSettings(settings);
  const sent = [], socket = new EventEmitter();
  Object.assign(socket, { readyState: 1, send: s => sent.push(typeof s === "string" ? JSON.parse(s) : s), ping() {}, close() { this.readyState = 3; this.emit("close"); } });
  const c = new VoiceConnection({ store, connections: new Map(), engine: { context: () => "", run: async () => ({}) } }, socket, { browser: true });
  c.message({ type: "hello", features: { playback_ack: true }, audio_params: { format: "pcm", sample_rate: 16000, channels: 1 } });
  c.message({ type: "listen", state: "start" });
  t.after(() => {
    socket.close(); store.close();
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe cleanup");
    rmSync(directory, { recursive: true, force: true });
  });
  return { c, sent, store };
}

function replyFixture(t, text, onSpeech) {
  const fixture = connection(t), { c, store } = fixture;
  c.options.browser = false;
  c.options.device = { id: "reply-fixture" };
  const settings = store.settings();
  settings.models.tts = { baseUrl: "http://speech.fixture", model: "fixture", pcmSampleRate: 16000 };
  store.saveSettings(settings);
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const input = JSON.parse(options.body).input;
    requests.push(input);
    return new Response(new ReadableStream({ start(controller) {
      const abort = () => controller.error(options.signal.reason);
      options.signal.addEventListener("abort", abort, { once: true });
      onSpeech({ input, controller, signal: options.signal, end(bytes) {
        options.signal.removeEventListener("abort", abort);
        if (bytes) controller.enqueue(bytes);
        controller.close();
      } });
    } }));
  });
  c.engine.run = async ({ emit }) => {
    emit({ type: "delta", text });
    const message = store.message(c.session.id, "assistant", text);
    emit({ type: "done", message });
    return { message, text };
  };
  return { ...fixture, requests };
}

test("gateway forwards text directly into one bidirectional session and plays before the answer completes", async t => {
  const { c, sent, store } = connection(t), settings = store.settings();
  settings.input.ttsProvider = "volcengine";
  settings.models.streamingTts = { baseUrl: "https://openspeech.bytedance.com", model: "seed-tts-2.0", voice: "fixture", apiKey: "fixture", pcmSampleRate: 24000 };
  store.saveSettings(settings);
  const profile = store.settings().models.streamingTts, writes = [], firstAudio = Promise.withResolvers();
  const audio = new PassThrough(), done = Promise.withResolvers();
  done.promise.catch(() => {});
  let sessions = 0, llmFinished = false;
  c.streamingTtsKey = JSON.stringify(profile);
  c.streamingTts = {
    close() {}, session(signal) {
      sessions++;
      signal.addEventListener("abort", () => { audio.destroy(); done.reject(signal.reason); }, { once: true });
      return {
        audio, completion: done.promise,
        write(text) { writes.push(text); audio.write(Buffer.alloc(48000, 1)); },
        finish() { audio.end(); done.resolve(); return done.promise; },
        cancel() { audio.destroy(); done.reject(new Error("cancelled")); },
      };
    },
  };
  const send = c.ws.send.bind(c.ws);
  t.mock.method(c.ws, "send", value => {
    send(value);
    if (Buffer.isBuffer(value)) firstAudio.resolve(!llmFinished);
  });
  c.engine.run = async ({ emit }) => {
    emit({ type: "delta", text: "惯性" });
    assert.deepEqual(writes, ["惯性"], "short deltas must not wait for a sentence boundary");
    assert.equal(await Promise.race([firstAudio.promise, delay(1500).then(() => false)]), true);
    emit({ type: "delta", text: "让物体保持原来的运动状态。" });
    llmFinished = true;
    const text = writes.join(""), message = store.message(c.session.id, "assistant", text);
    emit({ type: "done", message });
    return { message, text };
  };
  await c.process(null, "解释惯性");
  assert.equal(sessions, 1);
  assert.equal(sent.filter(Buffer.isBuffer).length, 100, "two seconds of 24 kHz audio becomes 100 16 kHz frames");
  assert.equal(sent.find(e => e.state === "sentence_end").text, writes.join(""));
  assert.equal(c.turns.get(c.call.turnId).segments[0].text, writes.join(""));
});

test("avatar onset metrics accept current browser turns without claiming playback acknowledgement", t => {
  const { c } = connection(t);
  const turn = c.startTurn(); turn.firstAudioSentAt = Date.now();
  const saved = [];
  t.mock.method(c, "savePlayback", value => saved.push(value));
  const send = (id, value) => c.message({ type: "avatar_metric", turn_id: id, name: "avatarAudioMs", value });
  send(turn.id, 300); assert.equal(saved.length, 0, "ordinary clients cannot submit avatar telemetry");
  c.features.avatar_audio = true;
  for (const value of [-1, Infinity, NaN, 30001, "300"]) send(turn.id, value);
  send(turn.id + 1, 300); assert.equal(saved.length, 0);
  c.options.browser = false; send(turn.id, 300); assert.equal(saved.length, 0);
  c.options.browser = true;
  const acknowledged = turn.acknowledged;
  send(turn.id, 345.6);
  assert.equal(turn.timings.avatarAudioMs, 346);
  assert.equal(turn.acknowledged, acknowledged);
  assert.equal(saved.length, 1);
  turn.interrupted = true; send(turn.id, 500); assert.equal(saved.length, 1);
});

test("a failed playback consumer cancels unfinished synthesis before the next turn", async t => {
  const { c, sent, store } = connection(t), settings = store.settings();
  settings.input.ttsProvider = "volcengine";
  settings.models.streamingTts = { baseUrl: "https://openspeech.bytedance.com", model: "seed-tts-2.0", voice: "fixture", apiKey: "fixture", pcmSampleRate: 24000 };
  store.saveSettings(settings);
  c.streamingTtsKey = JSON.stringify(store.settings().models.streamingTts);
  let open = false, sessions = 0, cancelled = 0, current;
  c.streamingTts = {
    close() { current?.cancel(); },
    session() {
      assert.equal(open, false, "the previous failed consumer must release its upstream session");
      open = true; sessions++;
      const audio = new PassThrough(), done = Promise.withResolvers(), first = sessions === 1;
      audio.on("error", () => {}); done.promise.catch(() => {});
      return current = {
        audio, completion: done.promise,
        write() { audio.write(Buffer.alloc(first ? 48000 : 9600)); },
        finish() { if (!first) { audio.end(); open = false; done.resolve(); } return done.promise; },
        cancel() { if (open) { cancelled++; open = false; audio.destroy(new Error("cancelled")); done.reject(new Error("cancelled")); } },
      };
    },
  };
  const speak = c.speak.bind(c);
  t.mock.method(c, "speak", (...args) => sessions === 1 ? Promise.reject(new Error("fixture playback failed")) : speak(...args));
  c.engine.run = async ({ emit }) => {
    const text = "测试语音。";
    emit({ type: "delta", text });
    const message = store.message(c.session.id, "assistant", text);
    emit({ type: "done", message }); return { text, message };
  };
  await c.process(null, "第一轮");
  assert.equal(cancelled, 1);
  assert.equal(open, false);
  assert.ok(sent.some(e => e.type === "error" && /播放失败/.test(e.message)));
  await c.process(null, "第二轮");
  assert.equal(sessions, 2);
  assert.equal(sent.filter(Buffer.isBuffer).length, 10);
});

test("a typed browser turn measures from submission instead of the previous microphone utterance", async t => {
  const { c } = replyFixture(t, "测试回答。", speech => speech.end(Buffer.alloc(640)));
  c.options.browser = true;
  c.lastSpeechAt = Date.now() - 30000;
  const process = c.process.bind(c);
  let running;
  t.mock.method(c, "process", (...args) => (running = process(...args)));
  c.message({ type: "text", text: "测试" });
  await running;
  assert.ok(c.turns.get(c.call.turnId).timings.endpointMs < 100);
});

test("a tiny stalled TTS head waits for a safe reserve or the complete short clause", async t => {
  const received = Promise.withResolvers();
  const { c, sent, store } = replyFixture(t, "音量已调到百分之八十。", speech => {
    speech.controller.enqueue(Buffer.alloc(640 * 5));
    received.resolve(speech);
  });
  const running = c.process(null, "声音调大一点");
  t.after(async () => { c.abort(); await running; });
  const speech = await received.promise;
  await delay(180);
  const premature = sent.filter(Buffer.isBuffer).length;
  speech.end(Buffer.alloc(640 * 30));
  await running;
  assert.equal(premature, 0, "do not start playing a sentence with an incomplete, stalled source");
  assert.equal(sent.filter(Buffer.isBuffer).length, 35);
  const playback = store.messages(c.session.id).at(-1).metadata.voicePlayback;
  assert.equal(playback.audioDelivery.audioFramesSent, 35);
  assert.equal(playback.audioDelivery.audioDurationMs, 700);
  assert.equal(playback.audioDelivery.bufferLeadMs, 200);
  assert.ok(playback.audioDelivery.firstAudioSentMs >= 180);
});

test("ESP32 starts a buffered reply before TTS completes and retains every audio frame", async t => {
  const received = Promise.withResolvers(), firstAudio = Promise.withResolvers();
  const { c, sent } = replyFixture(t, "这是一段可以边合成边播放的回答。", speech => {
    speech.controller.enqueue(Buffer.alloc(640 * 45));
    received.resolve(speech);
  });
  const send = c.ws.send.bind(c.ws);
  t.mock.method(c.ws, "send", value => { send(value); if (Buffer.isBuffer(value)) firstAudio.resolve(true); });
  const running = c.process(null, "请回答");
  t.after(async () => { c.abort(); await running; });
  const speech = await received.promise;
  assert.equal(await Promise.race([firstAudio.promise, delay(500).then(() => false)]), true,
    "playback must begin while the provider's remaining audio is still pending");
  speech.end(Buffer.alloc(640 * 15));
  await running;
  assert.equal(sent.filter(Buffer.isBuffer).length, 60);
  assert.equal(c.lastReply.audioDurationMs, 1200);
});

test("ordinary replies prepare the next sentence during playback, with only one sentence of lookahead", async t => {
  const firstPlaying = Promise.withResolvers(), releaseFirst = Promise.withResolvers();
  const secondReady = Promise.withResolvers();
  const { c, requests } = replyFixture(t, "这是第一句。接着是第二句。最后是第三句。", speech => {
    speech.end(Buffer.alloc(640 * 10));
    if (requests.length === 2) secondReady.resolve();
  });
  const original = c.speak.bind(c);
  t.mock.method(c, "speak", async (...args) => {
    if (args[0] === "这是第一句。") { firstPlaying.resolve(); await releaseFirst.promise; }
    return original(...args);
  });
  const running = c.process(null, "继续说");
  t.after(async () => { releaseFirst.resolve(); c.abort(); await running; });
  await firstPlaying.promise;
  await Promise.race([secondReady.promise, delay(200)]);
  const duringFirst = requests.slice();
  releaseFirst.resolve();
  await running;
  assert.deepEqual(duringFirst, ["这是第一句。", "接着是第二句。"], "the next request must not wait for the current playback to finish or prepare the entire answer");
  assert.deepEqual(requests, ["这是第一句。", "接着是第二句。", "最后是第三句。"]);
});

test("interruption cancels the prefetched speech and never emits its late audio", async t => {
  const nextStarted = Promise.withResolvers();
  const { c, sent, requests } = replyFixture(t, "这是第一句。接着是第二句。最后是第三句。", speech => {
    if (requests.length === 1) speech.end(Buffer.alloc(640 * 50));
    else { speech.controller.enqueue(Buffer.alloc(640)); nextStarted.resolve(speech); }
  });
  const running = c.process(null, "继续说");
  t.after(async () => { c.abort(); await running; });
  const next = await Promise.race([nextStarted.promise, delay(1500).then(() => null)]);
  assert.ok(next, "next sentence must be prefetched");
  c.abort();
  const frames = sent.filter(Buffer.isBuffer).length;
  await running;
  assert.equal(next.signal.aborted, true);
  assert.equal(sent.filter(Buffer.isBuffer).length, frames);
  assert.equal(requests.length, 2, "interrupted queued text must not start another synthesis");
});

test("playback receipts keep unheard words out of context and stale receipts cannot stop a new turn", t => {
  const { c, store } = connection(t);
  const turn = c.startTurn();
  turn.messageId = store.message(c.session.id, "assistant", "第一句。还没听到的第二句。").id;
  turn.generated = true;
  turn.segments = [{ text: "第一句。", durationMs: 1000, playedMs: 0, finished: true }, { text: "还没听到的第二句。", durationMs: 2000, playedMs: 0, finished: true }];
  c.playback({ turn_id: turn.id, segment_id: 0, played_ms: 999999 });
  c.playback({ turn_id: turn.id, segment_id: 1, played_ms: 400 });
  c.abort();
  c.startTurn();
  c.state = "speaking";
  c.playback({ turn_id: turn.id, segment_id: 1, played_ms: 2000 });
  assert.equal(c.call.output, "speaking");
  assert.equal(turn.segments[0].playedMs, 1000);
  // The initial interrupted record is conservative until a later receipt is confirmed.
  const context = audibleContext({ role: "assistant", text: "全文", metadata: { voicePlayback: { status: "interrupted", spokenText: "第一句。" } } });
  assert.ok(context.includes("第一句。"));
  assert.ok(!context.includes("全文"));
  assert.ok(store.messages(c.session.id)[0].metadata.voicePlayback.status === "interrupted");
});

test("short acknowledgement leaves output running; new speech during classification is preserved", async t => {
  const { c, sent } = connection(t);
  const voiced = Buffer.alloc(640);
  for (let i = 0; i < 640; i += 2) voiced.writeInt16LE(4000, i);
  t.mock.method(LiveTranscriber.prototype, "finish", async () => "嗯");
  c.state = "speaking";
  c.beginBarge(Array(7).fill(voiced));
  for (let i = 0; i < 12; i++) c.captureBarge(Buffer.alloc(640), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.bargeCandidate, null);
  assert.equal(c.call.output, "speaking");
  assert.equal(c.bargeInCount, 0);
  assert.ok(sent.some(e => e.type === "barge" && e.state === "resume"));
  t.mock.method(LiveTranscriber.prototype, "finish", () => new Promise(() => {}));
  c.beginBarge(Array(7).fill(voiced));
  for (let i = 0; i < 12; i++) c.captureBarge(Buffer.alloc(640), false);
  assert.equal(c.bargeCandidate.finishing, true);
  c.captureBarge(voiced, true);
  assert.equal(c.bargeCandidate, null);
  assert.equal(c.bargeInCount, 1);
  assert.ok(c.buffer.speechMs >= 160);
});

test("an unconfirmed ESP32 interruption cannot insert an ASR-sized gap into a spoken sentence", async t => {
  const { c, sent } = connection(t);
  c.options.browser = false;
  const classified = Promise.withResolvers();
  t.mock.method(LiveTranscriber.prototype, "finish", () => classified.promise);
  const control = new AbortController();
  c.controller = control;
  const voiced = Buffer.alloc(640);
  for (let i = 0; i < voiced.length; i += 2) voiced.writeInt16LE(4000, i);
  const turn = c.startTurn();
  turn.wake = c.lastWake = { receivedAt: new Date().toISOString(), cacheHit: true };
  c.state = "speaking";
  const speech = c.speak("我在，慢慢说。", control.signal, () => !control.signal.aborted, turn,
    [Buffer.alloc(640 * 90)]);
  speech.catch(() => {});
  t.after(async () => { control.abort(); classified.resolve(""); await speech.catch(() => {}); });
  await delay(80);
  const before = sent.filter(Buffer.isBuffer).length;
  assert.ok(before > 0);
  c.beginBarge(Array(7).fill(voiced));
  for (let i = 0; i < 12; i++) c.captureBarge(Buffer.alloc(640), false);
  assert.equal(c.bargeCandidate.finishing, true);
  await delay(160);
  assert.ok(sent.filter(Buffer.isBuffer).length >= before + 3,
    "audio must continue while recognition decides whether a brief sound is an interruption");
  assert.ok(!sent.some(e => e.type === "barge" && e.state === "hold"),
    "clients must not be told to pause on an unconfirmed interruption");
  classified.resolve("嗯");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.bargeInCount, 0);
  assert.equal(c.call.output, "speaking");
  c.beginBarge(Array(7).fill(voiced));
  for (let i = 0; i < 23; i++) c.captureBarge(voiced, true);
  assert.equal(c.bargeInCount, 0, "ESP32 speech duration alone cannot prove it is not playback echo");
  c.bargeCandidate.live.onPartial("停一下");
  assert.equal(c.bargeInCount, 1, "an explicit spoken request must still interrupt");
  assert.equal(control.signal.aborted, true);
  await speech.catch(() => {});
  const stoppedAt = sent.filter(Buffer.isBuffer).length;
  await delay(60);
  assert.equal(sent.filter(Buffer.isBuffer).length, stoppedAt, "confirmed interruption stops old audio");
});

test("playback echo comparison handles punctuation and fragments without discarding new questions", () => {
  assert.equal(isPlaybackEcho("我在，慢慢。", "我在，慢慢说。"), true);
  assert.equal(isPlaybackEcho("慢慢说", "我在，慢慢说。"), true);
  assert.equal(isPlaybackEcho("", "我在，慢慢说。"), false);
  assert.equal(isPlaybackEcho("我在开会，请小声一点", "我在，慢慢说。"), false);
  assert.equal(isPlaybackEcho("我在，慢慢说。现在几点了？", "我在，慢慢说。"), false);
});

test("a cached ESP32 greeting remains complete despite over 600ms of its own recognized speech", async t => {
  const { c, store, sent } = connection(t);
  c.options.browser = false;
  c.features.playback_ack = false;
  const settings = store.settings();
  settings.assistant.greeting = "我在，慢慢说。";
  settings.models.tts.pcmSampleRate = 16000;
  store.saveSettings(settings);
  c.gateway.greetingAudio = { source: () => ({ audio: [Buffer.alloc(640 * 100)], cacheHit: true }) };
  t.mock.method(LiveTranscriber.prototype, "finish", async () => "我在，慢慢说。");
  const voiced = Buffer.alloc(640);
  for (let i = 0; i < voiced.length; i += 2) voiced.writeInt16LE(4000, i);
  const playing = c.greet();
  t.after(async () => { c.abort(); await playing; });
  await delay(60);
  c.beginBarge(Array(7).fill(voiced));
  c.bargeCandidate.live.onPartial("我在，慢慢。");
  for (let i = 0; i < 40; i++) c.captureBarge(voiced, true);
  assert.equal(c.bargeInCount, 0);
  assert.equal(c.controller.signal.aborted, false);
  for (let i = 0; i < 12; i++) c.captureBarge(Buffer.alloc(640), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.lastBargeCandidate.reason, "playback_echo");
  assert.equal(c.bargeCandidate, null);
  await playing;
  assert.equal(sent.filter(Buffer.isBuffer).length, 100);
  assert.equal(c.lastWake.completed, true);
  assert.equal(c.lastWake.interrupted, undefined);
  assert.equal(c.state, "listening");
});

test("new speech after an echo while classification is pending is preserved and can interrupt", async t => {
  const { c } = connection(t);
  c.options.browser = false;
  const turn = c.startTurn();
  turn.segments = [{ text: "我在，慢慢说。", durationMs: 1000 }];
  c.state = "speaking";
  const classified = Promise.withResolvers();
  t.mock.method(LiveTranscriber.prototype, "finish", () => classified.promise);
  const voiced = Buffer.alloc(640);
  for (let i = 0; i < voiced.length; i += 2) voiced.writeInt16LE(4000, i);
  c.beginBarge(Array(7).fill(voiced));
  const echo = c.bargeCandidate;
  for (let i = 0; i < 12; i++) c.captureBarge(Buffer.alloc(640), false);
  assert.equal(echo.finishing, true);
  for (let i = 0; i < 20; i++) c.captureBarge(voiced, true);
  assert.equal(c.bargeInCount, 0);
  classified.resolve("我在，慢慢说。");
  await new Promise(resolve => setImmediate(resolve));
  assert.notEqual(c.bargeCandidate, echo);
  assert.equal(c.bargeCandidate.speechMs, 400);
  c.bargeCandidate.live.onPartial("明天的天气怎么样");
  assert.equal(c.bargeInCount, 1);
  assert.equal(c.lastBargeCandidate.reason, "distinct_speech");
  assert.ok(c.buffer.speechMs >= 400);
});

test("unrecognized ESP32 playback candidates have a bounded audio buffer", t => {
  const { c } = connection(t);
  c.options.browser = false;
  const turn = c.startTurn();
  turn.segments = [{ text: "正在播放的回答。", durationMs: 1000 }];
  c.state = "speaking";
  const voiced = Buffer.alloc(640);
  for (let i = 0; i < voiced.length; i += 2) voiced.writeInt16LE(4000, i);
  c.beginBarge(Array(7).fill(voiced));
  for (let i = 0; i < 300; i++) c.captureBarge(voiced, true);
  assert.equal(c.bargeCandidate, null);
  assert.equal(c.bargeInCount, 0);
  assert.equal(c.lastBargeCandidate.reason, "input_limit");
  assert.equal(c.state, "speaking");
});

test("voice playback accounting cannot leak encrypted health answers into ordinary metadata", t => {
  const { c, store } = connection(t);
  const turn = c.startTurn();
  turn.messageId = store.message(c.session.id, "assistant", "健康回答（保存在加密健康档案）", { metadata: { healthPrivate: true } }).id;
  turn.generated = true;
  turn.segments = [{ text: "private-health-answer", durationMs: 100, playedMs: 100, finished: true }];
  c.savePlayback(turn);
  assert.ok(!JSON.stringify(store.messages(c.session.id)).includes("private-health-answer"));
  assert.equal(store.messages(c.session.id)[0].metadata.voicePlayback.status, "complete");
});
