// Real configured cloud model, fictional transcripts, controlled VAD/ASR timing.
// No microphone capture, production writes, or claims about human speech quality.
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { createDecipheriv } from "node:crypto";
import { once } from "node:events";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { UtteranceBuffer } from "../server/audio.mjs";
import { defaults, normalizeSettings } from "../server/config.mjs";
import { TurnDetector } from "../server/turn-detector.mjs";

const root = resolve(import.meta.dirname, ".."), runtime = join(root, ".runtime");
const pointer = join(runtime, "endpoint-comparison.json");
const cases = [
  { id: "weather", kind: "complete", prefix: "明天天气怎么样？" },
  { id: "volume", kind: "complete", prefix: "把音量调小一点。" },
  { id: "explanation", kind: "complete", prefix: "给我解释一下什么是惯性。" },
  { id: "complete-condition", kind: "complete", prefix: "如果明天下雨，我们就改到室内。" },
  { id: "finished", kind: "complete", prefix: "就这些，我说完了，谢谢。" },
  { id: "keyword-question", kind: "complete", prefix: "请解释一下什么叫如果。" },
  { id: "condition", kind: "continuation", prefix: "如果明天下雨", pauseMs: 800, rest: "我们就改到室内。" },
  { id: "reason", kind: "continuation", prefix: "我今天没去公司是因为", pauseMs: 900, rest: "家里有点事情。" },
  { id: "missing-object", kind: "continuation", prefix: "帮我把明天的会议改到", pauseMs: 700, rest: "下午三点。" },
  { id: "correction", kind: "continuation", prefix: "把音量调到八十", pauseMs: 800, rest: "不对，调到六十。" },
  { id: "hesitation", kind: "continuation", prefix: "让我想想", pauseMs: 1200, rest: "明天上午九点比较合适。" },
  { id: "enumeration", kind: "continuation", prefix: "需要带的东西有", pauseMs: 900, rest: "身份证和充电器。" },
];
const variants = [
  { id: "local", label: "本地判停", patch: { semanticEndpoint: false } },
  { id: "cloud-current", label: "当前时序＋云端辅助", patch: { semanticEndpoint: true } },
  { id: "local-1000", label: "本地 1000ms（等待时长对照）", patch: { semanticEndpoint: false, silenceMs: 1000 } },
  { id: "cloud-1000", label: "1000ms 回退＋云端辅助（实验）", patch: { semanticEndpoint: true, silenceMs: 1000 } },
];
const context = new AsyncLocalStorage();
const rounded = n => Math.round(n * 10) / 10;
const mean = xs => xs.length ? rounded(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
const percentile = (xs, p) => xs.length ? [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * p) - 1] : null;

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

function observeRequests() {
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const run = context.getStore();
    if (!run) return original(...args);
    const request = { startedMs: rounded(performance.now() - run.origin) };
    run.requests.push(request);
    try {
      const response = await original(...args);
      request.httpStatus = response.status;
      const observed = response.clone().json().then(body => {
        request.finishedMs = rounded(performance.now() - run.origin);
        const content = body.choices?.[0]?.message?.content;
        if (typeof content === "string") {
          try {
            const decision = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, ""));
            if (typeof decision.complete === "boolean") request.complete = decision.complete;
            if (typeof decision.confidence === "number") request.confidence = decision.confidence;
          } catch { request.invalidJSON = true; }
        }
      }).catch(error => { request.error = error.name; request.finishedMs = rounded(performance.now() - run.origin); });
      run.observations.push(observed);
      return response;
    } catch (error) {
      request.error = error.name;
      request.finishedMs = rounded(performance.now() - run.origin);
      throw error;
    }
  };
  return () => { globalThis.fetch = original; };
}

