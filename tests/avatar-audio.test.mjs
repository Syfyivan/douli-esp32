import test from "node:test";
import assert from "node:assert/strict";
import { defaults } from "../server/config.mjs";
import { VoiceConnection } from "../server/gateway.mjs";
import { StreamingPlayback } from "../server/streaming-playback.mjs";

function fixture({ browser = true, avatar = true, night = true } = {}) {
  const settings = structuredClone(defaults);
  Object.assign(settings.assistant.night, { enabled: night, start: "22:00", end: "07:00", volume: 0.1 });
  settings.models.tts.pcmSampleRate = 24000;
  const frames = [], encodedFrames = [], events = [];
  const connection = Object.create(VoiceConnection.prototype);
  Object.assign(connection, {
    options: { browser }, features: { avatar_audio: avatar }, config: { volume: 0.5 },
    store: { settings: () => settings },
    call: { turnId: 1, holdingPlayback: false, update(value) { Object.assign(this, value); } },
    version: 1,
    ws: { send: bytes => frames.push(Buffer.from(bytes)) },
    // Capture the PCM entering the device codec, without asserting hardware output.
    encoder: { encode: bytes => { encodedFrames.push(Buffer.from(bytes)); return Buffer.from(bytes); } },
    send: event => events.push(event), mark() {}, recordAudioSent() {},
    paceOutput: async () => ({ sent() {} }),
  });
  const turn = { id: 1, segments: [], lastSpeechAt: Date.now() };
  const pcm = Buffer.alloc(960);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(12000, i);
  return { connection, settings, turn, pcm, frames, encodedFrames, events };
}

async function render(mode, fixture) {
  const { connection, turn, pcm, settings } = fixture;
  const signal = new AbortController().signal;
  if (mode === "cascade") {
    await connection.speak("test", signal, () => true, turn,
      (async function* () { yield pcm; })(), settings);
  } else {
    const playback = new StreamingPlayback(connection, turn, signal, () => true);
    await playback.push(pcm);
    await playback.finish("test");
  }
}

for (const mode of ["cascade", "realtime"]) {
  test(`${mode}: avatar driving PCM keeps its amplitude and carries night volume separately`, async t => {
    t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 9, 20, 23, 30).getTime() });
    const f = fixture();
    await render(mode, f);
    assert.equal(f.frames.length, 1);
    assert.equal(f.frames[0].length, 640, "one 24 kHz input frame becomes one 16 kHz / 20 ms frame");
    assert.equal(f.frames[0].readInt16LE(0), 12000, "night mode must not reduce the signal driving lip movement");
    assert.equal(f.events.find(e => e.state === "sentence_start").playback_gain, 0.05);
    assert.equal(f.encodedFrames.length, 0);
  });

  test(`${mode}: ordinary browser playback retains night attenuation`, async t => {
    t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 9, 20, 23, 30).getTime() });
    const f = fixture({ avatar: false });
    await render(mode, f);
    assert.equal(f.frames[0].readInt16LE(0), 600);
    assert.equal(Object.hasOwn(f.events.find(e => e.state === "sentence_start"), "playback_gain"), false);
  });

  test(`${mode}: device clients cannot bypass their playback volume using the avatar feature`, async t => {
    t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 9, 20, 23, 30).getTime() });
    const f = fixture({ browser: false });
    await render(mode, f);
    assert.equal(f.encodedFrames.length, 1);
    assert.equal(f.encodedFrames[0].readInt16LE(0), 600);
    assert.equal(Object.hasOwn(f.events.find(e => e.state === "sentence_start"), "playback_gain"), false);
  });

  test(`${mode}: disabling night mode updates avatar playback gain without changing driving PCM`, async () => {
    const f = fixture({ night: false });
    await render(mode, f);
    assert.equal(f.frames[0].readInt16LE(0), 12000);
    assert.equal(f.events.find(e => e.state === "sentence_start").playback_gain, 0.5);
  });
}
