import { extractFacts, putMemory, forgetMemory, hash, canonicalFact, isCurrent } from "./memory.mjs";

const affirmative = /^(确认|确认记住|确认修改|确认更正|确认删除|确认忘记|确认替换|是的|没错|对的|好的|好|可以|记住吧|删除吧)[。！!，,\s]*$/;
const negative = /^(取消|算了|不用了|先不|不要|不确认|取消修改|取消删除|取消记忆)[。！!，,\s]*$/;
export function memoryIntent(text) {
  const content = text.trim().replace(/^(?:豆梨[，,、\s]*)?(?:请|请你|帮我|麻烦你)?\s*/, "");
  if (/^(?:不要|不用|别|假如|假设|如果)|怎么|如何|能不能|可以吗/.test(content)) return null;
  if (/^(?:记住|记一下|记下|记着|以后记得)/.test(content)) return "remember";
  if (/^(?:更正|纠正|修改|更新)(?:一下)?(?:我的|这条|之前的)?记忆/.test(content) || /^把.+记忆.+改(?:成|为)/.test(content)) return "correct";
  if (/^(?:忘掉|忘记|删除)(?:一下)?/.test(content)) return "forget";
  if (/^(?:确认记住|接受)(?:这条|关于|我的)/.test(content)) return "approve";
  return null;
}
export class MemoryDialogue {
  constructor(service, dependencies = {}) {
    this.service = service; this.store = service.store; this.extract = dependencies.extractFacts || extractFacts;
  }
  pending(sessionId) {
    const row = this.store.db.prepare("SELECT * FROM memory_pending WHERE session_id=?").get(sessionId);
    if (!row || row.expires_at < new Date().toISOString()) {
      if (row) this.store.db.prepare("DELETE FROM memory_pending WHERE session_id=?").run(sessionId);
      return null;
    }
    return { ...row, ...JSON.parse(row.payload) };
  }
  async handle(message, signal) {
    const { store } = this, sessionId = message.session_id;
    const pending = this.pending(sessionId);
    if (pending && negative.test(message.text.trim())) {
      store.db.prepare("DELETE FROM memory_pending WHERE session_id=?").run(sessionId);
      return { text: "已取消，这次没有修改记忆。", operation: "cancel" };
    }
    if (pending && affirmative.test(message.text.trim())) return this.confirm(pending, message);
    if (pending) store.db.prepare("DELETE FROM memory_pending WHERE session_id=?").run(sessionId);
    const intent = memoryIntent(message.text);
    if (!intent) return null;
    let facts = [], targets = [];
    if (["remember", "correct"].includes(intent)) {
      facts = await this.extract(store, message, signal);
      if (!facts.length) return { text: "请把要记住或更正的内容完整说一遍，例如：记住，我不吃香菜。", operation: "clarify" };
      const keys = facts.map(canonicalFact);
      targets = store.all("memories").filter(m => isCurrent(m) && keys.some(f => {
        const old = canonicalFact(m); return old.subject === f.subject && old.predicate === f.predicate;
      }));
    } else {
      const query = message.text.replace(/^(?:请|帮我)?(?:忘掉|忘记|删除|确认记住|接受)(?:一下)?(?:关于)?/, "").replace(/(?:的记忆|这条记忆)[。！!]*$/, "").trim();
      if (!query || /^(那个|这个|那件事|这件事|它|吧|记忆)$/.test(query))
        return { text: "请说清要处理哪条记忆，例如：忘掉关于香菜的饮食偏好。", operation: "clarify" };
      if (/^(全部|所有)(?:记忆)?[。！!]*$/.test(query) && intent === "forget") targets = store.all("memories");
      else if (/刚才那条|刚刚那条/.test(query)) {
        targets = store.db.prepare(`SELECT DISTINCT m.* FROM memories m JOIN memory_evidence e ON e.memory_id=m.id
          JOIN messages s ON s.id=e.message_id WHERE s.session_id=? AND m.status!='superseded' ORDER BY m.updated_at DESC LIMIT 1`).all(sessionId);
      } else {
        const results = await this.service.search.memories(query, { signal, includePending: true, limit: 5 });
        targets = results.items;
        if (targets.length > 1 && targets[0].score > targets[1].score * 1.5) targets = targets.slice(0, 1);
      }
      if (intent === "approve") targets = targets.filter(m => ["suggested", "conflict", "needs_review"].includes(m.status));
      if (!targets.length) return { text: "没有找到对应的记忆。这次没有修改，可以再说一下具体内容。", operation: "clarify" };
      if (targets.length > 1 && !/全部|所有/.test(query)) return {
        text: `找到了几条可能的记忆：${targets.slice(0, 3).map(m => m.value).join("；")}。请明确说要处理哪一条。`, operation: "clarify",
      };
      if (intent === "forget") {
        // Remove earlier versions too, so history queries cannot resurrect the forgotten fact.
        const keys = targets.map(canonicalFact);
        targets = store.all("memories").filter(m => keys.some(k => {
          const f = canonicalFact(m); return f.subject === k.subject && f.predicate === k.predicate;
        }));
      }
    }
    signal?.throwIfAborted();
    if (store.closed || store.db.prepare("SELECT text FROM messages WHERE id=?").get(message.id)?.text !== message.text)
      return { text: "来源消息已变化，请重新说一次。", operation: "stale" };
    const payload = { action: intent, facts, targets: targets.map(m => ({ id: m.id, version: hash(m), value: m.value })), sourceHash: hash(message.text) };
    store.db.prepare("INSERT OR REPLACE INTO memory_pending VALUES (?,?,?,?)").run(sessionId, message.id, JSON.stringify(payload), new Date(Date.now() + 5 * 60000).toISOString());
    const details = (facts.length ? facts : targets).map(m => m.value).join("；");
    const verb = intent === "forget" ? "忘掉" : intent === "correct" ? "更正为" : "记住";
    return { text: `准备${verb}：${details}。${targets.length && facts.length ? "这会更新同一属性的旧记忆。" : ""}请说“确认”或“取消”。`, operation: "propose", pending: { action: intent, count: facts.length || targets.length } };
  }
  confirm(pending, message) {
    const { store } = this;
    store.db.prepare("DELETE FROM memory_pending WHERE session_id=?").run(message.session_id);
    const source = store.db.prepare("SELECT * FROM messages WHERE id=?").get(pending.source_id);
    const targets = pending.targets.map(t => store.db.prepare("SELECT * FROM memories WHERE id=?").get(t.id));
    if (!source || hash(source.text) !== pending.sourceHash || targets.some((t, i) => !t || hash(t) !== pending.targets[i].version))
      return { text: "相关记忆或原话已经变化，这次没有执行。请重新提出修改。", operation: "stale" };
    // Detect new conflicting facts created by another session after the proposal.
    const proposedKeys = pending.facts.map(canonicalFact);
    const knownIds = new Set(pending.targets.map(t => t.id));
    if (store.all("memories").some(m => isCurrent(m) && !knownIds.has(m.id) && proposedKeys.some(k => {
      const f = canonicalFact(m); return f.subject === k.subject && f.predicate === k.predicate;
    }))) return { text: "这项资料刚有新的记忆，请重新提出修改，我会先核对。", operation: "stale" };
    const results = [];
    store.db.exec("BEGIN IMMEDIATE");
    try {
    if (pending.action === "forget") {
      for (const m of targets) forgetMemory(store, m.id);
      // Keep the management request and reply out of future recall and summaries.
      for (const id of [source.id, message.id]) store.db.prepare("INSERT OR IGNORE INTO memory_exclusions VALUES (?)").run(id);
      store.db.exec("COMMIT");
      return { text: "已忘掉对应记忆，并清理相关摘要。原始聊天仍保留在聊天记录中，不再用于这部分记忆检索。", operation: "forget", affected: targets.map(m => m.id) };
    }
    if (pending.action === "approve") {
      for (const m of targets) results.push(putMemory(store, { ...m, status: "active", replace: true, origin: "explicit" }));
    } else for (const f of pending.facts) results.push(putMemory(store, { ...f, status: "active", replace: true, origin: "explicit" }));
    store.db.exec("COMMIT");
    } catch (error) { store.db.exec("ROLLBACK"); throw error; }
    this.service.schedule();
    return { text: `已经${pending.action === "correct" ? "更正" : "记住"}：${results.map(m => m.value).join("；")}。`, operation: pending.action, affected: results.map(m => m.id) };
  }
}
