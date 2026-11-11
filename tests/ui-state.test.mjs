import test from "node:test";
import assert from "node:assert/strict";
import { normalizeUiPreferences, readUiPreferences, conversationSource, inDateRange, speakerResultLabel } from "../web/ui-state.mjs";

test("display preferences hide devices by default and recover safely from invalid storage", () => {
  assert.deepEqual(normalizeUiPreferences(null), { showDevices: false, defaultPage: "chat" });
  assert.deepEqual(normalizeUiPreferences({ showDevices: "false", defaultPage: "devices" }), { showDevices: false, defaultPage: "chat" });
  assert.deepEqual(normalizeUiPreferences({ showDevices: true, defaultPage: "memory" }), { showDevices: true, defaultPage: "memory" });
  for (const storage of [{ getItem: () => "broken" }, { getItem() { throw Error("blocked"); } }]) {
    assert.equal(readUiPreferences(storage).defaultPage, "chat");
  }
});
test("history sources distinguish device voice, computer voice, and computer text", () => {
  assert.equal(conversationSource("browser").kind, "text");
  assert.equal(conversationSource("browser-voice").kind, "voice");
  assert.deepEqual(conversationSource("bedside", [{ id: "bedside", name: "床头音箱" }]), { kind: "speaker", label: "床头音箱" });
  assert.equal(conversationSource("old-device").kind, "speaker");
  assert.equal(conversationSource(null).kind, "unknown");
});
test("history dates use local calendar boundaries rather than a rolling 24-hour day", () => {
  const now = new Date(2026, 9, 16, 15);
  assert.ok(inDateRange(new Date(2026, 9, 16, 0), "today", now));
  assert.equal(inDateRange(new Date(2026, 9, 15, 23, 59), "today", now), false);
  assert.ok(inDateRange(new Date(2026, 9, 10), "week", now));
  assert.equal(inDateRange(new Date(2026, 9, 9, 23, 59), "week", now), false);
  assert.ok(inDateRange(new Date(2026, 8, 17), "month", now));
});

test("speaker labels distinguish a match, an unattributed turn and guest mode", () => {
  assert.equal(speakerResultLabel(null), "");
  assert.equal(speakerResultLabel({status:"matched", name:"小林"}), "匹配到小林");
  assert.equal(speakerResultLabel({status:"unknown", reason:"ambiguous_voiceprint", responseMode:"guest"}), "访客模式（两个候选人的分数接近）");
  assert.equal(speakerResultLabel({status:"unknown", reason:"missing_speaker_id"}), "未确认成员");
});
