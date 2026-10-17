import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { audioPermission, isAppUrl, externalUrl, probeService, port } from "../desktop/policy.mjs";
import { createApplication } from "../server/app.mjs";

test("desktop only permits its own origin, audio, and HTTP(S) external links", () => {
  const origin = "http://127.0.0.1:8788";
  assert.ok(isAppUrl(origin + "/api/health", origin));
  for (const value of ["http://127.0.0.1:8788.evil.test", "http://127.0.0.1:8789", "file:///etc/passwd", "http://user@127.0.0.1:8788", "about:blank"])
    assert.equal(isAppUrl(value, origin), false);
  assert.ok(externalUrl("https://www.electronjs.org"));
  for (const value of ["file:///x", "javascript:alert(1)", "ms-settings:privacy", "https://user:secret@example.com"])
    assert.equal(externalUrl(value), false);
  assert.ok(audioPermission("media", { mediaTypes: ["audio"] }));
  assert.ok(audioPermission("media", { mediaType: "audio" }));
  for (const [permission, details] of [["media", {}], ["media", { mediaTypes: ["video"] }], ["media", { mediaTypes: ["audio", "video"] }], ["geolocation", {}], ["display-capture", {}]])
    assert.equal(audioPermission(permission, details), false);
  assert.equal(port(undefined, 8788), 8788);
  for (const value of ["abc", "80", "65536", "1.5"]) assert.throws(() => port(value, 8788));
});

test("desktop detects a free port, existing Douli, and unrelated listeners", async t => {
  let payload = { ok: true, name: "douli-esp32", memoryVersion: 2 };
  const server = createServer((_req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(payload)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => server.close());
  const origin = "http://127.0.0.1:" + server.address().port;
  assert.equal(await probeService(origin), true);
  payload = { ok: true, name: "unrelated" };
  await assert.rejects(probeService(origin), /端口已被/);
  await new Promise(resolve => server.close(resolve));
  assert.equal(await probeService(origin), false);
});

test("desktop custom port accepts HTTP and voice, while foreign origins remain blocked", async t => {
  const app = await createApplication({ dataDir: mkdtempSync(join(tmpdir(), "douli-desktop-test-")), adminPort: 18788 });
  t.after(() => app.close());
  await app.admin.listen({ host: "127.0.0.1", port: 0 });
  const allowed = "http://127.0.0.1:18788";
  assert.equal((await app.admin.inject({ url: "/api/health", headers: { origin: allowed } })).statusCode, 200);
  for (const origin of ["https://evil.test", "http://127.0.0.1:18787", "file://127.0.0.1:18788", "https://127.0.0.1:18788"])
    assert.equal((await app.admin.inject({ url: "/api/health", headers: { origin } })).statusCode, 403);
  const url = "ws://127.0.0.1:" + app.admin.server.address().port + "/api/voice";
  const ws = new WebSocket(url, { headers: { Origin: allowed } });
  await once(ws, "open");
  ws.close(); await once(ws, "close");
  const rejected = new WebSocket(url, { headers: { Origin: "http://evil.test:18788" } });
  const [response] = await once(rejected, "error");
  assert.match(response.message, /403/);
});
