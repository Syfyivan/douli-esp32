import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once, EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { createApplication } from "../server/app.mjs";
import { mergeSettings } from "../server/config.mjs";
import { codec, packAudio, rms } from "../server/audio.mjs";
import { LiveTranscriber } from "../server/providers.mjs";
import { VoiceConnection } from "../server/gateway.mjs";

async function setup(t, options = {}) {
  let asrCalls = 0,
    speechCalls = 0;
  const received = [];
  const recordings = [];
  const mock = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    if (req.url === "/v1/audio/transcriptions") {
      asrCalls++;
      assert.ok(raw.includes(Buffer.from("RIFF")));
      const start = raw.indexOf(Buffer.from("RIFF"));
      recordings.push(
        raw.subarray(start, start + raw.readUInt32LE(start + 4) + 8),
      );
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ text: options.asrText ?? "今天我想聊一聊" }));
    } else if (req.url === "/v1/audio/speech") {
      speechCalls++;
      if (options.speechDelay) await delay(options.speechDelay);
      const samples = (options.speechMs || 200) * 16;
      const pcm = Buffer.alloc(samples * 2);
      for (let i = 0; i < samples; i++)
        pcm.writeInt16LE(Math.round(Math.sin(i / 5) * 4000), i * 2);
      res.end(pcm);
    } else if (req.url === "/v1/chat/completions") {
      const body = JSON.parse(raw.toString());
      received.push(body);
      if (!body.stream && body.messages[0]?.content.includes("健康信息助手"))
        return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ spoken: "我在这里，慢慢说就好。", explanation: "此处为协议测试，未核查医学资料。", nextSteps: [], questions: [], urgency: "uncertain", citations: [] }) } }] }));
      if (!body.stream)
        return res.end(
          JSON.stringify({
            choices: [{ message: { content: '{"facts":[]}' } }],
          }),
        );
      res.setHeader("Content-Type", "text/event-stream");
      if (body.messages.at(-1)?.role === "user" && body.messages.at(-1).content.includes("[history-tool-fixture]")) {
        res.end("data: " + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "history-call", type: "function", function: { name: "history_search", arguments: '{"query":"苏州"}' } }] } }] }) + "\n\ndata: [DONE]\n\n");
        return;
      }
      if (body.messages.at(-1)?.content?.includes("[stream-error-fixture]")) {
        res.write(
          'data: {"choices":[{"delta":{"content":"这是一段已开始生成的回答。"}}]}\n\n',
        );
        await delay(30);
        res.end(
          'data: {"error":{"message":"fixture upstream interrupted"}}\n\n',
        );
        return;
      }
      if (
        body.messages.at(-1)?.role === "user" &&
        body.messages.at(-1).content.includes("[repeat-tool-fixture]")
      ) {
        res.end(
          "data: " +
            JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [0, 1].map((index) => ({
                      index,
                      id: "call-" + index,
                      type: "function",
                      function: {
                        name: "home_action",
                        arguments: '{"id":"fixture-light"}',
                      },
                    })),
                  },
                },
              ],
            }) +
            "\n\ndata: [DONE]\n\n",
        );
        return;
      }
      for (const text of ["我在这里，", "慢慢说就好。"])
        res.write(
          "data: " +
            JSON.stringify({ choices: [{ delta: { content: text } }] }) +
            "\n\n",
        );
      res.end("data: [DONE]\n\n");
    } else if (req.url.startsWith("/api/states/")) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ state: "42.5" }));
    } else if (req.url.startsWith("/api/services/")) {
      res.setHeader("Content-Type", "application/json");
      res.end("[]");
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  mock.listen(0, "127.0.0.1");
  await once(mock, "listening");
  const dir = mkdtempSync(join(tmpdir(), "douli-integration-"));
  const app = await createApplication({
    dataDir: dir,
    distDir: join(dir, "no-dist"),
  });
  const baseUrl = `http://127.0.0.1:${mock.address().port}/v1`;
  const profile = { baseUrl, model: "fixture", pcmSampleRate: 16000 };
  app.store.saveSettings(
    mergeSettings(app.store.settings(), {
      models: { daily: profile, asr: profile, tts: profile },
      input: { vad: "energy", previewMs: 0, interruptionMode: "immediate" },
      privacy: { autoMemory: false },
    }),
  );
  await app.admin.listen({ port: 0, host: "127.0.0.1" });
  await app.device.listen({ port: 0, host: "127.0.0.1" });
  t.after(async () => {
    await app.close();
    mock.closeAllConnections();
    await new Promise((r) => mock.close(r));
    if (
      !resolve(dir).startsWith(
        resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/"),
      )
    )
      throw new Error("Unsafe cleanup");
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    app,
    mock,
    received,
    recordings,
    asrCalls: () => asrCalls,
    speechCalls: () => speechCalls,
  };
}
function observe(ws) {
  const messages = [],
    binary = [];
  let resolveWait;
  ws.on("message", (d, isBinary) => {
    (isBinary ? binary : messages).push(
      isBinary ? d : JSON.parse(d.toString()),
    );
    resolveWait?.();
  });
  return {
    messages,
    binary,
    wait: async (predicate) => {
      const deadline = Date.now() + 5000;
      while (!predicate(messages, binary)) {
        if (Date.now() > deadline)
          throw new Error(
            "WebSocket result timed out: " + JSON.stringify(messages),
          );
        await new Promise((r) => {
          resolveWait = r;
          setTimeout(r, 30);
        });
      }
    },
  };
}
test("API secrets, origin checks, streaming chat and source-linked memory CRUD", async (t) => {
  const { app, received } = await setup(t);
  const bad = await app.admin.inject({
    url: "/api/state",
    headers: { origin: "https://evil.example", host: "localhost" },
  });
  assert.equal(bad.statusCode, 403);
  const saved = await app.admin.inject({
    method: "PUT",
    url: "/api/settings",
    payload: { models: { daily: { apiKey: "fixture-secret" } } },
  });
  assert.equal(saved.json().models.daily.hasKey, true);
  assert.ok(!saved.body.includes("fixture-secret"));
  await app.admin.inject({
    method: "PUT",
    url: "/api/preferences",
    payload: { name: "称呼", value: "阿豆" },
  });
  const r = await app.admin.inject({
    method: "POST",
    url: "/api/chat",
    payload: { text: "你好" },
  });
  const events = r.body.trim().split("\n").map(JSON.parse);
  assert.equal(events.at(-1).type, "done");
  assert.equal(events.at(-1).message.text, "我在这里，慢慢说就好。");
  assert.ok(received[0].messages[0].content.includes("阿豆"));
  const user = events.find((e) => e.type === "user").message;
  const m = await app.admin.inject({
    method: "PUT",
    url: "/api/memories",
    payload: { name: "测试来源", value: "只是测试", sourceId: user.id },
  });
  const source = await app.admin.inject(
    "/api/memories/" + m.json().id + "/source",
  );
  assert.equal(source.json().text, "你好");
  await app.admin.inject({
    method: "DELETE",
    url: "/api/sessions/" + user.session_id,
  });
  assert.equal(app.store.messages(user.session_id).length, 0);
  assert.equal(app.store.all("memories").length, 0);
});
test("approved ESP32 handshake → Opus ASR → chat → playable Opus; reconnect retains session", async (t) => {
  const { app, asrCalls, speechCalls } = await setup(t);
  const id = "aa:bb:cc:dd:ee:01";
  const headers = { "device-id": id, host: "127.0.0.1" };
  app.gateway.pair();
  app.gateway.ota({ headers, body: {} }, 8789);
  app.store.db.prepare("UPDATE devices SET approved=1 WHERE id=?").run(id);
  const token = app.store.db
    .prepare("SELECT token FROM devices WHERE id=?")
    .get(id).token;
  const port = app.device.server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/xiaozhi/v1/`, {
    headers: { "Device-Id": id, Authorization: `Bearer ${token}` },
  });
  const out = observe(ws);
  await once(ws, "open");
  ws.send(
    JSON.stringify({
      type: "hello",
      version: 3,
      audio_params: { format: "opus", channels: 1, sample_rate: 16000 },
    }),
  );
  await out.wait((m) => m.some((e) => e.type === "hello"));
  const sid = out.messages.find((e) => e.type === "hello").session_id;
  ws.send(JSON.stringify({ type: "listen", state: "start", mode: "manual" }));
  const c = codec();
  const pcm = Buffer.alloc(640);
  for (let i = 0; i < 320; i++)
    pcm.writeInt16LE(Math.round(Math.sin(i / 4) * 12000), i * 2);
  for (let i = 0; i < 15; i++)
    ws.send(packAudio(Buffer.from(c.encode(pcm, 320)), 3));
  c.delete();
  ws.send(JSON.stringify({ type: "listen", state: "stop" }));
  await out.wait(
    (m, b) =>
      b.length > 0 &&
      m.filter((e) => e.type === "tts" && e.state === "stop" && !e.interrupted)
        .length > 0,
  );
  assert.equal(asrCalls(), 1);
  assert.ok(speechCalls() > 0);
  assert.ok(out.messages.some((e) => e.type === "stt"));
  ws.close();
  await once(ws, "close");
  const again = new WebSocket(`ws://127.0.0.1:${port}/xiaozhi/v1/`, {
    headers: { "Device-Id": id, Authorization: `Bearer ${token}` },
  });
  const out2 = observe(again);
  await once(again, "open");
  again.send(
    JSON.stringify({
      type: "hello",
      version: 1,
      audio_params: { format: "opus", channels: 1, sample_rate: 16000 },
    }),
  );
  await out2.wait((m) => m.some((e) => e.type === "hello"));
  assert.equal(out2.messages[0].session_id, sid);
  again.close();
  await once(again, "close");
});
test("unapproved device and cross-site browser WebSockets are rejected", async (t) => {
  const { app } = await setup(t);
  for (const [port, path, headers, expected] of [
    [app.device.server.address().port, "/xiaozhi/v1/", {}, 401],
    [
      app.admin.server.address().port,
      "/api/voice",
      { Origin: "https://evil.example" },
      403,
    ],
  ]) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    const result = await new Promise((resolve) => {
      ws.on("unexpected-response", (req, res) => {
        resolve(res.statusCode);
        req.destroy();
      });
      ws.on("error", () => {});
    });
    assert.equal(result, expected);
  }
});
test("streaming failure launches one HTTP fallback and ignores unrelated final IDs", async (t) => {
  const { app, asrCalls } = await setup(t);
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  server.on("connection", (ws) => {
    ws.on("message", (raw, binary) => {
      if (binary) return;
      const m = JSON.parse(raw.toString());
      if (m.type === "stop") {
        ws.send(
          JSON.stringify({
            type: "final",
            id: "wrong-request",
            text: "should not use",
          }),
        );
        ws.send(JSON.stringify({ type: "error", id: m.id }));
      }
    });
  });
  const settings = mergeSettings(app.store.settings(), {
    input: {
      streamingUrl: `ws://127.0.0.1:${server.address().port}`,
      finalTimeoutMs: 100,
    },
  });
  const live = new LiveTranscriber(settings, "test");
  await once(live.socket, "open");
  live.push(Buffer.alloc(6400));
  assert.equal(await live.finish(AbortSignal.timeout(3000)), "今天我想聊一聊");
  assert.equal(asrCalls(), 1);
  for (const ws of server.clients) ws.terminate();
  await new Promise((r) => server.close(r));
});
test("browser voice interruption cancels old speech and resumes another turn", async (t) => {
  const { app } = await setup(t);
  const port = app.admin.server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/voice`, {
    headers: { Origin: "http://127.0.0.1:8788" },
  });
  const out = observe(ws);
  await once(ws, "open");
  ws.send(
    JSON.stringify({
      type: "hello",
      version: 1,
      audio_params: { format: "pcm", channels: 1, sample_rate: 16000 },
    }),
  );
  await out.wait((m) => m.some((e) => e.type === "hello"));
  ws.send(JSON.stringify({ type: "text", text: "请说一句话" }));
  await out.wait((m, b) => b.length > 0);
  ws.send(JSON.stringify({ type: "abort" }));
  await out.wait((m) => m.some((e) => e.type === "tts" && e.interrupted));
  const count = out.binary.length;
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(out.binary.length, count);
  ws.send(JSON.stringify({ type: "text", text: "换一个话题" }));
  await out.wait((m) => m.filter((e) => e.type === "done").length >= 2);
  ws.close();
  await once(ws, "close");
});
test("Home Assistant sensor reads are authenticated and action state is verified separately", async (t) => {
  const { app, mock } = await setup(t);
  const baseUrl = `http://127.0.0.1:${mock.address().port}`;
  const created = await app.admin.inject({
    method: "PUT",
    url: "/api/sensors",
    payload: {
      name: "照度",
      unit: "lux",
      source: { baseUrl, entityId: "sensor.test", token: "test-ha-token" },
    },
  });
  assert.equal(created.statusCode, 200);
  await app.home.pollSensors();
  assert.equal(app.store.all("sensors")[0].value, 42.5);
  const action = await app.admin.inject({
    method: "PUT",
    url: "/api/actions",
    payload: {
      name: "测试读取确认",
      config: {
        type: "homeassistant",
        baseUrl,
        entityId: "light.test",
        service: "light.turn_on",
        token: "test-ha-token",
        expectedState: "on",
      },
    },
  });
  const result = await app.home.execute(action.json().id);
  assert.equal(result.acknowledged, true);
  assert.equal(result.verified, false);
  assert.equal(result.actualState, "42.5");
  const preview = await app.admin.inject({
    method: "POST",
    url: "/api/models/voice-preview",
    payload: { text: "测试声音" },
  });
  assert.equal(preview.rawPayload.subarray(0, 4).toString(), "RIFF");
});
test("OTA activation poll waits for approval and supports real firmware GET/POST forms", async (t) => {
  const { app } = await setup(t);
  const headers = {
    "device-id": "aa:bb:cc:77:88:99",
    "client-id": "fixture-client",
  };
  app.gateway.pair();
  const first = await app.device.inject({
    method: "POST",
    url: "/xiaozhi/ota/",
    headers,
    payload: { application: { version: "2.0.0" } },
  });
  assert.ok(first.json().activation.challenge);
  assert.match(first.json().activation.code, /^\d{6}$/);
  const poll = () =>
    app.device.inject({
      method: "POST",
      url: "/xiaozhi/ota/activate",
      headers,
      payload: {},
    });
  const pending = await poll();
  assert.equal(pending.statusCode, 202);
  assert.equal(pending.body, "");
  assert.equal(pending.headers["content-length"], "0");
  await app.admin.inject({
    method: "PUT",
    url: "/api/devices/" + headers["device-id"],
    payload: { approved: true },
  });
  const activated = await poll();
  assert.equal(activated.statusCode, 200);
  assert.equal(activated.body, "");
  assert.equal(activated.headers.connection, "close");
  assert.equal(activated.headers["content-length"], "0");
  const config = await app.device.inject({ url: "/xiaozhi/ota", headers });
  assert.equal(config.statusCode, 200);
  assert.ok(config.json().websocket.token);
  assert.equal(config.json().activation, undefined);
  const upgraded = await app.device.inject({
    method: "POST",
    url: "/xiaozhi/ota/",
    headers,
    payload: { application: { version: "2.5.2" } },
  });
  assert.equal(upgraded.json().firmware.version, "2.5.2");
  assert.equal(app.gateway.devices()[0].firmware, "2.5.2");
  const versionless = await app.device.inject({
    url: "/xiaozhi/ota/",
    headers,
  });
  assert.equal(versionless.json().firmware.version, "2.5.2");
  assert.equal(app.gateway.devices()[0].firmware, "2.5.2");
  assert.equal(
    (
      await app.device.inject({
        method: "POST",
        url: "/xiaozhi/ota/activate",
        headers: { ...headers, "client-id": "another-client" },
        payload: {},
      })
    ).statusCode,
    202,
  );
});
test("long waiting silence is excluded from ASR and recording retains the utterance onset", async (t) => {
  const { app, recordings, asrCalls } = await setup(t);
  const ws = new WebSocket(
    `ws://127.0.0.1:${app.admin.server.address().port}/api/voice`,
    { headers: { Origin: "http://127.0.0.1:8788" } },
  );
  const out = observe(ws);
  await once(ws, "open");
  ws.send(
    JSON.stringify({
      type: "hello",
      version: 1,
      audio_params: { format: "pcm", sample_rate: 16000, channels: 1 },
    }),
  );
  await out.wait((m) => m.some((e) => e.type === "hello"));
  ws.send(JSON.stringify({ type: "listen", state: "start", mode: "manual" }));
  for (let i = 0; i < 1000; i++) ws.send(Buffer.alloc(640)); // 20 seconds of waiting
  ws.send(JSON.stringify({ type: "ping" }));
  await out.wait((m) => m.some((e) => e.type === "pong"));
  assert.equal(asrCalls(), 0);
  const speech = Buffer.alloc(640, 0);
  for (let i = 0; i < 320; i++)
    speech.writeInt16LE(Math.round(Math.sin(i / 6) * 8000), i * 2);
  for (let i = 0; i < 10; i++) ws.send(speech);
  ws.send(JSON.stringify({ type: "listen", state: "stop" }));
  await out.wait((m) => m.some((e) => e.type === "stt"));
  assert.ok(
    recordings[0].length < 16000,
    "ASR upload should contain less than half a second, not 20 seconds of silence",
  );
  assert.ok(recordings[0].includes(speech));
  ws.close();
  await once(ws, "close");
});
test("fast utterance ending before the streaming handshake still sends stop and avoids fallback", async (t) => {
  const { app, asrCalls } = await setup(t);
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  server.on("connection", (ws) =>
    ws.on("message", (raw, binary) => {
      if (binary) return;
      const m = JSON.parse(raw.toString());
      if (m.type === "stop")
        ws.send(
          JSON.stringify({ type: "final", id: m.id, text: "短句也收到了" }),
        );
    }),
  );
  const s = mergeSettings(app.store.settings(), {
    input: {
      streamingUrl: `ws://127.0.0.1:${server.address().port}`,
      finalTimeoutMs: 500,
    },
  });
  const live = new LiveTranscriber(s, "");
  live.push(Buffer.alloc(6400));
  assert.equal(await live.finish(AbortSignal.timeout(2000)), "短句也收到了");
  assert.equal(asrCalls(), 0);
  for (const ws of server.clients) ws.terminate();
  await new Promise((r) => server.close(r));
});
test("a stale voice connection only cancels its own generation", async (t) => {
  const { app } = await setup(t);
  const socket = new EventEmitter();
  Object.assign(socket, { readyState: WebSocket.OPEN, send() {}, ping() {} });
  const connection = new VoiceConnection(app.gateway, socket, {
    browser: true,
  });
  const replacement = new AbortController();
  app.engine.active.set(connection.session.id, replacement);
  connection.controller = new AbortController();
  connection.abort();
  assert.equal(connection.controller.signal.aborted, true);
  assert.equal(replacement.signal.aborted, false);
  socket.readyState = WebSocket.CLOSED;
  socket.emit("close");
  app.engine.active.delete(connection.session.id);
});
test("device tool discovery follows pagination before allowing a tool call", async (t) => {
  const { app } = await setup(t);
  const id = "aa:bb:cc:12:34:56";
  app.gateway.pair();
  app.gateway.ota({ headers: { "device-id": id }, body: {} }, 8789);
  app.store.db.prepare("UPDATE devices SET approved=1 WHERE id=?").run(id);
  const token = app.store.db
    .prepare("SELECT token FROM devices WHERE id=?")
    .get(id).token;
  const ws = new WebSocket(
    `ws://127.0.0.1:${app.device.server.address().port}/xiaozhi/v1/`,
    { headers: { "Device-Id": id, Authorization: "Bearer " + token } },
  );
  const out = observe(ws);
  const pages = [];
  ws.on("message", (raw, binary) => {
    if (binary) return;
    const m = JSON.parse(raw.toString());
    const p = m.payload;
    if (m.type !== "mcp" || !p?.id) return;
    let result = {};
    if (p.method === "tools/list") {
      pages.push(p.params.cursor || "first");
      result = p.params.cursor
        ? { tools: [{ name: "light.off", inputSchema: { type: "object" } }] }
        : {
            tools: [{ name: "light.on", inputSchema: { type: "object" } }],
            nextCursor: "second",
          };
    }
    if (p.method === "tools/call")
      result = { content: [{ type: "text", text: "acknowledged" }] };
    ws.send(
      JSON.stringify({
        type: "mcp",
        payload: { jsonrpc: "2.0", id: p.id, result },
      }),
    );
  });
  await once(ws, "open");
  ws.send(
    JSON.stringify({
      type: "hello",
      version: 1,
      features: { mcp: true },
      audio_params: { format: "opus", sample_rate: 16000, channels: 1 },
    }),
  );
  await out.wait(() => app.gateway.connections.get(id)?.tools.length === 2);
  assert.deepEqual(pages, ["first", "second"]);
  assert.equal(
    (await app.gateway.call(id, "light.off", {})).acknowledged,
    true,
  );
  await assert.rejects(app.gateway.call(id, "undeclared", {}));
  ws.close();
  await once(ws, "close");
});
test("repeated tool calls in one voice request actuate a switch only once", async (t) => {
  const { app } = await setup(t);
  let count = 0;
  app.store.db
    .prepare("INSERT INTO actions VALUES (?,?,?,?)")
    .run(
      "fixture-light",
      "关灯",
      app.store.seal({ type: "http", url: "http://localhost/off" }),
      new Date().toISOString(),
    );
  app.home.execute = async () => {
    count++;
    return { acknowledged: true, verified: false };
  };
  const response = await app.admin.inject({
    method: "POST",
    url: "/api/chat",
    payload: { text: "帮我关灯 [repeat-tool-fixture]" },
  });
  const events = response.body.trim().split("\n").map(JSON.parse);
  assert.equal(events.at(-1).type, "done");
  assert.equal(count, 1);
  assert.equal(events.at(-1).message.metadata.tools.length, 2);
});

