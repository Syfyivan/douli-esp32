import React, { useEffect, useRef, useState } from "react";
import { HeartPulse, Plus, Trash2, FileText, Search, Download, RefreshCw, ChevronRight, ShieldCheck, Folder, Upload } from "lucide-react";
import "./health.css";
import { personUrl } from "./person-context.mjs";

const kinds = { condition: "已确认病史", allergy: "过敏记录", medication: "用药记录", background: "其他健康背景" };
const categories = { guideline: "诊疗指南", label: "药品说明书", patient: "疾病与检查解释", review: "证据综述" };
const blankFact = { kind: "condition", name: "", detail: "", generic: "", ingredients: "", formulation: "", strength: "", dose: "", frequency: "", manufacturer: "", approval: "", start: "", end: "", status: "active" };
const showDate = value => value ? new Date(value).toLocaleString("zh-CN") : "未标明";
async function base64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onerror = reject;
    reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.readAsDataURL(file);
  });
}
export async function pdfPages(bytes) {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false,
    cMapUrl: "/pdfjs/cmaps/", cMapPacked: true, standardFontDataUrl: "/pdfjs/standard_fonts/",
    wasmUrl: "/pdfjs/wasm/", iccUrl: "/pdfjs/iccs/" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void task.destroy().catch(() => {}); }, 60000);
  try {
    const doc = await task.promise;
    if (doc.numPages > 12) throw new Error("一次支持最多12页，请拆分后上传，避免漏读");
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const text = content.items.map(item => item.str + (item.hasEOL ? "\n" : " ")).join("");
      // Include the rendered page even for text PDFs: table order may be lost in extraction.
      const original = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(1.5, 1500 / Math.max(original.width, original.height)) });
      const canvas = document.createElement("canvas"); canvas.width = viewport.width; canvas.height = viewport.height;
      const context = canvas.getContext("2d");
      // This is an offscreen document conversion. Display rendering waits for
      // animation frames, which may stop when a browser/WebView is backgrounded.
      await page.render({ canvasContext: context, viewport, intent: "print" }).promise;
      pages.push({ text, image: canvas.toDataURL("image/jpeg", 0.8) });
      canvas.width = 0; canvas.height = 0; page.cleanup();
    }
    return pages;
  } catch (error) {
    if (timedOut) throw new Error("PDF解析超时，请拆分文件后重试或手动录入");
    throw error;
  } finally { clearTimeout(timer); await task.destroy(); }
}