async function replay(settings, sample, variant, repeat, realTime = true) {
  const config = structuredClone(settings);
  Object.assign(config.input, variant.patch);
  const run = { origin: performance.now(), requests: [], observations: [] };
  return context.run(run, async () => {
    const decisions = [];
    let logicalMs = 0;
    const detector = new TurnDetector(config, decision => decisions.push({ ...decision,
      atMs: rounded(performance.now() - run.origin), logicalMs }));
    const buffer = new UtteranceBuffer(config.input), frame = Buffer.alloc(640);
    // First phrase is already present: replay starts at its last voiced frame.
    // Boolean VAD labels are intentional; these zero bytes are not voice audio.
    for (let i = 0; i < 8; i++) { detector.speech(); buffer.push(frame, true, true, detector.threshold()); }
    detector.partial(sample.prefix);
    const speechEnd = sample.kind === "continuation" ? sample.pauseMs + 600 : 0;
    const thresholds = [];
    let resumed = false, finalTranscript = false, endpointMs = null, endpointWallMs = null, maxTickLagMs = 0;
    try {
      for (logicalMs = 20; logicalMs <= 6000; logicalMs += 20) {
        if (realTime) {
          const remaining = run.origin + logicalMs - performance.now();
          if (remaining > 0) await delay(remaining);
          maxTickLagMs = Math.max(maxTickLagMs, performance.now() - run.origin - logicalMs);
        }
        const voiced = sample.kind === "continuation" && logicalMs > sample.pauseMs && logicalMs <= speechEnd;
        if (voiced && !resumed) { resumed = true; detector.speech(); }
        if (sample.kind === "continuation" && logicalMs === speechEnd && !finalTranscript) {
          detector.partial(sample.prefix + "，" + sample.rest); finalTranscript = true;
        }
        // Match gateway.capture(): observe the previous silence count before push.
        if (voiced) detector.speech(); else detector.observeSilence(buffer.silenceMs);
        const threshold = detector.threshold();
        if (!thresholds.length || thresholds.at(-1).value !== threshold) thresholds.push({ atMs: logicalMs, value: threshold });
        if (buffer.push(frame, true, voiced, threshold)) {
          endpointMs = logicalMs; endpointWallMs = rounded(performance.now() - run.origin); break;
        }
      }
      // Observe late responses separately. They cannot change the ended replay.
      // Production may cancel them earlier while final ASR is completing.
      if (run.requests.length) {
        const remaining = run.requests.at(-1).startedMs + 700 - (performance.now() - run.origin);
        if (remaining > 0) await delay(remaining);
      }
      await Promise.allSettled(run.observations);
      const premature = endpointMs != null && sample.kind === "continuation" && endpointMs < speechEnd;
      return { caseId: sample.id, kind: sample.kind, variant: variant.id, repeat, endpointMs, endpointWallMs,
        premature, finalWaitMs: endpointMs != null && !premature ? endpointMs - speechEnd : null,
        maxTickLagMs: rounded(maxTickLagMs), thresholds, requests: run.requests,
        decisions: decisions.map(d => ({ ...d, beforeEndpoint: endpointWallMs != null && d.atMs <= endpointWallMs })) };
    } finally { detector.close(); }
  });
}

function summaries(rows) {
  return variants.map(v => {
    const group = rows.filter(r => r.variant === v.id), continued = group.filter(r => r.kind === "continuation");
    const complete = group.filter(r => r.kind === "complete"), waits = complete.map(r => r.finalWaitMs).filter(Number.isFinite);
    const requests = group.flatMap(r => r.requests);
    return { id: v.id, label: v.label, trials: group.length, continuationTrials: continued.length,
      premature: continued.filter(r => r.premature).length,
      completeTrials: complete.length, completeWaitMedianMs: percentile(waits, .5),
      completeWaitMeanMs: mean(waits), completeWaitMaxMs: waits.length ? Math.max(...waits) : null,
      over1000msOnComplete: waits.filter(n => n > 1000).length,
      cloudRequests: requests.length, cloudErrors: requests.filter(r => r.error || r.httpStatus >= 400).length,
      acceptedBeforeEndpoint: group.flatMap(r => r.decisions).filter(d => d.beforeEndpoint).length,
      acceptedAfterEndpoint: group.flatMap(r => r.decisions).filter(d => !d.beforeEndpoint).length,
      maxTickLagMs: Math.max(0, ...group.map(r => r.maxTickLagMs)) };
  });
}

