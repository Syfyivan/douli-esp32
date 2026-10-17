import test from "node:test";
import assert from "node:assert/strict";
import { AudioPacer } from "../server/audio-pacer.mjs";

function fixture(leadMs) {
  let clock = 0;
  const signal = new AbortController().signal;
  const pacer = new AudioPacer({ leadMs, now: () => clock,
    sleep: async (ms, signal) => { signal.throwIfAborted(); clock += Math.ceil(ms / 16) * 16; } });
  const send = async count => {
    const times = [];
    for (let i = 0; i < count; i++) { await pacer.wait(signal); times.push(clock); pacer.sent(); }
    return times;
  };
  return { pacer, signal, send, now: () => clock, advance: ms => { clock += ms; } };
}

test("ESP32 bounded audio lead covers short ordered-network jitter without overflowing its decode queue", async () => {
  const ordinary = fixture(0), buffered = fixture(200);
  const oldTimes = await ordinary.send(112), newTimes = await buffered.send(112);
  const playbackGap = times => {
    let previousArrival = 0, playbackAt = 300, lost = 0;
    times.forEach((time, i) => {
      const arrival = previousArrival = Math.max(previousArrival, time + 300 + (i >= 60 ? 140 : 0));
      if (arrival > playbackAt) { lost += arrival - playbackAt; playbackAt = arrival; }
      playbackAt += 20;
    });
    return lost;
  };
  assert.ok(playbackGap(oldTimes) >= 140, "without a lead, a later network delay starves playback");
  assert.equal(playbackGap(newTimes), 0, "the same ordered packet delay must fit the reserve");
  assert.equal(newTimes[0], 0, "building the reserve must not delay the first frame");
  for (let i = 0; i < newTimes.length; i++)
    assert.ok((i + 1) * 20 - newTimes[i] <= 220, "queued audio must stay below the 400 ms decode capacity");
  assert.ok(newTimes.at(-1) < 2240 - 150);
  await buffered.pacer.drain(buffered.signal);
  assert.ok(buffered.now() >= 2240, "normal stop cannot precede the nominal audio tail");
});

test("audio pacing recovers timer lateness and rebases after long provider stalls", async () => {
  const f = fixture(0);
  await f.send(5);
  f.advance(45);
  const catchup = await f.send(40);
  assert.ok(catchup.at(-1) <= 45 * 20 + 16, "ordinary timer lateness must not permanently shift every later frame");
  const b = fixture(200);
  await b.send(40); b.advance(5000);
  const start = b.now(), times = await b.send(60);
  assert.equal(times[0], start);
  assert.ok(times.at(-1) - start >= 60 * 20 - 220,
    "a provider stall must not release seconds of scheduled audio in a burst");
});

test("explicit pause shifts the media clock and cancellation rejects waiting output", async () => {
  const f = fixture(200);
  await f.send(40);
  f.advance(1000); f.pacer.postpone(1000);
  const start = f.now(), times = await f.send(20);
  assert.ok(times.at(-1) - start >= 350, "resume preserves the existing lead instead of adding a second reserve");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.pacer.wait(controller.signal), { name: "AbortError" });
  await assert.rejects(f.pacer.drain(controller.signal), { name: "AbortError" });
});
