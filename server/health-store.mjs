import { randomUUID } from "node:crypto";

const now = () => new Date().toISOString();
export function string(value, max = 1000, required = false) {
  if (value == null && !required) return "";
  if (typeof value !== "string" || value.length > max || (required && !value.trim()))
    throw new Error(`内容需要${required ? "1" : "0"}–${max}字`);
  return value.trim();
}
export function date(value, required = false) {
  if (!value && !required) return "";
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)
    throw new Error("请填写有效日期（年-月-日）");
  return value;
}
export const normalizeUnit = unit => String(unit || "").normalize("NFKC").replaceAll("μ", "u").replaceAll("µ", "u").replace(/\s/g, "");
export function observation(row) {
  const result = {
    name: string(row.name, 100, true), value: string(String(row.value ?? ""), 80, true),
    unit: string(row.unit, 40), reference: string(row.reference, 150),
    flag: string(row.flag, 40), specimen: string(row.specimen, 100),
    page: Number.isInteger(row.page) && row.page > 0 && row.page <= 12 ? row.page : null,
    uncertain: row.uncertain === true,
  };
  return result;
}
export function reportData(input, confirmed = false) {
  if (!Array.isArray(input.observations) || input.observations.length > 200)
    throw new Error("报告最多包含200项检查");
  const value = {
    title: string(input.title, 160, true), date: date(input.date, confirmed),
    facility: string(input.facility, 200), summary: string(input.summary, 12000),
    observations: input.observations.map(observation), confirmed,
  };
  if (confirmed && value.observations.some(o => o.uncertain))
    throw new Error("请核对所有标记为不确定的项目后再确认");
  return value;
}
export function factData(input) {
  if (!["condition", "allergy", "medication", "background"].includes(input.kind)) throw new Error("未知健康资料类型");
  if (input.confirmed !== true) throw new Error("健康事实需要你明确确认");
  const item = {
    kind: input.kind, name: string(input.name, 200, true), detail: string(input.detail, 2000),
    generic: string(input.generic, 200), ingredients: string(input.ingredients, 500),
    formulation: string(input.formulation, 100), strength: string(input.strength, 100),
    dose: string(input.dose, 100), frequency: string(input.frequency, 100),
    manufacturer: string(input.manufacturer, 200), approval: string(input.approval, 100),
    start: date(input.start), end: date(input.end), status: input.status === "inactive" ? "inactive" : "active",
    confirmed: true, confirmedAt: now(),
  };
  if (item.start && item.end && item.end < item.start) throw new Error("结束日期不能早于开始日期");
  return item;
}

// Health content is deliberately independent from inferred conversation memories.
// Neither payloads nor attachment names are stored in plaintext SQLite columns.
export class HealthStore {
  constructor(store) {
    this.store = store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS health_records (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL,
      revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS health_kind ON health_records(kind,updated_at);
      CREATE TABLE IF NOT EXISTS health_files (record_id TEXT PRIMARY KEY REFERENCES health_records(id) ON DELETE CASCADE, payload TEXT NOT NULL);`);
  }
  read(row) {
    return row ? { ...this.store.unseal(row.payload), id: row.id, kind: row.kind,
      revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at } : null;
  }
  get(id, kind) {
    const row = this.store.db.prepare("SELECT * FROM health_records WHERE id=?").get(id);
    if (!row || (kind && row.kind !== kind)) return null;
    return this.read(row);
  }
  require(id, kind) {
    const item = this.get(id, kind);
    if (!item) throw Object.assign(new Error("健康资料不存在或已删除"), { statusCode: 404 });
    return item;
  }
  list(kind) {
    return this.store.db.prepare("SELECT * FROM health_records WHERE kind=? ORDER BY updated_at DESC").all(kind).map(r => this.read(r));
  }
  put(kind, data, id, revision) {
    const previous = id ? this.require(id, kind) : null;
    if (previous && previous.revision !== revision)
      throw Object.assign(new Error("资料已更新，请重新打开后修改"), { statusCode: 409 });
    const timestamp = now();
    id ||= randomUUID();
    const payload = { ...data };
    for (const field of ["id", "kind", "revision", "createdAt", "updatedAt"]) delete payload[field];
    // A fact's subtype is distinct from the storage collection.
    if (kind === "fact") payload.factType = data.factType || data.kind;
    this.store.db.prepare(`INSERT INTO health_records VALUES (?,?,?,?,?,?) ON CONFLICT(id)
      DO UPDATE SET payload=excluded.payload, revision=excluded.revision, updated_at=excluded.updated_at`)
      .run(id, kind, this.store.seal(payload), (previous?.revision || 0) + 1, previous?.createdAt || timestamp, timestamp);
    return this.get(id);
  }
  remove(id, revision) {
    const item = this.require(id);
    if (item.revision !== revision) throw Object.assign(new Error("资料已更新，请刷新后删除"), { statusCode: 409 });
    this.store.db.prepare("DELETE FROM health_records WHERE id=?").run(id);
  }
  saveFile(id, file) {
    this.require(id);
    if (!file || !["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(file.mime)) throw new Error("支持 JPG、PNG、WebP 和 PDF");
    if (typeof file.base64 !== "string" || file.base64.length > 14 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(file.base64)) throw new Error("文件无效或超过10MB");
    const bytes = Buffer.from(file.base64, "base64");
    if (bytes.length > 10 * 1024 * 1024 || bytes.length < 12) throw new Error("文件无效或超过10MB");
    const valid = file.mime === "application/pdf" ? bytes.subarray(0, 5).toString() === "%PDF-" :
      file.mime === "image/png" ? bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" :
      file.mime === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 :
      bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
    if (!valid) throw new Error("文件内容与类型不符");
    this.store.db.prepare("INSERT OR REPLACE INTO health_files VALUES (?,?)").run(id,
      this.store.seal({ mime: file.mime, name: string(file.name, 200, true), base64: file.base64 }));
  }
  file(id) {
    this.require(id);
    const row = this.store.db.prepare("SELECT payload FROM health_files WHERE record_id=?").get(id);
    return row ? this.store.unseal(row.payload) : null;
  }
  context(reportIds = []) {
    if (!Array.isArray(reportIds) || reportIds.length > 5) throw new Error("最多选择5份报告");
    const reports = reportIds.map(id => this.require(id, "report"));
    if (reports.some(r => !r.confirmed)) throw new Error("请先核对并确认所选报告");
    return { facts: this.list("fact"), reports: reports.map(r => ({ id: r.id, title: r.title, date: r.date,
      facility: r.facility, summary: r.summary, observations: r.observations })),
      note: "只有用户确认的健康记录；停用药和过往病史不代表当前状态。档案缺失不代表没有过敏或疾病。" };
  }
  trends() {
    const groups = new Map();
    for (const report of this.list("report").filter(r => r.confirmed && r.date)) {
      for (const o of report.observations) {
        // Do not coerce inequalities, qualitative values, units, or different specimens.
        if (o.uncertain || !/^-?\d+(?:\.\d+)?$/.test(o.value)) continue;
        const key = JSON.stringify([o.name.normalize("NFKC").trim(), normalizeUnit(o.unit), o.specimen]);
        if (!groups.has(key)) groups.set(key, { key, name: o.name, unit: o.unit, specimen: o.specimen, points: [] });
        groups.get(key).points.push({ date: report.date, value: Number(o.value), reference: o.reference,
          reportId: report.id, facility: report.facility, flag: o.flag });
      }
    }
    return [...groups.values()].map(g => ({ ...g, points: g.points.sort((a, b) => a.date.localeCompare(b.date)) }));
  }
}