async function browserVoice(app) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${app.admin.server.address().port}/api/voice`,
    {
      headers: { Origin: "http://127.0.0.1:8788" },
    },
  );
  const out = observe(ws);
  await once(ws, "open");
  ws.send(
    JSON.stringify({
      type: "hello",
      version: 1,
      audio_params: { format: "pcm", sample_rate: 16000, channels: 1 },
    }),
  );
  await out.wait((m) => m.some((e) => e.type === "hello"));
  return { ws, out };
}

test("upstream failure cancels pending speech before listening resumes and another turn works", async (t) => {
  const { app, speechCalls } = await setup(t, { speechDelay: 100 });
  const { ws, out } = await browserVoice(app);
  ws.send(
    JSON.stringify({ type: "text", text: "你好 [stream-error-fixture]" }),
  );
  await out.wait((m) =>
    m.some((e) => e.type === "tts" && e.state === "stop" && e.interrupted),
  );
  await delay(200);
  assert.equal(speechCalls(), 1);
  assert.equal(
    out.binary.length,
    0,
    "failed turn must not play delayed synthesis",
  );
  ws.send(JSON.stringify({ type: "text", text: "我们继续聊吧" }));
  await out.wait(
    (m, b) =>
      b.length &&
      m.some((e) => e.type === "tts" && e.state === "stop" && !e.interrupted),
  );
  assert.ok(out.messages.some((e) => e.type === "done"));
  ws.close();
  await once(ws, "close");
});

test("empty recognition completes the waiting state without inventing a chat turn", async (t) => {
  const { app, asrCalls, received } = await setup(t, { asrText: "" });
  const { ws, out } = await browserVoice(app);
  ws.send(JSON.stringify({ type: "listen", state: "start", mode: "manual" }));
  const frame = Buffer.alloc(640);
  for (let i = 0; i < 320; i++) frame.writeInt16LE(6000, i * 2);
  for (let i = 0; i < 10; i++) ws.send(frame);
  ws.send(JSON.stringify({ type: "listen", state: "stop" }));
  await out.wait((m) =>
    m.some((e) => e.type === "tts" && e.state === "stop" && !e.interrupted),
  );
  assert.equal(asrCalls(), 1);
  assert.equal(received.length, 0);
  assert.ok(!out.messages.some((e) => e.type === "done"));
  ws.close();
  await once(ws, "close");
});

test("farewell commands close browser voice after ASR without refinement, chat or TTS", async (t) => {
  const options = {};
  const { app, asrCalls, received, speechCalls } = await setup(t, options);
  const settings = app.store.settings();
  app.store.saveSettings(mergeSettings(settings, {
    input: { refine: true },
    models: { refine: settings.models.daily },
  }));
  const phrases = ["晚安", "再见", "拜拜", "结束对话", "停止聊天", "再见豆梨", " 再见，豆梨！ ", "再见 豆梨。",
    "再见，都离。", "都离，再见啦", "拜拜，豆梨"];
  for (const text of phrases) {
    options.asrText = text;
    const { ws, out } = await browserVoice(app);
    t.after(() => ws.terminate());
    const closed = once(ws, "close", { signal: AbortSignal.timeout(5000) });
    ws.send(JSON.stringify({ type: "listen", state: "start", mode: "manual" }));
    const frame = Buffer.alloc(640);
    for (let i = 0; i < 320; i++) frame.writeInt16LE(6000, i * 2);
    for (let i = 0; i < 10; i++) ws.send(frame);
    ws.send(JSON.stringify({ type: "listen", state: "stop" }));
    await closed;
    assert.ok(out.messages.some(e => e.type === "stt" && e.text === text));
    assert.ok(out.messages.some(e => e.type === "farewell"));
    assert.ok(out.messages.some(e => e.type === "tts" && e.state === "stop" && e.interrupted));
    assert.ok(!out.messages.some(e => e.type === "tts" && e.state === "start"));
    assert.equal(out.binary.length, 0);
    const sessionId = out.messages.find(e => e.type === "hello").session_id;
    const messages = app.store.messages(sessionId);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, text);
    assert.equal(messages[0].metadata.voiceCommand, "farewell");
  }
  assert.equal(asrCalls(), phrases.length);
  assert.equal(received.length, 0, "farewells must bypass all language-model requests");
  assert.equal(speechCalls(), 0);
});

test("ESP32 farewell closes the Opus session without a reply and permits reconnect", async (t) => {
  const { app, asrCalls, received, speechCalls } = await setup(t, { asrText: "再见，豆梨。" });
  const id = "aa:bb:cc:dd:ee:02";
  app.gateway.pair();
  app.gateway.ota({ headers: { "device-id": id, host: "127.0.0.1" }, body: {} }, 8789);
  app.store.db.prepare("UPDATE devices SET approved=1 WHERE id=?").run(id);
  const { token } = app.store.db.prepare("SELECT token FROM devices WHERE id=?").get(id);
  const open = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${app.device.server.address().port}/xiaozhi/v1/`, {
      headers: { "Device-Id": id, Authorization: `Bearer ${token}` },
    });
    t.after(() => ws.terminate());
    const out = observe(ws);
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "hello", version: 3,
      audio_params: { format: "opus", channels: 1, sample_rate: 16000 } }));
    await out.wait(m => m.some(e => e.type === "hello"));
    return { ws, out };
  };
  const { ws, out } = await open();
  await app.gateway.warmGreeting();
  const closed = once(ws, "close", { signal: AbortSignal.timeout(5000) });
  ws.send(JSON.stringify({ type: "listen", state: "start", mode: "manual" }));
  const encoder = codec();
  const pcm = Buffer.alloc(640);
  for (let i = 0; i < 320; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 4) * 12000), i * 2);
  for (let i = 0; i < 15; i++) ws.send(packAudio(Buffer.from(encoder.encode(pcm, 320)), 3));
  encoder.delete();
  ws.send(JSON.stringify({ type: "listen", state: "stop" }));
  await closed;
  const transcript = out.messages.findIndex(e => e.type === "stt");
  assert.ok(transcript >= 0);
  assert.ok(out.messages.slice(transcript + 1).some(e => e.type === "tts" && e.state === "stop" && e.interrupted));
  assert.equal(asrCalls(), 1);
  assert.equal(received.length, 0);
  assert.equal(speechCalls(), 1, "only the silent greeting prewarm may use TTS");
  assert.equal(out.binary.length, 0);
  const again = await open();
  assert.notEqual(again.out.messages[0].session_id, out.messages[0].session_id);
  assert.equal(app.store.sessions().length, 1, "reconnecting in silence creates no empty session");
  const disconnected = once(again.ws, "close");
  again.ws.close();
  await disconnected;
});

