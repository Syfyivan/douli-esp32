import { spawn } from "node:child_process";
import {
  mkdirSync,
  openSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = join(root, ".runtime");
mkdirSync(runtime, { recursive: true });
const health = await fetch("http://127.0.0.1:8788/api/health")
  .then((r) => r.json())
  .catch(() => null);
if (health?.name === "douli-esp32") {
  console.log("豆梨已运行：http://127.0.0.1:8788");
  process.exit(0);
}
const child = spawn(process.execPath, [join(root, "server", "index.mjs")], {
  cwd: root,
  detached: true,
  windowsHide: true,
  stdio: [
    "ignore",
    openSync(join(runtime, "server.log"), "a"),
    openSync(join(runtime, "server.error.log"), "a"),
  ],
});
child.unref();
writeFileSync(
  join(runtime, "process.json"),
  JSON.stringify({
    pid: child.pid,
    root,
    executable: process.execPath,
    startedAt: new Date().toISOString(),
  }),
);
for (let n = 0; n < 50; n++) {
  await new Promise((r) => setTimeout(r, 200));
  const ok = await fetch("http://127.0.0.1:8788/api/health")
    .then((r) => r.json())
    .catch(() => null);
  if (ok?.name === "douli-esp32") {
    console.log(`豆梨独立进程 ${child.pid} 已启动：http://127.0.0.1:8788`);
    process.exit(0);
  }
}
throw new Error("启动未完成，请查看 .runtime/server.error.log");
