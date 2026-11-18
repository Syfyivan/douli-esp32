import test from "node:test";
import assert from "node:assert/strict";
import { BrowserVoice } from "../web/voice.mjs";

test("farewell immediately releases the microphone and cancels queued playback", async (t) => {
  let stoppedTracks = 0;
  const statuses = [],
    played = [];
  const originals = new Map();
  const install = (key, value) => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  };
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const node = () => ({ connect() {}, disconnect() {} });
  class Context {
    currentTime = 0;
    audioWorklet = { addModule: async () => {} };
    resume = async () => {};
    close = async () => {
      this.closed = true;
    };
    createMediaStreamSource = node;
    createGain = () => ({ ...node(), gain: {} });
    createBuffer = (_, length, rate) => ({
      duration: length / rate,
      getChannelData: () => new Float32Array(length),
    });
    createBufferSource = () => {
      const source = {
        ...node(),
        start() {},
        stop() {
          this.stopped = true;
        },
      };
      played.push(source);
      return source;
    };
  }
  class Socket {
    static OPEN = 1;
    readyState = 1;
    send() {}
    close() {
      this.readyState = 3;
    }
    emit(value) {
      this.onmessage({
        data: value instanceof ArrayBuffer ? value : JSON.stringify(value),
      });
    }
  }
  install("AudioContext", Context);
  install(
    "AudioWorkletNode",
    class {
      port = {};
      connect() {}
      disconnect() {}
    },
  );
  install("WebSocket", Socket);
  install("navigator", {
    mediaDevices: {
      getUserMedia: async () => ({
        getTracks: () => [
          {
            stop() {
              stoppedTracks++;
            },
          },
        ],
      }),
    },
  });
  install("location", { protocol: "http:", host: "localhost:8788" });
  const voice = new BrowserVoice({
    onEvent() {},
    onStatus: (s) => statuses.push(s),
  });
  await voice.start(null, "auto");
  t.after(() => voice.stop());
  voice.ws.emit({ type: "hello" });
  voice.ws.emit({ type: "tts", state: "start" });
  voice.ws.emit(new Int16Array(1600).buffer);
  voice.ws.emit({ type: "tts", state: "stop" });
  assert.equal(statuses.at(-1), "speaking");
  voice.ws.emit({ type: "farewell" });
  assert.equal(voice.ready, false);
  assert.equal(stoppedTracks, 1);
  assert.equal(voice.closed, true);
  assert.equal(played[0].stopped, true);
  assert.equal(voice.ws.readyState, 3);
  assert.equal(voice.context.closed, true);
  assert.equal(statuses.at(-1), "off");
  played[0].onended();
  voice.ws.emit({ type: "tts", state: "start" });
  voice.ws.emit(new Int16Array(1600).buffer);
  assert.equal(played.length, 1);
  assert.equal(statuses.at(-1), "off");
});

test("independent controls preserve capture while output holds, and reject old audio after interruption", async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: { OPEN: 1 } });
  t.after(() => previous ? Object.defineProperty(globalThis, "WebSocket", previous) : delete globalThis.WebSocket);
  const sent = [], statuses = [], tracks = [{ enabled: true, stop() {} }], played = [];
  const voice = new BrowserVoice({ onStatus: s => statuses.push(s), onEvent() {} });
  voice.stream = { getTracks: () => tracks };
  voice.ws = { readyState: 1, send: value => sent.push(JSON.parse(value)), close() {} };
  voice.captureContext = { state: "running", close: async () => {} };
  voice.context = {
    currentTime: 0, state: "running", destination: {},
    async suspend() { this.state = "suspended"; }, async resume() { this.state = "running"; }, close: async () => {},
    createBuffer: (_, length, rate) => ({ duration: length / rate, getChannelData: () => new Float32Array(length) }),
    createBufferSource: () => {
      const source = { connect() {}, disconnect() {}, start() {}, stop() {} }; played.push(source); return source;
    },
  };
  voice.receive({ type: "hello", features: { turn_ids: true } });
  voice.control("playback_pause"); await voice.controlQueue;
  assert.equal(voice.context.state, "suspended");
  assert.equal(voice.captureContext.state, "running");
  assert.equal(tracks[0].enabled, true);
  voice.control("pause"); await voice.controlQueue;
  assert.equal(tracks[0].enabled, false);
  voice.control("resume"); await voice.controlQueue;
  assert.equal(tracks[0].enabled, true);
  assert.equal(voice.context.state, "suspended", "independent playback pause survives a call pause");
  voice.control("playback_resume"); voice.control("playback_pause"); voice.control("playback_resume");
  await voice.controlQueue;
  assert.equal(voice.context.state, "running");
  voice.receive({ type: "tts", state: "start", turn_id: 2 });
  voice.receive({ type: "tts", state: "sentence_start", turn_id: 2, segment_id: 0, text: "这段只播一半" });
  voice.play(new Int16Array(1600).buffer);
  voice.context.currentTime = 0.085;
  voice.interrupt();
  const receipt = sent.filter(e => e.type === "playback" && e.state === "interrupted").at(-1);
  assert.equal(receipt.played_ms, 50);
  voice.play(new Int16Array(1600).buffer);
  voice.receive({ type: "tts", state: "start", turn_id: 2 });
  voice.play(new Int16Array(1600).buffer);
  assert.equal(played.length, 1);
  voice.receive({ type: "tts", state: "start", turn_id: 4 });
  voice.receive({ type: "tts", state: "sentence_start", turn_id: 4, segment_id: 0, text: "新的回答" });
  voice.play(new Int16Array(1600).buffer);
  const before = sent.length;
  played[0].onended();
  assert.equal(sent.length, before, "the old source's completion must not acknowledge new playback");
  voice.control("mute", true); await voice.controlQueue;
  assert.equal(tracks[0].enabled, false);
  assert.equal(voice.context.state, "running");
  voice.stop();
});

