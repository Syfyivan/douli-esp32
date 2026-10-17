import React, { useEffect, useRef, useState } from "react";
import { Monitor, RefreshCw, Send, Square, X } from "lucide-react";
import "./computer.css";

const labels = { queued: "等待启动", creating: "正在创建会话", starting: "等待 Agent 就绪", sending: "正在提交", accepted: "指令已接收",
  running: "正在执行", waiting: "请在 Orca 查看", stopping: "正在停止", interrupted: "已停止", completed: "本轮已返回", closed: "会话已关闭", failed: "未能执行", uncertain: "提交待核对" };

export function ComputerTasksPanel({ api, notify, Section, Field, Button, Toggle, platform }) {
  const [config, setConfig] = useState(null), [catalog, setCatalog] = useState(null), [connection, setConnection] = useState("");
  const [tasks, setTasks] = useState([]), [selected, setSelected] = useState(null), [detail, setDetail] = useState(null);
  const [instruction, setInstruction] = useState(""), [followup, setFollowup] = useState(""), [busy, setBusy] = useState("");
  const [loadError, setLoadError] = useState("");
  const pending = useRef(new Map());
  useEffect(() => {
    let alive = true, timer;
    const load = async () => {
      try {
        const data = await api("/computer");
        if (!alive) return;
        setConfig(old => old || data.config); setTasks(data.tasks); setLoadError("");
        if (selected) {
          const task = await api(`/computer/tasks/${selected}`);
          if (alive) setDetail(task);
        }
      } catch (error) { if (alive) setLoadError(error.message); }
      finally { if (alive) timer = setTimeout(load, 3000); }
    };
    void load(); return () => { alive = false; clearTimeout(timer); };
  }, [selected]);
  const run = async (name, fn) => {
    setBusy(name);
    try { await fn(); }
    catch (error) { notify(error.message, true); }
    finally { setBusy(""); }
  };
  const connect = () => run("connect", async () => {
    const data = await api("/computer/catalog"); setCatalog(data); setConnection(`已连接 Orca ${data.version || ""}`);
  });
  const submit = async (path, body) => {
    const signature = JSON.stringify([path, body]);
    // Preserve the request key after a lost HTTP response so retrying cannot
    // create another terminal or submit the same follow-up twice.
    if (!pending.current.has(signature)) pending.current.set(signature, crypto.randomUUID());
    const task = await api(path, "POST", { ...body, requestKey: pending.current.get(signature) });
    pending.current.delete(signature); setSelected(task.id); setDetail(task);
    const data = await api("/computer"); setTasks(data.tasks);
    return task;
  };
  if (platform === "android") return <Section title="电脑任务"><p>请在运行 Orca 的电脑上打开豆梨并配置此功能。手机后台不能直接调用电脑上的 Orca。</p></Section>;
  if (!config) return <Section title="电脑任务"><p role="status">{loadError || "正在读取电脑任务…"}</p></Section>;
  return <Section title="电脑任务" subtitle="让 Orca 里的 Codex 接手一项工作。结束聊天后，任务仍会继续。">
    {loadError && <p role="status" className="computer-notice">暂时无法刷新任务：{loadError}</p>}
    <div className="computer-settings">
      <Toggle label="允许豆梨调用本机 Orca" checked={config.enabled} onChange={enabled => setConfig({ ...config, enabled })} hint="可新建任务，也可指定已有会话继续。权限确认和登录提示仍在 Orca 中处理。" />
      <div className="computer-actions">
        <Button icon={RefreshCw} disabled={!!busy} onClick={connect}>{busy === "connect" ? "正在连接…" : "检查连接与项目"}</Button>
        <span role="status" className="small muted">{connection}</span>
      </div>
      <Field label="默认项目">
        <select value={config.defaultWorktree} onChange={e => setConfig({ ...config, defaultWorktree: e.target.value })}>
          <option value="">请选择工作区</option>
          {config.defaultWorktree && !catalog?.worktrees.some(w => w.id === config.defaultWorktree) && <option value={config.defaultWorktree}>已保存的项目（检查连接后查看名称）</option>}
          {catalog?.worktrees.map(w => <option key={w.id} value={w.id}>{w.label} — {w.path}</option>)}
        </select>
      </Field>
      <details><summary>Orca 路径设置</summary><Field label="Orca 原生 CLI 路径" hint="通常留空即可自动查找；Windows 使用 resources/bin/orca.exe。"><input value={config.cliPath} onChange={e => setConfig({ ...config, cliPath: e.target.value })} placeholder="自动查找" /></Field></details>
      <Button disabled={!!busy} onClick={() => run("save", async () => { setConfig(await api("/computer/config", "PUT", config)); notify("电脑任务设置已保存"); })}>{busy === "save" ? "保存中…" : "保存电脑任务设置"}</Button>
    </div>
    <form className="computer-new" onSubmit={e => { e.preventDefault(); void run("create", async () => { await submit("/computer/tasks", { instruction, project: config.defaultWorktree }); setInstruction(""); notify("任务已加入，正在等待 Orca 执行"); }); }}>
      <Field label="交给 Orca 的任务"><textarea rows={3} maxLength={12000} value={instruction} onChange={e => setInstruction(e.target.value)} placeholder="例如：检查这个项目的测试覆盖，先给出改进建议。" /></Field>
      <Button primary icon={Send} type="submit" disabled={!!busy || !config.enabled || !instruction.trim()}>{busy === "create" ? "正在安排…" : "交给 Orca"}</Button>
      <p className="small muted">也可以直接说：“让 Orca 帮我检查豆梨项目”“刚才的电脑任务怎么样了”“停止那个任务”。</p>
    </form>
    <div className="computer-workspace">
      <div className="computer-task-list" aria-label="电脑任务列表">
        {!tasks.length && <div className="computer-empty"><Monitor size={24} /><p>还没有电脑任务</p></div>}
        {tasks.map(task => <button key={task.id} className={selected === task.id ? "selected" : ""} onClick={() => { setSelected(task.id); setDetail(null); setFollowup(""); }}>
          <strong>{task.title}</strong><span>{labels[task.state] || task.state} · {task.project.name}</span><small>{new Date(task.updatedAt).toLocaleString()}</small>
        </button>)}
      </div>
      <div className="computer-task-detail" aria-live="polite">
        {!selected ? <p className="muted">选择任务查看进度和结果，或继续追问。</p> : !detail ? <p>正在读取任务…</p> : <>
          <div className="computer-detail-heading"><h3>{detail.title}</h3><span>{labels[detail.state] || detail.state}</span></div>
          <p className="small muted">{detail.project.name} · 第 {detail.turn} 轮{detail.lastCheckedAt ? ` · 最近检查 ${new Date(detail.lastCheckedAt).toLocaleTimeString()}` : ""}</p>
          {(detail.error || detail.observationError) && <p className="computer-notice" role="status">{detail.error || detail.observationError}</p>}
          {detail.state === "waiting" && <p className="computer-notice">请在 Orca 查看是否需要确认权限或补充信息。</p>}
          <div className="computer-actions">
            <Button icon={RefreshCw} disabled={!!busy} onClick={() => run("refresh", () => submit(`/computer/tasks/${selected}/refresh`, {}))}>刷新进度</Button>
            <Button icon={Square} disabled={!!busy || !detail.canStop} onClick={() => run("stop", () => submit(`/computer/tasks/${selected}/stop`, {}))}>停止任务</Button>
            <Button icon={X} disabled={!!busy || !detail.canClose} onClick={() => run("close", () => submit(`/computer/tasks/${selected}/close`, {}))}>关闭 Orca 会话</Button>
          </div>
          <details className="computer-history"><summary>已发送的要求 · {detail.turn} 轮</summary>{detail.turns.map((turn, i) => <p key={i}>{i + 1}. {turn.instruction}</p>)}</details>
          <p className="small muted">最近终端输出（较长内容可能截断）。“本轮已返回”表示 Agent 已结束本轮，具体完成情况以输出中的验证结果为准。</p>
          <pre className="computer-output">{detail.output || "尚未收到输出。"}</pre>
          {detail.state !== "closed" && <form onSubmit={e => { e.preventDefault(); void run("followup", async () => { await submit(`/computer/tasks/${selected}/followup`, { instruction: followup }); setFollowup(""); }); }}>
            <Field label="继续这个任务"><textarea rows={2} maxLength={12000} value={followup} onChange={e => setFollowup(e.target.value)} placeholder={detail.canFollowup ? "补充要求或追问结果" : "当前一轮结束或停止后，可以继续追问"} /></Field>
            <Button icon={Send} type="submit" disabled={!!busy || !detail.canFollowup || !config.enabled || !followup.trim()}>发送追问</Button>
          </form>}
        </>}
      </div>
    </div>
  </Section>;
}
