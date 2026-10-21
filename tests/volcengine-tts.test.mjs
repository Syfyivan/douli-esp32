import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import WebSocket, { WebSocketServer } from "ws";
import { readTtsPacket, VolcengineTts, speechProfile } from "../server/volcengine-tts.mjs";

function number(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; }
function field(value) { const b = Buffer.from(value); return Buffer.concat([number(b.length), b]); }
function response(event, id, payload = {}, { compressed = false } = {}) {
  const audio = Buffer.isBuffer(payload);
  let data = audio ? payload : Buffer.from(JSON.stringify(payload));
  if (compressed) data = gzipSync(data);
  return Buffer.concat([Buffer.from([0x11, audio ? 0xb4 : 0x94, (audio ? 0 : 0x10) | +compressed, 0]),
    number(event), field(id), field(data)]);
}
function request(data) {
  const event = data.readUInt32BE(4);
  let at = 8, id;
  const read = () => { const n = data.readUInt32BE(at); at += 4; const value = data.subarray(at, at + n); at += n; return value; };
  if (event >= 100) id = read().toString();
  return { event, id, payload: JSON.parse(read().toString()) };
}
export async function ttsServer(t, onText) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const requests = [], sockets = [];
  server.on("connection", ws => {
    sockets.push(ws);
    ws.on("message", bytes => {
      const message = request(bytes);
      requests.push(message);
      if (message.event === 1) ws.send(response(50, "connection"));
      if (message.event === 100) ws.send(response(150, message.id));
      if (message.event === 200) {
        if (onText) onText(ws, message);
        else ws.send(response(352, message.id, Buffer.alloc(48000, 1)));
      }
      if (message.event === 102) ws.send(response(152, message.id));
      if (message.event === 2) ws.close();
    });
  });
  t.after(() => { for (const ws of server.clients) ws.terminate(); server.close(); });
  return { url: `ws://127.0.0.1:${server.address().port}`, requests, sockets, response };
}
const profile = { apiKey: "fixture", model: "seed-tts-2.0", voice: "fixture", pcmSampleRate: 24000 };

test("TTS parser handles event identities, compressed JSON and raw PCM, rejects malformed sizes", () => {
  assert.equal(readTtsPacket(response(50, "conn")).connectId, "conn");
  assert.deepEqual(readTtsPacket(response(150, "session", { okay: true }, { compressed: true })).payload, { okay: true });
  assert.deepEqual(readTtsPacket(response(352, "session", Buffer.from([0, 1, 2, 3]))).payload, Buffer.from([0, 1, 2, 3]));
  assert.throws(() => readTtsPacket(response(352, "session", Buffer.alloc(8)).subarray(0, -1)), /长度/);
  assert.throws(() => readTtsPacket(Buffer.from([0x11])), /协议/);
  assert.equal(speechProfile({ models: { tts: profile } }), profile);
});

test("bidirectional TTS returns PCM before text finishes and reuses connection across complete sessions", async t => {
  const server = await ttsServer(t);
  const client = new VolcengineTts(profile, { url: server.url });
  t.after(() => client.close());
  for (let i = 0; i < 2; i++) {
    const session = client.session(), iterator = session.audio[Symbol.asyncIterator]();
    session.write("第一段");
    const head = await iterator.next();
    assert.equal(head.value.length, 48000);
    assert.equal(server.requests.filter(r => r.event === 102).length, i);
    session.write("第二段");
    await session.finish();
    const tail = [];
    for await (const bytes of { [Symbol.asyncIterator]: () => iterator }) tail.push(bytes);
    assert.equal(Buffer.concat(tail).length, 48000);
    assert.equal(session.text, "第一段第二段");
  }
  assert.equal(server.sockets.length, 1);
  assert.equal(server.requests.filter(r => r.event === 100).length, 2);
  assert.deepEqual(server.requests.filter(r => r.event === 200).map(r => r.payload.req_params.text), ["第一段", "第二段", "第一段", "第二段"]);
});

test("abort closes its synthesis and a subsequent session cannot receive old audio or errors", async t => {
  let first;
  const received = Promise.withResolvers();
  const server = await ttsServer(t, (ws, message) => {
    if (!first) { first = message.id; received.resolve(); }
    else {
      ws.send(response(153, first, { status_code: 999 }));
      ws.send(response(352, first, Buffer.alloc(4, 7)));
      ws.send(response(352, message.id, Buffer.alloc(8, 2)));
    }
  });
  const client = new VolcengineTts(profile, { url: server.url });
  t.after(() => client.close());
  const controller = new AbortController(), firstSession = client.session(controller.signal);
  firstSession.write("取消这一轮");
  await received.promise;
  controller.abort(new Error("fixture cancellation"));
  await assert.rejects(firstSession.completion, /cancellation/);
  const next = client.session();
  next.write("新一轮"); void next.finish();
  const bytes = [];
  for await (const chunk of next.audio) bytes.push(chunk);
  await next.completion;
  assert.deepEqual(Buffer.concat(bytes), Buffer.alloc(8, 2));
});

test("TTS reports missing authorization and never exposes submitted text or credentials", async t => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, verifyClient: (_info, done) => done(false, 403, "resource denied") });
  await once(server, "listening"); t.after(() => server.close());
  const client = new VolcengineTts(profile, { url: `ws://127.0.0.1:${server.address().port}` });
  t.after(() => client.close());
  const session = client.session(); session.write("private fixture text");
  await assert.rejects(session.completion, error => error.message.includes("未授权") && !error.message.includes("fixture"));
});

test("an invalid socket configuration releases its session immediately and permits a corrected retry", async t => {
  const server = await ttsServer(t);
  const client = new VolcengineTts(profile, { url: server.url, Socket: class {
    constructor() { throw new Error("private fixture header"); }
  } });
  t.after(() => client.close());
  const failed = client.session();
  await assert.rejects(failed.completion, error => /配置无效/.test(error.message) && !/fixture/.test(error.message));
  assert.equal(client.current, null);
  client.Socket = WebSocket;
  const session = client.session(); session.write("重试"); void session.finish();
  let bytes = 0;
  for await (const chunk of session.audio) bytes += chunk.length;
  await session.completion;
  assert.equal(bytes, 48000);
});

test("malformed provider JSON and nonnumeric error codes cannot echo private request data", async t => {
  const packet = response(153, "session", Buffer.from('{"private fixture text"'));
  packet[1] = 0x94; packet[2] = 0x10;
  assert.throws(() => readTtsPacket(packet), error => /无效 JSON/.test(error.message) && !/private/.test(error.message));
  const server = await ttsServer(t, (ws, message) => {
    ws.send(response(153, message.id, { status_code: "private fixture header" }));
  });
  const client = new VolcengineTts(profile, { url: server.url });
  t.after(() => client.close());
  const session = client.session(); session.write("private fixture text");
  await assert.rejects(session.completion, error => /153/.test(error.message) && !/private/.test(error.message));
});
