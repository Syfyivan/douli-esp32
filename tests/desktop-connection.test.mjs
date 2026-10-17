import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { ConnectionMonitor, describeConnectionError } from "../desktop/connection.mjs";
import { probeService } from "../desktop/policy.mjs";

const health = { ok: true, name: "douli-esp32", memoryVersion: 2 };
function harness(options = {}) {
  const events = [], logs = [];
  const monitor = new ConnectionMonitor({ probe: async () => true,
    onOffline: () => events.push("offline"), onRecovered: () => events.push("recovered"),
    log: message => logs.push(message), ...options });
  return { monitor, events, logs };
}

test("health monitoring tolerates a transient failure, detects sustained failure, and recovers from real HTTP responses", async t => {
  let status = 200;
  const server = createServer((_req, res) => { res.writeHead(status); res.end(JSON.stringify(health)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => server.close());
  const origin = "http://127.0.0.1:" + server.address().port;
  const { monitor, events, logs } = harness({ probe: () => probeService(origin) });
  status = 503; await monitor.check();
  status = 200; await monitor.check();
  assert.deepEqual(events, []);
  assert.equal(monitor.failures, 0);
  status = 503;
  for (let i = 0; i < 4; i++) await monitor.check();
  assert.deepEqual(events, ["offline"]);
  assert.ok(logs.some(line => line.includes("HTTP 503")));
  status = 200; await monitor.check(); await monitor.check();
  assert.deepEqual(events, ["offline", "recovered"]);
  assert.equal(monitor.offline, false);
  await new Promise(resolve => server.close(resolve));
  assert.equal(await probeService(origin), false);
});

test("a listening but stalled server is never treated as a free port, including a stalled response body", async t => {
  let headers = false;
  const server = createServer((_req, res) => { if (headers) { res.writeHead(200); res.write('{"ok":'); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = "http://127.0.0.1:" + server.address().port;
  for (const value of [false, true]) {
    headers = value;
    await assert.rejects(probeService(origin, { timeoutMs: 100 }), error => {
      assert.match(error.message, /未响应/);
      assert.match(describeConnectionError(error), /TimeoutError|AbortError/);
      return true;
    });
  }
});

test("a healthy response taking longer than the former two-second limit is accepted", async t => {
  const server = createServer(async (_req, res) => { await delay(2100); res.end(JSON.stringify(health)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => server.close());
  assert.equal(await probeService("http://127.0.0.1:" + server.address().port), true);
});

test("overlapping checks, manual reconnection, and shutdown cannot apply stale health results", async () => {
  let finish, calls = 0;
  const { monitor, events } = harness({ failureThreshold: 1, probe: () => {
    calls++; return new Promise(resolve => { finish = resolve; });
  } });
  const first = monitor.check();
  await monitor.check();
  assert.equal(calls, 1);
  monitor.reset(); finish(false); await first;
  assert.deepEqual(events, []);
  const second = monitor.check();
  monitor.stop(); finish(false); await second; await monitor.check();
  assert.deepEqual(events, []);
  assert.equal(calls, 2);
});

test("a failed recovery page load is retried and active manual connection suspends checks", async () => {
  let allowed = false, attempts = 0;
  const { monitor, logs } = harness({ canCheck: () => allowed, onRecovered: () => {
    if (++attempts === 1) throw new Error("page load interrupted");
  } });
  monitor.reset({ offline: true }); await monitor.check();
  assert.equal(attempts, 0);
  allowed = true; await monitor.check();
  assert.equal(monitor.offline, true);
  await monitor.check();
  assert.equal(attempts, 2);
  assert.equal(monitor.offline, false);
  assert.match(logs.join("\n"), /page load interrupted/);
});

test("scheduled checks continue on the recovery screen and stop at shutdown", async t => {
  let healthy = false;
  const { monitor, events } = harness({ intervalMs: 10, failureThreshold: 1, probe: async () => healthy });
  t.after(() => monitor.stop());
  monitor.start();
  for (let i = 0; i < 100 && !events.includes("offline"); i++) await delay(10);
  healthy = true;
  for (let i = 0; i < 100 && !events.includes("recovered"); i++) await delay(10);
  assert.deepEqual(events, ["offline", "recovered"]);
  monitor.stop(); healthy = false; await delay(40);
  assert.deepEqual(events, ["offline", "recovered"]);
});
