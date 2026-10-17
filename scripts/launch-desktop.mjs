import { spawn } from "node:child_process";
import { mkdirSync, openSync, closeSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import electron from "electron";

const root = resolve(import.meta.dirname, "..");
if (!existsSync(join(root, "dist/index.html"))) throw new Error("请先运行 npm run build");
const runtime = join(root, ".runtime");
mkdirSync(runtime, { recursive: true });
const packaged = process.argv.includes("--packaged");
const executable = packaged ? join(resolve(root, process.env.DOULI_DESKTOP_BUILD_DIR || "release/desktop"), "win-unpacked/Douli.exe") : electron;
if (!existsSync(executable)) throw new Error("找不到桌面程序，请先运行 npm run desktop:pack");
const out = openSync(join(runtime, "desktop-launch.log"), "a");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, packaged ? [] : [root], {
  // Electron is a GUI executable. SW_HIDE also hides its first app window on
  // Windows; detachment and file-backed stdio already avoid a console window.
  cwd: root, detached: true, windowsHide: false, env, stdio: ["ignore", out, out],
});
await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
child.unref(); closeSync(out);
writeFileSync(join(runtime, "desktop-process.json"), JSON.stringify({ pid: child.pid, executable, root, startedAt: new Date().toISOString() }, null, 2));
console.log("已请求打开豆梨；启动进程 PID " + child.pid + "（已有窗口时由单实例机制接管）。");