async function diagnostic(settings, sample) {
  // Keep the production prompt/parser/confidence check. Only the request timeout
  // is widened to 5 s, and no endpoint is committed, to expose semantic ability.
  const config = structuredClone(settings);
  Object.assign(config.input, { adaptiveEndpoint: true, semanticEndpoint: true });
  const run = { origin: performance.now(), requests: [], observations: [] };
  return context.run(run, async () => {
    const detector = new TurnDetector(config);
    detector.partial(sample.prefix);
    if (detector.threshold() > config.input.silenceMs) {
      detector.close(); return { caseId: sample.id, skipped: "production-local-hesitation-rule" };
    }
    // Use a dedicated fetch wrapper only for this sequential diagnostic call.
    const previous = globalThis.fetch;
    globalThis.fetch = (url, options) => previous(url, { ...options,
      signal: AbortSignal.any([detector.request.signal, AbortSignal.timeout(5000)]) });
    try {
      detector.observeSilence(300);
      const deadline = performance.now() + 5100;
      while (!detector.decision && performance.now() < deadline) {
        if (run.requests[0]?.error || run.requests[0]?.finishedMs != null) {
          await delay(10); break;
        }
        await delay(10);
      }
      await Promise.allSettled(run.observations);
      const expectedComplete = sample.kind === "complete";
      return { caseId: sample.id, expectedComplete, decision: detector.decision, requests: run.requests,
        agreesWithScript: detector.decision ? detector.decision.complete === expectedComplete : null,
        note: sample.id === "correction" ? "Prefix is itself complete; future self-correction is not observable to the model." : undefined };
    } finally { detector.close(); globalThis.fetch = previous; }
  });
}

function save(directory, report) {
  report.summary = summaries(report.rows);
  writeFileSync(join(directory, "result.json"), JSON.stringify(report, null, 2));
  const csv = ["case,kind,variant,repeat,premature,endpoint_ms,final_wait_ms,cloud_requests,accepted_before_endpoint"];
  for (const r of report.rows) csv.push([r.caseId, r.kind, r.variant, r.repeat, r.premature, r.endpointMs,
    r.finalWaitMs, r.requests.length, r.decisions.filter(d => d.beforeEndpoint).length].join(","));
  writeFileSync(join(directory, "trials.csv"), "\uFEFF" + csv.join("\n") + "\n");
}

async function selfTest() {
  const settings = structuredClone(defaults);
  const rows = [];
  for (const sample of cases) rows.push(await replay(settings, sample, variants[0], 1, false));
  assert.deepEqual(rows.filter(r => r.premature).map(r => r.caseId), ["condition", "missing-object", "correction", "enumeration"]);
  assert.equal(rows.find(r => r.caseId === "keyword-question").finalWaitMs, 2200);
  assert.equal(rows.find(r => r.caseId === "hesitation").finalWaitMs, 500);
  assert.equal(rows.find(r => r.caseId === "reason").finalWaitMs, 500);
  assert.ok(rows.every(r => r.requests.length === 0));
  const summary = summaries(rows)[0];
  assert.equal(summary.premature, 4); assert.equal(summary.completeTrials, 6);
  assert.equal(summary.completeWaitMedianMs, 500);
  const slowRows = [];
  for (const sample of cases) slowRows.push(await replay(settings, sample, variants.find(v => v.id === "local-1000"), 1, false));
  assert.ok(slowRows.every(r => !r.premature));
  assert.equal(summaries(slowRows).find(s => s.id === "local-1000").completeWaitMedianMs, 1000);
  // Verify that reported "late" decisions cannot retroactively fix an endpoint.
  // No network calls are made in this self-test.
  const originalFetch = globalThis.fetch;
  let responseMs = 350;
  settings.models.daily = { baseUrl: "https://endpoint-fixture.invalid", model: "fixture" };
  globalThis.fetch = async (_url, options) => {
    await delay(responseMs, undefined, { signal: options.signal });
    const text = JSON.parse(options.body).messages.at(-1).content;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      complete: text.includes("室内"), confidence: 0.95,
    }) } }] }), { headers: { "Content-Type": "application/json" } });
  };
  const restore = observeRequests();
  try {
    const sample = cases.find(c => c.id === "condition");
    const late = await replay(settings, sample, variants.find(v => v.id === "cloud-current"), 1);
    assert.equal(late.premature, true);
    assert.ok(late.decisions.some(d => !d.beforeEndpoint));
    const guarded = await replay(settings, sample, variants.find(v => v.id === "cloud-1000"), 1);
    assert.equal(guarded.premature, false);
    assert.ok(guarded.decisions.some(d => d.beforeEndpoint && !d.complete));
    responseMs = 60;
    const timely = await replay(settings, sample, variants.find(v => v.id === "cloud-current"), 1);
    assert.equal(timely.premature, false);
    assert.ok(timely.decisions.some(d => d.beforeEndpoint && !d.complete));
  } finally { restore(); globalThis.fetch = originalFetch; }
  console.log(JSON.stringify({ ok: true, fixtures: cases.length, timingChecks: 3, localSummary: summary }));
}

