import React, { useEffect, useState } from "react";
import { Plus, BookOpen, ChevronRight, LockKeyhole } from "lucide-react";
import "./diary.css";

const day = value => new Date(value).toLocaleDateString("sv-SE");
const date = value => new Date(value).toLocaleString("zh-CN", { year: "numeric", month: "short", day: "numeric" });
const origin = { automatic: "自动整理", edited: "已手动修订", manual: "手动记录" };
const emptyFilters = { q: "", from: "", until: "", topic: "", kind: "" };
function queryFor(filters, offset) {
  const params = new URLSearchParams({ q: filters.q, topic: filters.topic, kind: filters.kind, offset, limit: 30 });
  if (filters.from) params.set("from", filters.from);
  if (filters.until) {
    const end = new Date(filters.until + "T00:00:00"); end.setDate(end.getDate() + 1);
    params.set("to", day(end));
  }
  return params;
}

export function DiaryPage({ state, api, act, notify, Button, Field, openConversation, renderSummaries }) {
  const [filters, setFilters] = useState(emptyFilters), [draft, setDraft] = useState(emptyFilters);
  const [offset, setOffset] = useState(0), [refresh, setRefresh] = useState(0), [data, setData] = useState(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [editor, setEditor] = useState(null), [busy, setBusy] = useState(false), [sources, setSources] = useState({});
  const [removing, setRemoving] = useState(null);
  const [summaries, setSummaries] = useState(false);
  const revision = JSON.stringify((state.memorySummaries || []).map(s => [s.id, s.source_hash, s.updated_at]));
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError("");
    api("/memory/diary?" + queryFor(filters, offset)).then(result => {
      if (cancelled) return;
      if (offset && offset >= result.total) { setOffset(Math.max(0, offset - 30)); return; }
      setData(result); setSources({});
    }).catch(e => { if (!cancelled) { setData(null); setError(e.message); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [filters, offset, refresh, revision]);
  const reload = () => setRefresh(n => n + 1);
  const save = async e => {
    e.preventDefault(); if (busy) return; setBusy(true);
    try {
      await act(async () => {
        const saved = await api("/memory/diary" + (editor.id ? "/" + editor.id : ""), editor.id ? "PUT" : "POST", {
          ...editor,
          // Preserve a known clock time when only the text or topics were edited.
          occurredAt: editor.originalAt && day(editor.originalAt) === editor.occurredAt ? editor.originalAt : editor.occurredAt,
          endedAt: editor.originalUntil && day(editor.originalUntil) === editor.endedAt ? editor.originalUntil : editor.endedAt || null,
        });
        setEditor(null); setDraft(emptyFilters); setFilters(emptyFilters); setOffset(0); reload();
        notify(saved.origin === "manual" ? "生活记录已保存" : "记录已修订，原话保留");
      });
    } finally { setBusy(false); }
  };
  const edit = row => setEditor({ id: row.id, revision: row.revision, text: row.text, kind: row.kind, topics: row.topics,
    occurredAt: day(row.occurred_at), endedAt: row.ended_at ? day(row.ended_at) : "", originalAt: row.occurred_at, originalUntil: row.ended_at });
  const remove = async row => {
    if (busy) return; setBusy(true);
    try {
      await act(async () => {
        await api("/memory/diary/" + row.id, "DELETE", { revision: row.revision });
        setRemoving(null); reload(); notify("已移除记录，聊天原话保留");
      });
    } finally { setBusy(false); }
  };
  if (summaries) return <><Button onClick={() => setSummaries(false)}>返回生活记录</Button>{renderSummaries()}</>;
  return <div className="diary-page">
    <div className="profile-description"><div><h2>把日子，一件件记下来</h2><p>经历和计划分开记录，按发生日期回看，也能找到当时的原话。</p></div>
      <Button primary icon={Plus} onClick={() => setEditor({ text: "", kind: "event", occurredAt: day(new Date()), endedAt: "", topics: [] })}>记一件事</Button></div>
    <div className="personal-layout"><div>
      <form className="card diary-filters" onSubmit={e => { e.preventDefault(); setFilters({ ...draft }); setOffset(0); }}>
        <Field label="查找生活记录"><input value={draft.q} maxLength={500} placeholder="人物、事情或关键词" onChange={e => setDraft({ ...draft, q: e.target.value })} /></Field>
        <div className="grid two"><Field label="开始日期"><input type="date" value={draft.from} onChange={e => setDraft({ ...draft, from: e.target.value })} /></Field>
          <Field label="结束日期"><input type="date" min={draft.from || undefined} value={draft.until} onChange={e => setDraft({ ...draft, until: e.target.value })} /></Field>
          <Field label="生活主题"><select value={draft.topic} onChange={e => setDraft({ ...draft, topic: e.target.value })}><option value="">全部主题</option>{Object.entries(data?.topics || {}).map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></Field>
          <Field label="记录类型"><select value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value })}><option value="">经历与计划</option><option value="event">已经发生的经历</option><option value="plan">未来计划</option></select></Field></div>
        <div className="memory-actions"><Button type="submit" disabled={loading}>筛选记录</Button><Button type="button" onClick={() => { setDraft(emptyFilters); setFilters(emptyFilters); setOffset(0); }}>清除条件</Button></div>
      </form>
      {editor && <form className="card diary-editor" onSubmit={save}>
        <h3>{editor.id ? "修订这件事" : "记一件事"}</h3>
        <Field label="记录内容"><textarea value={editor.text} onChange={e => setEditor({ ...editor, text: e.target.value })} required maxLength={2000} rows={4} /></Field>
        <div className="grid two"><Field label="经历还是计划"><select value={editor.kind} onChange={e => setEditor({ ...editor, kind: e.target.value })}><option value="event">已经发生的经历</option><option value="plan">未来计划</option></select></Field>
          <Field label="发生日期"><input type="date" required value={editor.occurredAt} onChange={e => setEditor({ ...editor, occurredAt: e.target.value })} /></Field>
          <Field label="结束日期（可选）"><input type="date" min={editor.occurredAt} value={editor.endedAt} onChange={e => setEditor({ ...editor, endedAt: e.target.value })} /></Field></div>
        <fieldset className="diary-topics"><legend>生活主题（可多选）</legend>{Object.entries(data?.topics || {}).map(([id, label]) => <label key={id}><input type="checkbox" checked={editor.topics.includes(id)} onChange={e => setEditor({ ...editor, topics: e.target.checked ? [...editor.topics, id] : editor.topics.filter(t => t !== id) })} />{label}</label>)}</fieldset>
        <div className="memory-actions"><Button primary type="submit" disabled={busy}>{busy ? "正在保存…" : "保存记录"}</Button><Button type="button" disabled={busy} onClick={() => setEditor(null)}>取消编辑</Button></div>
      </form>}
      {error && <p className="notice" role="alert">{error} <Button onClick={reload}>重新加载</Button></p>}
      <p className="small muted" aria-live="polite">{loading ? "正在读取记录…" : data ? `找到 ${data.total} 条记录` : ""}</p>
      <div className="experience-stream">{!loading && data?.total === 0 && <div className="card empty-small"><BookOpen size={28} /><h3>这里还没有符合条件的记录</h3><p>可以记下一件事，或在设置中开启「整理近期经历」，从之后的对话中积累。</p></div>}
        {!loading && data?.items.map(row => <article className="experience-entry" key={row.id}>
          <div className="experience-date"><strong>{date(row.occurred_at)}</strong><i /></div><section className="card">
            <div className="row-title"><BookOpen size={17} /><h3>{row.kind === "plan" ? "未来计划" : "生活经历"}</h3><span className="tag">{origin[row.origin] || "自动整理"}</span></div>
            <p className="experience-body">{row.text}</p><div className="diary-tags">{row.topics.length ? row.topics.map(t => <span className="tag" key={t}>{data.topics[t]}</span>) : <span className="small muted">未分类</span>}</div>
            <p className="small muted">记录于 {date(row.recorded_at)}{row.ended_at ? ` · 结束于 ${date(row.ended_at)}` : ""}</p>
            <div className="memory-actions"><Button onClick={() => edit(row)}>修订记录</Button>
              <Button onClick={() => act(async () => { const result = await api("/memory/episodes/" + row.id + "/sources"); setSources(old => ({ ...old, [row.id]: result })); })}>查看原话<ChevronRight size={13} /></Button>
              <Button danger onClick={() => setRemoving(row)}>移除记录</Button></div>
            {removing?.id === row.id && <div className="notice" role="group" aria-label="移除生活记录确认"><p>从生活记录和经历检索中移除这条？聊天原话仍会保留，可在原对话中另行删除。</p><div className="memory-actions"><Button danger disabled={busy} onClick={() => remove(removing)}>确认移除</Button><Button disabled={busy} onClick={() => setRemoving(null)}>保留记录</Button></div></div>}
            {sources[row.id]?.map((m, i) => <blockquote key={m.id + ":" + i}>{m.quote}<footer>{date(m.created_at)} · 当时的原话</footer><Button onClick={() => openConversation(m.session_id)}>打开原对话</Button></blockquote>)}
          </section></article>)}
      </div>
      {data && data.total > 30 && <div className="memory-actions"><Button disabled={loading || !offset} onClick={() => setOffset(n => Math.max(0, n - 30))}>上一页</Button><span>{Math.floor(offset / 30) + 1} / {Math.ceil(data.total / 30)}</span><Button disabled={loading || offset + 30 >= data.total} onClick={() => setOffset(n => n + 30)}>下一页</Button></div>}
      <p className="profile-foot"><LockKeyhole size={13} />记录保存在服务所在设备，原话与修订后的内容分别保留。</p>
    </div><aside><div className="profile-help"><BookOpen size={21} /><h3>记录生活，保留原意</h3><p>一次经历不会自动变成长期偏好。未来计划也不会因为日期过去就被标成已完成。</p><p>自动分类可能有遗漏，你可以调整内容、日期和主题。检查报告、病史与用药请在「健康资料」中管理。</p><p>修订或移除后，这段原话的经历交由你维护，后台不会自动覆盖。更正或删除原话会使相关整理记录失效。</p><Button onClick={() => setSummaries(true)}>按天或对话回顾</Button></div></aside></div>
  </div>;
}
