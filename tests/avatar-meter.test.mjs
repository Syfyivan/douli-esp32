import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { SimliTransport } from "../web/simli.mjs";

test("decoded audio meter preserves samples and detects sustained onset once per armed turn", () => {
  let Processor;
  const reports = [], scope = {
    currentTime: 1,
    AudioWorkletProcessor: class { port = { postMessage: data => reports.push(data) }; },
    registerProcessor: (_name, implementation) => { Processor = implementation; },
  };
  runInNewContext(readFileSync(new URL("../web/avatar-meter.js", import.meta.url), "utf8"), scope);
  const meter = new Processor(), input = new Float32Array(128), output = new Float32Array(128);
  const step = value => { input.fill(value); meter.process([[input]], [[output]]); assert.deepEqual(output, input); scope.currentTime += 128 / 48000; };
  meter.port.onmessage({ data: { type: "arm", id: 1 } });
  step(0); step(0.001); step(0.02); step(0); step(0.02);
  assert.equal(reports.length, 0, "isolated noise must not count as sustained voice");
  const onset = scope.currentTime - 128 / 48000;
  step(0.02); step(0.02);
  assert.equal(reports.length, 1); assert.equal(reports[0].id, 1);
  assert.equal(reports[0].renderTime, onset);
  meter.port.onmessage({ data: { type: "arm", id: 2 } }); step(0.02);
  meter.port.onmessage({ data: { type: "clear" } }); step(0.02);
  assert.equal(reports.length, 1);
  meter.process([[]], [[output]]); assert.ok(output.every(n => n === 0));
});

test("Simli onset telemetry discards stale, duplicate and interrupted measurements", () => {
  const reports = [], transport = new SimliTransport({ video: {}, audio: {}, onMetric: value => reports.push(value) });
  transport.allowed = true; transport.measuredTurn = { id: 3, audioTime: 10 };
  for (const data of [{ id: 2, renderTime: 11 }, { id: 3, renderTime: 9 }, { id: 3, renderTime: NaN }]) transport.measureAudio(data);
  assert.equal(reports.length, 0);
  transport.measureAudio({ id: 3, renderTime: 11.234 });
  transport.measureAudio({ id: 3, renderTime: 12 });
  assert.deepEqual(reports, [{ turn_id: 3, name: "avatarAudioMs", value: 1234 }]);
  transport.measuredTurn = { id: 4, audioTime: 12 }; transport.allowed = false;
  transport.measureAudio({ id: 4, renderTime: 13 }); assert.equal(reports.length, 1);
});
