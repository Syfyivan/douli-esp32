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