test("completed playback segments are never downgraded to interrupted on mid-turn barge or next turn start", t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: { OPEN: 1 } });
  t.after(() => previous ? Object.defineProperty(globalThis, "WebSocket", previous) : delete globalThis.WebSocket);
  const sent = [], statuses = [], played = [];
  const voice = new BrowserVoice({ onStatus: s => statuses.push(s), onEvent() {} });
  voice.ws = { readyState: 1, send: value => sent.push(JSON.parse(value)), close() {} };
  voice.context = {
    currentTime: 0, state: "running", destination: {},
    async suspend() {}, async resume() {}, close: async () => {},
    createBuffer: (_, length, rate) => ({ duration: length / rate, getChannelData: () => new Float32Array(length) }),
    createBufferSource: () => {
      const source = { connect() {}, disconnect() {}, start() {}, stop() {} };
      played.push(source);
      return source;
    },
  };
  voice.receive({ type: "hello", features: { turn_ids: true } });

  // Turn 1: two sentences, first completes, second interrupted mid-way.
  voice.receive({ type: "tts", state: "start", turn_id: 1 });
  voice.receive({ type: "tts", state: "sentence_start", turn_id: 1, segment_id: 0, text: "第一句播完。" });
  voice.play(new Int16Array(1600).buffer); // 100ms
  voice.receive({ type: "tts", state: "sentence_end", turn_id: 1, segment_id: 0, duration_ms: 100 });
  played[0].onended();
  assert.equal(sent.filter(e => e.type === "playback" && e.turn_id === 1 && e.segment_id === 0).at(-1)?.state, "complete");

  voice.receive({ type: "tts", state: "sentence_start", turn_id: 1, segment_id: 1, text: "第二句被打断。" });
  voice.play(new Int16Array(1600).buffer);
  voice.context.currentTime = 0.165;
  voice.interrupt();
  assert.equal(
    sent.some(e => e.type === "playback" && e.turn_id === 1 && e.segment_id === 0 && e.state === "interrupted"),
    false,
    "already completed segment 0 must not be marked interrupted",
  );
  assert.equal(
    sent.some(e => e.type === "playback" && e.turn_id === 1 && e.segment_id === 1 && e.state === "interrupted"),
    true,
  );

  // Turn 2 finishes completely; Turn 3 start must not re-report Turn 2 segments as interrupted.
  voice.receive({ type: "tts", state: "start", turn_id: 2 });
  voice.receive({ type: "tts", state: "sentence_start", turn_id: 2, segment_id: 0, text: "完整播完的一轮。" });
  voice.play(new Int16Array(1600).buffer);
  voice.receive({ type: "tts", state: "sentence_end", turn_id: 2, segment_id: 0, duration_ms: 100 });
  voice.receive({ type: "tts", state: "stop", turn_id: 2 });
  played[2].onended();
  assert.equal(statuses.at(-1), "listening");

  voice.receive({ type: "tts", state: "start", turn_id: 3 });
  assert.equal(
    sent.some(e => e.type === "playback" && e.turn_id === 2 && e.state === "interrupted"),
    false,
    "starting Turn 3 must not mark finished Turn 2 segments as interrupted",
  );

  // Calling start() on an already closed client is a safe no-op.
  voice.stop();
  let createdAfterClose = false;
  globalThis.AudioContext = class { constructor() { createdAfterClose = true; } };
  t.after(() => { delete globalThis.AudioContext; });
  void voice.start(null, "auto");
  assert.equal(createdAfterClose, false);
});

test("AudioWorklet capture resamples 48 kHz 128-sample blocks to exact 16 kHz frames without sample drift", async t => {
  let Processor;
  const messages = [];
  globalThis.AudioWorkletProcessor = class {
    port = { postMessage: data => messages.push(data) };
  };
  globalThis.registerProcessor = (_name, Cls) => { Processor = Cls; };
  globalThis.sampleRate = 48000;
  t.after(() => {
    delete globalThis.AudioWorkletProcessor;
    delete globalThis.registerProcessor;
    delete globalThis.sampleRate;
  });
  await import("../web/capture.js");
  const capture = new Processor();
  // 76 blocks * 128 samples = 9,728 samples at 48 kHz (>= 9,601 needed for 3,200 output samples).
  for (let b = 0; b < 76; b++) {
    const block = new Float32Array(128);
    for (let i = 0; i < 128; i++) {
      const sampleIndex = b * 128 + i;
      block[i] = Math.sin((2 * Math.PI * 440 * sampleIndex) / 48000) * 0.5;
    }
    capture.process([[block]]);
  }
  assert.equal(messages.length, 10, "76 blocks (9728 @ 48kHz -> 3242 @ 16kHz) must produce exactly 10 frames of 320 samples");
  const combined = new Int16Array(3200);
  messages.forEach((m, idx) => combined.set(new Int16Array(m.pcm), idx * 320));
  for (let k = 0; k < 3200; k++) {
    const expected = Math.round(Math.sin((2 * Math.PI * 440 * k) / 16000) * 0.5 * 32767);
    assert.ok(Math.abs(combined[k] - expected) <= 1, `sample ${k} drifted: got ${combined[k]}, expected ${expected}`);
  }
});
