import { createHash, randomUUID } from "node:crypto";

const roles = ["computer", "phone"];
const modes = [...roles, "auto"];
const validId = value => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
const credentialHash = token => createHash("sha256").update(token || "").digest("hex");
const privateIp = host => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(host) &&
  host.split(".").length === 4 && host.split(".").every(v => /^\d{1,3}$/.test(v) && Number(v) < 256);

export function validateBackendPlan(plan) {
  if (!plan || plan.v !== 1 || !validId(plan.revision) || !modes.includes(plan.mode) ||
      !Array.isArray(plan.targets) || plan.targets.length < 1 || plan.targets.length > 2)
    throw new Error("无效的后台切换配置");
  const seen = new Set(), ids = new Set();
  for (const t of plan.targets) {
    if (!validId(t.id) || ids.has(t.id) || !roles.includes(t.kind) || seen.has(t.kind) ||
        typeof t.token !== "string" || !/^[a-f0-9]{64}$/.test(t.token) || t.version !== 1 ||
        typeof t.url !== "string" || t.url.length > 160)
      throw new Error("无效的后台目标");
    const url = new URL(t.url);
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password ||
        url.pathname !== '/xiaozhi/v1/' || url.search || url.hash ||
        !/^[A-Za-z0-9.-]+$/.test(url.hostname) ||
        (url.protocol === 'ws:' && !privateIp(url.hostname) && !url.hostname.endsWith('.local')))
      throw new Error("后台需要加密公网地址或私人局域网地址");
    if (t.fallbackUrl !== undefined) {
      const fallback = new URL(t.fallbackUrl);
      if (typeof t.fallbackUrl !== "string" || t.fallbackUrl.length > 160 ||
          url.protocol !== "ws:" || !url.hostname.endsWith(".local") ||
          fallback.protocol !== "ws:" || !privateIp(fallback.hostname) ||
          fallback.port !== url.port || fallback.pathname !== url.pathname ||
          fallback.username || fallback.password || fallback.search || fallback.hash)
        throw new Error("备用地址必须是同一后台的局域网地址");
    }
    if (t.remoteUrl !== undefined) {
      const remote = new URL(t.remoteUrl);
      if (typeof t.remoteUrl !== "string" || t.remoteUrl.length > 160 ||
          url.protocol !== "ws:" || remote.protocol !== "wss:" ||
          remote.username || remote.password || remote.pathname !== "/xiaozhi/v1/" ||
          remote.search || remote.hash || !/^[A-Za-z0-9.-]+$/.test(remote.hostname))
        throw new Error("跨网备用地址必须是已配对后台的加密连接");
    }
    seen.add(t.kind);
    ids.add(t.id);
  }
  if (plan.mode === "auto" ? seen.size !== 2 : (seen.size !== 1 || !seen.has(plan.mode)))
    throw new Error("后台目标与连接方式不一致");
  return plan;
}

