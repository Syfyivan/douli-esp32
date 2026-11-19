// Real TTS -> paced PCM -> real Doubao ASR. Local endpoint detectors run in
// shadow: they never stop the stream used to observe server-side segmentation.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { resample, rms, UtteranceBuffer } from "../server/audio.mjs";
import { normalizeSettings } from "../server/config.mjs";
import { synthesize, speechProfile } from "../server/providers.mjs";
import { SpeechDetector } from "../server/speech-detector.mjs";
import { TurnDetector } from "../server/turn-detector.mjs";
import { asrCorpus, asrPacket, readAsrPacket } from "../server/volcengine-asr.mjs";

const root = resolve(import.meta.dirname, ".."), runtime = join(root, ".runtime");
const pointer = join(runtime, "asr-endpoint-check.json");
const frameBytes = 640, batchBytes = 6400;
const rounded = n => Math.round(n * 10) / 10;
const cases = [
  { id: "weather", prefix: "明天天气怎么样？" },
  { id: "volume", prefix: "把音量调小一点。" },
  { id: "keyword-question", prefix: "请解释一下什么叫如果。" },
  { id: "condition-600", prefix: "如果明天下雨", pauseMs: 600, rest: "我们就改到室内。" },
  { id: "condition-1200", prefix: "如果明天下雨", pauseMs: 1200, rest: "我们就改到室内。" },
  { id: "hesitation-1200", prefix: "让我想想", pauseMs: 1200, rest: "明天上午九点比较合适。" },
  { id: "correction-900", prefix: "把音量调到八十", pauseMs: 900, rest: "不对，调到六十。" },
  { id: "missing-object-900", prefix: "帮我把明天的会议改到", pauseMs: 900, rest: "下午三点。" },
];
const variants = [
  { id: "server-default", label: "豆包默认 VAD（文档默认 800ms）", effectiveWindowMs: 800 },
  { id: "server-500", label: "豆包 VAD 500ms", endWindowMs: 500, effectiveWindowMs: 500 },
];

