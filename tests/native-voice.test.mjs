import test from "node:test";
import assert from "node:assert/strict";
import { NativeVoice } from "../web/native-voice.mjs";

test("Android permission handoff keeps a pending client until the service starts or fails", async t => {
  const old = globalThis.window, listeners = new Set(), commands = [], statuses = [];
  globalThis.window = { addEventListener: (name, fn) => listeners.add(fn), removeEventListener: (name, fn) => listeners.delete(fn),
    douliNativeVoice: { send: value => { commands.push(value); return { pending: true }; } } };
  t.after(() => { globalThis.window = old; });
  const voice = new NativeVoice({ onStatus: value => statuses.push(value) });
  await voice.start("test", "auto");
  voice.receive({ type: "native_snapshot", active: false });
  assert.equal(voice.closed, undefined); assert.equal(listeners.size, 1); assert.deepEqual(statuses, []);
  voice.receive({ type: "native_snapshot", active: true, status: "listening", session_id: "test" });
  assert.equal(statuses.at(-1), "listening");
  voice.receive({ type: "native_snapshot", active: false });
  assert.equal(voice.closed, true); assert.equal(listeners.size, 0); assert.equal(statuses.at(-1), "off");
  const denied = new NativeVoice({ onStatus: value => statuses.push(value) });
  await denied.start("test", "auto");
  denied.receive({ type: "error", nativeStartFailed: true, message: "permission denied" });
  assert.equal(denied.closed, true); assert.equal(listeners.size, 0);
  assert.equal(commands.length, 2);
});
