import React, { useEffect, useState } from "react";
import { Captions, Check, LoaderCircle, Mic, MicOff, MoreHorizontal, Pause, Phone, PhoneOff, Play, Settings, Square, Volume2 } from "lucide-react";

export function VideoCallPage({
  name, faceName, videoRef, audioRef, voiceState, avatarStatus, flags, level,
  captions, caption, captionSpeaker, volume, onStart, onStop, onMute, onPause,
  onSubmit, onInterrupt, onCaptions, onVolume, onUnlock, onSettings, metrics = {},
}) {
  const active = voiceState !== "off";
  const connecting = active && voiceState === "connecting";
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    setElapsed(0);
    if (!active || connecting) return;
    const began = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - began) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [active, connecting]);
  const status = !active ? "准备就绪"
    : connecting ? ({ preparing: "正在准备通话…", connecting: "正在建立视频连接…", starting: "正在等待形象画面…", ready: "正在准备麦克风…" }[avatarStatus] || "正在连接形象…")
    : flags.paused ? "通话已暂停"
    : voiceState === "speaking" ? `${name}正在说话`
    : voiceState === "thinking" ? `${name}正在想…`
    : flags.muted ? "麦克风已静音"
    : "正在听你说";
  const showVideo = active && ["ready", "audio-blocked"].includes(avatarStatus);
  const duration = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;

  return <section className="video-room" aria-label="视频通话">
    <div className="video-room-heading">
      <div><h1>视频通话</h1><p>和{name}面对面，聊聊今天。</p></div>
      <button className="video-settings" aria-label="视频通话设置" title="视频通话设置" onClick={onSettings}><Settings size={18} /></button>
    </div>
    <div className={`video-room-stage ${active ? "is-active" : ""}`}>
      <video ref={videoRef} autoPlay muted playsInline aria-label={`${name}实时形象`} className={showVideo ? "is-visible" : ""} />
      <audio ref={audioRef} autoPlay />
      {!showVideo && <div className="video-room-placeholder">
        <span className="video-room-bean" aria-hidden="true">d.</span>
        <h2>{connecting ? "马上见面" : `${name}在这里`}</h2>
        <p>{connecting ? "正在准备画面和声音…" : "准备好了，就开始吧。"}</p>
      </div>}
      <div className="video-room-identity"><span>{name}</span>{faceName && <small>{faceName}</small>}</div>
      {active && !connecting && <span className="video-room-duration" aria-label={`通话时长 ${duration}`}>{duration}</span>}
      {avatarStatus === "audio-blocked" && <button className="video-room-unlock" onClick={onUnlock}><Volume2 size={18} />启用画面和声音</button>}
      {active && captions && caption && <div className="video-room-caption" aria-live="polite"><span>{captionSpeaker}</span><p>{caption}</p></div>}
    </div>
    <div className="video-room-bottom">
      <div className="video-room-status" role="status">
        {connecting ? <LoaderCircle size={14} className="video-room-spinner" /> : <i className={active && !flags.paused ? "is-live" : ""} style={{ transform: `scale(${active && !flags.muted && !flags.paused ? 1 + Math.min(level * 5, 0.5) : 1})` }} />}
        <span>{status}</span>
      </div>
      <div className="video-room-controls">
        {active ? <>
          <button className={`video-room-mic ${flags.muted ? "is-muted" : ""}`} aria-label={flags.muted ? "开启麦克风" : "静音麦克风"} aria-pressed={!!flags.muted} disabled={connecting} onClick={onMute}>
            {flags.muted ? <MicOff size={19} /> : <Mic size={19} />}<span>{flags.muted ? "开启麦克风" : "麦克风"}</span>
          </button>
          <button className="video-room-end" onClick={onStop}><PhoneOff size={19} /><span>{connecting ? "取消连接" : "结束通话"}</span></button>
        </> : <button className="video-room-start primary" onClick={onStart}><Phone size={19} />开始通话</button>}
        <label className="avatar-volume video-room-volume">
          <Volume2 size={17} aria-hidden="true" />
          <input type="range" aria-label="视频通话音量" min="0" max="400" step="10"
            value={Math.round(volume * 100)} aria-valuetext={`${Math.round(volume * 100)}%`}
            onChange={event => onVolume(Number(event.target.value) / 100)} />
          <output>{Math.round(volume * 100)}%</output>
        </label>
        <details className="video-room-more">
          <summary aria-label="更多通话选项" title="更多通话选项"><MoreHorizontal size={21} /><span>更多</span></summary>
          <div className="video-room-options">
            <button onClick={onCaptions} aria-pressed={captions}><Captions size={17} /><span>显示字幕</span>{captions && <Check size={15} />}</button>
            {active && <>
              <button disabled={connecting} onClick={onPause}>{flags.paused ? <Play size={17} /> : <Pause size={17} />}<span>{flags.paused ? "继续通话" : "暂停通话"}</span></button>
              <button disabled={connecting || flags.paused || flags.muted} onClick={onSubmit}><Check size={17} /><span>我说完了</span></button>
              <button disabled={connecting} onClick={onInterrupt}><Square size={17} /><span>打断回答</span></button>
            </>}
            {Number.isFinite(metrics?.avatarAudioMs) && <small className="video-room-latency">形象音频返回 {(metrics.avatarAudioMs / 1000).toFixed(2)} 秒</small>}
            {Number.isFinite(metrics?.avatarConnectMs) && <small className="video-room-latency">形象连接 {(metrics.avatarConnectMs / 1000).toFixed(2)} 秒</small>}
          </div>
        </details>
      </div>
      <p className="video-room-note">{active ? "直接开口就好，停顿后会自动回复。" : "通话内容会保存在「对话记录」中。"}</p>
    </div>
  </section>;
}
