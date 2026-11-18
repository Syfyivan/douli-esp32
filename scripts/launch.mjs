import { spawn } from "node:child_process";
import {
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = join(root, ".runtime");
mkdirSync(runtime, { recursive: true });
const rawPort = Number(process.env.DOULI_PORT || 8788);
const port = Number.isInteger(rawPort) && rawPort >= 1024 && rawPort <= 65535 ? rawPort : 8788;
const baseUrl = `http://127.0.0.1:${port}`;
const health = await fetch(`${baseUrl}/api/health`)
  .then((r) => r.json())
  .catch(() => null);
if (health?.name === "douli-esp32") {
  console.log(`豆梨已运行：${baseUrl}`);
  process.exit(0);
}
const out = openSync(join(runtime, "server.log"), "a");
const err = openSync(join(runtime, "server.error.log"), "a");
const child = spawn(process.execPath, [join(root, "server", "index.mjs")], {
  cwd: root,
  detached: true,
  windowsHide: true,
  stdio: ["ignore", out, err],
});
closeSync(out);
closeSync(err);
let exited = null;
child.once("exit", (code, signal) => {
  exited = signal || code || 1;
});
child.unref();
const processFile = join(runtime, "process.json");
writeFileSync(
  processFile,
  JSON.stringify({
    pid: child.pid,
    port,
    root,
    executable: process.execPath,
    startedAt: new Date().toISOString(),
  }),
);
for (let n = 0; n < 50; n++) {
  if (exited !== null) break;
  await new Promise((r) => setTimeout(r, 200));
  const ok = await fetch(`${baseUrl}/api/health`)
    .then((r) => r.json())
    .catch(() => null);
  if (ok?.name === "douli-esp32") {
    console.log(`豆梨独立进程 ${child.pid} 已启动：${baseUrl}`);
    process.exit(0);
  }
}
if (exited === null) {
  try { process.kill(child.pid, "SIGTERM"); } catch {}
}
rmSync(processFile, { force: true });
throw new Error("启动未完成，请查看 .runtime/server.error.log");