test("persistent ESP32 negotiates standby and reuses its socket after farewell", async (t) => {
  const options = { asrText: "再见豆梨" };
  const { app, asrCalls, received, speechCalls } = await setup(t, options);
  const id = "aa:bb:cc:dd:ee:03";
  app.gateway.pair();
  app.gateway.ota({ headers: { "device-id": id, host: "127.0.0.1" }, body: {} }, 8789);
  app.store.db.prepare("UPDATE devices SET approved=1 WHERE id=?").run(id);
  const { token } = app.store.db.prepare("SELECT token FROM devices WHERE id=?").get(id);
  const ws = new WebSocket(`ws://127.0.0.1:${app.device.server.address().port}/xiaozhi/v1/`, {
    headers: { "Device-Id": id, Authorization: `Bearer ${token}` },
  });
  t.after(() => ws.terminate());
  const out = observe(ws);
  const send = value => ws.send(JSON.stringify(value));
  await once(ws, "open");
  send({ type: "hello", version: 3, features: { persistent_connection: true },
    audio_params: { format: "opus", channels: 1, sample_rate: 16000 } });
  await out.wait(m => m.some(e => e.type === "hello"));
  const hello = out.messages.find(e => e.type === "hello");
  assert.equal(hello.features.persistent_connection, true);
  await app.gateway.warmGreeting();
  send({ type: "session", state: "standby" });
  await out.wait(() => app.gateway.devices()[0].connection.standbyConfirmed);
  const standbyRequest = await app.admin.inject({ method: "POST", url: `/api/devices/${id}/standby` });
  assert.deepEqual(standbyRequest.json(), { ok: true, requested: true });
  await out.wait(m => m.some(e => e.type === "session" && e.reason === "manual"));
  assert.equal(app.gateway.devices()[0].connection.standbyConfirmed, false);
  send({ type: "session", state: "standby" });
  const encoder = codec();
  t.after(() => encoder.delete());
  const speak = () => {
    send({ type: "listen", state: "start", mode: "manual" });
    const pcm = Buffer.alloc(640);
    for (let i = 0; i < 320; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 4) * 12000), i * 2);
    for (let i = 0; i < 15; i++) ws.send(packAudio(Buffer.from(encoder.encode(pcm, 320)), 3));
    send({ type: "listen", state: "stop" });
  };
  speak();
  await out.wait(m => m.some(e => e.type === "session" && e.reason === "farewell"));
  assert.equal(ws.readyState, WebSocket.OPEN);
  assert.equal(asrCalls(), 1);
  assert.equal(received.length, 0);
  assert.equal(speechCalls(), 1, "farewell must not synthesize a reply after prewarming");
  assert.equal(out.binary.length, 0);
  send({ type: "session", state: "standby" });
  await out.wait(() => app.gateway.devices()[0].connection.standbyConfirmed);
  options.asrText = "今天聊一聊";
  speak();
  await out.wait((m, b) => b.length > 0 && m.some(e => e.type === "tts" && e.state === "stop" && !e.interrupted));
  assert.equal(ws.readyState, WebSocket.OPEN);
  assert.equal(asrCalls(), 2);
  assert.equal(out.messages.filter(e => e.type === "hello").length, 1);
  const transcripts = out.messages.filter(e => e.type === "stt");
  assert.notEqual(transcripts[0].session_id, hello.session_id, "manual standby ends the initial wake");
  assert.notEqual(transcripts[1].session_id, transcripts[0].session_id, "farewell ends the first spoken conversation");
  assert.deepEqual(app.store.messages(transcripts[0].session_id).map(m => m.text), ["再见豆梨"]);
  assert.deepEqual(app.store.messages(transcripts[1].session_id).map(m => m.role), ["user", "assistant"]);
  assert.equal(app.store.sessions().length, 2);
  assert.ok(!received.at(-1).messages.some(m => m.role === "user" && m.content === "再见豆梨"), "new sessions do not carry the previous chat history");
  const disconnected = once(ws, "close");
  ws.close();
  await disconnected;
});