export function EvidenceCards({ answer, evidence }) {
  return <div className="health-evidence">
    {answer?.citationWarnings?.length > 0 && <p className="health-note">{[...new Set(answer.citationWarnings)].join(" ")}</p>}
    {answer?.citations?.map((citation, i) => <details key={citation.sourceId}>
      <summary>依据 {i + 1} · {citation.source.title}</summary>
      <p>{citation.claim}</p><blockquote>{citation.excerpt}</blockquote>
      <p className="small muted">{citation.source.organization} · {citation.source.region} · 发布：{citation.source.published || "未标明"}</p>
      <p className="small">{citation.source.limitation}{citation.source.stale ? " · 已到复核日期" : ""}</p>
      <a href={/^https:\/\//.test(citation.source.url) ? citation.source.url : undefined} target="_blank" rel="noreferrer">查看原文 ↗</a>
    </details>)}
    {evidence && <details><summary>本次检索 · {evidence.sources?.length || 0} 条资料{evidence.cached ? " · 使用24小时内缓存" : ""}</summary>
      <p className="small muted">检索时间：{showDate(evidence.searchedAt)}</p>
      {evidence.services?.map((s, i) => <p key={i}>{s.name}：{{ retrieved: "已检索", empty: "未找到", failed: "暂不可用" }[s.status]} {s.message || ""}</p>)}
      {evidence.sources?.map(s => <p key={s.id}><a href={/^https:\/\//.test(s.url) ? s.url : undefined} target="_blank" rel="noreferrer">{s.title}</a><small> · {s.region} · {s.published || "日期未核实"}{s.stale ? " · 需要复核" : ""}<br />{s.limitation}</small></p>)}
    </details>}
  </div>;
}
function Answer({ turn }) {
  const a = turn.answer;
  return <article className="health-answer">
    <div className="health-question">{turn.question}</div>
    {a.urgency === "emergency" && <p className="health-urgent" role="alert">请优先处理紧急情况，及时联系当地急救。</p>}
    <p className="health-spoken">{a.spoken}</p>
    <details open><summary>详细解释</summary><p className="health-prose">{a.explanation}</p></details>
    {!!a.nextSteps?.length && <><h3>下一步</h3><ul>{a.nextSteps.map((v, i) => <li key={i}>{v}</li>)}</ul></>}
    {!!a.questions?.length && <><h3>还需要了解</h3><ul>{a.questions.map((v, i) => <li key={i}>{v}</li>)}</ul></>}
    <EvidenceCards answer={a} evidence={turn.evidence} />
    <small className="muted">{showDate(turn.at)}</small>
  </article>;
}
function ReportPreview({ id, onClose }) {
  const [pages, setPages] = useState([]), [error, setError] = useState("");
  useEffect(() => {
    let disposed = false, objectUrl;
    (async () => {
      const response = await fetch(personUrl(`/api/medical/reports/${id}/file`));
      if (!response.ok) throw new Error("原始报告无法打开");
      if (response.headers.get("Content-Type")?.includes("pdf")) {
        const parsed = await pdfPages(new Uint8Array(await response.arrayBuffer()));
        if (!disposed) setPages(parsed.map(p => p.image));
      } else { objectUrl = URL.createObjectURL(await response.blob()); if (!disposed) setPages([objectUrl]); }
    })().catch(e => { if (!disposed) setError(e.message); });
    return () => { disposed = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [id]);
  return <div className="health-preview" role="dialog" aria-modal="true" aria-label="报告原件"><div className="health-preview-toolbar"><strong>报告原件</strong><button onClick={onClose}>关闭原件</button></div>
    {error && <p role="alert">{error}</p>}{!pages.length && !error && <p>正在读取原件…</p>}
    {pages.map((src, i) => <img key={i} src={src} alt={`报告原件第${i + 1}页`} />)}
  </div>;
}
function Trend({ group }) {
  const values = group.points.map(p => p.value), min = Math.min(...values), max = Math.max(...values);
  const dates = group.points.map(p => Date.parse(p.date)), first = Math.min(...dates), last = Math.max(...dates);
  const points = group.points.map((p, i) => ({ ...p, x: 20 + ((dates[i] - first) / (last - first || 1)) * 560,
    y: 110 - ((p.value - min) / (max - min || 1)) * 80 }));
  return <div className="health-trend"><h3>{group.name} <small>{group.unit} {group.specimen}</small></h3>
    {points.length > 1 && <svg viewBox="0 0 600 140" role="img" aria-label={`${group.name}历次结果折线图`}>
      <line x1="20" y1="120" x2="580" y2="120" stroke="#ddd" />
      <polyline points={points.map(p => `${p.x},${p.y}`).join(" ")} fill="none" stroke="currentColor" strokeWidth="2" />
      {points.map((p, i) => <g key={i}><circle cx={p.x} cy={p.y} r="4" fill="currentColor"><title>{p.date}：{p.value} {group.unit}；参考：{p.reference}</title></circle><text x={p.x} y={p.y - 9} textAnchor="middle" fontSize="12">{p.value}</text></g>)}
    </svg>}
    <div className="health-table-wrap"><table><thead><tr><th>日期</th><th>结果</th><th>该次参考范围</th><th>机构</th></tr></thead>
      <tbody>{group.points.map((p, i) => <tr key={i}><td>{p.date}</td><td>{p.value} {group.unit} {p.flag}</td><td>{p.reference || "未提供"}</td><td>{p.facility || "未提供"}</td></tr>)}</tbody></table></div>
  </div>;
}

export function HealthPage({ api, Section, Field, Button, notify }) {
  const [state, setState] = useState(null), [tab, setTab] = useState("overview"), [busy, setBusy] = useState(""), [error, setError] = useState("");
  const [fact, setFact] = useState({ ...blankFact }), [report, setReport] = useState(null), [checked, setChecked] = useState(false);
  const [selected, setSelected] = useState([]), [conversation, setConversation] = useState(null), [turns, setTurns] = useState([]);
  const [reference, setReference] = useState(null), fileInput = useRef(null), [vision, setVision] = useState(null);
  const [preview, setPreview] = useState(null);
  const load = async () => { const data = await api("/medical/state"); setState(data); return data; };
  useEffect(() => { load().catch(e => setError(e.message)); }, []);
  const run = async (label, action) => {
    if (busy) return;
    setBusy(label); setError("");
    try { return await action(); } catch (e) { setError(e.message); } finally { setBusy(""); }
  };
  const remove = item => run("删除中", async () => {
    if (!window.confirm("删除这条健康资料？相关原文件也会删除，已有问答中的历史引用仍会保留。")) return;
    await api("/medical/records/" + item.id, "DELETE", { revision: item.revision });
    if (report?.id === item.id) setReport(null);
    if (conversation === item.id) { setConversation(null); setTurns([]); }
    setSelected(ids => ids.filter(id => id !== item.id)); await load();
  });
  const openReport = r => { setReport(structuredClone(r)); setChecked(!!r.confirmed); };
  const extract = () => run("识别报告中，请稍候", async () => {
    let pages;
    const response = await fetch(personUrl(`/api/medical/reports/${report.id}/file`));
    if (!response.ok) throw new Error("无法读取报告原件");
    if (response.headers.get("Content-Type")?.includes("pdf")) pages = await pdfPages(new Uint8Array(await response.arrayBuffer()));
    const updated = await api(`/medical/reports/${report.id}/extract`, "POST", { revision: report.revision, pages });
    openReport(updated); await load();
  });
  if (!state) return <p role="status">{error || "正在打开健康资料…"}</p>;
  return <div className="health-page">
    {preview && <ReportPreview id={preview} onClose={() => setPreview(null)} />}
            <input ref={fileInput} className="health-file-input" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; if (file) run("保存报告原件", async () => { if (file.size > 10 * 1024 * 1024) throw new Error("报告不能超过10MB"); setTab("reports"); openReport(await api("/medical/reports", "POST", { file: { name: file.name, mime: file.type, base64: await base64(file) } })); await load(); }); }} />
    <div className="profile-description"><div><h2>健康资料，妥善收好</h2><p>检查报告、健康背景和用药记录，放在一起方便回看。</p></div><Button primary icon={Plus} disabled={!!busy} onClick={() => fileInput.current.click()}>上传报告</Button></div>
    <div className="health-tabs" role="tablist" aria-label="健康资料分类">{[["overview", "资料概览"], ["reports", "检查报告"], ["profile", "健康档案"], ["sources", "医学资料"], ["consult", "过去的健康问答"]].map(([id, title]) => <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{title}</button>)}</div>
    {tab === "overview" && <div className="health-collection"><div><Section title="我的检查报告" subtitle="原件与核对后的内容，一起保留。" action={<Button onClick={() => setTab("reports")}>管理报告<ChevronRight size={14} /></Button>}>
      <div className="document-table"><div className="document-head"><span>报告名称</span><span>检查日期</span><span>状态</span><span /></div>{state.reports.map(r => <div className="document-row" key={r.id}><div><strong><FileText size={16} />{r.title}</strong><small>{r.facility || "检查机构未填写"} · {r.observations.length} 项</small></div><span>{r.date || "待核对"}</span><span className={"tag " + (r.confirmed ? "" : "amber")}>{r.confirmed ? "已核对" : "待核对"}</span><Button onClick={() => { openReport(r); setTab("reports"); }}>查看</Button></div>)}{!state.reports.length && <p className="empty-small">还没有检查报告。可以上传原件，也可以手动录入。</p>}</div>
      <button className="document-upload" disabled={!!busy} onClick={() => fileInput.current.click()}><Upload size={24} /><strong>添加一份检查报告</strong><span>支持 PDF、JPG、PNG、WebP · 每份不超过 10MB</span></button>
    </Section><Section title="最近更新">{[...state.reports, ...state.facts].sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))).slice(0, 5).map(item => <div className="data-row" key={item.id}><div><b>{item.title || item.name}</b><small className="muted">{showDate(item.updatedAt)}</small></div><span className="tag">{item.title ? "检查报告" : kinds[item.factType]}</span></div>)}{!state.reports.length && !state.facts.length && <p className="small muted">添加资料后，这里会显示最近的更新。</p>}</Section></div>
      <aside><Section title="我的健康档案">{Object.entries(kinds).map(([kind, title]) => <button className="health-folder" key={kind} onClick={() => { setFact({ ...blankFact, kind }); setTab("profile"); }}><span className="mini-icon"><Folder size={19} /></span><span><strong>{title}</strong><small>{state.facts.filter(f => f.factType === kind).length} 条记录</small></span><ChevronRight size={16} /></button>)}</Section><div className="profile-help"><ShieldCheck size={22} /><h3>隐私，由你掌握</h3><p>健康资料使用本机密钥加密保存。上传报告先保存在本机，点击识别后才会发送给你配置的模型。</p><p>只把你明确确认的内容记入档案。</p></div></aside>
    </div>}
    {error && <p className="health-error" role="alert">{error}</p>}
    {busy && <p className="health-note" role="status">{busy}…</p>}
    {tab === "consult" && <>
      {!state.consultations.length && <Section title="过去的健康问答"><p className="muted">还没有健康问答记录。</p></Section>}
      {turns.map((turn, i) => <Answer key={i} turn={turn} />)}
      {state.consultations.length > 0 && <Section title="过去的健康问答">{state.consultations.map(c => <div className="health-list-row" key={c.id}><button onClick={() => { setConversation(c.id); setTurns(c.turns); setSelected((c.turns.at(-1)?.reportIds || []).filter(id => state.reports.some(r => r.id === id && r.confirmed))); }}>{c.title}<small>{showDate(c.updatedAt)}</small></button><Button icon={Trash2} aria-label={`删除${c.title}`} disabled={!!busy} onClick={() => remove(c)} /></div>)}</Section>}
    </>}
    {tab === "profile" && <>
      <Section title="已确认的健康资料" subtitle="这里只保存你明确确认的信息。用药停用、过敏反应和诊断变化时，请更新日期与状态。">
        {!state.facts.length && <p className="muted">还没有健康档案，可以先填写过敏史和当前用药。</p>}
        {state.facts.map(f => <div className="health-list-row" key={f.id}><button onClick={() => setFact({ ...f, kind: f.factType })}><strong>{f.name}</strong><small>{kinds[f.factType]} · {f.status === "active" ? "当前" : "已结束/停用"} · {f.strength} {f.dose} {f.frequency}</small><small>{f.detail}</small></button><Button icon={Trash2} aria-label={`删除${f.name}`} disabled={!!busy} onClick={() => remove(f)} /></div>)}
      </Section>
      <Section title={fact.id ? "更新健康资料" : "添加健康资料"}>
        <form key={fact.id || "new"} onSubmit={e => { e.preventDefault(); run("保存资料", async () => { await api("/medical/facts", "PUT", { ...fact, confirmed: true }); setFact({ ...blankFact }); await load(); }); }}>
          <div className="grid two"><Field label="资料类型"><select value={fact.kind} onChange={e => setFact(f => ({ ...f, kind: e.target.value }))}>{Object.entries(kinds).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field><Field label="名称"><input value={fact.name} maxLength={200} onChange={e => setFact(f => ({ ...f, name: e.target.value }))} required placeholder="疾病、过敏原或实际药品名称" /></Field></div>
          <Field label="具体情况与来源"><textarea value={fact.detail} maxLength={2000} onChange={e => setFact(f => ({ ...f, detail: e.target.value }))} placeholder="如医生确认的诊断、过敏反应表现、需要保留的健康背景" /></Field>
          {fact.kind === "medication" && <div className="grid two">{[["generic", "通用名"], ["ingredients", "全部活性成分"], ["formulation", "剂型"], ["strength", "规格"], ["dose", "目前每次用量"], ["frequency", "目前使用频率"], ["manufacturer", "生产厂家"], ["approval", "批准文号"]].map(([key, label]) => <Field label={label} key={key}><input value={fact[key] || ""} maxLength={key === "ingredients" ? 500 : 100} onChange={e => setFact(f => ({ ...f, [key]: e.target.value }))} /></Field>)}</div>}
          <div className="grid three"><Field label="开始日期"><input type="date" value={fact.start} onChange={e => setFact(f => ({ ...f, start: e.target.value }))} /></Field><Field label="结束日期"><input type="date" value={fact.end} onChange={e => setFact(f => ({ ...f, end: e.target.value }))} /></Field><Field label="状态"><select value={fact.status} onChange={e => setFact(f => ({ ...f, status: e.target.value }))}><option value="active">当前有效</option><option value="inactive">已结束/停用</option></select></Field></div>
          <label className="health-check"><input type="checkbox" required />我确认以上是自己的实际情况，药品信息已按包装或医嘱核对</label>
          <div className="form-actions"><Button primary disabled={!!busy}>确认并保存</Button>{fact.id && <Button type="button" onClick={() => setFact({ ...blankFact })}>取消编辑</Button>}</div>
        </form>
      </Section>
      <p className="small muted">档案、报告原件和健康问答使用本机密钥加密保存。导出的 JSON 是明文，请自行妥善保管。</p><a className="health-export" href={personUrl("/api/medical/export")} download><Download size={16} /> 导出健康记录</a>
    </>}
    {tab === "reports" && <>
      <Section title="检查报告" subtitle="支持 JPG、PNG、WebP、PDF；每份不超过10MB，PDF不超过12页。上传先保存在本机，点击识别才发送给模型。">
        <div className="form-actions"><Button primary icon={Plus} disabled={!!busy} onClick={() => fileInput.current.click()}>上传报告</Button><Button disabled={!!busy} onClick={() => run("创建报告", async () => { openReport(await api("/medical/reports", "POST", { title: "手动录入的检查报告" })); await load(); })}>手动录入</Button></div>

        {state.reports.map(r => <div className="health-list-row" key={r.id}><button onClick={() => openReport(r)}><FileText size={17} />{r.title}<small>{r.date || "日期待核对"} · {r.confirmed ? "已确认" : "待核对"} · {r.observations.length}项</small></button><Button icon={Trash2} aria-label={`删除${r.title}`} disabled={!!busy} onClick={() => remove(r)} /></div>)}
      </Section>
      {report && <Section title="核对报告" subtitle="请逐项核对日期、数值、单位和参考范围。看不清的项目先查原件，不要猜测。">
        {report.hasFile && <div className="form-actions"><Button onClick={() => setPreview(report.id)}>查看原始报告</Button><Button icon={RefreshCw} disabled={!!busy} onClick={extract}>发送给模型并识别</Button></div>}
        <form onSubmit={e => { e.preventDefault(); run("保存报告", async () => { const updated = await api("/medical/reports/" + report.id, "PUT", { ...report, confirmed: checked }); openReport(updated); await load(); }); }}>
          <div className="grid three">{[["title", "报告名称", "text"], ["date", "检查日期", "date"], ["facility", "检查机构", "text"]].map(([key, label, type]) => <Field label={label} key={key}><input type={type} value={report[key] || ""} required={key === "title" || (key === "date" && checked)} onChange={e => { setChecked(false); setReport(r => ({ ...r, [key]: e.target.value })); }} /></Field>)}</div>
          <Field label="报告原文结论"><textarea rows={3} value={report.summary || ""} maxLength={12000} onChange={e => { setChecked(false); setReport(r => ({ ...r, summary: e.target.value })); }} /></Field>
          <div className="health-observations">{report.observations.map((o, i) => <div className="health-observation" key={i}>
            <div className="grid three">{[["name", "项目"], ["value", "结果原文"], ["unit", "单位"], ["reference", "参考范围原文"], ["flag", "原报告标记"], ["specimen", "标本"]].map(([key, label]) => <Field label={`${label} ${i + 1}`} key={key}><input value={o[key] || ""} required={key === "name" || key === "value"} onChange={e => { setChecked(false); setReport(r => ({ ...r, observations: r.observations.map((v, j) => j === i ? { ...v, [key]: e.target.value } : v) })); }} /></Field>)}</div>
            <div className="health-observation-actions"><label className="health-check"><input type="checkbox" checked={!!o.uncertain} onChange={e => { setChecked(false); setReport(r => ({ ...r, observations: r.observations.map((v, j) => j === i ? { ...v, uncertain: e.target.checked } : v) })); }} />尚未看清，需要核对</label>{o.page && <small>第{o.page}页</small>}<Button type="button" icon={Trash2} aria-label={`删除检查项目${i + 1}`} onClick={() => { setChecked(false); setReport(r => ({ ...r, observations: r.observations.filter((_, j) => j !== i) })); }} /></div>
          </div>)}</div>
          <Button type="button" icon={Plus} onClick={() => { setChecked(false); setReport(r => ({ ...r, observations: [...r.observations, { name: "", value: "", unit: "", reference: "", flag: "", specimen: "", uncertain: false }] })); }}>增加检查项目</Button>
          <label className="health-check"><input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} />我已对照原件核对本份报告，可用于问答与趋势对比</label>
          <div className="form-actions"><Button primary disabled={!!busy}>{checked ? "确认并保存报告" : "保存为待核对草稿"}</Button><Button type="button" onClick={() => setReport(null)}>关闭</Button></div>
        </form>
      </Section>}
      <Section title="历次检查对比" subtitle="按项目、单位和标本分组；不自动换算单位。不同机构或检测方法的数值仍可能不可直接比较。">
        {state.trends.length ? state.trends.map(g => <Trend key={g.key} group={g} />) : <p className="muted">确认报告后，这里会显示数值记录和趋势。</p>}
      </Section>
      <details><summary>报告识别模型</summary><p>默认使用日常模型（{state.visionModel || "未配置"}），需要支持图片输入；也可单独设置。</p>
        <form onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); run("保存识别模型", async () => { await api("/medical/config", "PUT", { revision: state.config.revision, vision: Object.fromEntries(f) }); setVision(null); await load(); }); }}>
          <Field label="服务地址"><input name="baseUrl" defaultValue={state.config.vision.baseUrl} placeholder="https://服务商/v1" /></Field><Field label="模型名称"><input name="model" defaultValue={state.config.vision.model} /></Field><Field label="API Key"><input type="password" name="apiKey" autoComplete="off" placeholder={state.config.vision.hasKey ? "已保存；留空保留" : "填写密钥"} /></Field><Button disabled={!!busy}>保存识别设置</Button>
        </form>
      </details>
    </>}
    {tab === "sources" && <>
      <Section title="资料来源与更新" subtitle="优先选择适用于中国和你的实际药品的资料，每份保留发布机构、版本、日期和适用人群。">
        <p>MedlinePlus.gov：健康主题解释；PubMed：论文摘要检索；DailyMed：美国药品说明书。中文权威网站：{state.searchConfigured ? "已配置" : "需在设置中填写 Brave 搜索密钥"}。</p><p className="small muted">联网结果缓存24小时；引用会显示检索时间与覆盖范围。主题摘要、研究摘要、搜索摘要和说明书节选会分别标明。</p>
        <div className="health-source-links"><a href="https://www.msdmanuals.cn/home" target="_blank" rel="noreferrer">默沙东大众版 ↗</a><a href="https://www.nmpa.gov.cn/directory/web/nmpa/xxgk/ggtg/index.html" target="_blank" rel="noreferrer">药监局说明书修订公告 ↗</a><a href="https://www.nice.org.uk/guidance" target="_blank" rel="noreferrer">NICE 指南 ↗</a></div>
        {state.references.map(r => <div className="health-list-row" key={r.id}><button onClick={() => setReference(r)}>{r.title}<small>{categories[r.category]} · {r.region} · {r.version} · {r.status === "retired" ? "已停用" : r.reviewAfter < new Date().toISOString().slice(0, 10) ? "需要复核" : "使用中"}</small></button><Button icon={Trash2} aria-label={`删除${r.title}`} disabled={!!busy} onClick={() => remove(r)} /></div>)}
        <Button icon={Plus} onClick={() => setReference({ title: "", organization: "", url: "", published: "", reviewAfter: "", region: "中国", category: "guideline", version: "", population: "", text: "", license: "", status: "active" })}>导入有权使用的资料</Button>
      </Section>
      {reference && <Section title={reference.id ? "更新资料与版本" : "导入医学资料"} subtitle="粘贴可保存使用的原文，并填写出处；不要在公共医学资料中放入个人病历。">
        <form onSubmit={e => { e.preventDefault(); run("保存医学资料", async () => { await api("/medical/references", "PUT", { ...reference, authorized: true }); setReference(null); await load(); }); }}>
          <div className="grid two">{[["title", "资料标题", "text"], ["organization", "发布机构", "text"], ["url", "原文链接", "url"], ["version", "版本", "text"], ["published", "发布日期", "date"], ["reviewAfter", "下次复核日期", "date"], ["region", "适用地区", "text"], ["population", "适用人群", "text"], ["license", "保存使用的授权依据", "text"]].map(([key, label, type]) => <Field key={key} label={label}><input type={type} value={reference[key]} required={key !== "population"} onChange={e => setReference(r => ({ ...r, [key]: e.target.value }))} /></Field>)}</div>
          <div className="grid two"><Field label="资料类型"><select value={reference.category} onChange={e => setReference(r => ({ ...r, category: e.target.value }))}>{Object.entries(categories).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field><Field label="状态"><select value={reference.status} onChange={e => setReference(r => ({ ...r, status: e.target.value }))}><option value="active">使用中</option><option value="retired">已被替代/停用</option></select></Field></div>
          <Field label="原文内容"><textarea rows={10} maxLength={60000} required value={reference.text} onChange={e => setReference(r => ({ ...r, text: e.target.value }))} /></Field><label className="health-check"><input type="checkbox" required />我已核对来源，并拥有保存使用这些内容的权限</label>
          <div className="form-actions"><Button primary disabled={!!busy}>保存资料</Button><Button type="button" onClick={() => setReference(null)}>取消</Button></div>
        </form>
      </Section>}
    </>}
  </div>;
}
