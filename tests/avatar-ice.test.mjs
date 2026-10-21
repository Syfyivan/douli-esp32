import test from "node:test";
import assert from "node:assert/strict";
import { waitForAvatarIce } from "../web/avatar-ice.mjs";

const candidate = type => `a=candidate:1 1 udp 1234 192.0.2.1 5000 typ ${type}\r\n`;
const sdp = (audio = "host", video = "host") => `v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\n${candidate(audio)}m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:1\r\n${candidate(video)}`;
function setup(t, description = sdp()) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pc = { iceGatheringState: "gathering", localDescription: { sdp: description } };
  const control = new AbortController();
  const result = { done: false };
  result.promise = waitForAvatarIce(pc, control.signal).then(reason => { result.done = true; return reason; });
  return { pc, control, result, tick: async ms => { t.mock.timers.tick(ms); await Promise.resolve(); } };
}

test("avatar ICE uses stable gathered relay fallbacks for every offered media section", async t => {
  const { pc, result, tick } = setup(t);
  pc.localDescription.sdp = sdp("relay", "relay"); pc.onicecandidate();
  await tick(249); assert.equal(result.done, false);
  await tick(1); assert.equal(await result.promise, "settled");
  assert.equal(pc.onicecandidate, null); assert.equal(pc.onicegatheringstatechange, null);
});

test("avatar ICE does not send an empty, host-only, or partial-relay offer early", async t => {
  const { pc, result, tick } = setup(t, "v=0\r\n");
  await tick(1000); assert.equal(result.done, false);
  pc.localDescription.sdp = sdp("host", "host"); pc.onicecandidate();
  await tick(1000); assert.equal(result.done, false);
  pc.localDescription.sdp = sdp("relay", "srflx"); pc.onicecandidate();
  await tick(5999); assert.equal(result.done, false);
  await tick(1); assert.equal(await result.promise, "timeout");
});

test("late candidates extend the quiet window, while full gathering finishes immediately", async t => {
  const { pc, result, tick } = setup(t, sdp("relay", "relay"));
  await tick(200); pc.onicecandidate();
  await tick(200); assert.equal(result.done, false);
  pc.iceGatheringState = "complete"; pc.onicegatheringstatechange();
  assert.equal(await result.promise, "complete");
  await tick(8000); assert.equal(pc.onicecandidate, null);
});

test("cancelling candidate gathering removes handlers and never advances to signalling", async t => {
  const { pc, control, result, tick } = setup(t, sdp("relay", "relay"));
  const rejected = assert.rejects(result.promise, /cancelled by caller/);
  control.abort(new Error("cancelled by caller")); await rejected;
  await tick(10000);
  assert.equal(result.done, false);
  assert.equal(pc.onicecandidate, null); assert.equal(pc.onicegatheringstatechange, null);
});

test("already completed or already aborted ICE is handled before waiting", async () => {
  const pc = { iceGatheringState: "complete" };
  assert.equal(await waitForAvatarIce(pc), "complete");
  await assert.rejects(waitForAvatarIce(pc, AbortSignal.abort(new Error("already cancelled"))), /already cancelled/);
});
