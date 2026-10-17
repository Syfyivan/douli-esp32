import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, openSync } from "node:fs";
import { resolve, join } from "node:path";
import { Store } from "../server/store.mjs";
import { HealthService } from "../server/health-service.mjs";
const root = resolve(import.meta.dirname, "..");
const directory = join(root, ".runtime/health-check");
mkdirSync(directory, { recursive: true });
const mode = process.argv[2];
if (mode === "--launch") {
  const actual = new Store(join(root, ".data"));
  const settings = actual.settings(); actual.close();
  settings.memory.semantic = false; settings.memory.maintenance = false; settings.memory.autoSummaries = false; settings.privacy.autoMemory = false;
  const isolated = new Store(join(directory, "data")); isolated.saveSettings(settings); isolated.close();
  const child = spawn(process.execPath, [join(root, "server/index.mjs")], { cwd: root, detached: true, windowsHide: true,
    env: { ...process.env, DOULI_PORT: "8790", DOULI_DEVICE_PORT: "18789", DOULI_DEVICE_HOST: "127.0.0.1", DOULI_DATA_DIR: join(directory, "data") },
    stdio: ["ignore", openSync(join(directory, "stdout.log"), "a"), openSync(join(directory, "stderr.log"), "a")] });
  child.unref(); writeFileSync(join(directory, "process.json"), JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }));
  console.log(JSON.stringify({ pid: child.pid, url: "http://127.0.0.1:8790", message: "Verify in a separate command after this launcher exits." }));
} else if (mode === "--verify") {
  const processInfo = JSON.parse(readFileSync(join(directory, "process.json")));
  process.kill(processInfo.pid, 0);
  const health = await fetch("http://127.0.0.1:8790/api/health").then(r => r.json());
  const state = await fetch("http://127.0.0.1:8790/api/medical/state").then(r => r.json());
  if (health.healthVersion !== 1 || !Array.isArray(state.reports)) throw new Error("Health host verification failed");
  console.log(JSON.stringify({ health, model: state.model, visionModel: state.visionModel, searchConfigured: state.searchConfigured, processAliveAfterLauncherExit: true }));
} else if (mode === "--sources") {
  const store = new Store(join(directory, "data")); const health = new HealthService(store);
  const results = [];
  for (const [name, run] of [["MedlinePlus", () => health.evidence.patient("laboratory tests", AbortSignal.timeout(20000))],
    ["PubMed", () => health.evidence.pubmed("laboratory reference ranges", AbortSignal.timeout(30000))],
    ["DailyMed", () => health.evidence.drugs("acetaminophen", AbortSignal.timeout(40000))],
    ["Chinese authoritative search", () => health.evidence.trustedWeb("检查报告 参考范围", AbortSignal.timeout(20000))]]) {
    try { const items = await run(); results.push({ name, ok: true, count: items.length, titles: items.map(i => i.title), textLengths: items.map(i => i.text.length) }); }
    catch (error) { results.push({ name, ok: false, error: error.message, cause: error.cause?.code }); }
  }
  store.close(); writeFileSync(join(directory, "sources.json"), JSON.stringify(results, null, 2)); console.log(JSON.stringify(results));
} else if (mode === "--consult") {
  const response = await fetch("http://127.0.0.1:8790/api/medical/consult", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "这是软件验收用的虚构场景：体检报告中一个指标略高于参考范围，是否就能确定患病？应该先核对哪些信息？" }), signal: AbortSignal.timeout(180000) });
  const data = await response.json(); writeFileSync(join(directory, "consult.json"), JSON.stringify(data, null, 2));
  if (!response.ok) throw new Error(data.error);
  console.log(JSON.stringify({ spoken: data.answer.spoken, citations: data.answer.citations.map(c => ({ title: c.source.title, excerpt: c.excerpt })), warnings: data.answer.citationWarnings,
    evidenceStatus: data.evidence.services, questionCount: data.answer.questions.length }));
} else throw new Error("Use --launch, --verify, --sources or --consult");
