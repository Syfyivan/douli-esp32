// Simli Compose: credentials stay in the encrypted local Store. Only short-lived
// session and TURN credentials go to the browser; user microphone audio does not.
const origin = "https://api.simli.ai";
const validId = value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
export const presetFaces = [
  { id: "66d1f5af-9b9b-49e2-a97f-6f5f3d59a2d5", name: "Tina（示例形象）" },
  { id: "b9e5fba3-071a-4e35-896e-211c4d6eaa7b", name: "Laila（示例形象）" },
  { id: "c060fe44-9b14-43e8-b92c-83a0e230db11", name: "Kate（示例形象）" },
];
export class SimliService {
  constructor(store, { fetch: fetcher = fetch } = {}) { this.store = store; this.fetch = fetcher; }
  async request(path, { method = "GET", body, headers = {}, timeout = 25000, signal } = {}) {
    const apiKey = this.store.settings().avatar.apiKey;
    if (!apiKey) throw new Error("请在设置 → 实时形象中填写 Simli API Key");
    let response;
    try {
      response = await this.fetch(origin + path, { method, body, redirect: "error",
        headers: { ...headers, "x-simli-api-key": apiKey },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) });
    } catch { throw new Error("连接 Simli 超时或网络不可用，请检查网络后重试"); }
    if (!response.ok) {
      // Do not relay provider bodies: they can contain submitted credentials/data.
      await response.body?.cancel();
      const reason = { 401: "API Key 无效", 402: "账户额度不足", 403: "账户权限或形象额度不足",
        404: "没有找到这个形象", 422: "图片或形象参数不符合要求", 429: "请求过于频繁或并发已满" }[response.status];
      throw new Error(`Simli ${reason || "服务暂时不可用"}（${response.status}）`);
    }
    return response;
  }
  async faces() {
    const data = await (await this.request("/faces")).json();
    if (!Array.isArray(data)) throw new Error("Simli 形象列表格式异常");
    const own = data.filter(f => validId(f.id)).map(f => ({ id: f.id, name: String(f.name || f.face_name || `我的形象 ${f.id.slice(0, 8)}`).slice(0, 80) }));
    return [...own, ...presetFaces.filter(p => !own.some(f => f.id === p.id))];
  }
  async session() {
    const { faceId, connectionMode } = this.store.settings().avatar;
    if (!validId(faceId)) throw new Error("请先在设置 → 实时形象中选择一个形象");
    const control = new AbortController();
    try {
      // Independent prerequisites: overlap their network waits; never cache tokens.
      const [ice, token] = await Promise.all([
        this.request("/compose/ice", { signal: control.signal }).then(async r => {
          const value = await r.json();
          if (!Array.isArray(value)) throw new Error("Simli 网络连接配置异常");
          return value;
        }),
        this.request("/compose/token", { method: "POST", signal: control.signal,
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ faceId,
            apiVersion: "v2", handleSilence: true, maxSessionLength: 1800, maxIdleTime: 120, audioInputFormat: "pcm16" }) }).then(async r => {
          const value = await r.json();
          if (typeof value.session_token !== "string" || !value.session_token || value.session_token === "FAIL TOKEN")
            throw new Error("Simli 没有返回有效的通话凭证，请检查账户和形象状态");
          return value;
        }),
      ]);
      return { sessionToken: token.session_token, iceServers: ice, enableSFU: connectionMode !== "direct" };
    } finally { control.abort(); }
  }
  job() {
    const row = this.store.db.prepare("SELECT value FROM settings WHERE id='avatar-generation'").get();
    return row ? this.store.unseal(row.value) : null;
  }
  saveJob(job) {
    this.store.db.prepare("INSERT OR REPLACE INTO settings VALUES ('avatar-generation',?)").run(this.store.seal(job));
    return job;
  }
  async create({ image, name } = {}) {
    if (this.creating || ["pending", "processing", "unknown"].includes(this.job()?.status))
      throw new Error("已有形象正在创建，请先刷新创建进度，避免重复消耗额度");
    if (typeof name !== "string" || !name.trim() || name.length > 80) throw new Error("请填写 1–80 字的形象名称");
    if (!this.store.settings().avatar.apiKey) throw new Error("请先保存 Simli API Key");
    const match = typeof image === "string" && image.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+=*)$/);
    if (!match || match[2].length > 7_000_000) throw new Error("请选择小于 5 MB 的 PNG、JPEG 或 WebP 图片");
    const data = Buffer.from(match[2], "base64"), type = match[1];
    const signature = type === "png" ? data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) :
      type === "jpeg" ? data[0] === 255 && data[1] === 216 && data[2] === 255 :
        data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP";
    if (!signature || data.length >= 5_000_000) throw new Error("图片格式不正确或超过 5 MB");
    this.creating = true;
    try {
      const form = new FormData(); form.set("image", new Blob([data], { type: `image/${type}` }), `portrait.${type}`);
      // This endpoint performs the official preprocessing when target-ratio is omitted.
      // One request avoids uploading/storing a second copy of the person's photo.
      this.saveJob({ status: "unknown", name: name.trim(), faceId: "", startedAt: new Date().toISOString() });
      const result = await (await this.request(`/faces/trinity?${new URLSearchParams({ gsVersion: "GSA_1.0", face_name: name.trim() })}`,
        { method: "POST", body: form, timeout: 180000 })).json();
      if (!validId(result.face_id)) throw new Error("Simli 未返回形象编号，请刷新进度或检查 Simli 控制台，勿重复上传");
      return this.saveJob({ ...this.job(), faceId: result.face_id, status: "pending" });
    } catch (error) {
      if (/（(?:401|402|403|404|422|429)）/.test(error.message)) this.saveJob({ ...this.job(), status: "failed" });
      throw error;
    } finally { this.creating = false; }
  }
  async progress() {
    const job = this.job(); if (!job) return null;
    // A timed-out submission has an unknown outcome. Do not attach an unrelated older job.
    if (!job.faceId) return { ...job, note: "提交结果尚未确认，请到 Simli 控制台核对；已有形象可通过刷新形象列表选用。" };
    const result = await (await this.request(`/faces/trinity/generation_status?face_id=${encodeURIComponent(job.faceId)}`)).json();
    const row = result.generations?.find(g => g.face_id === job.faceId) || (result.face_id === job.faceId ? result : null);
    if (!row || !["pending", "processing", "completed", "failed", "not_found"].includes(row.status)) return job;
    if (row.status === "not_found" && (await this.faces()).some(f => f.id === job.faceId)) row.status = "completed";
    return this.saveJob({ ...job, status: row.status, queuePosition: row.queue_position });
  }
  resolveUnknown({ faceId = "", confirmedAbsent = false } = {}) {
    const job = this.job();
    if (this.creating || job?.status !== "unknown") throw new Error("当前没有待核对的创建请求");
    if (faceId && validId(faceId)) return this.saveJob({ ...job, faceId, status: "pending" });
    if (confirmedAbsent === true) return this.saveJob({ ...job, status: "failed" });
    throw new Error("请填写控制台中的形象编号，或确认控制台没有收到这次创建请求");
  }
}
export function registerAvatarRoutes(app, store, options) {
  const service = new SimliService(store, options);
  app.get("/api/avatar/faces", () => service.faces());
  app.post("/api/avatar/session", () => service.session());
  app.get("/api/avatar/generation", () => service.progress());
  app.post("/api/avatar/generation/resolve", req => service.resolveUnknown(req.body || {}));
  app.post("/api/avatar/generation", { bodyLimit: 7_100_000 }, req => service.create(req.body));
}
