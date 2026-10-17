import { existsSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../server/store.mjs";
import { putMemory } from "../server/memory.mjs";
import { HealthStore, factData, reportData } from "../server/health-store.mjs";

// Fictional data is restricted to a marked acceptance profile; never run on user data.
export function seedDesktopUi(profile) {
  if (!existsSync(join(profile, "self-test-marker"))) throw Error("UI fixtures require an isolated test profile");
  const store = new Store(join(profile, "data"));
  try {
    const settings = store.settings();
    Object.assign(settings.memory, { semantic: false, autoSummaries: false, maintenance: false });
    settings.privacy.autoMemory = false;
    store.saveSettings(settings);
    const session = store.session(null, "acceptance-speaker");
    store.message(session.id, "assistant", "我在。今天过得怎么样？\n开心的、烦心的，或者只是一件小事，都可以聊聊。", { route: "daily" });
    const message = store.message(session.id, "user", "今天终于把拖了很久的事情做完了。\n挺开心的，但突然又有点不知道接下来做什么。", { rawText: "今天终于把拖了很久的事情做完了。挺开心的，但突然又有点不知道接下来做什么。" });
    store.message(session.id, "assistant", "那种一直惦记着的事，终于能放下了。\n先让自己享受一下这个轻松的晚上吧，不用马上给空出来的时间安排新任务。", { route: "daily" });
    store.db.prepare("UPDATE sessions SET title=? WHERE id=?").run("把今天慢慢说完（验收数据）", session.id);
    const other = store.session(null, "browser");
    store.message(other.id, "user", "周末想去公园走走。");
    store.db.prepare("UPDATE sessions SET updated_at=? WHERE id=?").run("2026-01-01T00:00:00Z", other.id);
    const day = new Date().toLocaleDateString("sv-SE"), now = new Date().toISOString();
    for (const [id, kind, dayValue] of [["ui-session-summary", "session", null], ["ui-day-summary", "day", day]]) {
      store.db.prepare("INSERT INTO memory_summaries VALUES (?,?,?,?,?,?,?)").run(id, kind, session.id, dayValue, "完成了一件惦记了很久的事，想给自己留一个轻松的晚上。", "acceptance-only", now);
      store.db.prepare("INSERT INTO summary_sources VALUES (?,?)").run(id, message.id);
    }
    putMemory(store, { name: "关于吃饭的小偏好", value: "不喜欢香菜，点餐时记得帮我留意。", kind: "preference", status: "active" });
    putMemory(store, { name: "我喜欢的交流方式", value: "先听我把话说完，不需要马上给建议。", kind: "preference", status: "active", pinned: true });
    putMemory(store, { name: "一个已完成的小目标", value: "完成了拖了很久的事情。", kind: "event", status: "suggested", sourceId: message.id, quote: "今天终于把拖了很久的事情做完了。" });
    const vault = new HealthStore(store);
    vault.put("fact", factData({ kind: "background", name: "验收用健康背景", detail: "虚构数据，仅用于界面检查。", confirmed: true }));
    vault.put("report", { ...reportData({ title: "年度体检报告（验收数据）", date: day, facility: "界面验收", summary: "虚构数据，仅用于检查报告编辑与确认流程。", observations: [{ name: "检查项目", value: "10", unit: "示例单位", reference: "见原件" }] }, true), hasFile: false });
  } finally { store.close(); }
}
