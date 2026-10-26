import { randomUUID } from "node:crypto";

export const diaryTopics = { life: "日常", work: "工作", study: "学习", social: "社交", family: "家庭", sleep: "睡眠", food: "饮食", exercise: "运动", mood: "心情" };
const error = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
export function normalizeTopics(value = [], strict = false) {
  if (!Array.isArray(value) || value.length > 9) {
    if (strict) throw error("请选择有效的生活主题");
    return [];
  }
  if (strict && value.some(topic => !Object.hasOwn(diaryTopics, topic))) throw error("未知的生活主题");
  return [...new Set(value.filter(topic => typeof topic === "string" && Object.hasOwn(diaryTopics, topic)))];
}
function timestamp(value, required = false) {
  if (value == null || value === "") {
    if (required) throw error("请选择发生日期");
    return null;
  }
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\d(?:T\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)?)?$/.test(value)) throw error("日期格式无效");
  const calendar = new Date(value.slice(0, 10) + "T00:00:00Z");
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== value.slice(0, 10)) throw error("日期不存在");
  const date = new Date(value.length === 10 ? value + "T00:00:00" : value);
  if (!Number.isFinite(date.getTime())) throw error("日期无效");
  return date.toISOString();
}
const serialize = row => ({ ...row, topics: normalizeTopics(JSON.parse(row.topics)) });
export function getEntry(store, id) {
  const row = store.db.prepare("SELECT * FROM memory_episodes WHERE id=? AND deleted=0").get(id);
  if (!row) throw error("记录不存在或已移除", 404);
  return serialize(row);
}
function checkRevision(row, revision) {
  if (!Number.isSafeInteger(revision) || revision !== row.revision) throw error("记录已发生变化，请重新打开后修改", 409);
}
export function listEntries(store, { q = "", from, to, topic = "", kind = "", limit = 30, offset = 0 } = {}) {
  if (typeof q !== "string" || q.length > 500) throw error("查询内容过长");
  if (topic && !Object.hasOwn(diaryTopics, topic)) throw error("未知的生活主题");
  if (kind && !["event", "plan"].includes(kind)) throw error("请选择经历或计划");
  from = timestamp(from); to = timestamp(to);
  if (from && to && from >= to) throw error("结束日期应晚于开始日期");
  limit = Number(limit); offset = Number(offset);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw error("分页参数无效");
  const where = `deleted=0 AND (?='' OR instr(text,?)>0) AND (? IS NULL OR occurred_at>=?) AND (? IS NULL OR occurred_at<?)
    AND (?='' OR kind=?) AND (?='' OR EXISTS(SELECT 1 FROM json_each(topics) WHERE value=?))
    AND NOT EXISTS(SELECT 1 FROM memory_exclusions WHERE message_id=source_id)`;
  const args = [q.trim(), q.trim(), from, from, to, to, kind, kind, topic, topic];
  const total = store.db.prepare(`SELECT count(*) n FROM memory_episodes WHERE ${where}`).get(...args).n;
  const rows = store.db.prepare(`SELECT * FROM memory_episodes WHERE ${where} ORDER BY occurred_at DESC,id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
  return { items: rows.map(serialize), total, offset, limit, topics: diaryTopics };
}
export function saveEntry(store, input) {
  if (!input || typeof input.text !== "string" || !input.text.trim() || input.text.length > 2000) throw error("请输入 1–2000 字的生活记录");
  if (!["event", "plan"].includes(input.kind)) throw error("请选择经历或计划");
  const at = timestamp(input.occurredAt, true), until = timestamp(input.endedAt), topics = normalizeTopics(input.topics, true);
  if (until && until < at) throw error("结束时间不能早于发生时间");
  const now = new Date().toISOString(), text = input.text.trim();
  store.db.exec("SAVEPOINT diary_write");
  try {
    let id = input.id;
    if (id) {
      const old = getEntry(store, id); checkRevision(old, input.revision);
      store.db.prepare(`UPDATE memory_episodes SET text=?,kind=?,occurred_at=?,ended_at=?,topics=?,
        origin=?,revision=revision+1,updated_at=? WHERE id=?`).run(text, input.kind, at, until, JSON.stringify(topics), old.origin === "manual" ? "manual" : "edited", now, id);
    } else {
      // A manual note is testimony, not a fabricated assistant conversation.
      // Its original wording is retained separately from later diary edits.
      const session = store.session(null, "diary");
      const source = store.message(session.id, "user", text, { metadata: { diaryEntry: true, memoryOperation: true } });
      id = randomUUID();
      store.db.prepare(`INSERT INTO memory_episodes
        (id,session_id,source_id,text,kind,occurred_at,ended_at,recorded_at,updated_at,topics,origin)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, session.id, source.id, text, input.kind, at, until, now, now, JSON.stringify(topics), "manual");
      store.db.prepare("INSERT INTO episode_sources VALUES (?,?,?)").run(id, source.id, text);
    }
    const saved = getEntry(store, id);
    store.db.exec("RELEASE diary_write"); return saved;
  } catch (e) { store.db.exec("ROLLBACK TO diary_write; RELEASE diary_write"); throw e; }
}
export function removeEntry(store, id, revision) {
  const old = getEntry(store, id); checkRevision(old, revision);
  // Retain an exclusion marker for this source, without another copy of the diary text.
  store.db.prepare(`UPDATE memory_episodes SET deleted=1,text='',topics='[]',origin='edited',revision=revision+1,updated_at=? WHERE id=?`)
    .run(new Date().toISOString(), id);
  return { ok: true };
}
