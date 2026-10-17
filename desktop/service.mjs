import { utilityProcess } from "electron";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { probeService } from "./policy.mjs";

export class DesktopService extends EventEmitter {
  constructor(options) { super(); Object.assign(this, options); this.mode = "stopped"; }

  async start() {
    const healthy = await probeService(this.origin);
    if (this.child) {
      if (!healthy) throw new Error("本地服务暂时没有响应，正在等待恢复。重新连接不会中断正在运行的服务。");
      return;
    }
    if (healthy) {
      this.mode = "attached";
      this.log("Connected to an existing Douli service; desktop does not own it.");
      return;
    }
    // An attached service can be restarting. Never replace it with a bundled
    // service using a different data directory just because its port is free.
    if (this.mode === "attached")
      throw new Error("原本连接的本机服务暂时不可用，正在自动重连。请确认原启动器中的服务已运行。");
    this.mode = "starting";
    const child = utilityProcess.fork(join(this.root, "desktop/worker.mjs"), [], {
      cwd: this.dataDir,
      env: { ...process.env, DOULI_MOBILE: "0", DOULI_DATA_DIR: this.dataDir,
        DOULI_DIST_DIR: join(this.root, "dist"), DOULI_PORT: String(this.adminPort),
        DOULI_DEVICE_PORT: String(this.devicePort) },
      stdio: "pipe", serviceName: "豆梨本地服务",
    });
    this.child = child;
    child.stdout.on("data", value => this.log(value.toString().trim()));
    child.stderr.on("data", value => this.log(value.toString().trim()));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error("本地服务启动超时，请查看运行日志。")); }, 20000);
      const cleanup = () => { clearTimeout(timer); child.off("message", message); child.off("exit", exit); };
      const exit = code => { cleanup(); reject(new Error(`本地服务启动失败（${code}），请查看运行日志。`)); };
      const message = value => {
        if (!["ready", "failed"].includes(value?.type)) return;
        cleanup();
        if (value.type === "failed") reject(new Error(value.message));
        else { this.nodeVersion = value.node; resolve(); }
      };
      child.on("message", message);
      child.once("exit", exit);
    }).catch(async error => { await this.stop(); throw error; });
    this.mode = "owned";
    child.once("exit", code => {
      if (this.child !== child) return;
      this.child = null;
      this.mode = "failed";
      this.log(`Service exited unexpectedly: ${code}`);
      this.emit("failed", new Error("本地服务意外停止。点击重新连接可再次启动。"));
    });
    this.log(`Started bundled service (${this.nodeVersion}), pid ${child.pid}`);
  }

  async stop() {
    const child = this.child;
    this.child = null;
    this.mode = "stopped";
    if (!child?.pid) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill(); }, 8500);
      const deadline = setTimeout(resolve, 10000);
      child.once("exit", () => { clearTimeout(timer); clearTimeout(deadline); resolve(); });
      child.postMessage({ type: "stop" });
    });
    this.log("Bundled service stopped.");
  }
}
