import test from "node:test";
import assert from "node:assert/strict";
import { validateFrame, describeFrame } from "../server/vision.mjs";
import { VisualInput } from "../web/visual-input.mjs";

test("frame validation rejects URL fetching, oversized and stale data", () => {
  const now = Date.now(), tinyJpegHeader = "data:image/jpeg;base64,/9j/2Q==";
  assert.equal(validateFrame({ dataUrl: tinyJpegHeader, capturedAt: now, source: "screen" }, now).source, "screen");
  assert.throws(() => validateFrame({ dataUrl: "https://example.com/image.jpg", capturedAt: now }, now), /JPEG/);
  assert.throws(() => validateFrame({ dataUrl: tinyJpegHeader, capturedAt: now - 20000 }, now), /过期/);
  assert.throws(() => validateFrame({ dataUrl: "data:image/jpeg;base64," + "a".repeat(700000), capturedAt: now }, now), /500/);
  assert.throws(() => validateFrame({ dataUrl: "data:image/jpeg;base64,AAAAAA==", capturedAt: now }, now), /无效/);
});

test("a stopped or replaced sharing request releases a late camera stream", async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let grant, stopped = 0;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: () => new Promise(resolve => { grant = resolve; }) } } });
  t.after(() => original ? Object.defineProperty(globalThis, "navigator", original) : delete globalThis.navigator);
  const sent = [], capture = new VisualInput({ send: value => sent.push(value) });
  const starting = capture.start("camera", {});
  capture.stop();
  grant({ getTracks: () => [{ stop: () => { stopped++; } }] });
  assert.equal(await starting, false);
  assert.equal(stopped, 1);
  assert.ok(!sent.some(e => e.action === "start"));
});

test("visual observations require an explicitly configured vision model", async () => {
  await assert.rejects(describeFrame({}, "画面是什么", {}, undefined), /画面理解/);
});
