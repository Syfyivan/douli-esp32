import Fastify from "fastify";
import staticFiles from "@fastify/static";
import { randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "./store.mjs";
import {
  defaults,
  mergeSettings,
  validateSettings,
  deviceConfig,
} from "./config.mjs";
import { HomeService, validateAction } from "./home.mjs";
import { ChatEngine } from "./engine.mjs";
import { Gateway } from "./gateway.mjs";
import { putMemory, forgetMemory, evidenceFor } from "./memory.mjs";
import { MemoryService } from "./memory-service.mjs";
import { embeddingProfile, rerankProfile } from "./memory-search.mjs";
import { recordCorrection } from "./input.mjs";
import { complete, synthesize, embed, rerank, speechProfile } from "./providers.mjs";
import { wav } from "./audio.mjs";
import { HealthService, registerHealthRoutes } from "./health-service.mjs";
import { SyncService, registerSyncRoutes } from "./sync-service.mjs";
import { isLocalOrigin } from "./local-origin.mjs";
import { readRemoteAccess, validateRemoteAccess, createRemoteGateway } from "./remote-access.mjs";
import { BackendSelectionService } from "./backend-selection.mjs";
import { controlSpeaker } from "./speaker-control.mjs";
import { ComputerTasks, registerComputerRoutes } from "./computer-tasks.mjs";
import { People, registerPeopleRoutes } from "./people.mjs";
import { registerAvatarRoutes } from "./avatar.mjs";

const text = (value, max = 4000) => {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`请输入 1–${max} 字的内容`);
  return value.trim();
};
export async function createApplication({
  dataDir,
  distDir = resolve("dist"),
  gatewayPort = 8789,
  adminPort = Number(process.env.DOULI_PORT || 8788),
  logger = false,
  remoteAccess,
  computerOptions,
  avatarOptions,
} = {}) {
  const directory = dataDir || resolve(".data");
  const remoteConfig = remoteAccess === undefined
    ? readRemoteAccess(directory) : validateRemoteAccess(remoteAccess);
  let store = new Store(directory);
  const home = new HomeService(store);
  let memory = new MemoryService(store);
  let engine = new ChatEngine(store, home, memory);
  const computer = new ComputerTasks(store, computerOptions);
  engine.computer = computer;
  let health = new HealthService(store);
  engine.health = health;
  const gateway = new Gateway(store, engine, { adminPort });
  const sync = new SyncService(store, { addresses: () => localAddresses(store.directory), port: gatewayPort,
    onChange: () => memory.schedule() });
  const backends = new BackendSelectionService(store, gateway, sync, { remoteConfig });
  const people = new People({ store, memory, engine, health, home }, { remoteConfig });
  gateway.people = people;
  people.onCreated = () => {
    // A pre-existing realtime socket may hold the original user's context.
    for (const connection of gateway.connections.values()) connection.finishConversation();
  };
  store = people.proxy("store"); memory = people.proxy("memory");
  engine = people.proxy("engine"); health = people.proxy("health");
  gateway.serviceHostname = () => sync.ready() ? sync.replica.config()?.hostname : null;
  home.deviceCall = (...args) => gateway.call(...args);
  const admin = Fastify({ logger, bodyLimit: 2 * 1024 * 1024 });
  const device = Fastify({ logger, bodyLimit: 1024 * 1024 });
  admin.addHook("onRequest", (req, _reply, done) => {
    if (!/^\/api\/(?:state|chat|sessions|messages|preferences|memories|memory|medical|dictionary)(?:[/?]|$)/.test(req.url)) return done();
    try {
      const id = req.headers["x-douli-person"] || new URL(req.url, "http://localhost").searchParams.get("person") || "";
      people.scope.run(people.bundle(id), done);
    } catch (error) { done(error); }
  });
  if (process.env.DOULI_MOBILE === "1" && process.env.DOULI_STOP_TOKEN) {
    admin.post("/api/mobile/stop", async (req, reply) => {
      if (req.headers.authorization !== `Bearer ${process.env.DOULI_STOP_TOKEN}`)
        return reply.code(403).send({ error: "未授权" });
      reply.send({ ok: true });
      setTimeout(() => process.emit("SIGTERM"), 100);
    });
  }
  admin.addHook("onRequest", async (req, reply) => {
    const ip = req.ip;
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip))
      return reply.code(403).send({ error: "管理页面仅限本机访问" });
    let host;
    try {
      host = new URL("http://" + req.headers.host).hostname;
    } catch {
      return reply.code(403).send({ error: "无效主机名" });
    }
    if (!["127.0.0.1", "localhost", "[::1]"].includes(host))
      return reply.code(403).send({ error: "请使用本机地址访问" });
    if (req.headers.origin && !isLocalOrigin(req.headers.origin, adminPort))
      return reply.code(403).send({ error: "不允许跨站访问本地管理接口" });
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
  });
  for (const app of [admin, device])
    app.setErrorHandler((error, req, reply) => {
      reply.code(error.statusCode || 400).send({ error: error.message });
    });
  registerHealthRoutes(admin, health);
  registerPeopleRoutes(admin, people);
  registerAvatarRoutes(admin, store, avatarOptions);
  registerComputerRoutes(admin, computer);
  registerSyncRoutes(admin, device, sync);
  admin.get("/api/devices/:id/backend", async req => backends.status(req.params.id));
  admin.post("/api/devices/:id/backend", async req => backends.switch(req.params.id, req.body?.mode));
  admin.get("/api/health", async () => ({
    ok: true,
    name: "douli-esp32",
    version: "0.1.0",
    voiceConnections: gateway.wsServers.reduce(
      (count, server) => count + server.clients.size,
      0,
    ),
    activeTurns: engine.active.size + [...people.bundles.values()].reduce((n, bundle) => n + bundle.engine.active.size, 0),
    memoryVersion: 2,
    healthVersion: 1,
    syncVersion: 1,
    remoteAccess: !!remoteConfig,
    computerControlVersion: 1,
  }));
  admin.get("/api/state", async () => ({
    people: people.state(),
    settings: store.publicSettings(),
    preferences: store.all("preferences"),
    memories: store
      .all("memories")
      .filter((m) => m.status !== "deleted"),
    memoryStatus: memory.status(),
    memorySummaries: store.db.prepare("SELECT * FROM memory_summaries WHERE text!='' ORDER BY updated_at DESC LIMIT 30").all(),
    memoryProfile: JSON.parse(store.db.prepare("SELECT value FROM memory_maintenance WHERE key='profile'").get()?.value || "[]"),
    dictionary: store.all("dictionary"),
    devices: gateway.devices(),
    actions: home.publicActions(),
    sensors: store.all("sensors"),
    rules: store
      .all("rules")
      .map((r) => ({ ...r, config: JSON.parse(r.config) })),
    pairingUntil: gateway.pairingUntil,
    gatewayAddresses: localAddresses(store.directory)
      .map((address) => `http://${address}:${gatewayPort}/xiaozhi/ota/`),
    platform: process.env.DOULI_MOBILE === "1" ? "android" : "desktop",
    configured: Object.fromEntries(
      Object.entries(store.settings().models).map(([k, v]) => [
        k,
        !!v.baseUrl && !!v.model,
      ]),
    ),
  }));
  admin.put("/api/settings", async (req) => {
    const current = store.settings();
    const patch = structuredClone(req.body);
    // Provider IDs are managed by enrollment, never by a stale settings form.
    delete patch.people;
    if (patch.avatar && !patch.avatar.apiKey && !patch.clearKeys?.includes("avatar")) delete patch.avatar.apiKey;
    for (const key of Object.keys(defaults.models))
      if (
        patch.models?.[key] &&
        !patch.models[key].apiKey &&
        !patch.clearKeys?.includes(key)
      )
        delete patch.models[key].apiKey;
    if (
      patch.search &&
      !patch.search.apiKey &&
      !patch.clearKeys?.includes("search")
    )
      delete patch.search.apiKey;
    if (
      patch.input &&
      !patch.input.streamingToken &&
      !patch.clearKeys?.includes("streaming")
    )
      delete patch.input.streamingToken;
    store.saveSettings(validateSettings(mergeSettings(current, patch)));
    void gateway.warmGreeting();
    memory.schedule();
    return store.publicSettings();
  });
  admin.post("/api/models/test", async (req) => {
    const kind = req.body.kind;
    if (!(kind in defaults.models) || ["asr", "tts", "streamingTts", "streamingAsr", "realtime"].includes(kind))
      throw new Error("请通过麦克风试聊测试语音模型");
    const started = Date.now();
    if (kind === "rerank") {
      const profile = rerankProfile(store);
      if (!profile) throw new Error("请配置重排模型，或复用硅基流动设置");
      await rerank(profile, "饮食", ["不吃香菜"], AbortSignal.timeout(15000));
      return { output: "重排连接成功", latencyMs: Date.now() - started };
    }
    if (kind === "embedding") {
      const profile = embeddingProfile(store);
      if (!profile) throw new Error("请先配置向量模型，或开启语义检索以复用硅基流动设置");
      const [vector] = await embed(profile, ["豆梨记忆连接测试"], AbortSignal.timeout(15000));
      return { output: `连接成功，向量维度 ${vector.length}`, latencyMs: Date.now() - started };
    }
    const output = await complete(
      // This short check verifies connectivity; reasoning can consume its entire token budget.
      { ...store.settings().models[kind], thinking: false },
      [{ role: "user", content: "请只回复“连接成功”。" }],
      AbortSignal.timeout(30000),
      { max_tokens: 20 },
    );
    if (!output.trim()) throw new Error("模型已连接，但未返回测试内容");
    return { output, latencyMs: Date.now() - started };
  });
  admin.post("/api/models/voice-preview", async (req, reply) => {
    const settings = store.settings();
    if (req.body?.kind && !["tts", "streamingTts"].includes(req.body.kind)) throw new Error("未知的语音合成配置");
    const audio = await synthesize(
      req.body?.kind ? settings.models[req.body.kind] : speechProfile(settings),
      text(req.body?.text || settings.assistant.greeting, 300),
      AbortSignal.timeout(30000),
    );
    return reply.type("audio/wav").send(wav(audio.pcm, audio.sampleRate));
  });
  admin.get("/api/sessions", async (req) =>
    store.sessions(String(req.query.q || "").slice(0, 200)),
  );
  admin.post("/api/sessions", async () => store.session());
  const visibleMessages = id => store.messages(id).map(message => {
    const reference = message.metadata?.healthRef;
    if (!reference) return message;
    const turn = health.vault.get(reference.consultationId, "consultation")?.turns.find(t => t.at === reference.at);
    return turn ? { ...message, text: message.role === "user" ? turn.question : turn.answer.spoken,
      metadata: { ...message.metadata, ...(message.role === "assistant" ? { health: turn } : {}) } } : message;
  });
  admin.get("/api/sessions/:id", async (req) => ({
    session: store.session(req.params.id),
    messages: visibleMessages(req.params.id),
  }));
  admin.delete("/api/sessions/:id", async (req) => {
    engine.abort(req.params.id);
    // Remove derived, unpinned memories with the source conversation.
    for (const m of store.db
      .prepare(
        "SELECT id FROM memories WHERE (source_id IN (SELECT id FROM messages WHERE session_id=?) OR id IN (SELECT memory_id FROM memory_evidence WHERE message_id IN (SELECT id FROM messages WHERE session_id=?))) AND pinned=0",
      )
      .all(req.params.id, req.params.id))
      forgetMemory(store, m.id);
    store.db.prepare("DELETE FROM sessions WHERE id=?").run(req.params.id);
    return { ok: true };
  });
  admin.get("/api/sessions/:id/export", async (req, reply) => {
    const session = store.session(req.params.id);
    const messages = visibleMessages(session.id);
    reply.header(
      "Content-Disposition",
      `attachment; filename="douli-${session.id}.json"`,
    );
    return { session, messages };
  });
  admin.get("/api/messages/:id/audio", async (req, reply) => {
    const audio = store.db
      .prepare("SELECT * FROM audio WHERE message_id=?")
      .get(req.params.id);
    if (!audio) return reply.code(404).send({ error: "这段对话没有保存音频" });
    return reply.type(audio.mime).send(Buffer.from(audio.data));
  });
  admin.post("/api/messages/:id/correction", async (req, reply) => {
    const message = store.db.prepare("SELECT metadata FROM messages WHERE id=?").get(req.params.id);
    if (message && JSON.parse(message.metadata || "{}").healthPrivate)
      return reply.code(409).send({ error: "请在健康对话中补充更正，健康内容仅保存在加密档案中" });
    return { suggestion: recordCorrection(store, req.params.id, text(req.body.text, 16000)) };
  });
  admin.post("/api/chat", async (req, reply) => {
    const content = text(req.body.text, 16000);
    const control = new AbortController();
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    reply.raw.on("close", () => {
      if (!reply.raw.writableEnded) control.abort();
    });
    try {
      await engine.run({
        sessionId: req.body.sessionId,
        text: content,
        route: req.body.route,
        signal: control.signal,
        emit: (e) => {
          if (!reply.raw.destroyed) reply.raw.write(JSON.stringify(e) + "\n");
        },
      });
    } catch (e) {
      if (!reply.raw.destroyed && !reply.raw.writableEnded)
        reply.raw.write(
          JSON.stringify({ type: "error", message: e.message }) + "\n",
        );
    } finally {
      if (!reply.raw.destroyed) reply.raw.end();
    }
  });
  admin.post("/api/sessions/:id/abort", async (req) => {
    engine.abort(req.params.id);
    return { ok: true };
  });
  admin.put("/api/preferences", async (req) => {
    const id = req.body.id || randomUUID();
    store.db
      .prepare(
        "INSERT INTO preferences VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,value=excluded.value,updated_at=excluded.updated_at",
      )
      .run(
        id,
        text(req.body.name, 80),
        text(req.body.value, 2000),
        new Date().toISOString(),
      );
    return { id };
  });
  admin.delete("/api/preferences/:id", async (req) => {
    store.db.prepare("DELETE FROM preferences WHERE id=?").run(req.params.id);
    return { ok: true };
  });
  admin.put("/api/memories", async (req) => {
    const saved = putMemory(store, {
      ...req.body,
      name: text(req.body.name, 100),
      value: text(req.body.value),
      sourceId: req.body.sourceId || null,
    });
    memory.schedule();
    return saved;
  });
  admin.get("/api/memory/status", async () => memory.status());
  admin.post("/api/memory/maintenance", async () => {
    store.db.prepare("UPDATE memory_jobs SET attempts=0,next_at=? WHERE attempts>=5").run(new Date().toISOString());
    void memory.run().catch(() => {});
    return { running: true };
  });
  admin.get("/api/memory/search", async (req) => memory.search.memories(text(req.query.q, 500), { includePending: req.query.pending === "true", limit: 20 }));
  admin.get("/api/memory/history", async (req) => memory.search.history(text(req.query.q, 500), { from: req.query.from, to: req.query.to }));
  admin.get("/api/memory/episodes", async (req) => memory.search.episodes(text(req.query.q, 500), { from: req.query.from, to: req.query.to, limit: 20 }));
  admin.get("/api/memory/episodes/:id/sources", async (req) => store.db.prepare(`SELECT e.quote,m.id,m.session_id,m.text,m.created_at
    FROM episode_sources e JOIN messages m ON m.id=e.message_id WHERE e.episode_id=? ORDER BY m.created_at`).all(req.params.id));
  admin.get("/api/memories/:id/evidence", async (req) => evidenceFor(store, req.params.id));
  admin.get("/api/memory/summaries/:id/sources", async (req) => store.db.prepare("SELECT m.id,m.session_id,m.text,m.created_at FROM messages m JOIN summary_sources s ON s.message_id=m.id WHERE s.summary_id=? ORDER BY m.created_at").all(req.params.id));
  admin.delete("/api/memories/:id", async (req) => {
    forgetMemory(store, req.params.id);
    return { ok: true };
  });
  admin.get("/api/memories/:id/source", async (req) => {
    const m = store.db
      .prepare("SELECT * FROM memories WHERE id=?")
      .get(req.params.id);
    return m?.source_id
      ? store.db
          .prepare("SELECT * FROM messages WHERE id=?")
          .get(m.source_id) || null
      : null;
  });
  admin.put("/api/dictionary", async (req) => {
    const id = req.body.id || randomUUID();
    const scope = req.body.scope || (req.body.replacement === store.settings().assistant.name ? "assistant_address" : "global");
    if (!["global", "assistant_address"].includes(scope)) throw new Error("未知的词典适用范围");
    store.db
      .prepare(
        "INSERT INTO dictionary (id,phrase,replacement,status,created_at,scope) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET phrase=excluded.phrase,replacement=excluded.replacement,status=excluded.status,scope=excluded.scope",
      )
      .run(
        id,
        text(req.body.phrase, 100),
        text(req.body.replacement, 100),
        req.body.status === "suggested" ? "suggested" : "active",
        new Date().toISOString(),
        scope,
      );
    return { id };
  });
  admin.delete("/api/dictionary/:id", async (req) => {
    store.db.prepare("DELETE FROM dictionary WHERE id=?").run(req.params.id);
    return { ok: true };
  });
  admin.post("/api/devices/pair", async () => ({
    pairingUntil: gateway.pair(),
  }));
  admin.put("/api/devices/:id", async (req) => {
    const found = store.db
      .prepare("SELECT * FROM devices WHERE id=?")
      .get(req.params.id);
    if (!found) throw new Error("设备不存在");
    const metadata = JSON.parse(found.metadata || "{}");
    if (req.body.config !== undefined)
      metadata.config = deviceConfig(req.body.config, metadata.config);
    store.db
      .prepare("UPDATE devices SET name=?,approved=?,metadata=? WHERE id=?")
      .run(
        req.body.name ? text(req.body.name, 80) : found.name,
        req.body.approved == null ? found.approved : req.body.approved ? 1 : 0,
        JSON.stringify(metadata),
        found.id,
      );
    if (req.body.approved === false) gateway.connections.get(found.id)?.close();
    return { ok: true };
  });
  admin.delete("/api/devices/:id", async (req) => {
    gateway.connections.get(req.params.id)?.close();
    store.db.prepare("DELETE FROM devices WHERE id=?").run(req.params.id);
    return { ok: true };
  });
  admin.post("/api/devices/:id/standby", async (req) => {
    const connection = gateway.connections.get(req.params.id);
    if (!connection) throw new Error("设备未连接");
    connection.endConversation("manual");
    return { ok: true, requested: true };
  });
  const speakerConnection = id => {
    const connection = gateway.connections.get(id);
    if (!connection) throw new Error("音箱未连接，暂时无法读取或调整音量");
    return connection;
  };
  admin.get("/api/devices/:id/volume", async req =>
    controlSpeaker(speakerConnection(req.params.id), { mode: "query" }, AbortSignal.timeout(30000)));
  admin.put("/api/devices/:id/volume", async req => {
    const value = req.body?.value;
    if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error("音量必须是 0 到 100 的整数");
    return controlSpeaker(speakerConnection(req.params.id), { mode: "set", value }, AbortSignal.timeout(30000));
  });
  admin.put("/api/actions", async (req) => {
    const id = req.body.id || randomUUID();
    store.db
      .prepare(
        "INSERT INTO actions VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,config=excluded.config",
      )
      .run(
        id,
        text(req.body.name, 80),
        store.seal(validateAction(req.body.config)),
        new Date().toISOString(),
      );
    return { id };
  });
  admin.delete("/api/actions/:id", async (req) => {
    store.db.prepare("DELETE FROM actions WHERE id=?").run(req.params.id);
    return { ok: true };
  });
  admin.post("/api/actions/:id/run", async (req) =>
    home.execute(req.params.id),
  );
  admin.put("/api/sensors", async (req) => {
    const id = req.body.id || randomUUID();
    const source = req.body.source;
    if (source) {
      const url = new URL(source.baseUrl);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        !source.entityId ||
        !source.token
      )
        throw new Error("Home Assistant 数据源配置不完整");
    }
    store.db
      .prepare(
        "INSERT INTO sensors VALUES (?,?,?,NULL,NULL) ON CONFLICT(id) DO UPDATE SET name=excluded.name,unit=excluded.unit",
      )
      .run(
        id,
        text(req.body.name, 80),
        String(req.body.unit || "").slice(0, 20),
      );
    if (source)
      store.db
        .prepare("INSERT OR REPLACE INTO sensor_sources VALUES (?,?)")
        .run(id, store.seal(source));
    return { id };
  });
  admin.delete("/api/sensors/:id", async (req) => {
    store.db.prepare("DELETE FROM sensors WHERE id=?").run(req.params.id);
    return { ok: true };
  });
  admin.put("/api/rules", async (req) => ({ id: home.saveRule(req.body) }));
  admin.delete("/api/rules/:id", async (req) => {
    store.db.prepare("DELETE FROM rules WHERE id=?").run(req.params.id);
    return { ok: true };
  });
  admin.get("/api/events", async () =>
    store.db
      .prepare("SELECT * FROM events ORDER BY created_at DESC LIMIT 60")
      .all()
      .map((e) => ({ ...e, detail: JSON.parse(e.detail) })),
  );
  for (const url of ["/xiaozhi/ota", "/xiaozhi/ota/"])
    device.route({
      method: ["GET", "POST"],
      url,
      handler: async (req) => gateway.ota(req, gatewayPort),
    });
  for (const url of ["/xiaozhi/ota/activate", "/xiaozhi/ota/activate/"])
    device.post(url, async (req, reply) => {
      // Xiaozhi consumes only the activation status code before destroying its
      // HTTP client. Do not leave a response body queued during that teardown.
      return reply
        .code(gateway.activationStatus(req) ? 200 : 202)
        .header("Connection", "close")
        .header("Content-Length", "0")
        .send();
    });
  device.get("/health", async () => ({
    ok: true,
    service: "douli-device-gateway",
  }));
  device.post("/sensors/:id", async (req, reply) => {
    if (!gateway.authorized(req))
      return reply.code(401).send({ error: "设备未授权" });
    home.sensor(req.params.id, req.body.value);
    return { ok: true };
  });
  if (existsSync(distDir)) {
    await admin.register(staticFiles, { root: distDir });
    admin.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/")
        ? reply.code(404).send({ error: "接口不存在" })
        : reply.sendFile("index.html"),
    );
  } else
    admin.get("/", async (req, reply) =>
      reply
        .type("text/html")
        .send("<h1>豆梨</h1><p>请先执行 npm run build。</p>"),
    );
  await admin.ready();
  await device.ready();
  gateway.attach(admin.server, true);
  gateway.attach(device.server, false);
  const remote = await createRemoteGateway(gateway, remoteConfig);
  const timer = setInterval(() => {
    void home.pollSensors().catch(() => {});
    void home.tick().catch(() => {});
  }, 15000);
  timer.unref();
  memory.start();
  sync.start();
  computer.start();
  return {
    admin,
    device,
    remote,
    store,
    engine,
    home,
    gateway,
    memory,
    health,
    sync,
    backends,
    computer,
    people,
    close: async () => {
      clearInterval(timer);
      await computer.close();
      await sync.close();
      for (const id of engine.active.keys()) engine.abort(id);
      await memory.stop();
      gateway.close();
      await admin.close();
      await device.close();
      if (remote) await remote.close();
      await people.close();
      store.close();
    },
  };
}

export function localAddresses(directory) {
  if (process.env.DOULI_MOBILE === "1") {
    try { return JSON.parse(readFileSync(resolve(directory, "network.json"), "utf8")); }
    catch { return []; }
  }
  return Object.values(networkInterfaces()).flat()
    .filter((n) => n?.family === "IPv4" && !n.internal).map((n) => n.address);
}
