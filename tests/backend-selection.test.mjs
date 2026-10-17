import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createApplication } from "../server/app.mjs";
import { BackendSelectionService, validateBackendPlan } from "../server/backend-selection.mjs";
import { Discovery } from "../server/discovery.mjs";

const deviceId = "backend-fixture-device", token = "b".repeat(64);
const target = kind => ({ id: randomUUID(), kind, url: kind === "phone" ? "ws://douli-node-12345678.local:8789/xiaozhi/v1/" : "wss://voice.example:8443/xiaozhi/v1/", token, version: 1 });
test("backend plans cannot send credentials to public cleartext or malformed targets", () => {
  const valid = { v: 1, revision: randomUUID(), mode: "auto", targets: [target("computer"), target("phone")] };
  assert.equal(validateBackendPlan(valid), valid);
  for (const url of ["http://192.168.0.1/xiaozhi/v1/", "ws://public.example/xiaozhi/v1/", "wss://u:p@voice.example/xiaozhi/v1/", "wss://voice.example/xiaozhi/v1/?key=x", "ws://192.168.1.999/xiaozhi/v1/"]) {
    const bad = structuredClone(valid); bad.targets[0].url = url;
    assert.throws(() => validateBackendPlan(bad));
  }
  const duplicate = structuredClone(valid); duplicate.targets[1].id = duplicate.targets[0].id;
  assert.throws(() => validateBackendPlan(duplicate));
  assert.throws(() => validateBackendPlan({ ...valid, mode: "phone" }));
  const fallback = structuredClone(valid);
  fallback.targets[1].fallbackUrl = "ws://192.168.0.105:8789/xiaozhi/v1/";
  assert.equal(validateBackendPlan(fallback), fallback);
  for (const url of ["ws://public.example:8789/xiaozhi/v1/", "ws://192.168.0.105:80/xiaozhi/v1/", "wss://192.168.0.105:8789/xiaozhi/v1/"]) {
    fallback.targets[1].fallbackUrl = url;
    assert.throws(() => validateBackendPlan(fallback));
  }
  const local = { ...target("phone"), remoteUrl: "wss://voice.example:8443/xiaozhi/v1/" };
  const remotePlan = { v: 1, revision: randomUUID(), mode: "phone", targets: [local] };
  assert.equal(validateBackendPlan(remotePlan), remotePlan);
  for (const remoteUrl of ["ws://public.example/xiaozhi/v1/", "ws://192.168.0.1/xiaozhi/v1/", "wss://u:p@voice.example/xiaozhi/v1/", "wss://voice.example/wrong", null])
    assert.throws(() => validateBackendPlan({ ...remotePlan, targets: [{ ...local, remoteUrl }] }));
  assert.throws(() => validateBackendPlan({ ...remotePlan, targets: [{ ...local, url: local.remoteUrl }] }));
});

