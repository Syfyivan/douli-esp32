import React, { useEffect, useState } from "react";
import { Plus, Search, BookOpen, Brain, Pin, Check, ChevronRight, RefreshCw, LockKeyhole, Pencil, X } from "lucide-react";
import { inDateRange } from "./ui-state.mjs";
import { DiaryPage } from "./diary.jsx";
const statuses = { active: "已确认", suggested: "待确认", conflict: "有冲突", needs_review: "原话待复核", superseded: "历史版本", expired: "已过期" };
const kinds = { fact: "长期事实", preference: "稳定偏好", event: "一次经历", state: "临时状态" };
const date = value => value ? new Date(value).toLocaleString("zh-CN", { year: "numeric", month: "short", day: "numeric" }) : "未指定";
const pendingStatuses = ["suggested", "conflict", "needs_review"];
export function MemoryPage(props) {
  return props.view === "experiences"
    ? <DiaryPage key={props.state.people?.selectedId || "default"} {...props} renderSummaries={() => <MemoryContents {...props} />} />
    : <MemoryContents {...props} />;
}
function MemoryContents({ state, act, notify, api, Section, Field, Form, Button, view = "memory", openConversation }) {
  const [filter, setFilter] = useState(""), [tab, setTab] = useState("current"), [editor, setEditor] = useState(null), [category, setCategory] = useState("all");
  const [preference, setPreference] = useState(null), [sources, setSources] = useState({}), [query, setQuery] = useState(""), [found, setFound] = useState(null);
  const [period, setPeriod] = useState("all"), [summaryKind, setSummaryKind] = useState("day");
  const revision = JSON.stringify([state.memories.map(m => [m.id, m.updated_at, m.status, m.value]), (state.memorySummaries || []).map(s => [s.id, s.source_hash, s.updated_at])]);
  useEffect(() => { setFound(null); setSources({}); }, [revision]);
  const status = state.memoryStatus || {};
  const save = m => act(async () => {
    const saved = await api("/memories", "PUT", m);
    notify(saved.status === "conflict" ? "与同一属性的记忆冲突，请核对后选择替换" : "记忆已保存");
    setEditor(null); setTab("current");
  });
  const search = e => { e.preventDefault(); act(async () => {
    const [memories, history, episodes] = await Promise.all([api("/memory/search?q=" + encodeURIComponent(query)), api("/memory/history?q=" + encodeURIComponent(query)), api("/memory/episodes?q=" + encodeURIComponent(query))]); setFound({ memories, history, episodes });
  }); };
  const candidates = state.memories.filter(m => pendingStatuses.includes(m.status));
  const memories = state.memories.filter(m => (m.name + m.value + m.subject).includes(filter) && (category === "all" || m.kind === category) &&
    (tab === "all" || tab === "current" && m.status === "active" || tab === "history" && ["superseded", "expired"].includes(m.status)));
  const summaries = (state.memorySummaries || []).filter(s => s.kind === summaryKind && inDateRange(s.day || s.updated_at, period) && (s.text || "").includes(filter));
  const evidence = m => act(async () => { const rows = await api("/memories/" + m.id + "/evidence"); setSources(s => ({ ...s, [m.id]: rows })); });
  const showSources = id => act(async () => { const rows = await api("/memory/summaries/" + encodeURIComponent(id) + "/sources"); setSources(old => ({ ...old, [id]: rows })); });
  const memoryRow = (m, pending = false) => <article className={pending ? "pending-item" : "memory-row"} key={m.id}>
    <div className="row-title"><span className="mini-icon"><Brain size={17} /></span><b>{m.name}</b><span className={"tag " + (m.status === "active" ? "" : "amber")}>{statuses[m.status]}</span>{!!m.pinned && <Pin size={13} aria-label="已固定" />}</div>
    <p>{m.value}</p>{pending && m.quote && <blockquote>{m.quote}</blockquote>}
    <small className="muted">{m.subject === "user" ? "你" : m.subject} · {kinds[m.kind] || "长期事实"} · {date(m.valid_from || m.created_at)}{m.valid_until ? " 至 " + date(m.valid_until) : ""}</small>
    {m.target_id && pending && <p className="small">{m.change_action === "expire" ? `建议结束这条旧记忆的有效期：${date(m.valid_until)}。确认后保留此前的历史记录。` : m.change_action === "supplement" ? "建议补充已有资料，确认后保存新版本。" : "根据这轮对话更新已有资料，确认后保留旧版本。"}</p>}
    {m.status === "conflict" && !m.target_id && <p className="small">这条内容与现有记忆有冲突。确认后将替换同一属性的旧记忆。</p>}
    <div className="memory-actions">
      {pending && <Button primary icon={Check} onClick={() => save({ ...m, status: "active", replace: m.status === "conflict" })}>{m.change_action === "expire" ? "确认结束有效期" : m.status === "conflict" ? "确认替换" : "确认记住"}</Button>}
      <Button onClick={() => evidence(m)}>查看原话<ChevronRight size={13} /></Button>
      <details className="action-menu"><summary aria-label={"更多操作：" + m.name}>•••</summary><div>{m.status === "active" && <Button onClick={() => save({ ...m, pinned: !m.pinned })}>{m.pinned ? "取消固定" : "固定记忆"}</Button>}<Button onClick={() => setEditor(m)}>修改记忆</Button><Button danger onClick={() => { if (pending || confirm("删除这条记忆？")) act(() => api("/memories/" + m.id, "DELETE")); }}>{pending ? "不保存这条" : "删除记忆"}</Button></div></details>
    </div>
    {sources[m.id] && <div className="memory-evidence">{sources[m.id].length ? sources[m.id].map((e, i) => <blockquote key={i}>{e.quote}<footer>{date(e.observed_at)} · {e.source_text ? "原对话保留" : "原对话已删除"}</footer>{e.session_id && e.source_text && <Button onClick={() => openConversation(e.session_id)}>打开原对话</Button>}</blockquote>) : <p className="small muted">由你手动添加，没有聊天原话。</p>}</div>}
  </article>;
  return <>
    <div className="profile-description"><div><h2>{view === "experiences" ? "一起聊过的日子" : "那些重要的小事，豆梨记得"}</h2><p>{view === "experiences" ? "按日期整理谈过的事，原话与来源一起保留。" : "记忆由你确认，也随时听你修正。"}</p></div>{view === "memory" && <Button primary icon={Plus} onClick={() => setEditor({ name: "", value: "", subject: "user", predicate: "", kind: "fact", valid_from: "", valid_until: "" })}>添加记忆</Button>}</div>
    <div className="personal-layout"><div>
      <div className="memory-search"><form onSubmit={search}><Search size={17} /><input aria-label="查找记忆与往事" placeholder="找一段记忆，也可以换一种说法…" value={query} onChange={e => { setQuery(e.target.value); setFilter(e.target.value); if (!e.target.value) setFound(null); }} maxLength={500} required /><Button type="submit">查找</Button></form>{found && <Button onClick={() => { setFound(null); setFilter(""); setQuery(""); }}>清除搜索</Button>}</div>
            {found && <div aria-live="polite"><p className="small muted">{found.memories.mode.startsWith("hybrid") ? "语义与关键词结果" : "关键词结果"}</p>
        {!found.memories.items.length && !found.history.length && !found.episodes.items.length && <p className="empty-small">没有找到相关内容。可以补充人物、日期或原话。</p>}
        {found.memories.items.map(m => <div className="data-row" key={m.id}><div><b>{m.name}</b><p>{m.value}</p><small>{statuses[m.status]} · {date(m.valid_from)}</small></div></div>)}
        {found.episodes.items.map(e => <div className="data-row" key={e.id}><div><b>{e.kind === "plan" ? "计划" : "经历"} · {date(e.occurred_at)}</b><p>{e.text}</p><Button onClick={() => act(async () => { const rows = await api("/memory/episodes/" + e.id + "/sources"); setSources(old => ({ ...old, [e.id]: rows })); })}>查看原话</Button>{sources[e.id]?.map(m => <blockquote key={m.id + m.quote}>{m.quote}<footer>{date(m.created_at)}</footer><Button onClick={() => openConversation(m.session_id)}>打开原对话</Button></blockquote>)}</div></div>)}
        {found.history.map(m => <div className="data-row" key={m.id}><div><b>{m.title}</b><blockquote>{m.text}</blockquote><small>{date(m.createdAt)}</small></div></div>)}
      </div>}

            {editor && <div className="memory-editor"><h3>{editor.id ? "编辑记忆" : "手动记住一件事"}</h3>
        <Form key={editor.id || "new"} label="保存记忆" submit={f => save({ ...editor, name: f.get("name"), value: f.get("value"), object: f.get("value"),
          subject: f.get("subject"), predicate: f.get("predicate"), kind: f.get("kind"),
          validFrom: f.get("from") === editor.valid_from?.slice(0, 10) ? editor.valid_from : f.get("from") || null,
          validUntil: f.get("until") === editor.valid_until?.slice(0, 10) ? editor.valid_until : f.get("until") || null, status: "active", replace: true })}>
          <div className="grid two"><Field label="主题"><input name="name" defaultValue={editor.name} required maxLength={100} /></Field>
            <Field label="人物"><input name="subject" defaultValue={editor.subject || "user"} required placeholder="user 表示你本人，也可填写人物名字" /></Field></div>
          <Field label="内容"><textarea name="value" defaultValue={editor.value} required maxLength={4000} /></Field>
          <div className="grid two"><Field label="记忆类型"><select name="kind" defaultValue={editor.kind || "fact"}>{Object.entries(kinds).map(([k, name]) => <option key={k} value={k}>{name}</option>)}</select></Field>
            <Field label="具体属性" hint="例如 food:香菜、residence（居住地）。留空会按主题归类。"><input name="predicate" defaultValue={editor.predicate} maxLength={120} /></Field></div>
          <div className="grid two"><Field label="何时开始成立"><input type="date" name="from" defaultValue={editor.valid_from?.slice(0, 10) || ""} /></Field>
            <Field label="何时失效" hint="没有明确期限可留空。"><input type="date" name="until" defaultValue={editor.valid_until?.slice(0, 10) || ""} /></Field></div>
        </Form><Button onClick={() => setEditor(null)}>取消编辑</Button></div>}

      {view === "memory" && <>
        <div className="memory-filter-row"><div className="filter-chips">{[["all", "全部记忆"], ["preference", "稳定偏好"], ["fact", "长期事实"], ["event", "一次经历"], ["state", "临时状态"]].map(([id, label]) => <button key={id} aria-pressed={category === id} onClick={() => setCategory(id)}>{label}</button>)}</div><select aria-label="记忆状态" value={tab} onChange={e => setTab(e.target.value)}><option value="current">当前已确认</option><option value="history">历史版本</option><option value="all">全部状态</option></select></div>
        <section className="card saved-memory-list">{!memories.length && <div className="empty-small"><Brain size={26} /><p>这里还没有符合条件的记忆。</p><small>可以手动添加，也可以确认右侧从聊天中整理的建议。</small></div>}{memories.map(m => memoryRow(m))}</section>
        <Section title="你明确设置的偏好" subtitle="称呼、交流方式和边界，由你直接填写。" action={<Button icon={Plus} onClick={() => setPreference({ name: "", value: "" })}>添加偏好</Button>}>
          {preference && <div className="memory-editor"><Form key={preference.id || "new"} label="保存偏好" submit={f => act(async () => { await api("/preferences", "PUT", { ...preference, name: f.get("name"), value: f.get("value") }); setPreference(null); notify("偏好已保存"); })}><Field label="偏好主题"><input name="name" defaultValue={preference.name} required maxLength={80} /></Field><Field label="偏好内容"><textarea name="value" defaultValue={preference.value} required maxLength={2000} /></Field></Form><Button onClick={() => setPreference(null)}>取消</Button></div>}
          {!state.preferences.length && !preference && <p className="small muted">还没有手动设置的偏好。</p>}
          {state.preferences.map(p => <div className="data-row" key={p.id}><div><b>{p.name}</b><p>{p.value}</p><small className="muted">由你手动设置</small></div><div className="row-actions"><Button icon={Pencil} aria-label={"修改偏好：" + p.name} onClick={() => setPreference(p)} /><Button icon={X} aria-label={"删除偏好：" + p.name} onClick={() => { if (confirm("删除这条偏好？")) act(() => api("/preferences/" + p.id, "DELETE")); }} /></div></div>)}
        </Section>
      </>}
      {view === "experiences" && <>
        <div className="memory-filter-row"><div className="filter-chips">{[["day", "按天回看"], ["session", "按对话回看"]].map(([id, label]) => <button key={id} aria-pressed={summaryKind === id} onClick={() => setSummaryKind(id)}>{label}</button>)}</div><select aria-label="经历日期" value={period} onChange={e => setPeriod(e.target.value)}><option value="all">全部日期</option><option value="week">最近 7 天</option><option value="month">最近 30 天</option></select></div>
        <div className="experience-stream">{!summaries.length && <div className="card empty-small"><BookOpen size={28} /><h3>一起聊过的经历，会慢慢积累</h3><p>启用「整理近期经历」后，每轮对话结束后，会整理有日期的经历与计划。</p></div>}{summaries.map(s => <article className="experience-entry" key={s.id}><div className="experience-date"><strong>{date(s.day || s.updated_at)}</strong><i /></div><section className="card"><div className="row-title"><BookOpen size={17} /><h3>{s.kind === "day" ? "这一天的经历与计划" : "一段对话的回顾"}</h3><span className="tag">自动整理</span></div><p className="experience-body">{s.text}</p><div className="memory-actions"><small className="muted">整理于 {date(s.updated_at)}</small><Button onClick={() => showSources(s.id)}>查看原话与来源<ChevronRight size={13} /></Button></div>{sources[s.id]?.map(m => <blockquote key={m.id}>{m.text}<footer>{date(m.created_at)}</footer><Button onClick={() => openConversation(m.session_id)}>打开原对话</Button></blockquote>)}</section></article>)}</div>
      </>}
      <p className="profile-foot"><LockKeyhole size={13} />资料保存在本机，可随时修改或删除。</p>
    </div><aside>
      {view === "memory" && <section className="card review-card"><div className="section-head"><h2>这几件事，想和你确认</h2><span className="tag amber">{candidates.length}</span></div><p className="review-intro">从对话中整理的新建议都需要你确认。确认前，不会作为正式记忆使用。</p>{candidates.length ? candidates.map(m => memoryRow(m, true)) : <p className="empty-small">暂时没有需要确认的记忆。</p>}</section>}
      <div className="profile-help"><BookOpen size={21} /><h3>{view === "memory" ? "记忆和经历，有什么不同？" : "回顾经历，保留原意"}</h3><p>记忆是相对稳定的个人事实和偏好；经历记录发生日期，原话另行保留。聊过一次的事情，不会因此变成长期偏好。</p><p>摘要可能有遗漏，可查看原话。更正或删除原对话后，后台会重新整理。</p></div>
      <details className="card maintenance-details"><summary><RefreshCw size={15} /> 记忆整理状态</summary><p className="small">{status.semanticConfigured ? "语义与关键词检索" : "关键词检索"} · 已索引 {status.indexed || 0} / {status.total || 0} 条</p>{status.degraded && <p className="notice">{status.degraded}</p>}<p className="small muted">待提取 {status.pendingJobs || 0} 条 · 待重试 {status.failedJobs || 0} 条<br />上次整理 {date(status.lastRun?.at)}</p><Button disabled={status.running} onClick={() => act(async () => { await api("/memory/maintenance", "POST", {}); notify("后台整理已开始，页面会自动更新"); })}>{status.running ? "正在整理…" : "整理并更新索引"}</Button>{!!state.memoryProfile?.length && <details><summary>已确认的稳定资料</summary>{state.memoryProfile.map(m => <p key={m.id}>{m.subject === "user" ? "你" : m.subject}：{m.value}</p>)}</details>}</details>
    </aside></div>
  </>;
}
