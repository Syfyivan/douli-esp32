import React, { useEffect, useState } from "react";

const statusNames = { pending: "排队中", processing: "制作中", completed: "制作完成", failed: "制作失败", not_found: "未找到创建记录", unknown: "提交结果待确认" };
export function AvatarSettings({ settings, api, act, notify, onSaved, Section, Field, Button }) {
  const [key, setKey] = useState(""), [faceId, setFaceId] = useState(settings.faceId), [faceName, setFaceName] = useState(settings.faceName);
  const [connectionMode, setConnectionMode] = useState(settings.connectionMode || "sfu");
  const [faces, setFaces] = useState([]), [busy, setBusy] = useState(false), [job, setJob] = useState(null);
  const [picture, setPicture] = useState(""), [name, setName] = useState("豆梨"), [consent, setConsent] = useState(false);
  const [recoveredId, setRecoveredId] = useState(""), [confirmedAbsent, setConfirmedAbsent] = useState(false);
  useEffect(() => {
    if (!settings.hasKey) return;
    let active = true;
    api("/avatar/generation").then(data => { if (active) setJob(data); }).catch(() => {});
    return () => { active = false; };
  }, [settings.hasKey]);
  useEffect(() => {
    if (!["pending", "processing"].includes(job?.status)) return;
    let active = true;
    const timer = setTimeout(() => api("/avatar/generation").then(data => { if (active) setJob(data); })
      .catch(e => { if (active) notify(e.message, true); }), 15000);
    return () => { active = false; clearTimeout(timer); };
  }, [job]);
  const perform = async action => {
    if (busy) return; setBusy(true);
    try { await action(); } catch (e) { notify(e.message, true); } finally { setBusy(false); }
  };
  const save = async (id = faceId, label = faceName) => {
    const result = await api("/settings", "PUT", { avatar: { apiKey: key.trim(), faceId: id.trim(), faceName: label.trim(), connectionMode } });
    onSaved(result.avatar); setKey("");
    await act(async () => {});
    return result;
  };
  const selectFile = async e => {
    const file = e.target.files?.[0];
    setPicture(""); setConsent(false);
    if (!file) return;
    await perform(async () => {
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size >= 5_000_000) throw new Error("请选择小于 5 MB 的 PNG、JPEG 或 WebP 图片");
      const bitmap = await createImageBitmap(file);
      const valid = bitmap.width >= 512 && bitmap.height >= 512; bitmap.close();
      if (!valid) throw new Error("照片宽和高都需要至少 512 像素");
      const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
      setPicture(data);
    });
  };
  return <>
    <Section title="豆梨的实时形象" subtitle="用一张照片创建豆梨的样子，通话时跟随现有音色实时说话。">
      <p className="small muted">视频通话会将豆梨的回答声音发送到 Simli。你的麦克风仍由现有语音服务识别；形象和音色可分别更换。</p>
      <Field label="Simli API Key"><input type="password" autoComplete="new-password" value={key} placeholder={settings.hasKey ? "已加密保存，留空保持不变" : "填写 Simli API Key"} onChange={e => setKey(e.target.value)} /></Field>
      <Field label="形象编号（Face ID）"><input value={faceId} onChange={e => setFaceId(e.target.value)} /></Field>
      <Field label="形象名称"><input value={faceName} onChange={e => setFaceName(e.target.value)} /></Field>
      <Field label="视频连接线路"><select value={connectionMode} onChange={e => setConnectionMode(e.target.value)}>
        <option value="sfu">中转线路</option><option value="direct">直连线路</option>
      </select><span className="small muted">连接不稳定时可切换线路，保存后重新开始通话生效。</span></Field>
      <div className="row-actions">
        <Button primary disabled={busy} onClick={() => perform(async () => { await save(); notify("实时形象设置已保存"); })}>保存形象设置</Button>
        <Button disabled={busy || !(key || settings.hasKey)} onClick={() => perform(async () => { await save(); const list = await api("/avatar/faces"); setFaces(list); notify("Simli 连接成功，形象列表已刷新"); })}>检查连接 / 刷新形象</Button>
      </div>
      {!!faces.length && <Field label="可用形象"><select value={faceId} onChange={e => { setFaceId(e.target.value); setFaceName(faces.find(f => f.id === e.target.value)?.name || "豆梨"); }}>
        {!faces.some(f => f.id === faceId) && <option value={faceId}>{faceName || "当前形象"}</option>}
        {faces.map(f => <option value={f.id} key={f.id}>{f.name}</option>)}
      </select></Field>}
      <p className="small muted">保存后，在对话页点击「视频通话」。连接期间按 Simli 套餐计费；不用时请结束通话。示例形象可先试聊，之后再换成你的照片。</p>
    </Section>
    <Section title="用照片创建形象" subtitle="创建 Trinity-1 形象会占用 Simli 套餐的形象名额。云端制作需要等待，完成后可重复用于通话。">
      <Field label="新形象名称"><input value={name} maxLength={80} onChange={e => setName(e.target.value)} /></Field>
      <Field label="正面人像照片"><input type="file" accept="image/png,image/jpeg,image/webp" onChange={selectFile} disabled={busy} /></Field>
      <p className="small muted">PNG、JPEG 或 WebP，小于 5 MB，至少 512 × 512。建议单人、正面、无遮挡，头部占图片高度至少 15%。</p>
      {picture && <img className="avatar-photo" src={picture} alt="待上传的形象照片" />}
      <label className="avatar-consent"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />我有权使用这张照片，并同意上传到 Simli 创建云端形象</label>
      <Button primary disabled={busy || !picture || !consent || !(key || settings.hasKey) || ["pending", "processing", "unknown"].includes(job?.status)} onClick={() => perform(async () => {
        await save();
        let data;
        try { data = await api("/avatar/generation", "POST", { image: picture, name }); }
        catch (error) { setJob(await api("/avatar/generation").catch(() => null)); throw error; }
        setJob(data); setPicture(""); setConsent(false); notify("照片已提交，可稍后回来查看创建进度");
      })}>{busy ? "正在处理…" : "上传照片并创建形象"}</Button>
      <p className="small muted">照片仅在内存中转发，本机不另存照片；Simli 会处理照片并保存云端形象。</p>
      {job && <div className="avatar-job" role="status"><strong>{job.name} · {statusNames[job.status] || job.status}</strong>
        {job.queuePosition > 0 && <p>当前排队位置：{job.queuePosition}</p>}{job.note && <p>{job.note}</p>}
        <div className="row-actions"><Button disabled={busy} onClick={() => perform(async () => setJob(await api("/avatar/generation")))}>刷新创建进度</Button>
        {job.status === "completed" && <Button primary disabled={busy} onClick={() => perform(async () => { await save(job.faceId, job.name); setFaceId(job.faceId); setFaceName(job.name); notify("已将这个形象用于豆梨的视频通话"); })}>使用这个形象</Button>}</div>
        {job.status === "unknown" && <>
          <Field label="在 Simli 控制台找到的形象编号"><input value={recoveredId} onChange={e => setRecoveredId(e.target.value)} /></Field>
          <Button disabled={busy || !recoveredId.trim()} onClick={() => perform(async () => setJob(await api("/avatar/generation/resolve", "POST", { faceId: recoveredId.trim() })))}>继续跟踪这个形象</Button>
          <label className="avatar-consent"><input type="checkbox" checked={confirmedAbsent} onChange={e => setConfirmedAbsent(e.target.checked)} />我已核对 Simli 控制台，确认没有这次创建任务</label>
          <Button disabled={busy || !confirmedAbsent} onClick={() => perform(async () => { setJob(await api("/avatar/generation/resolve", "POST", { confirmedAbsent: true })); setConfirmedAbsent(false); })}>允许重新上传</Button>
        </>}
      </div>}
    </Section>
  </>;
}
