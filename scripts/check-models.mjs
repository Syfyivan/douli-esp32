// Explicit opt-in live API check. Uses the locally saved credentials and a short synthetic phrase.
import { resolve } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { Store } from "../server/store.mjs";
import { synthesize, transcribe } from "../server/providers.mjs";
import { resample, wav, rms } from "../server/audio.mjs";
const store = new Store(resolve(".data"));
try {
  const s = store.settings(),
    started = Date.now();
  const audio = await synthesize(
    s.models.tts,
    "你好，请用一句话介绍一下你自己。",
    AbortSignal.timeout(30000),
  );
  const pcm = resample(audio.pcm, audio.sampleRate);
  const synthesisMs = Date.now() - started;
  if (!pcm.length || rms(pcm) < 0.0001)
    throw new Error("语音合成没有返回有效音频");
  mkdirSync(".runtime", { recursive: true });
  writeFileSync(".runtime/voice-check.wav", wav(pcm));
  const asrStarted = Date.now();
  const text = await transcribe(
    s.models.asr,
    pcm,
    "助手名字：豆梨",
    AbortSignal.timeout(30000),
  );
  const result = {
    source: "synthetic speech, not a microphone recording",
    text,
    durationSeconds: pcm.length / 32000,
    synthesisMs,
    transcriptionMs: Date.now() - asrStarted,
    checkedAt: new Date().toISOString(),
  };
  writeFileSync(".runtime/model-check.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  store.close();
}
