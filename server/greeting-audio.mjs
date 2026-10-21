import { createHash } from "node:crypto";
import { streamSpeech, speechProfile } from "./providers.mjs";

// One fixed greeting, in memory only. Warm it while the board is connected and
// idle; a wake during warming can consume incoming chunks without a second TTS
// request or waiting for the complete clip. Ordinary replies are never cached.
export class GreetingAudio {
  constructor(synthesize = streamSpeech) {
    this.synthesize = synthesize;
    this.entry = null;
    this.closed = false;
  }
  prepare(settings, retry = false) {
    if (this.closed) return null;
    const text = settings.assistant.greeting, profile = { ...speechProfile(settings) };
    const key = createHash("sha256").update(JSON.stringify([
      text, profile.baseUrl, profile.model, profile.voice || "alloy",
      profile.pcmSampleRate || 24000, profile.apiKey || "",
    ])).digest("hex");
    if (this.entry?.key === key && (!this.entry.error || (!retry && Date.now() < this.entry.retryAt)))
      return this.entry;
    this.entry?.controller.abort();
    this.entry = null;
    if (!text || !profile.baseUrl || !profile.model) return null;
    const entry = this.entry = {
      key, controller: new AbortController(), chunks: [], waiters: new Set(),
      startedAt: Date.now(), bytes: 0, done: false, error: null,
    };
    const notify = () => { for (const wake of [...entry.waiters]) wake(); };
    entry.completion = (async () => {
      try {
        const signal = AbortSignal.any([entry.controller.signal, AbortSignal.timeout(15000)]);
        for await (const chunk of this.synthesize(profile, text, signal)) {
          signal.throwIfAborted();
          entry.bytes += chunk.length;
          if (entry.bytes > 4 * 1024 * 1024) throw new Error("欢迎语音频过长，请缩短欢迎语");
          entry.firstByteMs ??= Date.now() - entry.startedAt;
          entry.chunks.push(Buffer.from(chunk));
          notify();
        }
        if (!entry.bytes || entry.bytes % 2) throw new Error("欢迎语合成未返回完整 PCM 音频");
      } catch (error) {
        entry.error = error;
        entry.chunks = [];
        entry.retryAt = Date.now() + 60000;
      } finally {
        entry.done = true;
        entry.synthesisMs = Date.now() - entry.startedAt;
        notify();
      }
    })();
    return entry;
  }
  warm(settings) { return this.prepare(settings)?.completion ?? Promise.resolve(); }
  source(settings, signal) {
    const entry = this.prepare(settings, true);
    const cacheHit = !!entry?.done && !entry.error;
    const audio = (async function* () {
      if (!entry) {
        yield* streamSpeech(speechProfile(settings), settings.assistant.greeting, signal);
        return;
      }
      let index = 0;
      while (true) {
        signal.throwIfAborted();
        if (entry.error) throw entry.error;
        if (index < entry.chunks.length) { yield entry.chunks[index++]; continue; }
        if (entry.done) return;
        await new Promise((resolve, reject) => {
          const clean = () => { entry.waiters.delete(wake); signal.removeEventListener("abort", abort); };
          const wake = () => { clean(); resolve(); };
          const abort = () => { clean(); reject(signal.reason); };
          entry.waiters.add(wake);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
      }
    })();
    return { audio, cacheHit };
  }
  snapshot() {
    const e = this.entry;
    return e ? {
      state: e.error ? "failed" : e.done ? "ready" : "warming",
      firstByteMs: e.firstByteMs ?? null, synthesisMs: e.synthesisMs ?? null,
      bytes: e.bytes,
    } : { state: "empty" };
  }
  close() { this.closed = true; this.entry?.controller.abort(); this.entry = null; }
}
