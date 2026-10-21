// Implements Simli's public Compose P2P protocol. No microphone track is added.
// https://docs.simli.com/api-reference/websockets/peer_to_peer
export function normalizeAvatarVolume(value) {
  if (value == null || value === "") return 2;
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(4, Math.max(0, number)) : 2;
}

export class SimliTransport {
  constructor({ video, audio, volume, onError, onSpeaking, onAudioBlocked, onMetric }) {
    Object.assign(this, { video, audio, onError, onSpeaking, onAudioBlocked, onMetric });
    this.volume = normalizeAvatarVolume(volume);
    this.playbackGain = 1;
    this.closed = false;
    this.allowed = false;
    this.abort = new AbortController();
  }
  prepareAudio(context) {
    if (this.closed || this.outputContext) return;
    this.outputContext = context;
    this.volumeGain = context.createGain();
    this.compressor = context.createDynamicsCompressor();
    this.outputGate = context.createGain();
    this.volumeGain.gain.value = this.volume * this.playbackGain;
    this.compressor.threshold.value = -6;
    this.compressor.knee.value = 3;
    this.compressor.ratio.value = 20;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.15;
    this.volumeGain.connect(this.compressor);
    this.compressor.connect(this.outputGate);
    this.outputGate.connect(context.destination);
    this.syncAudioGate();
    if (context.audioWorklet && typeof AudioWorkletNode !== "undefined") {
      this.meterReady = context.audioWorklet.addModule(new URL("./avatar-meter.js", import.meta.url)).then(() => {
        if (this.closed) return;
        this.meter = new AudioWorkletNode(context, "douli-avatar-meter");
        this.meter.connect(this.volumeGain);
        this.meter.port.onmessage = ({ data }) => this.measureAudio(data);
      }).catch(() => {}); // Missing telemetry must not prevent a working call.
    }
    return this.meterReady;
  }
  measureAudio(data) {
    const turn = this.measuredTurn;
    if (this.closed || !this.allowed || !turn || data.id !== turn.id || turn.reported ||
        !Number.isFinite(data.renderTime) || data.renderTime < turn.audioTime) return;
    const value = Math.round((data.renderTime - turn.audioTime) * 1000);
    if (value > 30000) return;
    turn.reported = true;
    this.onMetric?.({ turn_id: turn.id, name: "avatarAudioMs", value });
  }
  setVolume(value) {
    this.volume = normalizeAvatarVolume(value);
    this.updateVolume();
  }
  setPlaybackGain(value) {
    this.playbackGain = typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
    this.updateVolume();
  }
  updateVolume() {
    if (!this.closed && this.volumeGain) {
      const gain = this.volumeGain.gain, now = this.outputContext.currentTime;
      const level = this.volume * this.playbackGain;
      gain.cancelScheduledValues(now);
      // Zero is an immediate mute; smooth other changes to avoid clicks.
      if (level === 0) gain.setValueAtTime(0, now);
      else gain.setTargetAtTime(level, now, 0.015);
    }
  }
  syncAudioGate() {
    // The media element must stay muted when Web Audio owns playback.
    this.audio.muted = !!this.outputGate || !this.allowed;
    if (this.outputGate) this.outputGate.gain.value = this.allowed && !this.closed ? 1 : 0;
  }
  async start() {
    try {
      this.timer = setTimeout(() => this.fail("实时形象连接超时，请检查网络或稍后重试"), 45000);
      const r = await fetch("/api/avatar/session", { method: "POST", signal: this.abort.signal });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "无法创建实时形象通话");
      if (this.closed) throw new Error("通话已取消");
      this.pc = new RTCPeerConnection({ iceServers: data.iceServers });
      this.pc.addTransceiver("audio", { direction: "recvonly" });
      this.pc.addTransceiver("video", { direction: "recvonly" });
      const ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
      // Attach rejection immediately while ICE and the websocket are opening.
      ready.catch(() => {});
      this.video.onloadeddata = () => {
        if (!this.closed) { this.started = true; clearTimeout(this.timer); this.resolveReady?.(); }
      };
      this.pc.ontrack = ({ track, streams }) => {
        if (this.closed) return;
        const element = track.kind === "video" ? this.video : this.audio;
        element.srcObject = streams[0] || new MediaStream([track]);
        if (track.kind === "audio") {
          if (this.outputContext) {
            try {
              this.remoteSource?.disconnect();
              this.remoteSource = this.outputContext.createMediaStreamSource(new MediaStream([track]));
              this.remoteSource.connect(this.meter || this.volumeGain);
            } catch { this.fail("无法播放实时形象声音，请重新开始通话"); return; }
          }
          this.syncAudioGate();
        } else element.muted = true;
        element.play().catch(() => {
          if (!this.closed) { this.audioBlocked = true; this.onAudioBlocked?.(); }
        });
      };
      this.pc.onconnectionstatechange = () => {
        clearTimeout(this.disconnectTimer);
        if (this.pc.connectionState === "failed") this.fail("实时形象网络连接失败，请重新开始通话");
        if (this.pc.connectionState === "disconnected") this.disconnectTimer = setTimeout(() => this.fail("实时形象已断开，请重新开始通话"), 8000);
      };
      const query = new URLSearchParams({ session_token: data.sessionToken, enableSFU: String(data.enableSFU !== false) });
      // The documentation page is called peer_to_peer; the live endpoint and
      // official JS client use /p2p (the page's literal path returns HTTP 403).
      this.ws = new WebSocket(`wss://api.simli.ai/compose/webrtc/p2p?${query}`);
      const opened = new Promise((resolve, reject) => {
        this.rejectOpen = reject;
        this.ws.onopen = resolve;
        this.ws.onerror = () => this.fail("无法连接 Simli 视频服务，请检查网络");
        this.ws.onclose = event => this.fail(event.code === 1006
          ? "视频网络连接中断，请点击“视频通话”重新连接"
          : "Simli 视频通话已结束，可能已达到空闲或时长限制，可重新开始通话");
      });
      opened.catch(() => {});
      this.ws.onmessage = ({ data: message }) => this.receive(message);
      const offer = await this.pc.createOffer();
      if (this.closed) throw new Error("通话已取消");
      await this.pc.setLocalDescription(offer);
      if (this.closed) throw new Error("通话已取消");
      // Non-trickle ICE: send the offer with gathered candidates, not an early empty SDP.
      if (this.pc.iceGatheringState !== "complete") await new Promise((resolve, reject) => {
        this.rejectIce = reject;
        const done = () => { clearTimeout(this.iceTimer); this.pc.onicegatheringstatechange = null; resolve(); };
        this.pc.onicegatheringstatechange = () => { if (this.pc.iceGatheringState === "complete") done(); };
        this.iceTimer = setTimeout(done, 8000);
        if (this.pc.iceGatheringState === "complete") done();
      });
      await opened;
      if (this.closed) throw new Error("通话已取消");
      this.ws.send(JSON.stringify(this.pc.localDescription));
      await ready;
    } catch (error) { const failure = this.failure || error; this.stop(failure); throw failure; }
  }
  receive(message) {
    if (this.closed || typeof message !== "string") return;
    if (message === "SPEAK") { if (this.allowed) this.onSpeaking?.(true); return; }
    if (message === "SILENT") { this.onSpeaking?.(false); return; }
    if (/^(STOP|CLOSING|RATE|ERROR)/.test(message)) { this.fail("Simli 视频服务结束了通话，请检查账户额度或重新连接"); return; }
    if (message.startsWith("{")) {
      try {
        const answer = JSON.parse(message);
        if (answer.type === "answer" && typeof answer.sdp === "string")
          this.pc.setRemoteDescription(answer).catch(() => this.fail("实时形象视频协商失败，请重试"));
      } catch { this.fail("Simli 返回了无效的视频连接信息"); }
    }
  }
  send(bytes, turnId) {
    if (this.closed || !this.started || this.ws?.readyState !== WebSocket.OPEN) return;
    if (this.ws.bufferedAmount > 160000) { this.fail("视频网络发送积压，已结束通话，请检查网络后重试"); return; }
    this.allowed = true;
    this.syncAudioGate();
    if (Number.isInteger(turnId) && this.measuredTurn?.id !== turnId) {
      this.measuredTurn = { id: turnId, audioTime: this.outputContext?.currentTime };
      this.meter?.port.postMessage({ type: "arm", id: turnId });
    }
    this.ws.send(new Uint8Array(bytes));
  }
  clear() {
    this.measuredTurn = null;
    this.meter?.port.postMessage({ type: "clear" });
    this.allowed = false;
    this.syncAudioGate();
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send("SKIP");
    this.onSpeaking?.(false);
  }
  async unlockAudio() {
    await Promise.all([this.video.play(), this.audio.play(), this.outputContext?.resume()]);
    this.audioBlocked = false;
  }
  fail(message) {
    if (this.closed) return;
    const started = this.started;
    this.stop(new Error(message));
    if (started) this.onError?.(message);
  }
  stop(error = new Error("通话已取消")) {
    if (this.closed) return;
    this.failure = error;
    this.closed = true; this.allowed = false;
    this.syncAudioGate();
    this.measuredTurn = null;
    if (this.meter) this.meter.port.onmessage = null;
    for (const node of [this.remoteSource, this.meter, this.volumeGain, this.compressor, this.outputGate]) node?.disconnect();
    this.abort.abort();
    for (const timer of [this.timer, this.disconnectTimer, this.iceTimer]) clearTimeout(timer);
    this.rejectOpen?.(error); this.rejectIce?.(error); this.rejectReady?.(error);
    if (this.ws) {
      this.ws.onopen = this.ws.onclose = this.ws.onerror = this.ws.onmessage = null;
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send("DONE");
      this.ws.close();
    }
    if (this.pc) { this.pc.ontrack = this.pc.onconnectionstatechange = this.pc.onicegatheringstatechange = null; this.pc.close(); }
    for (const element of [this.video, this.audio]) {
      element.onloadeddata = null; element.muted = true; element.pause(); element.srcObject = null;
    }
  }
}
