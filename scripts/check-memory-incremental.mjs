// Fictional conversations only. The source database is opened read-only, solely for provider settings.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { createDecipheriv } from "node:crypto";
import { mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { createApplication } from "../server/app.mjs";
import { MemoryService } from "../server/memory-service.mjs";
import { Store } from "../server/store.mjs";
import { putMemory, evidenceFor } from "../server/memory.mjs";
import { localDay } from "../server/memory-search.mjs";
import { mergeSettings } from "../server/config.mjs";
import { complete } from "../server/providers.mjs";

const root = resolve(import.meta.dirname, ".."), runtime = join(root, ".runtime"), pointer = join(runtime, "memory-incremental-check.json");
mkdirSync(runtime, { recursive: true });
if (process.argv.includes("--verify")) {
  const saved = JSON.parse(readFileSync(pointer, "utf8")), result = join(saved.directory, "result.json");
  if (existsSync(result)) {
    const report = JSON.parse(readFileSync(result, "utf8")); console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } else {
    process.kill(saved.pid, 0);
    console.log(JSON.stringify({ running: true, ...saved }));
  }
  if (saved.origin) console.log(JSON.stringify({ independentHealth: await fetch(saved.origin + "/api/health").then(r => r.json()).catch(() => null) }));
} else if (!process.argv.includes("--run")) {
  const directory = mkdtempSync(join(runtime, "memory-incremental-live-")), fd = openSync(join(directory, "runner.log"), "a");
  const child = spawn(process.execPath, [import.meta.filename, "--run", directory],
    { cwd: root, detached: true, windowsHide: true, stdio: ["ignore", fd, fd] });
  await once(child, "spawn"); child.unref(); closeSync(fd);
  writeFileSync(pointer, JSON.stringify({ pid: child.pid, directory }, null, 2));
  console.log("Independent memory check launched: " + child.pid);
} else {
  const directory = resolve(process.argv[process.argv.indexOf("--run") + 1]), dataDir = join(directory, "data");
  const report = { checkedAt: new Date().toISOString(), isolated: true, realProviders: true, checks: [], ok: false };
  let app;
  const record = (name, detail = {}) => { report.checks.push({ name, ...detail }); console.log(name); };
  try {
    const sourceDir = resolve(process.env.DOULI_MEMORY_CHECK_CONFIG_DIR || join(root, ".data"));
    const source = new DatabaseSync(join(sourceDir, "douli.sqlite"), { readOnly: true });
    const sealed = source.prepare("SELECT value FROM settings WHERE id='config'").get()?.value; source.close();
    if (!sealed) throw new Error("Configure a model before running this check");
    const [nonce, tag, data] = sealed.split(".").map(x => Buffer.from(x, "base64"));
    const decipher = createDecipheriv("aes-256-gcm", readFileSync(join(sourceDir, "local.key")), nonce); decipher.setAuthTag(tag);
    const settings = JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString());
    const probe = createServer().listen(0, "127.0.0.1"); await once(probe, "listening");
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    app = await createApplication({ dataDir, distDir: join(root, "dist"), adminPort: port, gatewayPort: 0 });
    clearInterval(app.memory.timer); clearTimeout(app.memory.scheduled); app.memory.schedule = () => {};
    app.store.saveSettings(mergeSettings(mergeSettings(app.store.settings(), settings), {
      privacy: { autoMemory: true }, routing: { enabled: false }, memory: { autoSummaries: true, maintenance: false },
    }));
    let modelCall = 0;
    app.memory.complete = async (...args) => {
      const output = await complete(...args);
      writeFileSync(join(directory, `model-${++modelCall}.json`), JSON.stringify({ input: args[1], output }, null, 2));
      return output;
    };
    await app.admin.listen({ host: "127.0.0.1", port });
    const origin = "http://127.0.0.1:" + app.admin.server.address().port;
    writeFileSync(pointer, JSON.stringify({ pid: process.pid, directory, origin }, null, 2));
    record("independent-server", { origin });
    record("configured-model", { model: app.store.settings().models.memory.model || app.store.settings().models.daily.model });
    const call = async (path, method = "GET", body) => {
      const r = await fetch(origin + path, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const data = await r.json(); assert.ok(r.ok, JSON.stringify(data)); return data;
    };
    const first = await app.engine.run({ route: "daily", text: "我叫小南，常住杭州，职业是程序员。我不吃香菜，喜欢面条，养了一只猫，名字叫小白。我的表哥叫小林，他在苏州工作。昨天和朋友吃了火锅。" });
    const batch = await app.memory.run();
    const facts = app.store.all("memories"), episodes = app.store.db.prepare("SELECT * FROM memory_episodes").all();
    writeFileSync(join(directory, "extraction.json"), JSON.stringify({ batch, facts, episodes }, null, 2));
    assert.equal(batch.failures, 0); assert.ok(facts.length >= 6, "Expected at least six supported facts, got " + facts.length);
    assert.ok(facts.every(m => m.status === "suggested" && evidenceFor(app.store, m.id).some(e => e.message_id === first.input.id && first.input.text.includes(e.quote))));
    assert.ok(!facts.some(m => m.kind === "event"));
    assert.ok(facts.some(m => m.subject === "user" && m.predicate === "food:香菜" && /不吃香菜/.test(m.value)), "Dietary negation must survive extraction");
    const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
    assert.ok(episodes.some(e => /火锅/.test(e.text) && localDay(new Date(e.occurred_at)) === localDay(yesterday)));
    assert.ok(facts.some(m => /小林/.test(m.subject + m.value) && /苏州/.test(m.value)));
    record("full-turn-facts-and-experiences", { facts: facts.length, episodes: episodes.length });
    for (const f of facts) await call("/api/memories", "PUT", { ...f, status: "active", replace: true });
    await app.memory.search.index(AbortSignal.timeout(45000));
    const diet = await app.memory.context("我有什么忌口？", AbortSignal.timeout(20000));
    assert.ok([...diet.core, ...diet.facts].some(m => /香菜/.test(m.value)));
    const past = await call("/api/memory/episodes?q=" + encodeURIComponent("昨天做了什么"));
    assert.ok(past.items.some(e => /火锅/.test(e.text)));
    const proof = await call("/api/memory/episodes/" + past.items[0].id + "/sources");
    assert.ok(proof.some(m => m.id === first.input.id));
    record("question-specific-recall-and-http-sources");
    const residence = app.store.all("memories").find(m => m.predicate === "residence" && m.status === "active");
    assert.ok(residence);
    // The fictional move must occur after the first fictional residence was learned.
    await app.engine.run({ sessionId: first.session.id, route: "daily", text: "我现在已经从杭州搬到上海了，之后常住上海。" });
    const moveBatch = await app.memory.run();
    assert.equal(moveBatch.failures, 0);
    const proposal = app.store.all("memories").find(m => m.predicate === "residence" && m.status === "conflict" && /上海/.test(m.value));
    assert.ok(proposal, "Expected a reviewable residence change");
    await call("/api/memories", "PUT", { ...proposal, status: "active", replace: true });
    assert.equal(app.store.all("memories").find(m => m.id === residence.id).status, "superseded");
    record("real-model-residence-change-retains-history", { explicitTarget: !!proposal.target_id });
    const club = putMemory(app.store, { name: "周末跑团", subject: "user", predicate: "membership:周末跑团", kind: "state",
      value: "用户参加周末跑团", object: "参加", validFrom: "2020-01-01" });
    await app.engine.run({ route: "daily", text: "我今天已经退出周末跑团，以后不再参加了。" });
    const endBatch = await app.memory.run();
    assert.equal(endBatch.failures, 0);
    const expiry = app.store.all("memories").find(m => m.target_id === club.id && ["expire", "update"].includes(m.change_action));
    assert.ok(expiry, "Ending a state must produce a reviewable change");
    assert.equal(app.store.all("memories").find(m => m.id === club.id).status, "active");
    record("real-model-state-ending-awaits-confirmation", { proposalId: expiry.id, action: expiry.change_action });
    await app.memory.stop();
    const reopened = new Store(dataDir), next = new MemoryService(reopened);
    try {
      const saved = await next.context("我现在住哪里？", AbortSignal.timeout(20000));
      assert.ok([...saved.core, ...saved.facts].some(m => /上海/.test(m.value)));
      assert.ok((await next.search.episodes("昨天做了什么")).items.some(e => /火锅/.test(e.text)));
      record("reopened-database-recall");
    } finally { await next.stop(); reopened.close(); }
    assert.equal((await call("/api/health")).ok, true);
    report.ok = true;
    writeFileSync(join(directory, "result.json"), JSON.stringify(report, null, 2));
    // Leave the isolated UI available briefly for external verification after the launching shell exits.
    setTimeout(() => { void app.close(); }, 10 * 60 * 1000);
  } catch (error) {
    report.error = error.message;
    writeFileSync(join(directory, "result.json"), JSON.stringify(report, null, 2));
    console.error(error.stack);
    if (app) await app.close();
    process.exitCode = 1;
  }
}
