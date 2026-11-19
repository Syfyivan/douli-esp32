import test from "node:test";
import assert from "node:assert/strict";
import { VoiceSample } from "../server/voice-sample.mjs";

test("enrollment waits for wake and speech, bounds memory, and wipes temporary frames", async () => {
  const progress = [], sample = new VoiceSample({ onProgress: p => progress.push(p), durationMs: 5000 });
  const pcm = Buffer.alloc(640, 1);
  sample.push(pcm, true); assert.equal(sample.bytes, 0);
  sample.begin(); sample.push(pcm, false); assert.equal(sample.bytes, 0);
  sample.push(pcm, true); const retained = sample.frames[0];
  for (let i = 1; i < 251; i++) sample.push(pcm, true);
  const result = await sample.promise;
  assert.equal(result.length, 160000); assert.equal(progress.at(-1).seconds, 5);
  assert.equal(sample.frames.length, 0); assert.ok(retained.every(byte => byte === 0));
  assert.ok(result.equals(Buffer.alloc(160000, 1))); assert.equal(pcm[0], 1);
});
test("short, silent, clipped, cancelled and timed-out enrollment never yields a sample", async () => {
  for (const reason of ["short", "silent", "clipped", "cancel", "timeout"]) {
    const sample = new VoiceSample({ durationMs: 5000, timeoutMs: 10000, recordingTimeoutMs: reason === "timeout" ? 10 : 10000 });
    const rejected = assert.rejects(sample.promise);
    sample.begin();
    if (reason === "cancel") sample.cancel();
    else if (reason === "timeout") await new Promise(resolve => setTimeout(resolve, 20));
    else if (reason === "short") { sample.push(Buffer.alloc(640, 1), true); sample.finish(); }
    else {
      const pcm = Buffer.alloc(640, 1);
      if (reason === "clipped") for (let n = 0; n < pcm.length; n += 2) pcm.writeInt16LE(32767, n);
      for (let n = 0; n < 250; n++) sample.push(pcm, reason === "clipped" || n === 0);
    }
    await rejected; assert.equal(sample.frames.length, 0); assert.equal(sample.done, true);
  }
});

test("wake-up starts a separate recording deadline while an unwoken sample expires", async () => {
  const waiting = new VoiceSample({ timeoutMs: 10 });
  const expired = assert.rejects(waiting.promise, /等待录音超时/);
  const sample = new VoiceSample({ timeoutMs: 10, recordingTimeoutMs: 1000 });
  const cancelled = assert.rejects(sample.promise, /已取消/);
  sample.begin();
  await new Promise(resolve => setTimeout(resolve, 25));
  await expired; assert.equal(sample.done, false);
  sample.cancel(); await cancelled;
});
