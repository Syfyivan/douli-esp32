import test from "node:test";
import assert from "node:assert/strict";
import { GreetingAudio } from "../server/greeting-audio.mjs";

const settings = () => ({ assistant: { greeting: "我在，慢慢说。" }, models: {
  tts: { baseUrl: "http://fixture.invalid/v1", model: "fixture", voice: "one", pcmSampleRate: 16000 },
} });
const collect = async source => { const chunks = []; for await (const chunk of source.audio) chunks.push(chunk); return Buffer.concat(chunks); };

test("greeting warms once and is reusable across wakes without retaining ordinary replies", async t => {
  let calls = 0;
  const cache = new GreetingAudio(async function* () { calls++; yield Buffer.alloc(640, 1); yield Buffer.alloc(640, 2); });
  t.after(() => cache.close());
  const config = settings();
  await cache.warm(config);
  for (let i = 0; i < 3; i++) {
    const source = cache.source(config, new AbortController().signal);
    assert.equal(source.cacheHit, true);
    assert.equal((await collect(source)).length, 1280);
  }
  assert.equal(calls, 1);
  assert.equal(cache.snapshot().state, "ready");
});

test("wake during warming streams immediately, shares synthesis and can cancel independently", async t => {
  const first = Promise.withResolvers(), rest = Promise.withResolvers();
  let calls = 0;
  const cache = new GreetingAudio(async function* () {
    calls++;
    await first.promise; yield Buffer.alloc(640, 1);
    await rest.promise; yield Buffer.alloc(640, 2);
  });
  t.after(() => { first.resolve(); rest.resolve(); cache.close(); });
  const config = settings(), abort = new AbortController();
  const warming = cache.warm(config);
  const source = cache.source(config, abort.signal), audio = source.audio;
  assert.equal(source.cacheHit, false);
  const next = audio.next(); first.resolve();
  assert.equal((await next).value.length, 640);
  assert.equal(cache.snapshot().state, "warming", "first frame must not wait for clip completion");
  const waiting = audio.next(); abort.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  rest.resolve(); await warming;
  assert.equal((await collect(cache.source(config, new AbortController().signal))).length, 1280);
  assert.equal(calls, 1);
  assert.equal(cache.entry.waiters.size, 0);
});

test("changed greeting, provider, voice, sample rate and key each invalidate the clip", async t => {
  let calls = 0;
  const cache = new GreetingAudio(async function* () { calls++; yield Buffer.alloc(640, calls); });
  t.after(() => cache.close());
  const config = settings(); await cache.warm(config);
  const changes = [
    () => { config.assistant.greeting = "我在。"; },
    () => { config.models.tts.baseUrl = "http://new.invalid/v1"; },
    () => { config.models.tts.model = "another"; },
    () => { config.models.tts.voice = "two"; },
    () => { config.models.tts.pcmSampleRate = 24000; },
    () => { config.models.tts.apiKey = "test-only-secret"; },
  ];
  for (const change of changes) {
    change(); await cache.warm(config);
    const pcm = await collect(cache.source(config, new AbortController().signal));
    assert.equal(pcm[0], calls);
  }
  assert.equal(calls, 7);
  assert.ok(!JSON.stringify(cache.snapshot()).includes("test-only-secret"));
  config.assistant.volume = 0.5; await cache.warm(config);
  assert.equal(calls, 7, "playback gain must not regenerate provider audio");
});

test("failed prewarm is retried on wake and invalidation cancels an old request", async t => {
  let calls = 0, cancelled = false;
  const cache = new GreetingAudio(async function* (_p, _text, signal) {
    calls++;
    if (calls === 1) throw new Error("temporary failure");
    if (calls === 3) await new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => { cancelled = true; reject(signal.reason); }, { once: true });
    });
    yield Buffer.alloc(640);
  });
  t.after(() => cache.close());
  const config = settings();
  await cache.warm(config); await cache.warm(config);
  assert.equal(calls, 1, "background retries are rate limited");
  assert.equal((await collect(cache.source(config, new AbortController().signal))).length, 640);
  config.assistant.greeting = "another";
  const oldWarm = cache.warm(config);
  config.models.tts.voice = "changed";
  await cache.warm(config); await oldWarm;
  assert.equal(cancelled, true);
  assert.equal(cache.snapshot().state, "ready");
  cache.close();
  await cache.warm(config); assert.equal(calls, 4);
});
