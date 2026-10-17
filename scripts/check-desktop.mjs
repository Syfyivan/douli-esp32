import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, openSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";
import electron from "electron";

const root = resolve(import.meta.dirname, ".."), runtime = join(root, ".runtime");
const buildDirectory = resolve(root, process.env.DOULI_DESKTOP_BUILD_DIR || "release/desktop");
mkdirSync(runtime, { recursive: true });
const pointer = join(runtime, "desktop-check.json");
const portable = process.argv.includes("--portable");
const packaged = portable || process.argv.includes("--packaged");
if (process.argv.includes("--verify")) {
  const saved = JSON.parse(readFileSync(pointer, "utf8"));
  const result = join(saved.directory, "result.json");
  if (existsSync(result)) { const data = JSON.parse(readFileSync(result, "utf8")); console.log(JSON.stringify(data, null, 2)); if (!data.ok) process.exitCode = 1; }
  else { process.kill(saved.pid, 0); console.log("Desktop acceptance is running, PID " + saved.pid + ", " + saved.directory); }
} else if (!process.argv.includes("--run")) {
  const checkRoot = resolve(process.env.DOULI_DESKTOP_CHECK_ROOT || runtime);
  mkdirSync(checkRoot, { recursive: true });
  const directory = mkdtempSync(join(checkRoot, "desktop-check-"));
  const fd = openSync(join(directory, "runner.log"), "a");
  const child = spawn(process.execPath, [import.meta.filename, "--run", directory, ...(portable ? ["--portable"] : packaged ? ["--packaged"] : [])],
    { cwd: root, detached: true, windowsHide: true, stdio: ["ignore", fd, fd] });
  await once(child, "spawn"); child.unref(); closeSync(fd);
  writeFileSync(pointer, JSON.stringify({ pid: child.pid, directory, packaged, portable }, null, 2));
  console.log("Independent desktop acceptance launched, PID " + child.pid + ". Verify with npm run desktop:check:verify");
} else {
  const directory = resolve(process.argv[process.argv.indexOf("--run") + 1]);
  const results = [];
  async function freePort() {
    const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
  }
  try {
    const { createApplication } = await import("../server/app.mjs");
    for (const mode of ["owned", "attached", "conflict", "device-conflict"]) {
      const profile = join(directory, mode); mkdirSync(profile, { recursive: true });
      writeFileSync(join(profile, "self-test-marker"), "Isolated acceptance data only");
      if (mode === "owned") {
        const { seedDesktopUi } = await import("./desktop-ui-fixture.mjs");
        seedDesktopUi(profile);
      }
      const adminPort = await freePort(); let devicePort = await freePort();
      while (adminPort === devicePort) devicePort = await freePort();
      const origin = "http://127.0.0.1:" + adminPort;
      let fixture, listener, control, healthUnavailable = false;
      const startFixture = async () => {
        fixture = await createApplication({ dataDir: join(profile, "data"), distDir: join(root, "dist"), adminPort, gatewayPort: devicePort });
        const http = fixture.admin.server, handlers = http.listeners("request");
        http.removeAllListeners("request");
        http.on("request", (req, res) => {
          if (healthUnavailable && req.url === "/api/health") { res.writeHead(503); res.end('{"error":"Acceptance interruption"}'); }
          else for (const handler of handlers) handler.call(http, req, res);
        });
        await fixture.admin.listen({ host: "127.0.0.1", port: adminPort });
        await fixture.device.listen({ host: "127.0.0.1", port: devicePort });
      };
      try {
        if (mode === "attached") {
          await startFixture();
          // This control listener exists only in the isolated acceptance runner.
          control = createServer(async (req, res) => {
            try {
              if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
              if (req.url === "/health-error") healthUnavailable = true;
              else if (req.url === "/healthy") healthUnavailable = false;
              else if (req.url === "/stop") { await fixture?.close(); fixture = null; }
              else if (req.url === "/start" && !fixture) await startFixture();
              else { res.writeHead(404); res.end(); return; }
              res.end("ok");
            } catch (error) { res.writeHead(500); res.end(error.message); }
          });
          control.listen(0, "127.0.0.1"); await once(control, "listening");
        }
        if (mode === "conflict" || mode === "device-conflict") {
          listener = createServer((_req, res) => res.end("Unrelated application"));
          listener.listen(mode === "conflict" ? adminPort : devicePort, "127.0.0.1"); await once(listener, "listening");
        }
        const executable = portable ? join(buildDirectory, "Douli-Portable-0.1.0-x64.exe")
          : packaged ? join(buildDirectory, "win-unpacked/Douli.exe") : electron;
        const env = { ...process.env, DOULI_DESKTOP_SELF_TEST: "1", DOULI_DESKTOP_TEST_MODE: mode,
          DOULI_DESKTOP_PROFILE: profile, DOULI_DATA_DIR: join(profile, "data"),
          DOULI_PORT: String(adminPort), DOULI_DEVICE_PORT: String(devicePort), DOULI_DEVICE_HOST: "127.0.0.1",
          DOULI_DESKTOP_TEST_CONTROL: control ? "http://127.0.0.1:" + control.address().port : "" };
        delete env.ELECTRON_RUN_AS_NODE;
        const out = openSync(join(profile, "electron.log"), "a");
        const child = spawn(executable, [...(packaged ? [] : [root]), "--use-fake-device-for-media-stream"], {
          cwd: root, env, windowsHide: true, stdio: ["ignore", out, out] });
        closeSync(out);
        const exit = new Promise((resolve, reject) => { child.once("exit", (code, signal) => resolve({ code, signal })); child.once("error", reject); });
        let timer;
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => { child.kill(); reject(new Error(mode + " timed out (PID " + child.pid + ")")); }, 80000);
        });
        const outcome = await Promise.race([exit, timeout]).finally(() => clearTimeout(timer));
        const result = JSON.parse(readFileSync(join(profile, "result.json"), "utf8"));
        result.exit = outcome;
        if (!result.ok) throw new Error(JSON.stringify(result));
        if (outcome.code !== 0) throw new Error("Desktop did not exit cleanly: " + JSON.stringify(outcome));
        if (mode === "owned" || mode === "device-conflict") {
          let reachable = false;
          try { reachable = (await fetch(origin + "/api/health", { signal: AbortSignal.timeout(1000) })).ok; } catch { /* Expected. */ }
          if (reachable) throw new Error("Owned service leaked after quit");
          result.checks.push("quit releases owned HTTP listener");
        }
        if (mode === "attached") {
          if (!(await fetch(origin + "/api/health").then(r => r.json())).ok) throw new Error("Desktop killed an existing service");
          result.checks.push("quit preserves existing service");
        }
        results.push(result);
        console.log(mode + ": " + result.checks.length + " checks passed");
      } finally {
        await fixture?.close();
        if (control) await new Promise(resolve => control.close(resolve));
        if (listener) await new Promise(resolve => listener.close(resolve));
      }
    }
    writeFileSync(join(directory, "result.json"), JSON.stringify({ ok: true, packaged, portable, results }, null, 2));
  } catch (error) {
    writeFileSync(join(directory, "result.json"), JSON.stringify({ ok: false, packaged, portable, results, error: error.stack }, null, 2));
    process.exitCode = 1;
  }
}
