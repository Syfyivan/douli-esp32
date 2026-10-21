import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID, randomBytes } from "node:crypto";
import { join } from "node:path";
import { Store } from "./store.mjs";
import { MemoryService } from "./memory-service.mjs";
import { ChatEngine } from "./engine.mjs";
import { HealthService } from "./health-service.mjs";

const idPattern = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
export function voiceprintIdentifier(result, kind, fallback) {
  // The live API uses GroupID / SpeakID; the published examples use Id.
  const fields = kind === "group" ? ["GroupID", "GroupId"] : ["SpeakID", "SpeakId"];
  const values = fields.map(field => result[field]).filter(value => value != null);
  if (!values.length && fallback) values.push(fallback);
  if (!values.length || new Set(values).size !== 1 || typeof values[0] !== "string" ||
      !values[0].trim() || values[0].length > 150)
    throw new Error(kind === "group" ? "服务没有返回有效的声纹组编号" : "服务没有返回有效的声纹编号，请重试");
  return values[0];
}
export class People {
  constructor(root, { remoteConfig, fetcher = fetch } = {}) {
    this.root = root; this.remoteConfig = remoteConfig; this.fetcher = fetcher;
    this.scope = new AsyncLocalStorage(); this.bundles = new Map(); this.audio = new Map(); this.enrolling = new Set();
    root.store.db.exec(`CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY,name TEXT NOT NULL,voice_id TEXT,voice_name TEXT,created_at TEXT NOT NULL)`);
  }
  list() { return this.root.store.db.prepare("SELECT * FROM people ORDER BY created_at,id").all(); }
  active() { return this.list().length > 0; }
  state() { return { people: this.list().map(p => ({ id: p.id, name: p.name, enrolled: !!p.voice_id })),
    selectedId: this.scope.getStore()?.person?.id || "", enrollmentAvailable: !!this.remoteConfig,
    voiceIdentification: this.root.store.settings().people.voiceIdentification }; }
  create(name) {
    if (typeof name !== "string" || !name.trim() || name.length > 40) throw new Error("请填写 1–40 字的称呼");
    if (this.list().length >= 10) throw new Error("最多创建 10 个个人档案");
    const person = { id: randomUUID(), name: name.trim() };
    this.root.store.db.prepare("INSERT INTO people VALUES (?,?,NULL,NULL,?)").run(person.id, person.name, new Date().toISOString());
    this.bundle(person.id); this.onCreated?.(); return person;
  }
  bundle(id = "") {
    if (!id) return this.root;
    if (!idPattern.test(id)) throw Object.assign(new Error("个人档案不存在"), { statusCode: 404 });
    const person = this.list().find(p => p.id === id);
    if (!person) throw Object.assign(new Error("个人档案不存在"), { statusCode: 404 });
    if (this.bundles.has(id)) {
      const bundle = this.bundles.get(id); bundle.person = person; bundle.engine.person = person; return bundle;
    }
    const store = new Store(join(this.root.store.directory, "people", id));
    store.settings = () => this.root.store.settings();
    store.saveSettings = settings => this.root.store.saveSettings(settings);
    const all = store.all.bind(store);
    store.all = table => ["devices", "actions", "sensors", "rules"].includes(table) ? this.root.store.all(table) : all(table);
    const memory = new MemoryService(store), health = new HealthService(store);
    const engine = new ChatEngine(store, this.root.home, memory);
    engine.health = health;
    // Computer task history belongs to the original space until it is scoped.
    engine.person = person;
    const bundle = { person, store, memory, health, engine };
    this.bundles.set(id, bundle); memory.start(); return bundle;
  }
  proxy(key) {
    return new Proxy(this.root[key], { get: (_target, property) => {
      const target = (this.scope.getStore() || this.root)[key];
      const value = target[property]; return typeof value === "function" ? value.bind(target) : value;
    } });
  }
  voiceContext() {
    return JSON.stringify({ vocabulary: [this.root.store.settings().assistant.name, ...this.list().map(p => p.name)], recent: [] });
  }
  voiceBundle(speaker) {
    if (speaker?.status !== "matched" || !this.list().some(p => p.id === speaker.personId && p.voice_id)) return null;
    return this.bundle(speaker.personId);
  }
  voiceSession(bundle, conversationId, source) {
    const id = `voice:${conversationId}:${bundle.person.id}`;
    return bundle.store.db.prepare("SELECT * FROM sessions WHERE id=?").get(id) || bundle.store.createSession(source, id);
  }
  async call(action, body, signal) {
    const key = this.root.store.settings().models.streamingAsr.apiKey;
    if (!key) throw new Error("请先配置豆包语音识别的 API Key");
    const response = await this.fetcher(`https://openspeech.bytedance.com/api/proxy/invoke?Action=${action}`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Api-Key": key }, body: JSON.stringify(body),
      signal: signal || AbortSignal.timeout(45000),
    });
    const data = await response.json();
    if (!response.ok || data.ResponseMetadata?.Error || data.Result?.Code !== 1000)
      throw new Error(`声纹服务未完成请求（${data.ResponseMetadata?.Error?.Code || data.Result?.Code || response.status}）`);
    return data.Result;
  }
  async check() {
    const result = await this.call("ListVoiceprint", { Limit: 1, Offset: 0 });
    return { available: true, registeredCount: result.TotalCount || 0 };
  }
  updateSettings() {
    const settings = this.root.store.settings();
    settings.people.members = this.list().filter(p => p.voice_id).map(p => ({ personId: p.id, voiceId: p.voice_id, voiceName: p.voice_name }));
    settings.people.voiceIdentification = settings.people.members.length > 0;
    this.root.store.saveSettings(settings);
  }
  async enroll(id, input) {
    const person = this.bundle(id).person;
    if (!person || input.consent !== true) throw new Error("请由本人确认声纹注册和云端处理后再录入");
    if (!this.remoteConfig) throw new Error("录入声纹需要先配置可访问的 HTTPS 设备入口，用于临时传送录音");
    if (this.enrolling.has(id)) throw new Error("正在录入，请稍候");
    if (typeof input.pcm !== "string" || input.pcm.length > 1_280_004 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.pcm)) throw new Error("录音无效");
    const pcm = Buffer.from(input.pcm, "base64");
    if (pcm.length < 160000 || pcm.length > 960000 || pcm.length % 2) throw new Error("请录制 5–30 秒音频");
    this.enrolling.add(id);
    const token = randomBytes(32).toString("hex");
    try {
      let settings = this.root.store.settings();
      if (!settings.people.groupId) {
        this.groupCreating ||= this.call("CreateVoiceprintGroup", { GroupName: "Douli household" }).then(result => {
          const groupId = voiceprintIdentifier(result, "group");
          const latest = this.root.store.settings(); latest.people.groupId = groupId;
          this.root.store.saveSettings(latest); return groupId;
        }).finally(() => { this.groupCreating = null; });
        await this.groupCreating; settings = this.root.store.settings();
      }
      this.audio.set(token, { pcm, expires: Date.now() + 60000 });
      const voiceName = `douli_${id}`;
      const result = await this.call("UpdateVoiceprint", { Action: person.voice_id ? 1 : 0,
        ...(person.voice_id ? { SpeakId: person.voice_id } : {}), SpeakerName: voiceName, GroupId: settings.people.groupId,
        AudioUrl: `${this.remoteConfig.origin}/voiceprint-audio/${token}.wav` });
      const voiceId = voiceprintIdentifier(result, "voice", person.voice_id);
      this.root.store.db.prepare("UPDATE people SET voice_id=?,voice_name=? WHERE id=?").run(voiceId, voiceName, id);
      this.updateSettings(); return { enrolled: true };
    } finally { this.audio.delete(token); this.enrolling.delete(id); }
  }
  temporaryAudio(path) {
    const token = /^\/voiceprint-audio\/([a-f0-9]{64})\.wav$/.exec(path)?.[1];
    const entry = token && this.audio.get(token);
    if (!entry || entry.expires <= Date.now()) { if (token) this.audio.delete(token); return null; }
    return entry.pcm;
  }
  async removeVoice(id) {
    const person = this.bundle(id).person;
    if (this.enrolling.has(id)) throw new Error("请等待录入完成");
    if (person.voice_id) await this.call("UpdateVoiceprint", { Action: 2, SpeakId: person.voice_id });
    this.root.store.db.prepare("UPDATE people SET voice_id=NULL,voice_name=NULL WHERE id=?").run(id);
    this.updateSettings(); return { ok: true };
  }
  async close() {
    this.audio.clear();
    for (const bundle of this.bundles.values()) {
      for (const id of bundle.engine.active.keys()) bundle.engine.abort(id);
      await bundle.memory.stop(); bundle.store.close();
    }
  }
}

export function registerPeopleRoutes(admin, people) {
  admin.get("/api/people", async () => people.state());
  admin.post("/api/people", async req => people.create(req.body?.name));
  admin.put("/api/people/:id", async req => {
    people.bundle(req.params.id);
    if (typeof req.body?.name !== "string" || !req.body.name.trim() || req.body.name.length > 40) throw new Error("请填写 1–40 字的称呼");
    people.root.store.db.prepare("UPDATE people SET name=? WHERE id=?").run(req.body.name.trim(), req.params.id);
    return { ok: true };
  });
  admin.post("/api/people/voiceprint/check", async () => people.check());
  admin.post("/api/people/:id/voiceprint", async req => people.enroll(req.params.id, req.body || {}));
  admin.delete("/api/people/:id/voiceprint", async req => people.removeVoice(req.params.id));
}