test("farewell cancels pending speech without waiting for its synthesis", async (t) => {
  const { app, received, speechCalls } = await setup(t, { speechDelay: 300 });
  const { ws, out } = await browserVoice(app);
  t.after(() => ws.terminate());
  ws.send(JSON.stringify({ type: "text", text: "你好" }));
  // Cancel while synthesis is pending; tts/start now waits for prepared audio.
  await out.wait(() => speechCalls() > 0);
  const requests = received.length;
  const closed = once(ws, "close", { signal: AbortSignal.timeout(5000) });
  ws.send(JSON.stringify({ type: "text", text: "再见，都离。" }));
  await closed;
  assert.ok(out.messages.some(e => e.type === "farewell"));
  await delay(350);
  assert.equal(out.binary.length, 0, "cancelled audio must never be sent");
  assert.equal(received.length, requests, "the farewell must not start another model request");
});

test("mentioning or negating a farewell keeps normal voice conversation open", async (t) => {
  const { app } = await setup(t);
  const { ws, out } = await browserVoice(app);
  t.after(() => ws.terminate());
  let turns = 0;
  for (const text of ["再见豆梨是什么意思？", "不要结束对话", "再见豆梨，我还有个问题"]) {
    ws.send(JSON.stringify({ type: "text", text }));
    turns++;
    await out.wait(m => m.filter(e => e.type === "tts" && e.state === "stop" && !e.interrupted).length === turns);
    assert.equal(ws.readyState, WebSocket.OPEN);
    assert.ok(!out.messages.some(e => e.type === "farewell"));
  }
  assert.equal(out.messages.filter(e => e.type === "done").length, turns);
  const closed = once(ws, "close");
  ws.close();
  await closed;
});

