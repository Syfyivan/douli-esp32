import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const saved = JSON.parse(readFileSync(resolve(root, ".runtime/process.json")));
if (saved.root !== root || !Number.isInteger(saved.pid))
  throw new Error("进程记录无效");
// Inspect command identity before acting on a potentially reused PID.
let command;
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
if (!command.includes(resolve(root, "server/index.mjs")))
  throw new Error("进程已经变化，未执行停止");
process.kill(saved.pid, "SIGTERM");
console.log("豆梨已停止");
