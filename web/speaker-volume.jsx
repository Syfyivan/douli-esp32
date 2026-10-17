import React, { useEffect, useRef, useState } from "react";
import { RefreshCw, Volume2 } from "lucide-react";
import "./speaker-volume.css";

export function SpeakerVolume({ device, api, Button, Field, notify }) {
  const [reading, setReading] = useState(null), [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const request = useRef(0);
  const path = "/devices/" + encodeURIComponent(device.id) + "/volume";
  const load = async () => {
    const version = ++request.current;
    setBusy(true); setError("");
    try {
      const result = await api(path);
      if (version !== request.current) return;
      setReading(result); setDraft(result.value);
    } catch (e) { if (version === request.current) setError(e.message); }
    finally { if (version === request.current) setBusy(false); }
  };
  useEffect(() => {
    setReading(null); setDraft(null); setError(""); setBusy(false);
    if (device.online) void load();
    return () => { request.current++; };
  }, [device.id, device.online]);
  const apply = async () => {
    const version = ++request.current;
    setBusy(true); setError("");
    try {
      const result = await api(path, "PUT", { value: draft });
      if (version !== request.current) return;
      if (Number.isInteger(result.value)) { setReading(result); setDraft(result.value); }
      if (result.status !== "applied") { setError(result.text); notify(result.text, true); }
      else notify(result.text);
    } catch (e) { if (version === request.current) { setError(e.message); notify(e.message, true); } }
    finally { if (version === request.current) setBusy(false); }
  };
  return <div className="speaker-volume">
    <div className="row-title"><Volume2 size={18} /><b>{device.name}</b><span className={"tag " + (device.online ? "" : "gray")}>{device.online ? "已连接" : "未连接"}</span></div>
    {!device.online ? <p className="small muted">音箱连接后可在这里调整音量。</p> : <>
      {reading && <Field label={`${reading.hardware ? "扬声器音量" : "播放音量"} · ${draft}%`} hint="拖动后点击应用音量，立即调整这台音箱。">
        <input aria-label={`${device.name}音量`} type="range" min="0" max="100" step="1" value={draft ?? 0} disabled={busy} onChange={e => setDraft(Number(e.target.value))} />
      </Field>}
      <div className="row-actions"><Button primary disabled={busy || !reading || draft === reading.value} onClick={apply}>{busy ? "处理中…" : "应用音量"}</Button><Button icon={RefreshCw} disabled={busy} onClick={load}>读取当前音量</Button></div>
      {error && <p className="small" role="alert">{error}</p>}
    </>}
  </div>;
}