if (process.argv.includes("--self-test")) {
  await selfTest();
} else if (process.argv.includes("--verify")) {
  const saved = JSON.parse(readFileSync(pointer, "utf8"));
  const path = join(saved.directory, "result.json");
  const report = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  let alive = false; try { process.kill(saved.pid, 0); alive = true; } catch {}
  console.log(JSON.stringify({ ...saved, alive, state: report?.state || "starting", model: report?.model,
    completedTrials: report?.rows.length || 0, summary: report?.summary, diagnostic: report?.diagnostic,
    error: report?.error }, null, 2));
  if (!alive && report?.state !== "complete") process.exitCode = 1;
} else if (!process.argv.includes("--run")) {
  mkdirSync(runtime, { recursive: true });
  const directory = mkdtempSync(join(runtime, "endpoint-comparison-")), fd = openSync(join(directory, "runner.log"), "a");
  const child = spawn(process.execPath, [import.meta.filename, "--run", directory],
    { cwd: root, detached: true, windowsHide: true, stdio: ["ignore", fd, fd] });
  await once(child, "spawn"); child.unref(); closeSync(fd);
  writeFileSync(pointer, JSON.stringify({ pid: child.pid, directory }, null, 2));
  console.log(JSON.stringify({ launched: true, pid: child.pid, directory }));
} else {
  const directory = resolve(process.argv[process.argv.indexOf("--run") + 1]);
  const report = { startedAt: new Date().toISOString(), state: "running", methodology: {
    realCloud: true, microphone: false, simulatedVADAndASR: true, productionWrites: false,
    repeats: 2, continuationSpeechMs: 600, frameMs: 20,
    modelSeesFutureContinuation: false, promptSource: "server/turn-detector.mjs",
    limits: ["Small deliberately difficult fixture set, not population accuracy.",
      "Perfect transcript at pause start; no actual ASR lag, noise, prosody, playback or barge-in.",
      "Each variant makes its own real request; order rotates but network variability remains.",
      "Late responses are observed for diagnostics only and never reopen an ended turn.",
      "Unannounced self-correction is not inferable from a complete prefix."] },
    cases, variants, rows: [], diagnostic: [] };
  let restore;
  try {
    const settings = readSettings();
    if (!settings.models.daily.baseUrl || !settings.models.daily.model) throw new Error("No configured daily model");
    report.model = settings.models.daily.model;
    report.input = Object.fromEntries(["silenceMs", "adaptiveEndpoint", "semanticEndpoint", "thinkingPauseMs", "fastEndpointMs"].map(k => [k, settings.input[k]]));
    restore = observeRequests(); save(directory, report);
    for (let repeat = 1; repeat <= 2; repeat++) {
      for (let i = 0; i < cases.length; i++) {
        const start = (i + repeat - 1) % variants.length;
        for (let j = 0; j < variants.length; j++) {
          const variant = variants[(start + j) % variants.length];
          report.rows.push(await replay(settings, cases[i], variant, repeat));
          save(directory, report);
          console.log(JSON.stringify({ trial: report.rows.length, case: cases[i].id, variant: variant.id }));
        }
      }
    }
    for (const sample of cases) {
      report.diagnostic.push(await diagnostic(settings, sample)); save(directory, report);
    }
    report.state = "complete"; report.completedAt = new Date().toISOString(); save(directory, report);
  } catch (error) {
    report.state = "failed"; report.error = { name: error.name, message: "Comparison failed; inspect bounded runner progress and configuration." };
    save(directory, report); process.exitCode = 1;
  } finally { restore?.(); }
}