test("per-device settings survive reconnect and control recognition, route and output gain", async (t) => {
  const { app, asrCalls, received } = await setup(t);
  const settings = app.store.settings();
  settings.models.health = {
    ...settings.models.daily,
    model: "fixture-health",
  };
  app.store.saveSettings(settings);
  const id = "aa:bb:cc:66:55:44";
  app.gateway.pair();
  app.gateway.ota({ headers: { "device-id": id }, body: {} }, 8789);
  const config = { route: "health", volume: 0, rmsThreshold: 0.2 };
  const saved = await app.admin.inject({
    method: "PUT",
    url: "/api/devices/" + id,
    payload: { approved: true, config },
  });
  assert.equal(saved.statusCode, 200);
  const invalid = await app.admin.inject({
    method: "PUT",
    url: "/api/devices/" + id,
    payload: { config: { volume: -1 } },
  });
  assert.equal(invalid.statusCode, 400);
  const device = app.store.all("devices").find((d) => d.id === id);
  const connect = async () => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${app.device.server.address().port}/xiaozhi/v1/`,
      { headers: { "Device-Id": id, Authorization: `Bearer ${device.token}` } },
    );
    const out = observe(ws);
    await once(ws, "open");
    ws.send(
      JSON.stringify({
        type: "hello",
        version: 1,
        audio_params: { format: "opus", sample_rate: 16000, channels: 1 },
      }),
    );
    await out.wait((m) => m.some((e) => e.type === "hello"));
    return { ws, out };
  };
  const { ws, out } = await connect();
  const enc = codec(),
    dec = codec();
  t.after(() => {
    enc.delete();
    dec.delete();
  });
  const sendUtterance = (amplitude) => {
    ws.send(JSON.stringify({ type: "listen", state: "start", mode: "manual" }));
    const pcm = Buffer.alloc(640);
    for (let i = 0; i < 320; i++)
      pcm.writeInt16LE(Math.round(Math.sin(i / 4) * amplitude), i * 2);
    for (let i = 0; i < 15; i++) ws.send(Buffer.from(enc.encode(pcm, 320)));
    ws.send(JSON.stringify({ type: "listen", state: "stop" }));
  };
  sendUtterance(2000);
  await out.wait((m) =>
    m.some((e) => e.type === "tts" && e.state === "stop" && !e.interrupted),
  );
  assert.equal(
    asrCalls(),
    0,
    "quiet sound below device threshold must not trigger ASR",
  );
  sendUtterance(18000);
  await out.wait(
    (m, b) =>
      b.length &&
      m.filter((e) => e.type === "tts" && e.state === "stop" && !e.interrupted)
        .length === 2,
  );
  assert.equal(asrCalls(), 1);
  assert.ok(received.some(call => call.model === "fixture-health" && call.messages[0]?.content?.includes("健康信息助手")));
  const decoded = Buffer.concat(
    out.binary.map((b) => Buffer.from(dec.decode(b))),
  );
  assert.ok(rms(decoded) < 0.0002, "zero device volume must produce silence");
  const sessionId = out.messages[0].session_id;
  ws.close();
  await once(ws, "close");
  const second = await connect();
  assert.equal(second.out.messages[0].session_id, sessionId);
  const state = (await app.admin.inject({ url: "/api/state" })).json();
  assert.deepEqual(state.devices.find((d) => d.id === id).config, config);
  second.ws.close();
  await once(second.ws, "close");
});


test("memory operations travel through ASR, confirmation, storage and spoken playback", async (t) => {
  const options = { asrText: "记住，我不吃香菜" };
  const { app, asrCalls, speechCalls } = await setup(t, options);
  app.engine.memoryDialogue.extract = async (_store, message) => [{ name: "饮食偏好", value: "不吃香菜", predicate: "food:香菜", quote: message.text, sourceId: message.id }];
  const ws = new WebSocket(`ws://127.0.0.1:${app.admin.server.address().port}/api/voice?route=daily`, { headers: { Origin: "http://127.0.0.1:8788" } });
  const out = observe(ws);
  await once(ws, "open");
  ws.send(JSON.stringify({ type: "hello", version: 1, audio_params: { format: "pcm", channels: 1, sample_rate: 16000 } }));
  await out.wait(m => m.some(e => e.type === "hello"));
  const pcm = Buffer.alloc(16000);
  for (let n = 0; n < 8000; n++) pcm.writeInt16LE(Math.round(Math.sin(n / 5) * 8000), n * 2);
  const say = async (text, count) => {
    options.asrText = text;
    const stops = out.messages.filter(e => e.type === "tts" && e.state === "stop" && !e.interrupted).length;
    ws.send(JSON.stringify({ type: "listen", state: "start", mode: "manual" }));
    for (let n = 0; n < pcm.length; n += 640) ws.send(pcm.subarray(n, n + 640));
    ws.send(JSON.stringify({ type: "listen", state: "stop" }));
    await out.wait(m => m.filter(e => e.type === "done").length >= count && m.filter(e => e.type === "tts" && e.state === "stop" && !e.interrupted).length > stops);
  };
  await say("记住，我不吃香菜", 1);
  assert.equal(app.store.all("memories").length, 0);
  assert.match(out.messages.find(e => e.type === "done").message.text, /确认/);
  await say("确认", 2);
  assert.equal(app.store.all("memories")[0].status, "active");
  await say("忘掉香菜", 3);
  await say("确认", 4);
  assert.equal(app.store.all("memories").length, 0);
  assert.equal(asrCalls(), 4);
  assert.ok(speechCalls() >= 4 && out.binary.length > 0);
  assert.ok(!out.messages.some(e => e.type === "error"));
  ws.close(); await once(ws, "close");
});

