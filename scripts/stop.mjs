import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const processFile = resolve(root, ".runtime/process.json");
if (!existsSync(processFile)) {
  console.log("豆梨未运行");
  process.exit(0);
}
const saved = JSON.parse(readFileSync(processFile, "utf8"));
const normalizePath = (p) =>
  typeof p === "string"
    ? process.platform === "win32"
      ? resolve(p).toLowerCase()
      : resolve(p)
    : "";
if (normalizePath(saved.root) !== normalizePath(root) || !Number.isInteger(saved.pid) || saved.pid <= 0)
  throw new Error("进程记录无效");
try {
  process.kill(saved.pid, 0);
} catch (error) {
  if (error?.code === "ESRCH") {
    rmSync(processFile, { force: true });
    console.log("豆梨已停止");
    process.exit(0);
  }
}
// Inspect command identity before acting on a potentially reused PID.
let command = "";
if (process.platform === "win32")
  command = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter 'ProcessId=${saved.pid}').CommandLine`,
    ],
    { encoding: "utf8", windowsHide: true },
  );
else
  command = execFileSync("ps", ["-p", String(saved.pid), "-o", "command="], {
    encoding: "utf8",
  });
const expectedEntry = resolve(root, "server/index.mjs");
const matchesEntry =
  process.platform === "win32"
    ? command.toLowerCase().replaceAll("/", "\\").includes(expectedEntry.toLowerCase())
    : command.includes(expectedEntry);
if (!command.trim()) {
  rmSync(processFile, { force: true });
  console.log("豆梨已停止");
  process.exit(0);
}
if (!matchesEntry)
  throw new Error("进程已经变化，未执行停止");
try {
  process.kill(saved.pid, "SIGTERM");
} catch (error) {
  if (error?.code !== "ESRCH") throw error;
}
rmSync(processFile, { force: true });
console.log("豆梨已停止");
