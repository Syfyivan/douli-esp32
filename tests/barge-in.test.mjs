import test from "node:test";
import assert from "node:assert/strict";
import { BargeInBuffer } from "../server/audio.mjs";

const quiet = Buffer.alloc(640);
const onset = Buffer.alloc(640);
const voice = Buffer.alloc(640);
for (let n = 0; n < 320; n++) {
  onset.writeInt16LE(100, n * 2);
  voice.writeInt16LE(3000, n * 2);
}

test("barge-in retains quiet onset and short syllable gaps, but discards isolated clicks", () => {
  const buffer = new BargeInBuffer();
  for (let n = 0; n < 10000; n++) assert.equal(buffer.push(quiet, 0.012), null);
  assert.ok(buffer.totalMs <= 200);
  assert.equal(buffer.push(voice, 0.012), null);
  for (let n = 0; n < 10; n++) assert.equal(buffer.push(quiet, 0.012), null);
  assert.equal(buffer.speechMs, 0);
  buffer.push(onset, 0.012);
  for (let n = 0; n < 3; n++) assert.equal(buffer.push(voice, 0.012), null);
  buffer.push(quiet, 0.012);
  for (let n = 0; n < 3; n++) assert.equal(buffer.push(voice, 0.012), null);
  const frames = buffer.push(voice, 0.012);
  assert.ok(frames.includes(onset));
  assert.equal(frames.filter(frame => frame === voice).length, 7);
  assert.ok(frames.reduce((n, frame) => n + frame.length / 32, 0) <= 500);
  assert.equal(buffer.frames.length, 0);
});
