import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

const execute = promisify(execFile);
export class OrcaError extends Error {
  constructor(message, code = "unavailable", receipt) {
    super(message); this.code = code; this.receipt = receipt;
  }
}

// Use the public native CLI. Never send user text through cmd.exe/PowerShell.
export function orcaExecutable(configured = "", env = process.env, platform = process.platform) {
  if (configured) {
    if (/\.(cmd|bat|ps1)$/i.test(configured)) throw new OrcaError("请选择 Orca 原生可执行文件，不能使用命令脚本");
    if (!existsSync(configured)) throw new OrcaError("找不到配置的 Orca 可执行文件");
    return configured;
  }
  const candidates = platform === "win32" ? [
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs", "orca", "resources", "bin", "orca.exe"),
    ...(env.PATH || env.Path || "").split(delimiter).filter(Boolean).map(p => join(p, "orca.exe")),
  ] : ["/Applications/Orca.app/Contents/Resources/bin/orca", "/usr/local/bin/orca", "/opt/homebrew/bin/orca"];
  return candidates.find(path => path && existsSync(path)) || (platform === "win32" ? "orca.exe" : "orca");
}

export class OrcaClient {
  constructor(config, { exec = execute } = {}) { this.config = config; this.exec = exec; }
  async call(args, { timeoutMs = 12000 } = {}) {
    if (process.env.DOULI_MOBILE === "1") throw new OrcaError("Orca 控制需要在运行 Orca 的电脑后台使用");
    const executable = orcaExecutable(this.config().cliPath);
    // A server launched inside an Agent must still address the local desktop,
    // never inherit a parent Agent's terminal, remote pairing or environment.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^ORCA_/i.test(key)));
    let stdout;
    try {
      ({ stdout } = await this.exec(executable, [...args, "--json"], {
        env, windowsHide: true, shell: false, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024,
      }));
    } catch (error) {
      let response;
      try { response = JSON.parse(error.stdout); } catch {}
      if (response?.error) throw new OrcaError(response.error.message || "Orca 操作失败", response.error.code, response);
      throw new OrcaError(error.code === "ENOENT" ? "没有找到 Orca CLI，请安装 Orca 或填写可执行文件路径"
        : error.killed ? "等待 Orca 响应超时；操作结果尚未确认" : "无法连接 Orca，请确认它正在本机运行", "transport");
    }
    let response;
    try { response = JSON.parse(stdout); } catch { throw new OrcaError("Orca 未返回有效的 JSON 结果", "protocol"); }
    if (!response.ok) throw new OrcaError(response.error?.message || "Orca 操作失败", response.error?.code, response);
    return response.result;
  }
  async catalog() {
    const status = await this.call(["status"]);
    if (status.runtime?.state !== "ready") throw new OrcaError("Orca 尚未就绪，请先打开 Orca");
    const result = await this.call(["worktree", "list", "--limit", "100"]);
    return { connected: true, version: status.runtime.appVersion, runtimeId: status.runtime.runtimeId,
      worktrees: (result.worktrees || []).filter(w => !w.isArchived && w.identity?.key && w.identity.executionHostId === "local")
        .map(w => ({ id: w.identity.key, worktreeId: w.id, name: w.path.replaceAll("\\", "/").split("/").at(-1),
          label: `${w.path.replaceAll("\\", "/").split("/").at(-1)} · ${w.displayName || w.branch || "工作区"}`,
          path: w.path, branch: w.branch })) };
  }
  create(worktree, title) {
    return this.call(["terminal", "create", "--worktree", `identity:${worktree}`, "--title", title, "--command", "codex"], { timeoutMs: 30000 });
  }
  show(handle) { return this.call(["terminal", "show", "--terminal", handle]); }
  read(handle) { return this.call(["terminal", "read", "--terminal", handle, "--screen", "--limit", "120"]); }
  async idle(handle) {
    try { return !!(await this.call(["terminal", "wait", "--terminal", handle, "--for", "tui-idle", "--timeout-ms", "1000"], { timeoutMs: 5000 })).wait?.satisfied; }
    catch (error) { if (error.code === "timeout") return false; throw error; }
  }
  send(handle, prompt, requestId) {
    return this.call(["terminal", "send", "--terminal", handle, "--text", prompt, "--enter", "--wait-submit", "3",
      ...(requestId ? ["--retry-request", requestId] : [])], { timeoutMs: 10000 });
  }
  interrupt(handle) { return this.call(["terminal", "send", "--terminal", handle, "--interrupt"]); }
  close(handle) { return this.call(["terminal", "close", "--terminal", handle, "--tab"]); }
  list(worktree) { return this.call(["terminal", "list", "--worktree", `identity:${worktree}`, "--limit", "100"]); }
}

export function screenText(result) { return (result.terminal?.tail || []).join("\n").slice(-20000); }
export function startupReady(screen) {
  return /^\s*›\s*Ask Codex to do anything\s*$/m.test(screen) && !/Working \(|esc to interrupt|sign in|log in|trust this|approve|allow once/i.test(screen);
}