// Only the local management API and already paired, encrypted sync channel can
// request a switch. The browser never supplies an address or a device token.
export class BackendSelectionService {
  constructor(store, gateway, sync, { remoteConfig, kind = process.env.DOULI_MOBILE === "1" ? "phone" : "computer" } = {}) {
    Object.assign(this, { store, gateway, sync, remoteConfig, kind });
    this.busy = new Set();
    gateway.backendIdentity = () => ({ id: sync.replica.id, kind: this.kind, version: 1 });
    sync.onBackendControl = (command, body) => this.receive(command, body);
  }
  device(id) {
    const d = this.store.db.prepare("SELECT * FROM devices WHERE id=?").get(id);
    if (!d?.approved) throw new Error("设备尚未授权");
    return d;
  }
  saveMetadata(id, patch) {
    const d = this.device(id);
    this.store.db.prepare("UPDATE devices SET metadata=? WHERE id=?")
      .run(JSON.stringify({ ...JSON.parse(d.metadata || "{}"), ...patch }), id);
  }
  info(id) {
    const d = this.device(id), status = this.sync.status(), c = this.gateway.connections.get(id);
    const model = this.store.settings().models.daily;
    const host = this.sync.replica.config() ? `douli-node-${status.nodeId.slice(0, 8)}.local` : status.address;
    const url = this.remoteConfig
      ? this.remoteConfig.origin.replace(/^https:/, "wss:") + "/xiaozhi/v1/"
      : host ? `ws://${host}:${status.port}/xiaozhi/v1/` : null;
    return { id: status.nodeId, kind: this.kind, name: status.name, url,
      localUrl: host ? `ws://${host}:${status.port}/xiaozhi/v1/` : null,
      localFallbackUrl: privateIp(status.address || "") ? `ws://${status.address}:${status.port}/xiaozhi/v1/` : null,
      ready: !!url && !!model.baseUrl && !!model.model,
      credentialHash: credentialHash(d.token),
      board: c?.hello ? { online: true, supported: c.features.backend_selection === 1,
        localPriority: c.features.local_backend_priority === true,
        standby: c.standbyConfirmed, backend: c.backendStatus || null } : null };
  }
  async collect(id) {
    const local = this.info(id);
    const peers = await Promise.all([...this.sync.peers.values()].map(async peer => {
      try {
        const value = await this.sync.call(peer, "backend", { command: "info", body: { id } }, { timeoutMs: 3000 });
        if (value.id !== peer.id || !roles.includes(value.kind)) throw new Error("后台身份不符");
        return { ...value, peer };
      } catch { return { id: peer.id, kind: peer.kind, name: peer.name, ready: false, peer, board: null }; }
    }));
    return [local, ...peers];
  }
  async status(id) {
    const infos = await this.collect(id), own = infos[0];
    const active = infos.find(h => h.board?.online);
    const metadata = JSON.parse(this.device(id).metadata || "{}");
    const report = active?.board?.backend || metadata.backendStatus || null;
    const requested = metadata.backendRequest || null;
    let phase = requested ? "switching" : "idle";
    if (requested && report?.failedRevision === requested.revision) phase = "failed";
    else if (requested && report?.revision === requested.revision && report?.phase === "applied") phase = "applied";
    else if (requested && Date.now() - Date.parse(requested.at) > 120000) phase = "unconfirmed";
    return { current: active ? { id: active.id, kind: active.kind, name: active.name, standby: active.board.standby } : null,
      mode: report?.mode || "computer", supported: !!active?.board?.supported,
      requested: requested ? { ...requested, phase } : null,
      targets: roles.map(kind => {
        const target = infos.find(h => h.kind === kind && h.ready && h.credentialHash === own.credentialHash);
        return { kind, name: target?.name || (kind === "phone" ? "手机后台" : "电脑后台"), available: !!target,
          reason: target ? null : "请先配对两端、同步设备授权并启动对应后台",
          scope: target?.url?.startsWith("wss:") ? "可跨网" : "需与板子在同一局域网" };
      }) };
  }
  async switch(id, mode) {
    if (!modes.includes(mode)) throw new Error("请选择固定电脑、固定手机或自动选择");
    if (this.busy.has(id)) throw new Error("正在处理切换，请等待设备确认");
    this.busy.add(id);
    try {
      const infos = await this.collect(id), own = infos[0], d = this.device(id);
      const owner = infos.find(h => h.board?.online);
      if (!owner) throw new Error("板子当前未连接可控制的后台，请先恢复连接");
      if (!owner.board.supported) throw new Error("请先将板子升级到支持后台切换的固件");
      const targets = (mode === "auto" ? roles : [mode]).map(kind => {
        const h = infos.find(h => h.kind === kind && h.ready && h.credentialHash === own.credentialHash);
        if (!h) throw new Error(`${kind === "phone" ? "手机" : "电脑"}后台暂不可用，请先配对并完成同步`);
        const target = { id: h.id, kind, url: h.url, token: d.token, version: 1 };
        if (owner.board.localPriority && h.url.startsWith("wss:") && h.localUrl) {
          target.url = h.localUrl;
          target.remoteUrl = h.url;
          if (new URL(h.localUrl).hostname.endsWith(".local") && h.localFallbackUrl)
            target.fallbackUrl = h.localFallbackUrl;
          return target;
        }
        const url = new URL(h.url), address = h.peer?.address || this.sync.status().address;
        if (url.protocol === "ws:" && url.hostname.endsWith(".local") && privateIp(address || ""))
          target.fallbackUrl = `ws://${address}:${url.port || 80}${url.pathname}`;
        return target;
      });
      const plan = validateBackendPlan({ v: 1, revision: randomUUID(), mode, targets });
      const result = owner.peer
        ? await this.sync.call(owner.peer, "backend", { command: "apply", body: { id, plan } }, { timeoutMs: 15000 })
        : await this.apply(id, plan);
      if (!result.accepted) throw new Error("板子未接受切换请求");
      const request = { revision: plan.revision, mode, at: new Date().toISOString() };
      this.saveMetadata(id, { backendRequest: request });
      return { accepted: true, ...request };
    } finally { this.busy.delete(id); }
  }
  async apply(id, plan) {
    validateBackendPlan(plan);
    const d = this.device(id), ownId = this.sync.replica.id;
    if (plan.targets.some(t => t.token !== d.token || (t.id !== ownId && !this.sync.peers.has(t.id))))
      throw new Error("目标不是已配对的后台");
    const c = this.gateway.connections.get(id);
    if (!c?.hello || c.features.backend_selection !== 1) throw new Error("板子未连接或固件不支持切换");
    if (plan.targets.some(t => t.remoteUrl) && c.features.local_backend_priority !== true)
      throw new Error("请先更新支持局域网优先的板子固件");
    let result;
    try { result = await c.configureBackend(plan); }
    catch (error) {
      // A fast LAN reconnect can beat the old WAN socket's acknowledgement.
      // Only an authenticated board's applied revision can confirm that race.
      for (let n = 0; n < 20; n++) {
        const current = this.gateway.connections.get(id);
        if (current !== c && current?.hello && current.backendStatus?.revision === plan.revision &&
            current.backendStatus?.phase === "applied") { result = { accepted: true }; break; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (!result) throw error;
    }
    this.saveMetadata(id, { backendRequest: { revision: plan.revision, mode: plan.mode, at: new Date().toISOString() } });
    return result;
  }
  receive(command, body) {
    if (!body || typeof body.id !== "string") throw new Error("无效设备请求");
    if (command === "info") return this.info(body.id);
    if (command === "apply") return this.apply(body.id, body.plan);
    throw new Error("未知后台操作");
  }
}
