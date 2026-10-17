import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createApplication } from "../server/app.mjs";
import { readRemoteAccess, validateRemoteAccess } from "../server/remote-access.mjs";

test("remote access is opt-in and requires a fixed HTTPS origin", t => {
  const dir = mkdtempSync(join(tmpdir(), "douli-remote-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(readRemoteAccess(dir), null);
  assert.equal(validateRemoteAccess({ enabled: false }), null);
  for (const origin of ["http://voice.example", "https://user:secret@voice.example", "https://voice.example/path", "https://voice.example/?key=x"])
    assert.throws(() => validateRemoteAccess({ enabled: true, origin }));
  writeFileSync(join(dir, "remote-access.json"), JSON.stringify({ enabled: true, origin: "https://voice.example:8443/" }));
  assert.deepEqual(readRemoteAccess(dir), { enabled: true, origin: "https://voice.example:8443", port: 8792 });
});

test("remote gateway authenticates discovery and exposes no pairing, sync or management", async t => {
  const dir = mkdtempSync(join(tmpdir(), "douli-remote-gateway-"));
  const app = await createApplication({ dataDir: dir, remoteAccess: { enabled: true, origin: "https://voice.example:8443", port: 0 } });
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const id = "remote-test-device", token = "f".repeat(64);
  app.store.db.prepare("INSERT INTO devices VALUES (?,?,1,?,?,?,?)")
    .run(id, "fixture", token, "2.5.2.2", new Date().toISOString(), "{}");
  const headers = { "device-id": id, authorization: `Bearer ${token}` };
  assert.equal(app.remote.server.address().address, "127.0.0.1");
  for (const auth of [{}, { "device-id": id }, { ...headers, authorization: "Bearer wrong" }]) {
    const res = await app.remote.inject({ url: "/xiaozhi/ota/", headers: auth });
    assert.equal(res.statusCode, 401);
    assert.ok(!res.body.includes(token));
  }
  // Neither proxy headers, an incoming Host nor shared .local discovery may
  // redirect an authenticated board away from the configured remote endpoint.
  app.gateway.serviceHostname = () => "douli-12345678.local";
  const ota = await app.remote.inject({ method: "POST", url: "/xiaozhi/ota/", headers: { ...headers, host: "attacker.example", "x-forwarded-host": "attacker.example" }, payload: { application: { version: "2.5.2.2" } } });
  assert.equal(ota.statusCode, 200);
  assert.equal(ota.json().websocket.url, "wss://voice.example:8443/xiaozhi/v1/");
  for (const url of ["/api/state", "/api/sessions", "/douli/pair", "/douli/sync", "/xiaozhi/ota/activate", "/"]) {
    const res = await app.remote.inject({ method: "POST", url, headers, payload: {} });
    assert.equal(res.statusCode, 404);
    assert.ok(!res.body.includes(token));
  }
  const large = await app.remote.inject({ method: "POST", url: "/xiaozhi/ota/", headers, payload: { padding: "x".repeat(17000) } });
  assert.equal(large.statusCode, 413);

  const port = app.remote.server.address().port;
  const rejected = new WebSocket(`ws://127.0.0.1:${port}/xiaozhi/v1/`, { headers: { ...headers, authorization: "Bearer wrong" } });
  const rejectedStatus = await new Promise((resolve, reject) => {
    rejected.on("unexpected-response", (req, res) => { res.resume(); req.destroy(); resolve(res.statusCode); });
    rejected.on("error", () => {});
    rejected.on("open", () => { rejected.terminate(); reject(new Error("Unauthorized socket opened")); });
  });
  assert.equal(rejectedStatus, 401);
  assert.equal(app.gateway.connections.size, 0);
  const socket = new WebSocket(`ws://127.0.0.1:${port}/xiaozhi/v1/`, { headers });
  t.after(() => socket.terminate());
  await once(socket, "open");
  const hello = once(socket, "message");
  socket.send(JSON.stringify({ type: "hello", version: 1, features: { persistent_connection: true }, audio_params: { format: "opus", channels: 1, sample_rate: 16000 } }));
  assert.equal(JSON.parse((await hello)[0]).features.persistent_connection, true);
  assert.equal(app.gateway.devices()[0].connection.remote, true);
  const stopped = once(socket, "message");
  socket.send(JSON.stringify({ type: "session", state: "standby" }));
  await stopped;
  assert.equal(app.gateway.devices()[0].connection.standbyConfirmed, true);
  socket.close();
  await once(socket, "close");
  app.store.db.prepare("UPDATE devices SET approved=0 WHERE id=?").run(id);
  assert.equal((await app.remote.inject({ url: "/xiaozhi/ota/", headers })).statusCode, 401);
});
