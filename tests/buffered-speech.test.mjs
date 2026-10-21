import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { bufferSpeech } from "../server/buffered-speech.mjs";
import { streamSpeech } from "../server/providers.mjs";

test("a short incomplete head waits, but a complete short response can play below the reserve", async () => {
  const tail = Promise.withResolvers();
  const prepared = bufferSpeech((async function* () {
    yield Buffer.alloc(3200, 1);
    await tail.promise;
    yield Buffer.alloc(3200, 2);
  })(), { sampleRate: 16000 });
  let ready = false;
  prepared.ready.then(() => { ready = true; });
  await setImmediate();
  assert.equal(ready, false);
  tail.resolve(); await prepared.ready;
  const chunks = []; for await (const chunk of prepared.audio) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), Buffer.concat([Buffer.alloc(3200, 1), Buffer.alloc(3200, 2)]));
});

test("cancellation releases startup and read waits without sending late audio", async () => {
  const abort = new AbortController(), tail = Promise.withResolvers();
  const prepared = bufferSpeech((async function* () {
    yield Buffer.alloc(3200);
    await tail.promise;
    yield Buffer.alloc(3200);
  })(), { sampleRate: 16000, signal: abort.signal });
  await setImmediate(); abort.abort();
  await assert.rejects(prepared.ready, { name: "AbortError" });
  tail.resolve();
  await assert.rejects(prepared.completion, { name: "AbortError" });
  assert.equal(prepared.audio.destroyed, true);
});

test("a fast source starts at the reserve while its remaining audio is still pending", async () => {
  const tail = Promise.withResolvers();
  let clock = 0;
  const prepared = bufferSpeech((async function* () {
    yield Buffer.alloc(3200);
    clock = 400;
    yield Buffer.alloc(22400);
    await tail.promise;
    yield Buffer.alloc(6400);
  })(), { sampleRate: 16000, now: () => clock });
  let complete = false;
  prepared.completion.then(() => { complete = true; });
  await prepared.ready;
  assert.equal(complete, false);
  tail.resolve();
  let bytes = 0;
  for await (const chunk of prepared.audio) bytes += chunk.length;
  assert.equal(bytes, 32000);
});

test("a source slower than playback waits for completion even after a later burst", async () => {
  const tail = Promise.withResolvers();
  let clock = 0;
  const prepared = bufferSpeech((async function* () {
    yield Buffer.alloc(3200);
    clock = 1500;
    yield Buffer.alloc(22400);
    clock = 1600;
    yield Buffer.alloc(64000);
    await tail.promise;
    yield Buffer.alloc(6400);
  })(), { sampleRate: 16000, now: () => clock });
  let ready = false;
  prepared.ready.then(() => { ready = true; });
  await setImmediate();
  assert.equal(ready, false, "a slow download must not start with a reserve it will exhaust");
  tail.resolve(); await prepared.ready;
  let bytes = 0;
  for await (const chunk of prepared.audio) bytes += chunk.length;
  assert.equal(bytes, 96000);
});

test("continuous synthesis starts with a reserve even when input text arrives slowly", async () => {
  const tail = Promise.withResolvers();
  let clock = 0;
  const prepared = bufferSpeech((async function* () {
    yield Buffer.alloc(3200);
    clock = 2000;
    yield Buffer.alloc(22400);
    await tail.promise;
    yield Buffer.alloc(6400);
  })(), { sampleRate: 16000, now: () => clock, continuous: true });
  await prepared.ready;
  tail.resolve();
  let bytes = 0; for await (const chunk of prepared.audio) bytes += chunk.length;
  await prepared.completion;
  assert.equal(bytes, 32000);
});

test("continuous synthesis still bounds its pending audio", async () => {
  const prepared = bufferSpeech((async function* () { yield Buffer.alloc(128); })(),
    { sampleRate: 16000, maxBytes: 64, continuous: true });
  await assert.rejects(prepared.ready, /积压/);
  await assert.rejects(prepared.completion, /积压/);
});

test("buffered synthesis rejects oversized and incomplete PCM instead of retaining unbounded audio", async () => {
  for (const [bytes, pattern] of [[128, /过长/], [3, /完整 PCM/], [0, /完整 PCM/]]) {
    const prepared = bufferSpeech((async function* () { yield Buffer.alloc(bytes); })(), { sampleRate: 16000, maxBytes: 64 });
    await assert.rejects(prepared.ready, pattern);
    await assert.rejects(prepared.completion, pattern);
  }
});

test("SiliconFlow explicitly requests streaming PCM without adding vendor fields to other providers", async t => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(Buffer.alloc(640));
  });
  for (const baseUrl of ["https://api.siliconflow.cn/v1", "https://api.siliconflow.com/v1", "https://other.fixture/v1"]) {
    for await (const chunk of streamSpeech({ baseUrl, model: "fixture", pcmSampleRate: 16000 }, "测试", new AbortController().signal))
      assert.equal(chunk.length, 640);
  }
  for (const request of requests.slice(0, 2)) {
    assert.equal(request.stream, true);
    assert.equal(request.sample_rate, 16000);
    assert.equal(request.response_format, "pcm");
  }
  assert.equal(requests[2].stream, undefined);
  assert.equal(requests[2].sample_rate, undefined);
});