function readSettings() {
  const directory = resolve(process.env.DOULI_ENDPOINT_CONFIG_DIR || join(root, ".data"));
  const db = new DatabaseSync(join(directory, "douli.sqlite"), { readOnly: true });
  let sealed;
  try { sealed = db.prepare("SELECT value FROM settings WHERE id='config'").get()?.value; }
  finally { db.close(); }
  if (!sealed) throw new Error("No configured model");
  const [nonce, tag, bytes] = sealed.split(".").map(x => Buffer.from(x, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", readFileSync(join(directory, "local.key")), nonce);
  decipher.setAuthTag(tag);
  return normalizeSettings(JSON.parse(Buffer.concat([decipher.update(bytes), decipher.final()]).toString()));
}

function trimClip(pcm) {
  const padded = Buffer.alloc(Math.ceil(pcm.length / frameBytes) * frameBytes);
  pcm.copy(padded);
  const levels = [];
  for (let at = 0; at < padded.length; at += frameBytes) levels.push(rms(padded.subarray(at, at + frameBytes)));
  const peak = Math.max(...levels), threshold = Math.max(0.001, peak * 0.01);
  const first = levels.findIndex(n => n >= threshold), last = levels.findLastIndex(n => n >= threshold);
  if (first < 0 || peak < 0.005) throw new Error("Synthetic speech is too quiet");
  const start = Math.max(0, first - 1), end = Math.min(levels.length, last + 2);
  return { pcm: Buffer.from(padded.subarray(start * frameBytes, end * frameBytes)),
    activeStartMs: (first - start) * 20, activeEndMs: (last + 1 - start) * 20,
    threshold, rms: rms(padded), originalMs: padded.length / 32 };
}

function assemble(sample, first, second) {
  const leadingMs = 200;
  const chunks = [Buffer.alloc(leadingMs * 32), first.pcm];
  let lastPhraseStartMs = leadingMs + first.activeStartMs;
  let speechEndMs = leadingMs + first.activeEndMs;
  const firstSpeechEndMs = speechEndMs;
  let resumeMs = null;
  if (second) {
    const firstTail = first.pcm.length / 32 - first.activeEndMs;
    const insertedMs = sample.pauseMs - firstTail - second.activeStartMs;
    if (insertedMs < 0 || insertedMs % 20) throw new Error("Invalid fixture gap");
    chunks.push(Buffer.alloc(insertedMs * 32));
    const secondStart = chunks.reduce((sum, b) => sum + b.length / 32, 0);
    resumeMs = secondStart + second.activeStartMs;
    lastPhraseStartMs = resumeMs;
    speechEndMs = secondStart + second.activeEndMs;
    chunks.push(second.pcm);
    assert.equal(resumeMs - firstSpeechEndMs, sample.pauseMs);
  }
  chunks.push(Buffer.alloc(32000 * 3));
  let pcm = Buffer.concat(chunks);
  // Exactly 200ms packets, sent only after their audio time has elapsed.
  if (pcm.length % batchBytes) pcm = Buffer.concat([pcm, Buffer.alloc(batchBytes - pcm.length % batchBytes)]);
  return { pcm, metadata: { id: sample.id, prefix: sample.prefix, rest: sample.rest,
    pauseMs: sample.pauseMs, firstSpeechEndMs, resumeMs, lastPhraseStartMs, speechEndMs,
    totalMs: pcm.length / 32, sha256: createHash("sha256").update(pcm).digest("hex"),
    energyBoundary: "20ms RMS frames, max(0.001, peak-frame-RMS * 0.01)",
    firstClipRms: rounded(first.rms * 10000) / 10000,
    ...(second ? { secondClipRms: rounded(second.rms * 10000) / 10000 } : {}) } };
}

function shadow(settings, silenceMs) {
  const config = structuredClone(settings);
  Object.assign(config.input, { semanticEndpoint: false, silenceMs });
  return { detector: new TurnDetector(config), buffer: new UtteranceBuffer(config.input),
    silenceMs, endpoint: null, lastVoicedMs: null, latestText: "", thresholdChanges: [] };
}

function scoreSignal(signal, fixture) {
  if (!signal) return { observed: false, premature: null, finalWaitMs: null };
  const premature = fixture.resumeMs != null && signal.atMs < fixture.speechEndMs;
  return { observed: true, atMs: signal.atMs, premature,
    beforeContinuation: fixture.resumeMs != null && signal.atMs < fixture.resumeMs,
    finalWaitMs: premature ? null : rounded(signal.atMs - fixture.speechEndMs) };
}

async function trial(settings, fixture, variant, repeat) {
  const profile = settings.models.streamingAsr;
  const url = new URL(profile.baseUrl); url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const request = { model_name: "bigmodel", enable_itn: true, enable_punc: true, enable_ddc: false,
    enable_nonstream: true, show_utterances: true, corpus: asrCorpus(settings, ""),
    ...(variant.endWindowMs != null ? { end_window_size: variant.endWindowMs } : {}),
    ...(settings.people?.voiceIdentification && settings.people.groupId ? {
      enable_speaker_info: true, ssd_version: "200", ssd_mode: 2,
      voiceprints: [{ id: "", group_id: settings.people.groupId }],
    } : {}) };
  const row = { caseId: fixture.metadata.id, variant: variant.id, repeat, fixture: fixture.metadata,
    messages: [], newDefinites: [], firstStableTail: null, clientFinalAtMs: null,
    serverFinalAtMs: null, finalText: "", packetsSent: 0, maxSendLagMs: 0, error: null };
  const locals = { current: shadow(settings, settings.input.silenceMs),
    matched: shadow(settings, variant.effectiveWindowMs) };
  const vad = new SpeechDetector();
  let origin = null, seen = new Set(), failure = null, ended = false, lastSentMediaMs = 0;
  const ws = new WebSocket(url, { headers: { "X-Api-Key": profile.apiKey,
    "X-Api-Resource-Id": profile.model, "X-Api-Connect-Id": randomUUID() },
    handshakeTimeout: 8000, maxPayload: 1024 * 1024 });
  const final = Promise.withResolvers(); final.promise.catch(() => {});
  const fail = error => { failure ||= error; final.reject(error); };
  ws.on("error", () => fail(new Error("ASR connection error")));
  ws.on("close", () => { if (!ended) fail(new Error("ASR closed before its final packet")); });
  ws.on("unexpected-response", (_req, response) => { response.resume(); fail(new Error(`ASR HTTP ${response.statusCode}`)); });
  ws.on("message", bytes => {
    try {
      const parsed = readAsrPacket(bytes), data = parsed.value.result;
      if (origin == null) return;
      const atMs = rounded(performance.now() - origin);
      // Only these fields are retained; voiceprint identities/scores are omitted.
      const utterances = (data?.utterances || []).filter(u => typeof u.text === "string" && u.text.trim()).map(u => ({
        text: u.text, definite: u.definite === true, startMs: u.start_time, endMs: u.end_time,
      }));
      const text = typeof data?.text === "string" ? data.text : "";
      if (text) {
        row.finalText = text;
        for (const local of Object.values(locals)) if (!local.endpoint) {
          local.latestText = text; local.detector.partial(text);
        }
      }
      const event = { atMs, sentAudioMs: lastSentMediaMs, finalPacket: parsed.final,
        beforeClientFinal: row.clientFinalAtMs == null, text, utterances };
      if (row.messages.length < 300) row.messages.push(event);
      for (const utterance of utterances.filter(u => u.definite)) {
        const key = JSON.stringify([utterance.startMs, utterance.endMs, utterance.text]);
        if (seen.has(key)) continue;
        seen.add(key); row.newDefinites.push({ ...utterance, atMs,
          beforeClientFinal: row.clientFinalAtMs == null, sentAudioMs: lastSentMediaMs });
      }
      if (row.clientFinalAtMs == null && utterances.at(-1)?.definite && !row.firstStableTail)
        row.firstStableTail = { atMs, utterance: utterances.at(-1), sentAudioMs: lastSentMediaMs };
      if (parsed.final) { ended = true; row.serverFinalAtMs = atMs; final.resolve(); }
    } catch (error) { fail(error); }
  });
  try {
    await Promise.race([once(ws, "open"), final.promise]);
    if (failure || ws.readyState !== WebSocket.OPEN) throw failure || new Error("ASR not open");
    ws.send(asrPacket(1, { user: { uid: "douli-endpoint-check" },
      audio: { format: "pcm", rate: 16000, bits: 16, channel: 1 }, request }));
    origin = performance.now();
    const pcm = fixture.pcm;
    for (let at = 0; at < pcm.length; at += frameBytes) {
      const mediaMs = (at + frameBytes) / 32;
      const waitMs = origin + mediaMs - performance.now();
      if (waitMs > 0) await delay(waitMs);
      if (failure) throw failure;
      if (ended) throw new Error("ASR finalized before client audio ended");
      const frame = pcm.subarray(at, at + frameBytes);
      const voiced = settings.input.vad === "energy" ? rms(frame) >= settings.input.rmsThreshold
        : vad.detect(frame, settings.input.rmsThreshold);
      for (const local of Object.values(locals)) {
        if (local.endpoint) continue;
        if (voiced) { local.lastVoicedMs = mediaMs; local.detector.speech(); }
        else local.detector.observeSilence(local.buffer.silenceMs);
        const threshold = local.detector.threshold();
        if (local.thresholdChanges.at(-1)?.value !== threshold) local.thresholdChanges.push({ atMs: mediaMs, value: threshold });
        if (local.buffer.push(frame, true, voiced, threshold)) {
          local.endpoint = { atMs: rounded(performance.now() - origin), audioMs: mediaMs,
            transcript: local.latestText, lastVoicedMs: local.lastVoicedMs };
          local.detector.close();
        }
      }
      if ((at + frameBytes) % batchBytes === 0) {
        if (ws.bufferedAmount > 128000) throw new Error("ASR send backlog");
        row.maxSendLagMs = Math.max(row.maxSendLagMs, performance.now() - origin - mediaMs);
        lastSentMediaMs = mediaMs;
        ws.send(asrPacket(2, pcm.subarray(at + frameBytes - batchBytes, at + frameBytes)));
        row.packetsSent++;
      }
    }
    // All trailing silence is already uploaded. A short processing allowance
    // exposes naturally emitted results before the explicit end marker.
    await delay(300);
    if (failure) throw failure;
    row.clientFinalAtMs = rounded(performance.now() - origin);
    ws.send(asrPacket(2, Buffer.alloc(0), true));
    let timeout;
    try { await Promise.race([final.promise, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("ASR final timeout")), 6000);
    })]); } finally { clearTimeout(timeout); }
  } catch (error) { row.error = { name: error.name, message: String(error.message).slice(0, 160) }; }
  finally {
    for (const local of Object.values(locals)) local.detector.close();
    vad.close();
    if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
  }
  row.maxSendLagMs = rounded(row.maxSendLagMs);
  row.serverEndpoint = scoreSignal(row.firstStableTail, fixture.metadata);
  row.local = Object.fromEntries(Object.entries(locals).map(([name, local]) => [name, {
    silenceMs: local.silenceMs, endpoint: local.endpoint, score: scoreSignal(local.endpoint, fixture.metadata),
    thresholdChanges: local.thresholdChanges } ]));
  return row;
}

