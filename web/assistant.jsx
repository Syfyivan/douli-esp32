import React, { useState } from "react";
import { Check, Moon, Sparkles, Radio } from "lucide-react";
import { SpeakerVolume } from "./speaker-volume.jsx";
import { ComputerTasksPanel } from "./computer.jsx";

export function AssistantPage({ state, act, notify, api, Section, Field, Button, Toggle, saveNight, nightSave }) {
  const [patch, setPatch] = useState({});
  const a = { ...state.settings.assistant, ...patch, night: { ...state.settings.assistant.night, ...nightSave.patch } };
  const [saving, setSaving] = useState(false);
  const set = (key, value) => setPatch(old => ({ ...old, [key]: value }));
  const night = (key, value) => { if (value !== "") void saveNight(key, value); };
  const save = () => act(async () => {
    setSaving(true);
    try { await api("/settings", "PUT", { assistant: patch }); setPatch({}); notify("助手偏好已保存，下一轮对话生效"); }
    finally { setSaving(false); }
  });
  return <>
    <div className="page-title title-with-action"><div><span className="eyebrow">A LITTLE MORE LIKE YOU</span><h1>你喜欢的陪伴方式</h1><p>从一句问候，到每一次回应，慢慢找到合拍的方式。</p></div><Button primary icon={Check} disabled={saving} onClick={save}>{saving ? "保存中…" : "保存偏好"}</Button></div>
    <div className="assistant-layout">
      <div>
        <Section title="认识你的助手" subtitle="给它一个名字，也给你们的相处留一点空间。">
          <Field label="助手的名字"><input value={a.name} onChange={e => set("name", e.target.value)} maxLength={80} /></Field>
          <div className="field"><span>说话的语气</span><div className="choice-row">{["温柔自然", "轻松有趣", "直接清晰"].map(tone => <button key={tone} aria-pressed={a.tone === tone} onClick={() => set("tone", tone)}>{tone}</button>)}</div><input aria-label="自定义语气" value={a.tone} onChange={e => set("tone", e.target.value)} /></div>
          <Field label="性格与相处方式"><textarea rows={4} value={a.persona} onChange={e => set("persona", e.target.value)} /></Field>
          <div className="grid two"><div className="field"><span>回复长度</span><div className="choice-row">{["简短", "适中", "详细"].map(length => <button key={length} aria-pressed={a.replyLength === length} onClick={() => set("replyLength", length)}>{length}</button>)}</div></div><Field label={`幽默程度 · ${a.humor}%`}><input type="range" min="0" max="100" value={a.humor} onChange={e => set("humor", +e.target.value)} /><small className="range-labels"><span>认真一点</span><span>俏皮一点</span></small></Field></div>
          <Field label="不喜欢的表达习惯"><textarea rows={2} value={a.avoid} onChange={e => set("avoid", e.target.value)} placeholder="例如：少一些客套话，不急着给建议" /></Field>
        </Section>
        <Section title="听到你时，怎样回应" subtitle="实际唤醒词由音箱固件决定；这里设置收到唤醒事件后的回应。">
          <Field label="回应你的第一句话"><input value={a.greeting} onChange={e => set("greeting", e.target.value)} /></Field>
          <details><summary><Radio size={15} /> 设备唤醒词</summary><Field label="设备会发送的唤醒词（逗号分隔）"><input value={a.wakeWords.join("，")} onChange={e => set("wakeWords", e.target.value.split(/[,，]/).map(x => x.trim()))} /></Field></details>
        </Section>
      </div>
      <aside>
        <section className="assistant-preview"><div className="preview-label"><Sparkles size={16} /> 开场白预览</div><div className="preview-avatar">d.</div><h2>{a.name || "豆梨"}</h2><blockquote>{a.greeting || "填写一句你想听到的问候。"}</blockquote><div className="preview-tags"><span>{a.tone}</span><span>{a.replyLength}回复</span></div><p>展示你填写的问候语，保存后生效。</p></section>
        <Section title="音箱音量" subtitle="调整板子的日常音量，也可以直接对它说“声音大一点”。">
          {state.devices.filter(d => d.approved).map(device => <SpeakerVolume key={device.id} {...{ device, api, Button, Field, notify }} />)}
          {!state.devices.some(d => d.approved) && <p className="small muted">连接音箱后，这里会显示音量调节。</p>}
        </Section>
        <Section title="夜深了，轻声一点" subtitle="这里的修改会自动保存。">
          <div className="night-symbol"><Moon size={20} /></div>
          <Toggle label="夜间模式" checked={a.night.enabled} onChange={v => night("enabled", v)} hint="在指定时段进一步降低音量；关闭后使用日常音量。" />
          <div className="grid two">
            <Field label="开始时间"><input type="time" value={a.night.start} onChange={e => night("start", e.target.value)} /></Field>
            <Field label="结束时间"><input type="time" value={a.night.end} onChange={e => night("end", e.target.value)} /></Field>
          </div>
          <Field label={`夜间音量比例 · ${Math.round(a.night.volume * 100)}%`} hint="例如 30% 表示在日常音量基础上进一步压低，并非板子扬声器的音量刻度。">
            <input type="range" min="0.05" max="1" step="0.05" value={a.night.volume} onChange={e => night("volume", +e.target.value)} />
          </Field>
          <p className="small muted" role="status">{nightSave.status === "saving" ? "正在保存夜间设置…" : nightSave.status === "error" ? "保存未确认，请检查连接后重试。" : nightSave.status === "saved" ? "夜间设置已自动保存" : "修改后自动保存，切换页面不会丢失。"}</p>
        </Section>
        <div className="profile-help"><h3>直接说，也能调整</h3><p>对音箱说“声音大一点”“音量调到百分之五十”“以后回答简短些”或“说话轻松一点”。音量只调整当前音箱，回复风格会保存到这里。</p></div>
      </aside>
    </div>
    <ComputerTasksPanel {...{ api, notify, Section, Field, Button, Toggle }} platform={state.platform} />
  </>;
}
