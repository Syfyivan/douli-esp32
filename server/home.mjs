import { randomUUID } from "node:crypto";

export function validateAction(config) {
  if (!["http", "homeassistant", "device"].includes(config.type))
    throw new Error("未知的动作类型");
  if (config.type === "http") {
    const u = new URL(config.url);
    if (!["http:", "https:"].includes(u.protocol))
      throw new Error("动作地址必须是 HTTP");
  }
  if (
    config.type === "homeassistant" &&
    (!config.baseUrl || !config.entityId || !config.service)
  )
    throw new Error("请填写 Home Assistant 地址、实体和服务");
  if (config.type === "device" && (!config.deviceId || !config.tool))
    throw new Error("请选择设备和工具");
  return config;
}
export class HomeService {
  constructor(store, deviceCall = null) {
    this.store = store;
    this.deviceCall = deviceCall;
    this.busy = new Set();
    this.lastPoll = 0;
  }
  async pollSensors() {
    if (this.polling || Date.now() - this.lastPoll < 30000) return;
    this.polling = true;
    this.lastPoll = Date.now();
    try {
      await Promise.allSettled(
        this.store.db
          .prepare("SELECT * FROM sensor_sources")
          .all()
          .map(async (row) => {
            const c = this.store.unseal(row.config);
            try {
              const r = await fetch(
                c.baseUrl.replace(/\/$/, "") +
                  "/api/states/" +
                  encodeURIComponent(c.entityId),
                {
                  headers: { Authorization: "Bearer " + c.token },
                  signal: AbortSignal.timeout(8000),
                  redirect: "error",
                },
              );
              if (!r.ok) throw new Error("HA read failed");
              const data = await r.json();
              const value = Number(data.state);
              if (
                !this.store.closed &&
                data.state !== "" &&
                Number.isFinite(value)
              )
                this.sensor(row.id, value);
            } catch {
              /* Keep original timestamp so stale readings cannot trigger rules. */
            }
          }),
      );
    } finally {
      this.polling = false;
    }
  }
  publicActions() {
    return this.store.all("actions").map((a) => {
      const c = this.store.unseal(a.config);
      return {
        id: a.id,
        name: a.name,
        type: c.type,
        target: c.entityId || c.deviceId || new URL(c.url).hostname,
      };
    });
  }
  async execute(id, signal) {
    const row = this.store.db
      .prepare("SELECT * FROM actions WHERE id=?")
      .get(id);
    if (!row) throw new Error("动作不存在");
    if (this.busy.has(id)) throw new Error("这个动作正在执行，请稍后");
    const c = this.store.unseal(row.config);
    this.busy.add(id);
    try {
      let result;
      if (c.type === "device") {
        if (!this.deviceCall) throw new Error("设备连接尚未准备好");
        result = await this.deviceCall(
          c.deviceId,
          c.tool,
          c.arguments || {},
          signal,
        );
      } else {
        let url = c.url;
        let method = c.method || "POST";
        let headers = { ...(c.headers || {}) };
        let body = c.body;
        if (c.type === "homeassistant") {
          const [domain, service] = c.service.split(".");
          if (!domain || !service)
            throw new Error("服务应为 light.turn_off 这样的格式");
          url = `${c.baseUrl.replace(/\/$/, "")}/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`;
          headers = {
            Authorization: `Bearer ${c.token}`,
            "Content-Type": "application/json",
          };
          body = { entity_id: c.entityId, ...(c.data || {}) };
        }
        if (
          body &&
          typeof body === "object" &&
          !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")
        )
          headers["Content-Type"] = "application/json";
        const response = await fetch(url, {
          method,
          headers,
          ...(body && method !== "GET"
            ? { body: typeof body === "string" ? body : JSON.stringify(body) }
            : {}),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
            : AbortSignal.timeout(10000),
          redirect: "error",
        });
        if (!response.ok) throw new Error(`设备服务返回 ${response.status}`);
        result = {
          acknowledged: true,
          verified: false,
          message: "服务已接收指令，实际状态尚未验证",
        };
        if (c.type === "homeassistant" && c.expectedState) {
          const stateResponse = await fetch(
            `${c.baseUrl.replace(/\/$/, "")}/api/states/${encodeURIComponent(c.entityId)}`,
            {
              headers: { Authorization: `Bearer ${c.token}` },
              signal: AbortSignal.timeout(5000),
            },
          );
          if (stateResponse.ok) {
            const state = await stateResponse.json();
            result.verified = state.state === c.expectedState;
            result.actualState = state.state;
            result.message = result.verified
              ? "设备状态已核实"
              : "已发送，设备状态尚未达到预期";
          }
        }
      }
      this.store.event("action", { id, name: row.name, result });
      return result;
    } catch (e) {
      this.store.event("action_failed", {
        id,
        name: row.name,
        message: "动作执行失败，请检查设备配置",
      });
      throw e;
    } finally {
      this.busy.delete(id);
    }
  }
  sensor(id, value) {
    if (!Number.isFinite(value)) throw new Error("传感器值必须是有限数字");
    const result = this.store.db
      .prepare("UPDATE sensors SET value=?,updated_at=? WHERE id=?")
      .run(value, new Date().toISOString(), id);
    if (!result.changes) throw new Error("传感器尚未登记");
  }
  async tick(now = new Date()) {
    for (const row of this.store.all("rules").filter((r) => r.enabled)) {
      const c = JSON.parse(row.config);
      const last = row.last_fired ? new Date(row.last_fired) : null;
      if (last && now - last < Math.max(60, c.cooldownSeconds || 300) * 1000)
        continue;
      let shouldFire = false;
      if (c.type === "time") {
        const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
        shouldFire =
          c.time === time &&
          (!last || last.toDateString() !== now.toDateString());
      } else if (c.type === "sensor") {
        const s = this.store.db
          .prepare("SELECT * FROM sensors WHERE id=?")
          .get(c.sensorId);
        if (s?.value != null && now - new Date(s.updated_at) < 120000) {
          const reset =
            c.operator === "above"
              ? s.value <= c.threshold - (c.hysteresis || 0)
              : s.value >= c.threshold + (c.hysteresis || 0);
          if (c.armed === false && reset) {
            c.armed = true;
            this.store.db
              .prepare("UPDATE rules SET config=? WHERE id=?")
              .run(JSON.stringify(c), row.id);
          }
          shouldFire =
            c.armed !== false &&
            (c.operator === "above"
              ? s.value > c.threshold
              : s.value < c.threshold);
        }
      }
      if (shouldFire) {
        if (c.type === "sensor") {
          c.armed = false;
          this.store.db
            .prepare("UPDATE rules SET config=? WHERE id=?")
            .run(JSON.stringify(c), row.id);
        }
        // Claim persistently before I/O; a restart cannot replay the same due action.
        this.store.db
          .prepare("UPDATE rules SET last_fired=? WHERE id=?")
          .run(now.toISOString(), row.id);
        try {
          await this.execute(c.actionId);
        } catch {
          /* execute records the failure; cooldown prevents hammering. */
        }
      }
    }
  }
  saveRule(input) {
    const c = input.config;
    if (
      !["time", "sensor"].includes(c?.type) ||
      !this.store.db
        .prepare("SELECT id FROM actions WHERE id=?")
        .get(c.actionId)
    )
      throw new Error("请选择有效触发条件和动作");
    if (c.type === "time" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(c.time))
      throw new Error("时间格式应为 HH:mm");
    if (
      c.type === "sensor" &&
      (!Number.isFinite(c.threshold) ||
        !["above", "below"].includes(c.operator) ||
        !this.store.db
          .prepare("SELECT id FROM sensors WHERE id=?")
          .get(c.sensorId))
    )
      throw new Error("传感器条件无效");
    if (
      c.hysteresis != null &&
      (!Number.isFinite(c.hysteresis) || c.hysteresis < 0)
    )
      throw new Error("回差必须是非负数");
    if (
      !Number.isFinite(c.cooldownSeconds || 300) ||
      (c.cooldownSeconds && c.cooldownSeconds < 60)
    )
      throw new Error("冷却间隔至少 60 秒");
    const id = input.id || randomUUID();
    this.store.db
      .prepare(
        "INSERT INTO rules VALUES (?,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET name=excluded.name,enabled=excluded.enabled,config=excluded.config",
      )
      .run(
        id,
        input.name || "新规则",
        input.enabled ? 1 : 0,
        JSON.stringify(c),
      );
    return id;
  }
}
