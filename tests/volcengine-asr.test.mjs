import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { gzipSync, gunzipSync } from "node:zlib";
import { WebSocketServer } from "ws";
import { VolcengineTranscriber, readAsrPacket } from "../server/volcengine-asr.mjs";
import { LiveTranscriber } from "../server/providers.mjs";
import { defaults } from "../server/config.mjs";

function result(text, final, utterances) {
  const body = gzipSync(Buffer.from(JSON.stringify({ result: { text, ...(utterances ? { utterances } : {}) } })));
  const header = Buffer.alloc(12);
  header.set([0x11, final ? 0x93 : 0x91, 0x11, 0]);
  header.writeInt32BE(final ? -2 : 1, 4); header.writeUInt32BE(body.length, 8);
  return Buffer.concat([header, body]);
}
test("native SAUC streams 200ms packets and exposes partial recognition before finishing", async t => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  t.after(() => { for (const ws of server.clients) ws.terminate(); server.close(); });
  const packets = [], requests = [];
  server.on("connection", (ws, request) => {
    requests.push(request);
    ws.on("message", bytes => {
      packets.push(bytes);
      if (bytes[1] >> 4 === 2) ws.send(result(bytes[1] & 2 ? "请记住，我喜欢短回答" : "请记住", !!(bytes[1] & 2)));
    });
  });
  const settings = structuredClone(defaults);
  settings.input.asrProvider = "volcengine";
  settings.models.streamingAsr = { baseUrl: `http://127.0.0.1:${server.address().port}/api/v3/sauc/bigmodel`, apiKey: "test-only", model: "volc.seedasr.sauc.duration" };
  let partialResolve;
  const partial = new Promise(resolve => { partialResolve = resolve; });
  const live = new LiveTranscriber(settings, JSON.stringify({ recent: [{ text: "前一句" }], vocabulary: ["豆梨"] }), partialResolve);
  assert.ok(live instanceof VolcengineTranscriber);
  t.after(() => live.close());
  await once(live.socket, "open");
  for (let i = 0; i < 10; i++) live.push(Buffer.alloc(640, i));
  assert.equal(await partial, "请记住");
  assert.equal(live.finishing, undefined);
  assert.equal(await live.finish(), "请记住，我喜欢短回答");
  assert.equal(requests[0].headers["x-api-resource-id"], "volc.seedasr.sauc.duration");
  assert.equal(requests[0].headers["x-api-key"], "test-only");
  const initial = JSON.parse(gunzipSync(packets[0].subarray(8)));
  assert.equal(initial.audio.format, "pcm");
  assert.equal(initial.request.enable_ddc, false, "do not remove spoken hesitations");
  assert.equal(JSON.parse(initial.request.corpus.context).hotwords[0].word, "豆梨");
  assert.equal(gunzipSync(packets[1].subarray(8)).length, 6400);
  assert.equal(packets.at(-1)[1], 0x22);
});

test("SAUC parser handles signed final sequence, errors and malformed lengths", () => {
  assert.deepEqual(readAsrPacket(result("你好", true)), { value: { result: { text: "你好" } }, final: true });
  const error = Buffer.from([0x11, 0xf0, 0x10, 0, 0, 0, 0, 23]);
  assert.throws(() => readAsrPacket(error), /23/);
  const truncated = result("你好", false).subarray(0, 15);
  assert.throws(() => readAsrPacket(truncated), /长度/);
  assert.throws(() => readAsrPacket(Buffer.alloc(4)), /协议/);
});

test("native recognition cancellation closes the socket while waiting for a final result", async t => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  t.after(() => { for (const ws of server.clients) ws.terminate(); server.close(); });
  const settings = structuredClone(defaults);
  settings.models.streamingAsr = { baseUrl: `http://127.0.0.1:${server.address().port}`, model: "fixture", apiKey: "test" };
  const live = new VolcengineTranscriber(settings, "");
  await once(live.socket, "open");
  const control = new AbortController(), waiting = live.finish(control.signal);
  control.abort(new Error("cancelled-by-user"));
  await assert.rejects(waiting, /cancelled-by-user/);
  assert.equal(live.closed, true);
});

test("voiceprint request uses the group and only attributes identity from the final packet", async t => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  t.after(() => { for (const ws of server.clients) ws.terminate(); server.close(); });
  let request;
  server.on("connection", ws => ws.on("message", bytes => {
    if (bytes[1] >> 4 === 1) request = JSON.parse(gunzipSync(bytes.subarray(8))).request;
    else ws.send(result("你好豆梨", !!(bytes[1] & 2), [{ text: "你好豆梨", definite: true,
      additions: { source: "two_pass", speaker_id: "0" }, attributes: { voiceprint_matches: [
        { id: "id-a", name: "registered-a", similarity: bytes[1] & 2 ? 0.12 : 0.9 },
        { id: "id-b", name: "registered-b", similarity: bytes[1] & 2 ? 0.84 : 0.1 },
      ] } }]));
  }));
  const settings = structuredClone(defaults);
  settings.input.asrTwoPass = false;
  settings.people = { voiceIdentification: true, groupId: "fixture-group", members: [
    { personId: "a", voiceName: "registered-a", voiceId: "id-a" }, { personId: "b", voiceName: "registered-b", voiceId: "id-b" },
  ] };
  settings.models.streamingAsr = { baseUrl: `http://127.0.0.1:${server.address().port}`, model: "fixture", apiKey: "test" };
  let partialReady;
  const partial = new Promise(resolve => { partialReady = resolve; });
  const live = new VolcengineTranscriber(settings, "", partialReady); t.after(() => live.close());
  await once(live.socket, "open"); live.push(Buffer.alloc(64000)); await partial;
  assert.equal(live.speaker.status, "unknown");
  assert.equal(await live.finish(), "你好豆梨"); assert.equal(live.speaker.personId, "b");
  assert.deepEqual(live.speaker.diagnostic.labels, ["anonymous:0"]);
  assert.deepEqual(live.speaker.diagnostic.candidates, [[{ personId: "a", similarity: 0.12 }, { personId: "b", similarity: 0.84 }]]);
  assert.equal(request.enable_nonstream, true); assert.equal(request.enable_speaker_info, true);
  assert.equal(request.ssd_version, "200", "registered matching requires the large-model SSD version");
  assert.equal(request.ssd_mode, 2); assert.deepEqual(request.voiceprints, [{ id: "", group_id: "fixture-group" }]);
});
