import React, { useEffect, useRef, useState } from "react";

const labels = { computer: "固定电脑", phone: "固定手机", auto: "自动选择" };

export function BackendSelection({ id, api, Button, Field, notify }) {
  const [status, setStatus] = useState(null), [mode, setMode] = useState("computer");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const initialized = useRef(false);
  useEffect(() => {
    let cancelled = false, timer;
    const refresh = async () => {
      try {
        const value = await api(`/devices/${encodeURIComponent(id)}/backend`);
        if (!cancelled) {
          setStatus(value); setError("");
          if (!initialized.current) { setMode(value.mode); initialized.current = true; }
        }
      } catch (e) { if (!cancelled) setError(e.message); }
      if (!cancelled) timer = setTimeout(refresh, 4000);
    };
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [id, api]);
  const available = kind => status?.targets.some(t => t.kind === kind && t.available);
  const canSelect = kind => kind === "auto" ? available("computer") && available("phone") : available(kind);
  const switching = status?.requested?.phase === "switching";
  const apply = async () => {
    setBusy(true); setError("");
    try {
      const request = await api(`/devices/${encodeURIComponent(id)}/backend`, "POST", { mode });
      setStatus(s => ({ ...s, requested: { ...request, phase: "switching" } }));
      notify("板子已接受请求，正在确认新连接");
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  return <div className="backend-selection">
    <strong>板子连接哪个后台</strong>
    <p className="small">{status?.current
      ? `当前连接：${status.current.name}（${status.current.kind === "phone" ? "手机" : "电脑"}）${status.current.standby ? " · 在线待机" : ""}`
      : status ? "当前未确认板子的连接，请检查两端服务和网络。" : "正在检查连接…"}</p>
    <div className="grid two">
      <Field label="连接方式" hint={`当前生效：${labels[status?.mode] || "正在检查"}`}>
        <select value={mode} onChange={e => setMode(e.target.value)} disabled={busy || switching}>
          {Object.entries(labels).map(([value, label]) => <option key={value} value={value} disabled={!canSelect(value)}>{label}{!canSelect(value) ? "（暂不可用）" : ""}</option>)}
        </select>
      </Field>
      <div className="row-actions"><Button onClick={apply} disabled={busy || switching || !status?.supported || !canSelect(mode)}>
        {busy || switching ? "正在切换…" : "应用连接方式"}
      </Button></div>
    </div>
    <p className="small muted">固定模式只连接所选后台。自动模式新建连接时优先电脑，无法连接再尝试手机；已连接正常时保持当前后台。应用设置会结束当前对话。</p>
    {status?.targets.map(t => <p className="small muted" key={t.kind}>{t.kind === "phone" ? "手机" : "电脑"}：{t.available ? `可用 · ${t.scope}` : t.reason}</p>)}
    {status?.current && !status.supported && <p className="notice">需要支持后台切换的新版板子固件。</p>}
    {status?.requested?.phase === "switching" && <p role="status" className="notice">请求已接受，等待板子确认新连接；失败时会恢复之前的设置。</p>}
    {status?.requested?.phase === "applied" && <p role="status" className="notice">板子已确认：{labels[status.requested.mode]}。</p>}
    {status?.requested?.phase === "failed" && <p role="alert" className="notice">新后台未能连接，板子已恢复之前的设置。</p>}
    {status?.requested?.phase === "unconfirmed" && <p role="alert" className="notice">暂未收到切换结果，请检查网络和后台；当前没有确认切换成功。</p>}
    {error && <p role="alert" className="health-error">{error}</p>}
  </div>;
}
