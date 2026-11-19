import React, { useEffect, useRef, useState } from "react";

export function PeoplePanel({ state, api, act, notify, Section, Button }) {
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [consent, setConsent] = useState(false);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [sample, setSample] = useState(null);
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState("device");
  const [deviceId, setDeviceId] = useState("");
  const job = state.people.deviceEnrollment;
  const deviceBusy = job && ["waiting", "recording", "uploading"].includes(job.status);
  const locked = busy || recording || deviceBusy;
  const devices = (state.devices || []).filter(device => device.online && device.connection?.persistent);
  const selectedDevice = deviceId || devices[0]?.id || "";
  const capture = useRef(null), mounted = useRef(true);
  useEffect(() => {
    if (!deviceBusy) return;
    const timer = setInterval(() => { void act(async () => {}); }, 1000);
    return () => clearInterval(timer);
  }, [deviceBusy, act]);
  const stop = () => {
    const current = capture.current; if (!current) return;
    capture.current = null; clearInterval(current.timer);
    if (current.worklet) current.worklet.port.onmessage = null;
    current.stream?.getTracks().forEach(track => track.stop());
    current.source?.disconnect(); current.worklet?.disconnect(); current.gain?.disconnect();
    current.context?.close().catch(() => {});
    if (mounted.current) {
      setRecording(false);
      const size = current.frames.reduce((n, frame) => n + frame.byteLength, 0);
      if (size >= 160000) {
        const pcm = new Uint8Array(size); let offset = 0;
        for (const frame of current.frames) { pcm.set(new Uint8Array(frame), offset); offset += frame.byteLength; }
        setSample(pcm);
      } else { setSample(null); if (size) notify("请录满至少 5 秒后再结束", true); }
    }
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; stop(); }; }, []);
  const record = async () => {
    if (capture.current || !consent || !target) return;
    const current = { frames: [], context: new AudioContext() }; capture.current = current;
    setSample(null); setSeconds(0); setRecording(true);
    try {
      await current.context.resume();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
      if (capture.current !== current) { stream.getTracks().forEach(t => t.stop()); return; }
      current.stream = stream;
      await current.context.audioWorklet.addModule(new URL("./capture.js", import.meta.url));
      if (capture.current !== current) return;
      current.source = current.context.createMediaStreamSource(stream);
      current.worklet = new AudioWorkletNode(current.context, "douli-capture");
      const gain = current.context.createGain(); gain.gain.value = 0; current.gain = gain;
      current.source.connect(current.worklet); current.worklet.connect(gain); gain.connect(current.context.destination);
      current.worklet.port.onmessage = ({ data }) => {
        if (capture.current !== current) return;
        current.frames.push(data.pcm);
        if (current.frames.length >= 1500) stop();
      };
      current.timer = setInterval(() => setSeconds(Math.floor(current.frames.length / 50)), 250);
    } catch (error) { if (capture.current === current) stop(); if (mounted.current) notify(error.message, true); }
  };
  const submit = async () => {
    if (busy || !sample || !target || !consent) return;
    setBusy(true);
    try {
      let binary = "";
      for (let i = 0; i < sample.length; i += 8192) binary += String.fromCharCode(...sample.subarray(i, i + 8192));
      await api(`/people/${target}/voiceprint`, "POST", { consent, pcm: btoa(binary) });
      setSample(null); setConsent(false); await act(async () => {}); notify("声纹已录入，请本人在音箱上试说一段话");
    } catch (error) { notify(error.message, true); }
    finally { setBusy(false); }
  };
  return <>
    <Section title="两个人，各自的资料" subtitle="偏好、记忆、对话和健康资料分别保存。旧数据留在“原有档案”，不会自动分给任何人。">
      {state.people.people.map(person => <div className="data-row" key={person.id}>
        <input key={`${person.id}:${person.name}`} aria-label={`${person.name}的称呼`} defaultValue={person.name} maxLength={40}
          onBlur={event => {
            const next = event.target.value.trim();
            if (!next) { event.target.value = person.name; return; }
            if (next !== person.name) act(async () => {
              try { await api(`/people/${person.id}`, "PUT", { name: next }); }
              catch (e) { event.target.value = person.name; throw e; }
            });
          }} />
        <span>{person.enrolled ? "已录入声音" : "尚未录入"}</span>
        {person.enrolled && <Button disabled={locked} onClick={() => act(() => api(`/people/${person.id}/voiceprint`, "DELETE"))}>停用声纹</Button>}
      </div>)}
      <form onSubmit={event => { event.preventDefault(); act(async () => { await api("/people", "POST", { name }); setName(""); }); }}>
        <div className="row-actions"><input aria-label="新档案称呼" placeholder="例如：我、女朋友" value={name} onChange={e => setName(e.target.value)} maxLength={40} /><Button type="submit" disabled={!name.trim()}>添加档案</Button></div>
      </form>
      <p className="small muted">侧栏选择的是当前页面的使用者；音箱会逐句匹配声纹。无法确认时不会读写个人资料。请轮流讲话，避免同时出声。声纹会误判，不能当作身份锁；健康档案需在页面中选择身份后使用。</p>
      <p className="small muted">个人档案目前保存在这台设备，尚不参加跨设备同步。模型、声音和家居设置共用。</p>
    </Section>
    <Section title="录入各自的声音" subtitle="请两位本人分别操作，在安静处用平时的音量自然说话 10–20 秒。">
      <label>录入给谁<select value={target} disabled={locked} onChange={e => { setTarget(e.target.value); setSample(null); setConsent(false); }}><option value="">选择档案</option>{state.people.people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label>录音设备<select value={source} disabled={locked} onChange={e => { setSource(e.target.value); setSample(null); }}><option value="device">音箱麦克风（推荐）</option><option value="browser">此页面的麦克风</option></select></label>
      {source === "device" && <>
        <label>音箱<select value={selectedDevice} disabled={locked} onChange={e => setDeviceId(e.target.value)}>{!devices.length && <option value="">暂无在线音箱</option>}{devices.map(device => <option key={device.id} value={device.id}>{device.name}</option>)}</select></label>
        <p className="small muted">用平常使用的音箱、距离和音量录入。点击后唤醒音箱，直接朗读约 20 秒；录完自动上传，随后恢复待机。</p>
      </>}
      <p>可以读：“你好豆梨，这是我的声音。以后我们聊天时，请把我的日常习惯和偏好记在我的档案里。今天的天气不错，我想安排一下接下来的生活。”</p>
      <p className="small muted">录音会通过临时链接交给火山引擎，提取并保存云端声纹用于匹配。本机不落盘保存注册录音；链接在请求结束或 60 秒后失效。“停用声纹”会停止本地匹配并请求服务端软删除，不等于云端物理删除。</p>
      <label><input type="checkbox" checked={consent} disabled={locked} onChange={e => setConsent(e.target.checked)} /> 我是该档案本人，同意此次录音上传及云端声纹处理</label>
      <div className="row-actions">
        {source === "browser" ? <Button disabled={!target || !consent || busy || deviceBusy || !state.people.enrollmentAvailable} onClick={recording ? stop : record}>{recording ? `结束录音（${seconds} 秒）` : "开始录音"}</Button>
          : <Button disabled={!target || !consent || locked || !selectedDevice || !state.people.enrollmentAvailable} onClick={() => act(() => api(`/people/${target}/voiceprint/device`, "POST", { consent, deviceId: selectedDevice }))}>从音箱录入</Button>}
        {sample && !recording && <Button primary disabled={!consent || busy || deviceBusy} onClick={submit}>{busy ? "正在录入…" : `上传并录入（${(sample.length / 32000).toFixed(1)} 秒）`}</Button>}
        <Button disabled={locked} onClick={() => act(async () => { await api("/people/voiceprint/check", "POST", {}); notify("声纹服务连接成功"); })}>检查连接</Button>
        {deviceBusy && job.status !== "uploading" && <Button onClick={() => act(() => api(`/people/${job.personId}/voiceprint/device`, "DELETE"))}>取消音箱录入</Button>}
      </div>
      {job && <p role="status">{job.status === "waiting" ? "等待唤醒音箱，请直接开始朗读。" : job.status === "recording" ? `正在录音：${Math.floor(job.seconds)} / 20 秒` : job.status === "uploading" ? "正在上传并更新声纹…" : job.status === "completed" ? "声纹已更新，请在音箱前试说几句长短不同的话。" : job.error || "录音已取消"}</p>}
      {!state.people.enrollmentAvailable && <p>尚未配置 HTTPS 设备入口，暂时不能传送注册录音。仍可手动切换个人档案。</p>}
    </Section>
  </>;
}