function summary(rows) {
  const mean = xs => xs.length ? rounded(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
  return variants.flatMap(variant => ["server", "local-current", "local-matched"].map(strategy => {
    const selected = rows.filter(r => r.variant === variant.id && !r.error);
    const score = row => strategy === "server" ? row.serverEndpoint : row.local[strategy === "local-current" ? "current" : "matched"].score;
    const complete = selected.filter(r => r.fixture.resumeMs == null), continued = selected.filter(r => r.fixture.resumeMs != null);
    const waits = complete.map(score).filter(s => s.observed).map(s => s.finalWaitMs);
    return { variant: variant.id, strategy, trials: selected.length,
      completeTrials: complete.length, continuedTrials: continued.length,
      premature: continued.filter(r => score(r).premature).length,
      missingSignal: selected.filter(r => !score(r).observed).length,
      completeWaitMeanMs: mean(waits), completeWaitMinMs: waits.length ? Math.min(...waits) : null,
      completeWaitMaxMs: waits.length ? Math.max(...waits) : null };
  }));
}

function save(directory, report) {
  report.summary = summary(report.rows);
  writeFileSync(join(directory, "result.json"), JSON.stringify(report, null, 2));
  const lines = ["case,variant,repeat,error,native_before_final,native_early,native_wait_ms,local_early,local_wait_ms,matched_local_early,matched_local_wait_ms,client_final_ms,server_final_ms"];
  for (const r of report.rows) lines.push([r.caseId, r.variant, r.repeat, !!r.error,
    r.serverEndpoint.observed, r.serverEndpoint.premature, r.serverEndpoint.finalWaitMs,
    r.local.current.score.premature, r.local.current.score.finalWaitMs,
    r.local.matched.score.premature, r.local.matched.score.finalWaitMs, r.clientFinalAtMs, r.serverFinalAtMs].join(","));
  writeFileSync(join(directory, "trials.csv"), "\uFEFF" + lines.join("\n") + "\n");
}

async function selfTest() {
  const tone = Buffer.alloc(6400);
  for (let i = 0; i < tone.length; i += 2) tone.writeInt16LE(Math.round(Math.sin(i / 2 * 2 * Math.PI * 180 / 16000) * 15000), i);
  const clip = trimClip(Buffer.concat([Buffer.alloc(3200), tone, Buffer.alloc(3200)]));
  const fixture = assemble({ id: "test", prefix: "first", pauseMs: 900, rest: "second" }, clip, clip);
  assert.equal(fixture.metadata.resumeMs - fixture.metadata.firstSpeechEndMs, 900);
  assert.equal(fixture.pcm.length % batchBytes, 0);
  assert.equal(scoreSignal({ atMs: fixture.metadata.resumeMs - 10 }, fixture.metadata).premature, true);
  assert.equal(scoreSignal({ atMs: fixture.metadata.speechEndMs + 800 }, fixture.metadata).finalWaitMs, 800);
  assert.equal(scoreSignal(null, fixture.metadata).observed, false);
  console.log(JSON.stringify({ ok: true, checks: ["audio trimming", "exact inserted gap", "paced packet size", "early and late signal scoring"] }));
}

if (process.argv.includes("--self-test")) {
  await selfTest();
} else if (process.argv.includes("--verify")) {
  const saved = JSON.parse(readFileSync(pointer, "utf8"));
  const result = join(saved.directory, "result.json");
  const report = existsSync(result) ? JSON.parse(readFileSync(result, "utf8")) : null;
  let alive = false; try { process.kill(saved.pid, 0); alive = true; } catch {}
  console.log(JSON.stringify({ ...saved, alive, state: report?.state || "starting", model: report?.model,
    trials: report?.rows.length || 0, synthesis: report?.synthesis, summary: report?.summary,
    errors: report?.rows.filter(r => r.error).map(r => ({ caseId: r.caseId, variant: r.variant, error: r.error })),
    error: report?.error }, null, 2));
  if (!alive && report?.state !== "complete") process.exitCode = 1;
} else if (!process.argv.includes("--run")) {
  mkdirSync(runtime, { recursive: true });
  const directory = mkdtempSync(join(runtime, "asr-endpoint-live-")), fd = openSync(join(directory, "runner.log"), "a");
  const args = [import.meta.filename, "--run", directory, ...(process.argv.includes("--smoke") ? ["--smoke"] : [])];
  const child = spawn(process.execPath, args, { cwd: root, detached: true, windowsHide: true, stdio: ["ignore", fd, fd] });
  await once(child, "spawn"); child.unref(); closeSync(fd);
  writeFileSync(pointer, JSON.stringify({ pid: child.pid, directory }, null, 2));
  console.log(JSON.stringify({ launched: true, pid: child.pid, directory }));
} else {
  const directory = resolve(process.argv[process.argv.indexOf("--run") + 1]);
  const smoke = process.argv.includes("--smoke");
  const report = { startedAt: new Date().toISOString(), state: "running", smoke,
    methodology: { realTTS: true, realASR: true, actualWebRtcVad: true, microphone: false,
      audioStored: false, sourceDatabaseReadOnly: true, extraChatModel: false,
      uploadMsPerPacket: 200, localFrameMs: 20, trailingSilenceMs: 3000,
      localShadowOnly: true, nativePolicy: "first response with a definite last utterance, before client final marker",
      limits: ["Synthetic clips with artificial pauses do not establish human or hardware accuracy.",
        "ASR stable sentence is evaluated as a hypothetical turn-end signal, not a provider guarantee of intent completion.",
        "Local detectors see real partial transcripts; they do not stop the shared stream.",
        "Timings exclude socket setup and are relative to an energy-based synthetic speech boundary."] },
    model: null, synthesis: [], fixtures: [], rows: [] };
  try {
    const settings = readSettings(), profile = speechProfile(settings);
    if (settings.input.asrProvider !== "volcengine") throw new Error("Configured ASR is not Volcengine");
    report.model = settings.models.streamingAsr.model;
    report.input = Object.fromEntries(["vad", "rmsThreshold", "silenceMs", "thinkingPauseMs"].map(k => [k, settings.input[k]]));
    report.voiceprintModePreserved = !!(settings.people?.voiceIdentification && settings.people.groupId);
    report.tts = { model: profile.model, voice: profile.voice, sampleRate: profile.pcmSampleRate || 24000 };
    save(directory, report);
    const cache = new Map();
    const clip = async text => {
      if (cache.has(text)) return cache.get(text);
      const began = performance.now();
      const generated = await synthesize(profile, text, AbortSignal.timeout(30000));
      const audio = trimClip(resample(generated.pcm, generated.sampleRate));
      cache.set(text, audio);
      report.synthesis.push({ text, elapsedMs: rounded(performance.now() - began), audioMs: audio.pcm.length / 32 });
      save(directory, report); return audio;
    };
    const selectedCases = smoke ? cases.slice(0, 1) : cases;
    const selectedVariants = smoke ? variants.slice(0, 1) : variants;
    const fixtures = [];
    for (const sample of selectedCases) {
      const first = await clip(sample.prefix), second = sample.rest ? await clip(sample.rest) : null;
      const fixture = assemble(sample, first, second); fixtures.push(fixture);
      report.fixtures.push(fixture.metadata); save(directory, report);
    }
    for (let repeat = 1; repeat <= (smoke ? 1 : 2); repeat++) {
      for (let i = 0; i < fixtures.length; i++) {
        for (let j = 0; j < selectedVariants.length; j++) {
          const variant = selectedVariants[(i + repeat - 1 + j) % selectedVariants.length];
          const row = await trial(settings, fixtures[i], variant, repeat);
          report.rows.push(row); save(directory, report);
          console.log(JSON.stringify({ completed: report.rows.length, caseId: row.caseId, variant: row.variant,
            nativeSignal: row.serverEndpoint, error: row.error }));
          if (row.error) throw new Error("A live ASR trial failed; inspect sanitized trial error");
        }
      }
    }
    report.state = "complete"; report.completedAt = new Date().toISOString(); save(directory, report);
  } catch (error) {
    report.state = "failed"; report.error = { name: error.name,
      message: String(error.message).replace(/(?:Bearer\s+|sk-)[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 180) };
    save(directory, report); process.exitCode = 1;
  }
}
