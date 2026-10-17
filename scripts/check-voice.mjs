import { readFileSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { WebSocket } from "ws";
import { setTimeout as delay } from "node:timers/promises";
import { wav, rms } from "../server/audio.mjs";
const recording = readFileSync(".runtime/voice-check.wav").subarray(44);
const ws = new WebSocket("ws://127.0.0.1:8788/api/voice?route=daily", {
  headers: { Origin: "http://127.0.0.1:8788" },
});
const output = [],
  events = [];
let id,
  finished = false,
  failed;
ws.on("message", (raw, binary) => {
  if (binary) output.push(Buffer.from(raw));
  else {
    const e = JSON.parse(raw);
    events.push(e);
    if (e.type === "hello") id = e.session_id;
    if (e.type === "error") failed = e.message;
    if (
      e.type === "tts" &&
      e.state === "stop" &&
      !e.interrupted &&
      output.length
    )
      finished = true;
  }
});
try {
  await once(ws, "open");
  ws.send(
    JSON.stringify({
      type: "hello",
      version: 1,
      features: { aec: true },
      audio_params: { format: "pcm", sample_rate: 16000, channels: 1 },
    }),
  );
  while (!id) await delay(20);
  ws.send(JSON.stringify({ type: "listen", state: "start", mode: "manual" }));
  for (let at = 0; at < recording.length; at += 640)
    ws.send(recording.subarray(at, at + 640));
  ws.send(JSON.stringify({ type: "listen", state: "stop" }));
  const start = Date.now();
  while (!finished && !failed && Date.now() - start < 60000) await delay(100);
  if (failed || !finished)
    throw new Error(failed || "Voice roundtrip timed out");
  const pcm = Buffer.concat(output);
  if (rms(pcm) < 0.0001) throw new Error("Response audio was silent");
  writeFileSync(".runtime/voice-response.wav", wav(pcm));
  const report = {
    input: "synthetic speech over browser voice WebSocket",
    transcript: events.find((e) => e.type === "stt")?.text,
    answer: events.find((e) => e.type === "done")?.message.text,
    timings: events.filter((e) => e.type === "metric"),
    audioSeconds: pcm.length / 32000,
    checkedAt: new Date().toISOString(),
  };
  writeFileSync(
    ".runtime/voice-roundtrip.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  ws.close();
  await once(ws, "close");
  if (id)
    await fetch("http://127.0.0.1:8788/api/sessions/" + id, {
      method: "DELETE",
    });
}