test("history tool sends cross-session original evidence to the answering model", async (t) => {
  const { app, received } = await setup(t);
  const old = app.store.session();
  const source = app.store.message(old.id, "user", "去苏州看朋友小林");
  const response = await app.admin.inject({ method: "POST", url: "/api/chat", payload: { text: "[history-tool-fixture] 以前聊过的旅行", route: "daily" } });
  assert.equal(response.statusCode, 200);
  const toolMessage = received.flatMap(r => r.messages).find(m => m.role === "tool" && m.tool_call_id === "history-call");
  assert.ok(toolMessage);
  const evidence = JSON.parse(toolMessage.content).messages;
  assert.equal(evidence[0].id, source.id);
  assert.equal(evidence[0].text, source.text);
  assert.equal(evidence[0].sessionId, old.id);
});

test("ESP32 voice settings flow through ASR, device volume verification, spoken acknowledgement and durable style", async t => {
  const options = { asrText: "声音小一点" };
  const { app, received, asrCalls } = await setup(t, options);
  app.store.saveSettings(mergeSettings(app.store.settings(), { input: { vad: "energy", semanticEndpoint: false, adaptiveEndpoint: false } }));
  const { id, ws, out, send } = await wakingDevice(t, app);
  let volume = 70;
  const connection = app.gateway.connections.get(id), writes = [];
  connection.tools = [{ name: "self.get_device_status" }, { name: "self.audio_speaker.set_volume" }];
  ws.on("message", (raw, binary) => {
    if (binary) return;
    const m = JSON.parse(raw.toString()), p = m.payload;
    if (m.type !== "mcp" || p?.method !== "tools/call") return;
    if (p.params.name === "self.audio_speaker.set_volume") { volume = p.params.arguments.volume; writes.push(volume); }
    send({ type: "mcp", payload: { jsonrpc: "2.0", id: p.id, result: { content: [{ type: "text", text: JSON.stringify({ audio_speaker: { volume } }) }] } } });
  });
  const sound = deviceAudio(t, ws);
  for (const text of ["声音小一点", "再大一点", "以后回复详细一点"]) {
    options.asrText = text;
    const start = out.messages.length;
    send({ type: "listen", state: "start", mode: "manual" });
    sound(400, 12000);
    send({ type: "listen", state: "stop" });
    await out.wait(m => m.slice(start).some(e => e.type === "tts" && e.state === "stop" && !e.interrupted));
    assert.ok(out.messages.slice(start).some(e => e.type === "tts" && e.state === "sentence_start"));
  }
  assert.equal(asrCalls(), 3);
  assert.deepEqual(writes, [60, 70]);
  assert.equal(received.length, 0, "common setting commands must not depend on the answering or routing model");
  assert.equal(app.store.settings().assistant.replyLength, "详细");
  assert.equal(connection.config.volume, 1, "speaker setting must not double-attenuate server audio");
  const messages = app.store.messages(connection.session.id);
  assert.equal(messages.filter(m => m.role === "assistant" && m.metadata.assistantControl?.status === "applied").length, 3);
  assert.ok(!app.memory.summaryGroups().some(g => g.sessionId === connection.session.id));
  const before = out.messages.length;
  send({ type: "listen", state: "detect", text: "你好" });
  await out.wait(m => m.slice(before).some(e => e.type === "tts" && e.state === "stop" && !e.interrupted));
  assert.match(received.find(r => r.stream).messages[0].content, /回答长度：详细/);
  ws.close(); await once(ws, "close");
});

