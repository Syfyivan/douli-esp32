import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { Store } from "../server/store.mjs";
import { mergeSettings } from "../server/config.mjs";
import { ComputerTasks, computerIntent, explicitComputerAction } from "../server/computer-tasks.mjs";
import { OrcaClient, OrcaError, startupReady } from "../server/orca-client.mjs";
import { createApplication } from "../server/app.mjs";

class FixtureOrca {
  constructor() { this.terminals = new Map(); this.creates = 0; this.sends = []; this.interrupts = 0; this.transportDown = false; }
  async catalog() { return { runtimeId: "fixture-runtime", version: "fixture", worktrees: [{ id: "fixture-project", worktreeId: "worktree-id", name: "douli", label: "douli", path: "/fixture/douli" }] }; }
  async create() {
    this.creates++; const id = `fixture-${this.creates}`;
    const terminal = { handle: id, incarnationId: `process-${id}`, tabId: `tab-${id}`, worktreeId: "worktree-id", agentIdentity: "codex", connected: true, writable: true };
    this.terminals.set(id, { terminal, idle: true, output: "› Ask Codex to do anything" });
    return { terminal: { ...terminal } };
  }
  async show(id) {
    if (this.transportDown) throw new OrcaError("fixture offline", "transport");
    const t = this.terminals.get(id); if (!t) throw new OrcaError("stale", "terminal_handle_stale");
    return { terminal: { ...t.terminal } };
  }
  async read(id) { return { terminal: { tail: this.terminals.get(id).output.split("\n") } }; }
  async idle(id) { return this.terminals.get(id).idle; }
  async send(id, text, requestId) {
    const t = this.terminals.get(id);
    if (!requestId) this.sends.push({ id, text });
    t.output = `› ${text}\n• Working (0s • esc to interrupt)`; t.idle = false;
    if (this.failSend) throw new OrcaError("ambiguous", "transport");
    return { send: { accepted: true, prompt: { requestId: requestId || `request-${this.sends.length}`, stages: this.acceptOnly ? ["input_accepted"] : ["input_accepted", "turn_started"], processIncarnation: t.terminal.incarnationId } } };
  }
  finish(id, text = "fixture result") { const t = this.terminals.get(id); t.output = `• ${text}\n› Ask Codex to do anything`; t.idle = true; }
  async interrupt(id) { this.interrupts++; this.finish(id, "Conversation interrupted"); return { send: { accepted: true } }; }
  async close(id) { const t = this.terminals.get(id); t.terminal.connected = t.terminal.writable = false; t.terminal.exitCause = { kind: "operator_close" }; return { close: { ptyKilled: true } }; }
  async list() { return { terminals: [...this.terminals.values()].map(t => ({ ...t.terminal })) }; }
}
const cleanups = new WeakMap();
const onClose = (t, callback) => cleanups.get(t).push(callback);
function directory(t) {
  const root = resolve(tmpdir()), dir = mkdtempSync(join(root, "douli-computer-"));
  cleanups.set(t, []);
  t.after(async () => {
    for (const close of cleanups.get(t).reverse()) await close();
    if (!resolve(dir).startsWith(root + sep)) throw new Error("Unsafe cleanup");
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
async function fixture(t) {
  const dir = directory(t), store = new Store(dir), client = new FixtureOrca(), service = new ComputerTasks(store, { client });
  onClose(t, async () => { await service.close(); store.close(); });
  await service.configure({ enabled: true, defaultWorktree: "fixture-project" });
  return { dir, store, client, service };
}
function existingSessions(client) {
  client.catalog = async () => ({ runtimeId: "fixture-runtime", worktrees: [
    { id: "fixture-project", worktreeId: "worktree-id", name: "douli-esp32", path: "/fixture/douli-esp32" },
    { id: "other-project", worktreeId: "other-worktree", name: "other", path: "/fixture/other" },
  ] });
  for (let n = 1; n <= 5; n++) client.terminals.set(`existing-${n}`, {
    terminal: { handle: `existing-${n}`, title: `已有会话 ${n}`, worktreeId: n <= 4 ? "worktree-id" : "other-worktree",
      incarnationId: `existing-process-${n}`, tabId: `existing-tab-${n}`, agentIdentity: "codex", connected: true, writable: true,
      preview: "must not leak terminal content into the list" }, output: `会话 ${n} 的画面`, idle: true,
  });
}

test("existing Orca sessions are discoverable without Douli tasks, including spoken ESP32 project names", async t => {
  const { service, client } = await fixture(t); existingSessions(client);
  for (const project of [undefined, "ESP32", "esp 32", "豆梨ESP三二", "豆梨 ESP 三十二", "豆梨", "douli-esp32"]) {
    const result = await service.sessions(project);
    assert.equal(result.scope, "orca_project_sessions"); assert.equal(result.count, 4); assert.equal(result.totalCount, 4);
    assert.equal(result.truncated, false); assert.ok(result.sessions.every(s => s.supportsContinue && s.title && s.sessionId));
    assert.ok(!JSON.stringify(result).includes("existing-5")); assert.ok(!JSON.stringify(result).includes("must not leak"));
  }
  const text = "呃，你看一下这个豆梨ESP三二这个，有现在有这个这个奥卡里面现在有多少个session啊？";
  assert.ok(computerIntent(text)); assert.ok(computerIntent("ESP32 下面有多少 session"));
  const fallback = await service.tool({ action: "list", project: "豆梨ESP三二" }, { text });
  assert.equal(fallback.count, 4, "old list tool choice must not silently return an empty task table");
  const tasks = await service.tool({ action: "list" }, { text: "我让你创建的电脑任务有哪些" });
  assert.equal(tasks.scope, "douli_tasks"); assert.deepEqual(tasks.tasks, []);
  assert.equal(client.creates, 0); assert.equal(client.sends.length, 0);
  const catalog = await client.catalog(); catalog.worktrees.push({ id: "another", worktreeId: "another", name: "another-esp32", path: "/another-esp32" });
  client.catalog = async () => catalog;
  await assert.rejects(service.sessions("ESP32"), /多个同名项目/);
  await assert.rejects(service.sessions("missing"), /没有找到这个本机项目/);
});

test("reading existing sessions does not adopt them, checks identity, and reports unavailable or truncated results", async t => {
  const { service, client } = await fixture(t); existingSessions(client);
  const view = await service.readSession({ project: "ESP32", sessionTitle: "已有会话 2" });
  assert.equal(view.output, "会话 2 的画面"); assert.ok(view.outputTruncated); assert.ok(view.session.supportsContinue);
  assert.equal(service.list().length, 0, "reading does not adopt personal sessions as Douli tasks");
  await assert.rejects(service.readSession({ sessionTitle: "已有会话" }), /多个同名会话/);
  await assert.rejects(service.readSession({ sessionId: "existing-5" }), /该项目当前没有找到/);
  await assert.rejects(service.tool({ action: "stop", taskId: "existing-2" }, { text: "停止这个 Orca 会话" }), /没有找到这个豆梨电脑任务/);
  await assert.rejects(service.tool({ action: "followup", taskId: "existing-2", instruction: "继续" }, { text: "让 Orca 继续" }), /没有找到这个豆梨电脑任务/);
  const read = client.read.bind(client); let reads = 0;
  client.read = async id => { reads++; return read(id); };
  const show = client.show.bind(client);
  client.show = async id => ({ terminal: { ...(await show(id)).terminal, incarnationId: "replacement" } });
  await assert.rejects(service.readSession({ sessionId: "existing-2" }), /身份已变化/); assert.equal(reads, 0);
  client.show = show;
  client.read = async id => { const result = await read(id); client.terminals.get(id).terminal.incarnationId = "replaced-during-read"; return result; };
  await assert.rejects(service.readSession({ sessionId: "existing-2" }), /身份已变化/);
  const listed = (await client.list()).terminals.filter(t => t.worktreeId === "worktree-id");
  client.list = async () => ({ terminals: listed.slice(0, 2), totalCount: 4, truncated: true });
  const partial = await service.sessions(); assert.equal(partial.count, 2); assert.equal(partial.totalCount, 4); assert.ok(partial.truncated);
  client.list = async () => { throw new OrcaError("连接失败", "transport"); };
  await assert.rejects(service.sessions(), /连接失败/);
  client.list = async () => ({});
  await assert.rejects(service.sessions(), /没有返回有效的会话列表/);
  await service.configure({ enabled: false });
  await assert.rejects(service.sessions(), /开启 Orca 控制/);
  assert.equal(client.creates, 0); assert.equal(client.sends.length, 0); assert.equal(client.interrupts, 0);
});

test("continuing an existing session keeps its identity, deduplicates input, and tracks later turns without creating terminals", async t => {
  const { service, client } = await fixture(t); existingSessions(client);
  const args = { project: "ESP32", sessionTitle: "已有会话 2", instruction: "继续上一轮的检查，不要修改文件", requestKey: "continue-one", chatSessionId: "chat-one" };
  const [a, b] = await Promise.all([service.continueSession(args), service.continueSession(args)]);
  assert.equal(a.id, b.id); assert.equal(a.origin, "existing_session"); assert.equal(a.sessionId, "chat-one");
  assert.equal(a.terminal.handle, "existing-2"); assert.equal(a.state, "running");
  assert.equal(service.list().length, 1); assert.equal(client.creates, 0); assert.equal(client.sends.length, 1);
  assert.match(client.sends[0].text, /沿用本会话已有上下文/); assert.match(client.sends[0].text, /不要修改文件/);
  await assert.rejects(service.continueSession({ ...args, instruction: "不同指令" }), /同一个请求编号/);
  await assert.rejects(service.continueSession({ ...args, requestKey: "while-busy" }), /等待当前一轮/);
  client.finish("existing-2", "first answer"); let task = await service.refresh(a.id); assert.equal(task.state, "completed");
  task = await service.continueSession({ ...args, requestKey: "continue-two", instruction: "继续补充" });
  assert.equal(task.id, a.id); assert.equal(task.turns.length, 2); assert.equal(client.sends.length, 2);
  assert.equal(service.view(task).canClose, false); await assert.rejects(service.closeTask(task.id), /原有会话/);
  await service.stop(task.id); task = await service.refresh(task.id); assert.equal(task.state, "interrupted");
  assert.equal(client.interrupts, 1); assert.equal(client.terminals.get("existing-1").output, "会话 1 的画面");
  assert.equal(client.terminals.size, 5);
});

test("continuing sessions rejects ambiguous, busy, disconnected, permission-waiting or replaced targets before sending", async t => {
  const { service, client } = await fixture(t); existingSessions(client);
  const args = { sessionId: "existing-2", instruction: "继续", requestKey: "guarded" };
  await assert.rejects(service.continueSession({ ...args, sessionId: undefined, sessionTitle: "已有会话" }), /多个同名会话/);
  await assert.rejects(service.continueSession({ ...args, sessionId: undefined }), /明确要操作哪一个会话/);
  await assert.rejects(service.continueSession({ ...args, sessionId: "existing-5" }), /没有找到/);
  const live = client.terminals.get("existing-2"); live.idle = false;
  await assert.rejects(service.continueSession(args), /尚未确认空闲/); live.idle = true;
  live.output = "Working (1s • esc to interrupt)";
  await assert.rejects(service.continueSession(args), /仍在工作/);
  live.output = "Allow once? Approve this command";
  await assert.rejects(service.continueSession(args), /等待权限确认/); live.output = "Ready";
  live.terminal.connected = false;
  await assert.rejects(service.continueSession(args), /尚未确认空闲/); live.terminal.connected = true;
  live.terminal.agentIdentity = "shell";
  await assert.rejects(service.continueSession(args), /只能继续.*Codex/); live.terminal.agentIdentity = "codex";
  const show = client.show.bind(client); client.show = async id => ({ terminal: { ...(await show(id)).terminal, incarnationId: "replaced" } });
  await assert.rejects(service.continueSession(args), /身份已变化/); client.show = show;
  const tool = { action: "session_continue", ...args };
  for (const text of ["能接着某个session继续吗？", "不要继续那个 Orca 会话", "假如让那个会话继续"]) {
    await assert.rejects(service.tool(tool, { text, messageId: "blocked" }), /没有明确要求/);
  }
  await assert.rejects(service.tool({ action: "start", instruction: "继续" }, { text: "请让 Orca 里那个 session 继续", messageId: "wrong-action" }), /没有新建会话/);
  assert.equal(service.list().length, 0); assert.equal(client.creates, 0); assert.equal(client.sends.length, 0);
});

test("ambiguous continuation remains tracked across restarts and never sends a duplicate prompt", async t => {
  const { dir, service, client } = await fixture(t); existingSessions(client); client.failSend = true;
  const args = { sessionId: "existing-2", instruction: "继续检查", requestKey: "uncertain-continuation" };
  const task = await service.continueSession(args); assert.equal(task.state, "uncertain");
  assert.equal(client.sends.length, 1); await service.close();
  const store = new Store(dir), resumed = new ComputerTasks(store, { client });
  onClose(t, async () => { await resumed.close(); store.close(); });
  const duplicate = await resumed.continueSession(args); assert.equal(duplicate.id, task.id);
  await resumed.refresh(task.id); assert.equal(client.sends.length, 1); assert.equal(client.creates, 0);
});

test("native Orca CLI passes prompts literally and strips inherited Orca identity", async () => {
  const prompt = 'literal `$(secret)` & echo bad\n中文 "quotes"';
  const old = process.env.ORCA_ENVIRONMENT; process.env.ORCA_ENVIRONMENT = "must-not-inherit";
  try {
    const client = new OrcaClient(() => ({ cliPath: "" }), { exec: async (file, args, options) => {
      assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
      assert.equal(options.env.ORCA_ENVIRONMENT, undefined); assert.equal(args[args.indexOf("--text") + 1], prompt);
      assert.equal(args.at(-1), "--json");
      return { stdout: JSON.stringify({ ok: true, result: { send: { accepted: true } } }) };
    } });
    assert.ok((await client.send("owned-handle", prompt)).send.accepted);
  } finally { if (old === undefined) delete process.env.ORCA_ENVIRONMENT; else process.env.ORCA_ENVIRONMENT = old; }
  const client = new OrcaClient(() => ({}), { exec: async () => { throw { stdout: '{"ok":false,"error":{"code":"timeout","message":"timeout"}}' }; } });
  assert.equal(await client.idle("owned"), false);
  assert.ok(startupReady("OpenAI Codex\n› Ask Codex to do anything"));
  assert.ok(!startupReady("Working (0s • esc to interrupt)\n› Ask Codex to do anything"));
});

test("task lifecycle survives sessions, deduplicates creation and followups, interrupts and closes only owned terminals", async t => {
  const { service, client, store } = await fixture(t);
  const session = store.session();
  const args = { instruction: "检查项目，不要修改文件", requestKey: "start-one", sessionId: session.id };
  const [first, duplicate] = await Promise.all([service.create(args), service.create(args)]);
  assert.equal(first.id, duplicate.id);
  let task = await service.refresh(first.id); assert.equal(task.state, "running");
  assert.equal(client.creates, 1); assert.equal(client.sends.length, 1);
  await assert.rejects(service.create({ ...args, instruction: "不同请求" }), /同一个请求编号/);
  store.db.prepare("DELETE FROM sessions WHERE id=?").run(session.id);
  assert.equal(service.get(task.id).state, "running", "deleting chat does not cancel background work");
  client.finish(task.terminal.handle, "analysis complete"); task = await service.refresh(task.id);
  assert.equal(task.state, "completed"); assert.match(task.output, /analysis complete/);
  await Promise.all([service.followup(task.id, { instruction: "继续补充建议", requestKey: "followup-one" }), service.followup(task.id, { instruction: "继续补充建议", requestKey: "followup-one" })]);
  task = await service.refresh(task.id); assert.equal(client.sends.length, 2); assert.equal(task.turns.length, 2); assert.equal(client.creates, 1);
  await Promise.all([service.stop(task.id), service.stop(task.id)]);
  task = await service.refresh(task.id); assert.equal(task.state, "interrupted"); assert.equal(client.interrupts, 1);
  task = await service.closeTask(task.id); assert.equal(task.state, "closed"); assert.equal(service.view(task).canFollowup, false);
});

test("a transient disconnect and server restart observe original work without resending", async t => {
  const { dir, store, service, client } = await fixture(t);
  let task = await service.create({ instruction: "运行任务", requestKey: "persistent" }); task = await service.refresh(task.id);
  client.transportDown = true; task = await service.refresh(task.id);
  assert.equal(task.state, "running"); assert.match(task.observationError, /offline/);
  client.transportDown = false;
  client.terminals.get(task.terminal.handle).terminal.connected = false;
  task = await service.refresh(task.id); assert.equal(task.state, "running"); assert.match(task.observationError, /尚未确认/);
  client.terminals.get(task.terminal.handle).terminal.connected = true;
  await service.close();
  const reopened = new Store(dir), resumed = new ComputerTasks(reopened, { client });
  onClose(t, async () => { await resumed.close(); reopened.close(); });
  assert.equal(resumed.config().enabled, true);
  client.transportDown = false; client.finish(task.terminal.handle, "finished while Douli was offline");
  task = await resumed.refresh(task.id); assert.equal(task.state, "completed"); assert.equal(task.observationError, "");
  assert.equal(client.sends.length, 1); assert.equal(client.creates, 1);
  assert.ok(!store.db.prepare("SELECT payload FROM computer_tasks WHERE id=?").get(task.id).payload.includes("运行任务"));
});

test("accepted-only sends use the same receipt; ambiguous writes are never automatically submitted twice", async t => {
  const { service, client } = await fixture(t);
  client.acceptOnly = true;
  let task = await service.create({ instruction: "执行检查", requestKey: "accepted" }); task = await service.refresh(task.id);
  assert.equal(task.state, "accepted"); assert.equal(client.sends.length, 1);
  client.acceptOnly = false; task = await service.refresh(task.id);
  assert.equal(task.state, "running"); assert.equal(client.sends.length, 1, "durable retry only observes existing send");
  client.failSend = true;
  let uncertain = await service.create({ instruction: "另一项检查", requestKey: "unknown" }); uncertain = await service.refresh(uncertain.id);
  assert.equal(uncertain.state, "uncertain"); const count = client.sends.length;
  await service.refresh(uncertain.id); await service.refresh(uncertain.id);
  assert.equal(client.sends.length, count);
});

test("changed process identity cannot receive followups or stop signals", async t => {
  const { service, client } = await fixture(t);
  let task = await service.create({ instruction: "检查", requestKey: "identity" }); task = await service.refresh(task.id);
  client.terminals.get(task.terminal.handle).terminal.incarnationId = "replacement-process";
  await assert.rejects(service.stop(task.id), /身份已变化/);
  await assert.rejects(service.closeTask(task.id), /身份已变化/);
  assert.equal(client.interrupts, 0);
  task = await service.refresh(task.id); assert.match(task.observationError, /身份已变化/);
});

test("startup waits for the actual prompt and stale handles rebind only the same process", async t => {
  const { service, client } = await fixture(t);
  const create = client.create.bind(client);
  client.create = async () => {
    const result = await create(); const t = client.terminals.get(result.terminal.handle);
    t.idle = false; t.output = "Please sign in to continue"; return result;
  };
  let task = await service.create({ instruction: "启动测试", requestKey: "startup" }); task = await service.refresh(task.id);
  assert.equal(task.state, "starting"); assert.equal(client.sends.length, 0); assert.equal(client.creates, 1);
  client.terminals.get(task.terminal.handle).output = "› Ask Codex to do anything";
  task = await service.refresh(task.id); assert.equal(task.state, "running"); assert.equal(client.sends.length, 1);
  const old = task.terminal.handle, live = client.terminals.get(old); client.terminals.delete(old);
  live.terminal.handle = "replacement-handle-same-process"; client.terminals.set(live.terminal.handle, live);
  task = await service.refresh(task.id);
  assert.equal(task.terminal.handle, live.terminal.handle); assert.equal(client.sends.length, 1); assert.equal(task.observationError, "");
});

test("a previous interrupted turn cannot falsely acknowledge a new stop", async t => {
  const { service, client } = await fixture(t);
  let task = await service.create({ instruction: "初次任务", requestKey: "old-stop" }); task = await service.refresh(task.id);
  await service.stop(task.id); task = await service.refresh(task.id); assert.equal(task.state, "interrupted");
  await service.followup(task.id, { instruction: "新的一轮", requestKey: "new-turn" }); task = await service.refresh(task.id);
  const live = client.terminals.get(task.terminal.handle);
  live.output = "■ Conversation interrupted\n› 新的一轮用户指令\n• Working (0s • esc to interrupt)";
  client.interrupt = async () => { live.output = live.output.replace("0s", "1s"); return { send: { accepted: true } }; };
  await service.stop(task.id); task = await service.refresh(task.id);
  assert.equal(task.state, "stopping", "old interrupted marker is not evidence for this turn");
});

test("local API rejects foreign origins, disabled writes, invalid prompts and arbitrary terminal ids", async t => {
  const dir = directory(t), client = new FixtureOrca();
  const app = await createApplication({ dataDir: dir, distDir: join(dir, "absent"), computerOptions: { client } });
  onClose(t, () => app.close());
  let response = await app.admin.inject({ method: "POST", url: "/api/computer/tasks", payload: { instruction: "hello", requestKey: "blocked" }, headers: { origin: "https://hostile.example" } });
  assert.equal(response.statusCode, 403);
  response = await app.admin.inject({ method: "POST", url: "/api/computer/tasks", payload: { instruction: "hello", requestKey: "blocked" } });
  assert.equal(response.statusCode, 400); assert.equal(client.creates, 0);
  await app.computer.configure({ enabled: true, defaultWorktree: "fixture-project" });
  response = await app.admin.inject({ method: "POST", url: "/api/computer/tasks", payload: { instruction: "\u001bquit", requestKey: "escape" } });
  assert.equal(response.statusCode, 400);
  response = await app.admin.inject({ method: "POST", url: "/api/computer/tasks/unowned-terminal/stop" });
  assert.equal(response.statusCode, 400); assert.equal(client.interrupts, 0);
  existingSessions(client);
  response = await app.admin.inject({ method: "GET", url: "/api/computer/sessions?project=ESP32" });
  assert.equal(response.statusCode, 200); assert.equal(response.json().count, 4);
  response = await app.admin.inject({ method: "GET", url: "/api/computer/sessions/existing-2?project=ESP32" });
  assert.equal(response.statusCode, 200); assert.equal(response.json().output, "会话 2 的画面");
  response = await app.admin.inject({ method: "GET", url: "/api/computer/sessions?project=ESP32", headers: { origin: "https://hostile.example" } });
  assert.equal(response.statusCode, 403);
  const continuation = { project: "ESP32", instruction: "继续检查，不要改文件", requestKey: "http-continuation" };
  response = await app.admin.inject({ method: "POST", url: "/api/computer/sessions/existing-2/continue", payload: continuation, headers: { origin: "https://hostile.example" } });
  assert.equal(response.statusCode, 403); assert.equal(client.sends.length, 0);
  response = await app.admin.inject({ method: "POST", url: "/api/computer/sessions/existing-2/continue", payload: continuation });
  assert.equal(response.statusCode, 200); const resumed = response.json(); assert.equal(resumed.origin, "existing_session");
  response = await app.admin.inject({ method: "POST", url: "/api/computer/sessions/existing-2/continue", payload: continuation });
  assert.equal(response.statusCode, 200); assert.equal(response.json().id, resumed.id); assert.equal(client.sends.length, 1);
  for (const text of ["不要让 Orca 改代码", "假如让 Orca 帮我工作", "翻译：让 Orca 帮我改代码"]) assert.equal(explicitComputerAction(text, "start"), false);
  assert.ok(explicitComputerAction("让 Orca 检查项目，不要改文件", "start"));
  assert.ok(!Object.keys(app.sync.replica.schema()).some(key => key.startsWith("computer_")), "computer permissions and handles never sync to another machine");
});

test("chat dispatch queries existing Orca sessions even when the model uses the old list action", async t => {
  const dir = directory(t), client = new FixtureOrca(); existingSessions(client);
  const mock = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks));
    const actions = body.tools.find(tool => tool.function.name === "computer_task").function.parameters.properties.action.enum;
    assert.ok(actions.includes("sessions") && actions.includes("session_read") && actions.includes("session_continue"));
    const delta = body.messages.at(-1).role === "tool" ? { content: "ESP32 项目当前有 4 个会话。" } : {
      tool_calls: [{ index: 0, id: "existing-call", type: "function", function: { name: "computer_task",
        arguments: JSON.stringify({ action: "list", project: "豆梨ESP三二" }) } }],
    };
    if (body.messages.at(-1).role === "tool") assert.equal(JSON.parse(body.messages.at(-1).content).count, 4);
    res.setHeader("Content-Type", "text/event-stream");
    res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
  });
  mock.listen(0, "127.0.0.1"); await once(mock, "listening");
  const app = await createApplication({ dataDir: dir, distDir: join(dir, "absent"), computerOptions: { client } });
  onClose(t, async () => { await app.close(); mock.closeAllConnections(); await new Promise(r => mock.close(r)); });
  app.store.saveSettings(mergeSettings(app.store.settings(), { models: { daily: { baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, model: "fixture" } },
    memory: { semantic: false, maintenance: false, autoSummaries: false } }));
  await app.computer.configure({ enabled: true, defaultWorktree: "fixture-project" });
  const result = await app.engine.run({ text: "呃，你看一下这个豆梨ESP三二这个，有现在有这个这个奥卡里面现在有多少个session啊？" });
  assert.equal(result.message.metadata.tools[0].result.scope, "orca_project_sessions");
  assert.equal(result.message.metadata.tools[0].result.count, 4);
  assert.equal(app.computer.list().length, 0); assert.equal(client.creates, 0); assert.equal(client.sends.length, 0);
  assert.ok(result.message.metadata.computerTask);
  assert.equal(app.store.db.prepare("SELECT count(*) AS n FROM memory_jobs").get().n, 0);
});

