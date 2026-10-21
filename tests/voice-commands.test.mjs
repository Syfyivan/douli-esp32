import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { WebSocket } from "ws";
import { Store } from "../server/store.mjs";
import { VoiceConnection } from "../server/gateway.mjs";
import { isFarewell } from "../server/voice-commands.mjs";
import { ChatEngine } from "../server/engine.mjs";
import { transcribe } from "../server/providers.mjs";
import { defaults } from "../server/config.mjs";

test("farewell accepts observed ASR aliases and natural word order only as complete commands", () => {
  for (const text of ["再见豆梨", "再见，都丽。", "再见，都离。", "再 见，都 离！", "晚安", "再见", "停止聊天",
    "豆梨，再见", "都离，拜拜", "再见啦，豆梨", "豆梨，晚安啦", "拜拜啦", "结束对话吧", "停止聊天了",
    "嗯，好的，再见豆梨。", "嗯嗯，好，那就再见啦，豆梨", "豆梨，好的，再见", "好，再见豆梨，谢谢",
    "那今天先聊到这里吧", "先不聊了", "好了，结束这次会话吧"])
    assert.equal(isFarewell(text), true, text);
  for (const text of ["不要说再见都丽", "再见都离是什么意思", "你刚才说再见都离了吗", "我跟都丽说了再见", "再见都离，先别结束", "再见张三", "你好都离",
    "豆梨，不要结束对话", "豆梨，再见之前还有个问题", "如果我说再见呢", "再见吗", "你说晚安", "‘再见，都离’", "都离", "豆梨豆梨再见",
    "嗯好的", "谢谢你", "嗯好的，再见是什么意思", "好，再见豆梨，不过先别结束", "我说了好的再见豆梨",
    "今天先聊到这里是什么意思", "把再见翻译成英文", "停止电脑任务", "那今天先聊到这里吗"])
    assert.equal(isFarewell(text), false, text);
});

test("farewell supports the configured assistant name without arbitrary name matching", () => {
  for (const text of ["小满，再见啦", "晚安，小满", "小满，停止聊天"])
    assert.equal(isFarewell(text, "小满"), true, text);
  assert.equal(isFarewell("再见小明", "小满"), false);
  assert.equal(isFarewell("小满是谁", "小满"), false);
  assert.equal(isFarewell("再见任意名字", ".*"), false);
});

test("ASR prompt prioritizes the assistant name and confirmed vocabulary even with long history", async t => {
  const settings = structuredClone(defaults);
  settings.assistant.name = "小满";
  const store = {
    settings: () => settings,
    all: table => table === "dictionary" ? [
      { replacement: "小满", status: "active" },
      { replacement: "树莓派", status: "active" },
      { replacement: "未确认词", status: "suggested" },
    ] : [{ name: "测试偏好", value: "长上下文".repeat(1000) }],
    messages: () => [],
  };
  const context = ChatEngine.prototype.context.call({ store });
  assert.equal(JSON.parse(context).vocabulary[0], "小满");
  assert.equal(JSON.parse(context).vocabulary.filter(w => w === "小满").length, 1);
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const prompt = options.body.get("prompt");
    assert.ok(prompt.includes("小满"));
    assert.ok(prompt.includes("你好豆梨"));
    assert.ok(prompt.includes("树莓派"));
    assert.ok(!prompt.includes("未确认词"));
    assert.ok(prompt.length <= 3000);
    return Response.json({ text: "再见，小满。" });
  });
  assert.equal(await transcribe({ baseUrl: "https://fixture.invalid/v1", model: "asr" }, Buffer.alloc(640), context), "再见，小满。");
});

test("observed farewell transcripts enter confirmed standby without asking the answer model", async () => {
  const directory = mkdtempSync(join(tmpdir(), "douli-farewell-alias-"));
  const store = new Store(directory);
  const sent = [];
  let modelCalls = 0;
  const socket = new EventEmitter();
  Object.assign(socket, {
    readyState: WebSocket.OPEN,
    send(value) {
      if (typeof value !== "string") return;
      const message = JSON.parse(value); sent.push(message);
      if (message.type === "session" && message.state === "standby")
        this.emit("message", Buffer.from('{"type":"session","state":"standby"}'), false);
    },
    close() { this.readyState = WebSocket.CLOSED; this.emit("close"); },
    ping() {},
  });
  let connection;
  try {
    const settings = store.settings(); settings.input.vad = "energy"; store.saveSettings(settings);
    store.db.prepare("INSERT INTO devices (id,name,approved,token,metadata) VALUES (?,?,1,?,?)")
      .run("farewell-alias-fixture", "Test speaker", "test-only", "{}");
    const device = store.db.prepare("SELECT * FROM devices WHERE id=?").get("farewell-alias-fixture");
    const gateway = { store, connections: new Map(), engine: { context: () => "", run: async () => { modelCalls++; return { farewell: false }; } } };
    connection = new VoiceConnection(gateway, socket, { device });
    connection.message({ type: "hello", version: 3, features: { persistent_connection: true }, audio_params: { format: "opus", channels: 1, sample_rate: 16000 } });
    connection.message({ type: "session", state: "standby" });
    for (const text of ["再见，都丽。", "再见，都离。", "都离，再见啦", "拜拜，豆梨", "嗯，好的，再见豆梨。", "那今天先聊到这里吧"]) {
      connection.message({ type: "listen", state: "start", mode: "auto" });
      await connection.process(null, text);
      assert.equal(modelCalls, 0, text);
      assert.equal(connection.standby, true, text);
      assert.equal(connection.standbyConfirmed, true, text);
      assert.equal(connection.state, "idle");
      assert.equal(socket.readyState, WebSocket.OPEN);
      assert.ok(sent.some(m => m.type === "session" && m.state === "standby" && m.reason === "farewell"));
      assert.ok(!sent.some(m => m.type === "tts" && m.state === "start"));
      const saved = store.messages(connection.session.id).at(-1);
      assert.equal(saved.text, text, "keep the actual transcript for correction and diagnosis");
      assert.equal(saved.metadata.voiceCommand, "farewell");
    }
    settings.assistant.name = "小满"; store.saveSettings(settings);
    connection.message({ type: "listen", state: "start", mode: "auto" });
    await connection.process(null, "小满，再见啦");
    assert.equal(modelCalls, 0);
    assert.equal(connection.standbyConfirmed, true);
  } finally {
    if (connection) socket.close();
    store.close();
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe cleanup");
    rmSync(directory, { recursive: true, force: true });
  }
});