async function wakingDevice(t, app, features = {}) {
  const id = "aa:bb:cc:dd:ee:09";
  app.gateway.pair();
  app.gateway.ota({ headers: { "device-id": id, host: "127.0.0.1" }, body: {} }, 8789);
  app.store.db.prepare("UPDATE devices SET approved=1 WHERE id=?").run(id);
  const { token } = app.store.db.prepare("SELECT token FROM devices WHERE id=?").get(id);
  const ws = new WebSocket(`ws://127.0.0.1:${app.device.server.address().port}/xiaozhi/v1/`, {
    headers: { "Device-Id": id, Authorization: `Bearer ${token}` },
  });
  t.after(() => ws.terminate());
  const out = observe(ws), send = value => ws.send(JSON.stringify(value));
  await once(ws, "open");
  send({ type: "hello", version: 1, features: { persistent_connection: true, ...features },
    audio_params: { format: "opus", channels: 1, sample_rate: 16000 } });
  await out.wait(m => m.some(e => e.type === "hello"));
  send({ type: "session", state: "standby" });
  return { id, ws, out, send };
}

test("ESP32 wake detect followed by listen start still plays the complete greeting", async t => {
  const { app, speechCalls, received } = await setup(t, { speechDelay: 150 });
  const { id, ws, out, send } = await wakingDevice(t, app);
  // This is the order sent by Application::ContinueWakeWordInvoke / StartListeningAudio.
  send({ type: "listen", state: "detect", text: "你好豆梨" });
  send({ type: "listen", state: "start", mode: "auto" });
  await out.wait((m, b) => b.length > 0 && m.some(e => e.type === "tts" && e.state === "stop" && !e.interrupted));
  assert.equal(speechCalls(), 1);
  assert.equal(received.length, 0, "the greeting needs no answering-model request");
  assert.ok(out.messages.some(e => e.type === "tts" && e.state === "sentence_start" && e.text === app.store.settings().assistant.greeting));
  assert.equal(out.binary.length, 10, "all 200 ms of fixture audio must be delivered");
  send({ type: "listen", state: "start", mode: "auto" });
  send({ type: "ping" });
  await out.wait(m => m.some(e => e.type === "pong"));
  assert.equal(app.gateway.connections.get(id).state, "listening");
  ws.close(); await once(ws, "close");
});