test("chat tool dispatch persists tasks across conversations and excludes task turns from personal memory", async t => {
  const dir = directory(t), client = new FixtureOrca(); let action = "start", target, requests = 0;
  const mock = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks)); requests++;
    res.setHeader("Content-Type", "text/event-stream");
    let delta;
    if (body.messages.at(-1).role === "tool") delta = { content: "电脑任务状态已查询。" };
    else {
      assert.ok(body.tools.some(tool => tool.function.name === "computer_task"));
      delta = { tool_calls: [0, 1].map(index => ({ index, id: `call-${index}`, type: "function", function: {
        name: "computer_task", arguments: JSON.stringify({ action, ...(action === "start" ? { instruction: "记住编号，检查代码，不要修改" } : { taskId: target }) }),
      } })) };
    }
    res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
  });
  mock.listen(0, "127.0.0.1"); await once(mock, "listening");
  const app = await createApplication({ dataDir: dir, distDir: join(dir, "absent"), computerOptions: { client } });
  onClose(t, async () => { await app.close(); mock.closeAllConnections(); await new Promise(r => mock.close(r)); });
  app.store.saveSettings(mergeSettings(app.store.settings(), { models: { daily: { baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, model: "fixture" } },
    memory: { semantic: false, maintenance: false, autoSummaries: false } }));
  await app.computer.configure({ enabled: true, defaultWorktree: "fixture-project" });
  const first = await app.engine.run({ text: "让 Orca 记住编号，检查代码，不要修改", route: "health" });
  const tasks = app.computer.list(); assert.equal(tasks.length, 1); target = tasks[0].id;
  assert.ok(first.message.metadata.computerTask); assert.ok(first.input.metadata.computerTask);
  assert.equal(app.store.db.prepare("SELECT count(*) AS n FROM memory_jobs").get().n, 0);
  let task = await app.computer.refresh(target); assert.equal(task.state, "running");
  app.engine.abort(first.session.id); assert.equal(app.computer.get(target).state, "running");
  client.finish(task.terminal.handle, "real fixture evidence"); action = "status";
  const second = await app.engine.run({ text: "刚才的电脑任务怎么样了" });
  assert.notEqual(first.session.id, second.session.id); assert.equal(second.message.metadata.tools[0].result.task.state, "completed");
  assert.equal(client.sends.length, 1); assert.ok(requests >= 4);
});
