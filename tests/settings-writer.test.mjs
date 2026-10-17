import test from "node:test";
import assert from "node:assert/strict";
import { SettingsWriter } from "../web/settings-writer.mjs";

test("night edits stay pending across page changes and rapid toggles save in order", async () => {
  const writes = [], results = [], snapshots = [], first = Promise.withResolvers();
  const writer = new SettingsWriter({ write: async patch => {
    writes.push(patch);
    if (writes.length === 1) await first.promise;
    return patch;
  }, saved: value => results.push(value), changed: value => snapshots.push(value), failed: assert.fail });
  const finished = writer.update({ enabled: false });
  writer.update({ enabled: true });
  writer.update({ enabled: false, volume: 0.25 });
  assert.deepEqual(writes, [{ enabled: false }], "only one write may be in flight");
  // A newly mounted page reads the same App-owned writer snapshot.
  assert.deepEqual(writer.snapshot().patch, { enabled: false, volume: 0.25 });
  first.resolve(); await finished;
  assert.deepEqual(writes, [{ enabled: false }, { enabled: false, volume: 0.25 }]);
  assert.deepEqual(results.at(-1), { enabled: false, volume: 0.25 });
  assert.deepEqual(snapshots.at(-1), { patch: {}, status: "saved", error: "" });
});

test("failed night edits stop overriding saved settings and a later edit can retry", async () => {
  const failures = [], saved = [];
  let fail = true;
  const writer = new SettingsWriter({ write: async patch => { if (fail) throw new Error("offline"); return patch; },
    saved: value => saved.push(value), changed() {}, failed: error => failures.push(error.message) });
  await writer.update({ enabled: false });
  assert.deepEqual(writer.snapshot(), { patch: {}, status: "error", error: "offline" });
  assert.deepEqual(failures, ["offline"]); assert.equal(saved.length, 0);
  fail = false;
  await writer.update({ enabled: false });
  assert.deepEqual(saved, [{ enabled: false }]);
  assert.equal(writer.snapshot().status, "saved");
});

test("a failed older write cannot discard a newer value queued during the request", async () => {
  const first = Promise.withResolvers(), writes = [], saved = [];
  const writer = new SettingsWriter({ write: async patch => {
    writes.push(patch);
    if (writes.length === 1) await first.promise;
    return patch;
  }, saved: value => saved.push(value), changed() {}, failed() {} });
  const completed = writer.update({ start: "23:00" });
  writer.update({ start: "23:30", end: "08:00" });
  first.reject(new Error("request failed")); await completed;
  assert.deepEqual(saved, [{ start: "23:30", end: "08:00" }]);
  assert.equal(writer.snapshot().status, "saved");
});