test("an explicit abort or standby still cancels an unfinished wake greeting", async t => {
  const { app } = await setup(t, { speechDelay: 200 });
  const { id, ws, out, send } = await wakingDevice(t, app);
  for (const action of ["abort", "standby"]) {
    // Force a new slow clip on each iteration; a ready clip is intentionally
    // allowed to send its first frame immediately after detect.
    const settings = app.store.settings();
    settings.models.tts.voice = action;
    app.store.saveSettings(settings);
    const start = out.messages.length, frames = out.binary.length;
    send({ type: "listen", state: "detect", text: "你好豆梨" });
    send({ type: "listen", state: "start", mode: "auto" });
    await out.wait(m => m.slice(start).some(e => e.type === "tts" && e.state === "start"));
    if (action === "abort") send({ type: "abort" });
    else await app.admin.inject({ method: "POST", url: `/api/devices/${id}/standby` });
    await out.wait(m => m.slice(start + 2).some(e => e.type === "tts" && e.state === "stop" && e.interrupted));
    await delay(350);
    assert.equal(out.binary.length, frames, "cancelled synthesis must not leak late audio");
    assert.ok(!out.messages.slice(start).some(e => e.type === "tts" && e.state === "sentence_start"));
    if (action === "standby") {
      send({ type: "session", state: "standby" });
      await out.wait(() => app.gateway.devices()[0].connection.standbyConfirmed);
    }
  }
  ws.close(); await once(ws, "close");
});

test("idle prewarm removes cloud TTS from the first wake and survives later standby", async t => {
  const { app, speechCalls, received } = await setup(t, { speechDelay: 300 });
  const { id, ws, out, send } = await wakingDevice(t, app);
  await app.gateway.warmGreeting();
  assert.equal(speechCalls(), 1);
  assert.equal(out.binary.length, 0, "prewarming must be silent");
  const connection = app.gateway.connections.get(id);
  for (let wake = 0; wake < 2; wake++) {
    const start = out.messages.length;
    connection.lastSpeechAt = Date.now() - 3600000;
    send({ type: "listen", state: "detect", text: "你好豆梨" });
    send({ type: "listen", state: "start", mode: "auto" });
    await out.wait(m => m.slice(start).some(e => e.type === "tts" && e.state === "stop" && !e.interrupted));
    assert.equal(speechCalls(), 1, "waking must not resynthesize the fixed greeting");
    assert.equal(connection.lastWake.cacheHit, true);
    assert.ok(connection.lastWake.firstAudioSentMs < 300, "first frame bypasses the delayed TTS provider");
    assert.ok(out.messages.slice(start).find(m => m.type === "metric" && m.name === "firstAudioMs").value < 300,
      "wake timing must not include the previous standby duration");
    send({ type: "session", state: "standby" });
    await out.wait(() => connection.standbyConfirmed);
  }
  assert.equal(received.length, 0);
  assert.equal(out.binary.length, 20);
  const state = (await app.admin.inject({ url: "/api/state" })).json();
  assert.equal(state.devices.find(d => d.id === id).connection.greetingAudio.state, "ready");
  ws.close(); await once(ws, "close");
});

function deviceAudio(t, ws) {
  const encoder = codec();
  t.after(() => encoder.delete());
  return (milliseconds, amplitude = 0) => {
    const pcm = Buffer.alloc(640);
    for (let n = 0; n < 320; n++) pcm.writeInt16LE(Math.round(Math.sin(n / 5) * amplitude), n * 2);
    for (let ms = 0; ms < milliseconds; ms += 20) ws.send(Buffer.from(encoder.encode(pcm, 320)));
  };
}

test("device AEC allows a correction during an answer and preserves conversation context", async t => {
  const options = { speechMs: 1400, asrText: "不对，我问的是夏天的情况" };
  const { app, received, recordings } = await setup(t, options);
  const { id, ws, out, send } = await wakingDevice(t, app, { device_aec: true });
  const sound = deviceAudio(t, ws);
  send({ type: "listen", state: "detect", text: "请介绍一下这里的天气" });
  await out.wait((m, b) => b.length >= 4);
  const connection = app.gateway.connections.get(id);
  // Quiet input and a short click must not interrupt playback.
  sound(200); sound(20, 12000); sound(240);
  send({ type: "ping" });
  await out.wait(m => m.some(e => e.type === "pong"));
  assert.equal(connection.bargeInCount, 0);
  const stopAt = out.messages.length;
  sound(80, 100); sound(80, 12000); sound(20); sound(100, 12000);
  await out.wait(m => m.slice(stopAt).some(e => e.type === "tts" && e.state === "stop" && e.interrupted));
  assert.equal(connection.bargeInCount, 1);
  assert.equal(connection.state, "listening");
  const cancelledFrames = out.binary.length;
  await delay(80);
  assert.equal(out.binary.length, cancelledFrames, "old answer audio must stop before recognition finishes");
  sound(240, 12000); sound(1000);
  await out.wait(m => m.some(e => e.type === "stt" && e.text === options.asrText) &&
    m.some(e => e.type === "tts" && e.state === "stop" && !e.interrupted));
  assert.equal(recordings.length, 1);
  assert.ok(recordings[0].length > (140 + 240 + 1000) * 32, "recognition retains the onset and brief syllable gap");
  const answers = received.filter(request => request.stream);
  assert.equal(answers.length, 2);
  assert.ok(answers[1].messages.some(m => m.role === "user" && m.content.includes("请介绍一下这里的天气")));
  assert.ok(answers[1].messages.at(-1).content.includes(options.asrText));
  assert.equal(connection.state, "listening");
});

test("farewell spoken over playback interrupts first then enters persistent standby without a reply", async t => {
  const { app, received, speechCalls, asrCalls } = await setup(t, { speechMs: 1600, asrText: "再见，豆梨。" });
  const { id, ws, out, send } = await wakingDevice(t, app, { device_aec: true });
  const sound = deviceAudio(t, ws);
  send({ type: "listen", state: "detect", text: "你好豆梨" });
  send({ type: "listen", state: "start", mode: "realtime" });
  await out.wait((m, b) => b.length >= 4);
  sound(360, 14000); sound(1000);
  await out.wait(m => m.some(e => e.type === "session" && e.reason === "farewell"));
  const connection = app.gateway.connections.get(id);
  assert.equal(connection.bargeInCount, 1);
  assert.equal(asrCalls(), 1);
  assert.equal(speechCalls(), 1, "only the interrupted greeting was synthesized");
  assert.equal(received.length, 0, "a farewell must never invoke the answer model");
  send({ type: "session", state: "standby" });
  await out.wait(() => connection.standbyConfirmed);
  assert.equal(ws.readyState, WebSocket.OPEN);
});

test("an ESP32 without echo cancellation cannot interrupt itself with speaker echo", async t => {
  const { app, asrCalls } = await setup(t, { speechMs: 400 });
  const { id, ws, out, send } = await wakingDevice(t, app);
  const sound = deviceAudio(t, ws);
  send({ type: "listen", state: "detect", text: "你好豆梨" });
  await out.wait((m, b) => b.length >= 2);
  sound(400, 14000);
  await out.wait(m => m.some(e => e.type === "tts" && e.state === "stop" && !e.interrupted));
  assert.equal(app.gateway.connections.get(id).bargeInCount, 0);
  assert.equal(asrCalls(), 0);
});