async function pair(t) {
  const apps = [], dirs = [];
  t.after(async () => { for (const a of apps) await a.close(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
  for (const kind of ["computer", "phone"]) {
    const dir = mkdtempSync(join(tmpdir(), "douli-backend-")); dirs.push(dir);
    const app = await createApplication({ dataDir: dir }); apps.push(app);
    app.backends.kind = kind;
    app.sync.useDiscovery = false; app.sync.addresses = () => ["127.0.0.1"];
    await app.device.listen({ host: "127.0.0.1", port: 0 });
    app.sync.port = app.device.server.address().port;
  }
  const [a, b] = apps;
  const settings = a.store.settings(); Object.assign(settings.models.daily, { baseUrl: "http://127.0.0.1:1", model: "fixture" }); a.store.saveSettings(settings);
  a.store.db.prepare("INSERT INTO devices VALUES (?,?,1,?,?,?,?)").run(deviceId, "fixture", token, "2.5.2.3", new Date().toISOString(), "{}");
  await b.sync.join(a.sync.invite().invitation);
  return apps;
}

async function board(t, app, backend = { mode: "computer", phase: "legacy", revision: "" }, extraFeatures = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${app.sync.port}/xiaozhi/v1/`, { headers: { "Device-Id": deviceId, Authorization: "Bearer " + token } });
  t.after(() => ws.terminate());
  const plans = [];
  ws.on("message", bytes => {
    const m = JSON.parse(bytes);
    if (m.type === "session" && m.state === "standby") ws.send(JSON.stringify({ type: "session", state: "standby" }));
    if (m.type === "backend" && m.action === "configure") {
      plans.push(m.plan);
      ws.send(JSON.stringify({ type: "backend", action: "ack", request_id: m.request_id, accepted: true }));
    }
  });
  await once(ws, "open"); const hello = once(ws, "message");
  ws.send(JSON.stringify({ type: "hello", version: 1, backend, features: { persistent_connection: true, backend_selection: 1, ...extraFeatures }, audio_params: { format: "opus", sample_rate: 16000, channels: 1 } }));
  const response = JSON.parse((await hello)[0]);
  assert.equal(response.backend.id, app.sync.replica.id);
  ws.send(JSON.stringify({ type: "session", state: "standby" }));
  return { ws, plans };
}

test("paired hosts control the actual owning socket, distinguish accepted/applied/rollback and hide credentials", async t => {
  const [a, b] = await pair(t);
  const first = await board(t, a);
  let status = await a.backends.status(deviceId);
  assert.equal(status.current.kind, "computer");
  assert.ok(status.targets.every(t => t.available));
  assert.ok(!JSON.stringify(status).includes(token));
  const request = await a.backends.switch(deviceId, "phone");
  assert.equal(request.accepted, true);
  assert.equal(first.plans[0].targets[0].id, b.sync.replica.id);
  assert.equal(first.plans[0].targets[0].fallbackUrl, `ws://127.0.0.1:${b.sync.port}/xiaozhi/v1/`);
  assert.equal((await a.backends.status(deviceId)).requested.phase, "switching");
  first.ws.close(); await once(first.ws, "close");
  const second = await board(t, b, { mode: "phone", phase: "applied", revision: request.revision, targetId: b.sync.replica.id });
  status = await a.backends.status(deviceId);
  assert.equal(status.current.kind, "phone"); assert.equal(status.mode, "phone");
  assert.equal(status.requested.phase, "applied");
  const auto = await a.backends.switch(deviceId, "auto");
  assert.deepEqual(second.plans[0].targets.map(t => t.kind), ["computer", "phone"]);
  assert.equal(second.plans[0].revision, auto.revision);
  second.ws.send(JSON.stringify({ type: "backend", action: "status", backend: { mode: "phone", phase: "applied", revision: request.revision, failedRevision: auto.revision } }));
  await new Promise(r => setTimeout(r, 30));
  status = await a.backends.status(deviceId);
  assert.equal(status.requested.phase, "failed"); assert.equal(status.mode, "phone");
  assert.ok(!JSON.stringify(status).includes(token));
  second.ws.close(); await once(second.ws, "close");
});

test("unavailable or unapproved targets cannot alter a running connection policy", async t => {
  const [a, b] = await pair(t);
  const connected = await board(t, a);
  b.store.db.prepare("UPDATE devices SET approved=0 WHERE id=?").run(deviceId);
  await assert.rejects(a.backends.switch(deviceId, "phone"), /不可用/);
  assert.equal(connected.plans.length, 0);
  assert.equal((await a.backends.status(deviceId)).current.kind, "computer");
  const noAuth = await b.device.inject({ method: "POST", url: "/douli/sync", payload: { command: "apply", body: {} } });
  assert.equal(noAuth.statusCode, 409);
  const publicPath = await a.device.inject({ method: "POST", url: `/api/devices/${deviceId}/backend`, payload: { mode: "phone" } });
  assert.equal(publicPath.statusCode, 404);
  connected.ws.close(); await once(connected.ws, "close");
});

test("each paired host answers its unique local name regardless of shared-name election", () => {
  const args = { group: "fixture", key: "fixture", address: "127.0.0.1", hostname: "douli-shared.local" };
  const phone = new Discovery({ ...args, id: randomUUID(), priority: 10 });
  const computer = new Discovery({ ...args, id: randomUUID(), priority: 20 });
  phone.receive(computer.packet(), { address: "127.0.0.2" });
  assert.deepEqual(phone.names(), [`douli-node-${phone.id.slice(0, 8)}.local`]);
  assert.ok(computer.names().includes("douli-shared.local"));
});

test("capable boards prefer LAN and retain authenticated WSS fallback; older boards keep WSS", async t => {
  const [a] = await pair(t);
  a.backends.remoteConfig = { origin: "https://voice.example:8443" };
  const old = await board(t, a);
  await a.backends.switch(deviceId, "computer");
  assert.equal(old.plans[0].targets[0].url, "wss://voice.example:8443/xiaozhi/v1/");
  assert.equal(old.plans[0].targets[0].remoteUrl, undefined);
  old.ws.close(); await once(old.ws, "close");
  const current = await board(t, a, undefined, { local_backend_priority: true });
  await a.backends.switch(deviceId, "computer");
  const plan = current.plans[0].targets[0];
  assert.equal(plan.url, `ws://douli-node-${a.sync.replica.id.slice(0, 8)}.local:${a.sync.port}/xiaozhi/v1/`);
  assert.equal(plan.fallbackUrl, `ws://127.0.0.1:${a.sync.port}/xiaozhi/v1/`);
  assert.equal(plan.remoteUrl, "wss://voice.example:8443/xiaozhi/v1/");
  assert.equal(plan.id, a.sync.replica.id);
  assert.equal(plan.token, token);
  current.ws.close(); await once(current.ws, "close");
});

test("fast reconnect confirms only the exact applied revision when the old socket closes before ack", async () => {
  const plan = { v: 1, revision: randomUUID(), mode: "computer", targets: [target("computer")] };
  const connections = new Map(); let saved;
  const c = { hello: true, features: { backend_selection: 1 }, configureBackend: async () => {
    connections.set(deviceId, { hello: true, backendStatus: { revision: plan.revision, phase: "applied" } });
    throw new Error("old socket closed");
  } };
  connections.set(deviceId, c);
  const service = new BackendSelectionService({}, {connections}, {replica:{id:plan.targets[0].id},peers:new Map()});
  service.device = () => ({ token }); service.saveMetadata = (id, patch) => { saved = patch; };
  assert.deepEqual(await service.apply(deviceId, plan), { accepted: true });
  assert.equal(saved.backendRequest.revision, plan.revision);
  connections.set(deviceId, { ...c, configureBackend: async () => { throw new Error("unconfirmed"); } });
  await assert.rejects(service.apply(deviceId, plan), /unconfirmed/);
});
