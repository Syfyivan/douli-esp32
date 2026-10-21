import React, { useEffect, useRef, useState } from "react";

export function PeoplePanel({ state, api, act, notify, Section, Button }) {
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [consent, setConsent] = useState(false);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [sample, setSample] = useState(null);
  const [busy, setBusy] = useState(false);
  const capture = useRef(null), mounted = useRef(true);
  const stop = () => {
    const current = capture.current; if (!current) return;
    capture.current = null; clearInterval(current.timer);
    current.stream?.getTracks().forEach(track => track.stop());
    current.source?.disconnect(); current.worklet?.disconnect(); void current.context?.close();
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
      const gain = current.context.createGain(); gain.gain.value = 0;
      current.source.connect(current.worklet); current.worklet.connect(gain); gain.connect(current.context.destination);
      current.worklet.port.onmessage = ({ data }) => {
        if (capture.current !== current) return;
        current.frames.push(data.pcm);
        if (current.frames.length >= 1500) stop();
      };
      current.timer = setInterval(() => setSeconds(Math.floor(current.frames.length / 50)), 250);
    } catch (error) { if (capture.current === current) stop(); notify(error.message, true); }
  };
  const submit = async () => {
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
        <input aria-label={`${person.name}的称呼`} defaultValue={person.name} maxLength={40}
          onBlur={event => { if (event.target.value !== person.name) act(() => api(`/people/${person.id}`, "PUT", { name: event.target.value })); }} />
        <span>{person.enrolled ? "已录入声音" : "尚未录入"}</span>
        {person.enrolled && <Button disabled={busy || recording} onClick={() => act(() => api(`/people/${person.id}/voiceprint`, "DELETE"))}>停用声纹</Button>}
      </div>)}
      <form onSubmit={event => { event.preventDefault(); act(async () => { await api("/people", "POST", { name }); setName(""); }); }}>
        <div className="row-actions"><input aria-label="新档案称呼" placeholder="例如：我、女朋友" value={name} onChange={e => setName(e.target.value)} maxLength={40} /><Button type="submit" disabled={!name.trim()}>添加档案</Button></div>
      </form>
      <p className="small muted">侧栏选择的是当前页面的使用者；音箱会逐句匹配声纹。无法确认时不会读写个人资料。请轮流讲话，避免同时出声。声纹会误判，不能当作身份锁；健康档案需在页面中选择身份后使用。</p>
      <p className="small muted">个人档案目前保存在这台设备，尚不参加跨设备同步。模型、声音和家居设置共用。</p>
    </Section>
    <Section title="录入各自的声音" subtitle="请两位本人分别操作，在安静处用平时的音量自然说话 10–20 秒。">
      <label>录入给谁<select value={target} disabled={recording || busy} onChange={e => { setTarget(e.target.value); setSample(null); setConsent(false); }}><option value="">选择档案</option>{state.people.people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <p>可以读：“你好豆梨，这是我的声音。以后我们聊天时，请把我的日常习惯和偏好记在我的档案里。今天的天气不错，我想安排一下接下来的生活。”</p>
      <p className="small muted">录音会通过临时链接交给火山引擎，提取并保存云端声纹用于匹配。本机不落盘保存注册录音；链接在请求结束或 60 秒后失效。“停用声纹”会停止本地匹配并请求服务端软删除，不等于云端物理删除。</p>
      <label><input type="checkbox" checked={consent} disabled={recording || busy} onChange={e => setConsent(e.target.checked)} /> 我是该档案本人，同意此次录音上传及云端声纹处理</label>
      <div className="row-actions">
        <Button disabled={!target || !consent || busy || !state.people.enrollmentAvailable} onClick={recording ? stop : record}>{recording ? `结束录音（${seconds} 秒）` : "开始录音"}</Button>
        {sample && !recording && <Button primary disabled={!consent || busy} onClick={submit}>{busy ? "正在录入…" : `上传并录入（${(sample.length / 32000).toFixed(1)} 秒）`}</Button>}
        <Button disabled={busy || recording} onClick={() => act(async () => { await api("/people/voiceprint/check", "POST", {}); notify("声纹服务连接成功"); })}>检查连接</Button>
      </div>
      {!state.people.enrollmentAvailable && <p>尚未配置 HTTPS 设备入口，暂时不能传送注册录音。仍可手动切换个人档案。</p>}
    </Section>
  </>;
}
