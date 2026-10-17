export class BrowserVoice {
  constructor({ onEvent, onStatus, onLevel }) {
    Object.assign(this, { onEvent, onStatus, onLevel });
    this.sources = new Set();
    this.segments = new Map();
    this.flags = { paused: false, muted: false, playbackPaused: false };
    this.closed = false;
    this.turnId = 0;
    this.rejectedThrough = -1;
  }
  async start(sessionId, route) {
    try {
      // Separate clocks let output pause without suspending microphone capture.
      this.context = new AudioContext();
      this.captureContext = new AudioContext();
      await Promise.race([
        Promise.all([this.context.resume(), this.captureContext.resume()]),
        new Promise((_, reject) => {
          this.resumeTimer = setTimeout(() => reject(new Error("请在页面上直接点击“开始语音”，以允许声音播放")), 5000);
        }),
      ]);
      clearTimeout(this.resumeTimer);
      if (this.closed) return;
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false,
      });
      if (this.closed) { this.stream.getTracks().forEach(t => t.stop()); return; }
      await this.captureContext.audioWorklet.addModule(new URL("./capture.js", import.meta.url));
      if (this.closed) return;
      this.source = this.captureContext.createMediaStreamSource(this.stream);
      this.worklet = new AudioWorkletNode(this.captureContext, "douli-capture");
      this.silentGain = this.captureContext.createGain();
      this.silentGain.gain.value = 0;
      this.source.connect(this.worklet);
      this.worklet.connect(this.silentGain);
      this.silentGain.connect(this.captureContext.destination);
      const query = new URLSearchParams({ route });
      if (sessionId) query.set("session", sessionId);
      this.ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/voice?${query}`);
      this.ws.binaryType = "arraybuffer";
      this.worklet.port.onmessage = ({ data }) => {
        if (this.closed || this.flags.paused || this.flags.muted) return;
        this.onLevel?.(data.level);
        if (this.ready && this.ws.readyState === WebSocket.OPEN && this.ws.bufferedAmount < 128000) this.ws.send(data.pcm);
      };
      this.ws.onopen = () => this.send({
        type: "hello", version: 1, transport: "websocket",
        features: { aec: this.stream.getAudioTracks?.()[0]?.getSettings?.().echoCancellation === true, voice_controls: true, playback_ack: true },
        audio_params: { format: "pcm", sample_rate: 16000, channels: 1, frame_duration: 20 },
      });
      this.ws.onmessage = ({ data }) => {
        if (this.closed) return;
        if (data instanceof ArrayBuffer) return this.play(data);
        try { this.receive(JSON.parse(data)); }
        catch { this.onEvent?.({ type: "error", message: "收到无法解析的语音事件" }); }
      };
      this.ws.onerror = () => this.onEvent?.({ type: "error", message: "语音连接失败，请检查本地服务是否运行" });
      this.ws.onclose = () => this.stop();
      this.heartbeat = setInterval(() => this.send({ type: "ping" }), 25000);
      this.progressTimer = setInterval(() => this.reportPlayback(), 100);
    } catch (e) {
      this.stop();
      throw new Error(e.name === "NotAllowedError" ? "麦克风权限未开启，请允许此页面使用麦克风后重试" : e.message);
    }
  }
  receive(event) {
    const id = event.turn_id;
    // History can update an older message; late text/audio cannot replace a new turn.
    if (Number.isInteger(id) && id < this.turnId && !["playback", "farewell", "ping"].includes(event.type)) return;
    if (event.type === "hello") {
      this.ready = true;
      this.identifiedAudio = !!event.features?.turn_ids;
      this.send({ type: "listen", state: "start", mode: "auto" });
      this.onStatus?.("listening");
    }
    if (event.type === "ping") this.send({ type: "pong" });
    if (event.type === "voice_state") {
      if (Number.isInteger(id)) this.turnId = Math.max(this.turnId, id);
      Object.assign(this.flags, { paused: event.paused, muted: event.muted, playbackPaused: event.playbackPaused });
      this.syncControls();
      this.onStatus?.(event.paused ? "paused" : event.output === "idle" ? "listening" : event.output);
    }
    if (event.type === "barge" && id === this.turnId) {
      this.bargeHold = event.state === "hold";
      this.syncControls();
    }
    if (event.type === "tts") {
      if (Number.isInteger(id) && id <= this.rejectedThrough) return;
      if (event.state === "start") {
        this.stopPlayback();
        this.turnId = id ?? this.turnId + 1;
        this.acceptAudio = true;
        this.bargeHold = false;
        this.syncControls();
        this.onStatus?.(this.flags.paused ? "paused" : "speaking");
      }
      if (event.state === "sentence_start") {
        if (!this.acceptAudio || id !== this.turnId) return;
        const segment = { turnId: id, id: event.segment_id, text: event.text, completedMs: 0, lastReported: -1 };
        this.segments.set(`${id}:${segment.id}`, segment);
        this.currentSegment = segment;
      }
      if (event.state === "sentence_end") {
        const segment = this.segments.get(`${id}:${event.segment_id}`);
        if (segment) { segment.totalMs = event.duration_ms; this.reportSegment(segment, true); }
      }
      if (event.state === "stop") {
        if (event.interrupted) {
          this.stopPlayback();
          this.rejectedThrough = Math.max(this.rejectedThrough, id ?? this.turnId);
          this.bargeHold = false;
          this.syncControls();
        }
        this.playbackStopped = true;
        this.finishPlayback();
      }
    }
    if (event.type === "stt") this.onStatus?.(this.flags.paused ? "paused" : "thinking");
    if (event.type === "error") this.onStatus?.(this.flags.paused ? "paused" : "listening");
    if (event.type === "farewell") this.stop();
    this.onEvent?.(event);
  }
  send(value) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(value));
  }
  control(action, enabled) {
    if (this.closed) return;
    if (action === "mute") this.flags.muted = !!enabled;
    if (action === "pause" || action === "resume") this.flags.paused = action === "pause";
    if (action === "playback_pause" || action === "playback_resume") this.flags.playbackPaused = action === "playback_pause";
    this.syncControls();
    this.send({ type: "voice_control", action, enabled });
    this.onEvent?.({ type: "voice_controls", ...this.flags });
  }
  syncControls() {
    this.stream?.getTracks().forEach(t => { t.enabled = !this.flags.paused && !this.flags.muted; });
    if (this.flags.paused || this.flags.muted) this.onLevel?.(0);
    this.controlQueue = (this.controlQueue || Promise.resolve()).then(async () => {
      if (this.closed || !this.context) return;
      const held = this.flags.paused || this.flags.playbackPaused || this.bargeHold;
      if (held) await this.context.suspend?.();
      else await this.context.resume();
    }).catch(() => this.onEvent?.({ type: "error", message: "播放暂停状态未能更新，请点击继续播放" }));
  }
  interrupt() {
    this.stopPlayback();
    this.rejectedThrough = Math.max(this.rejectedThrough, this.turnId);
    this.bargeHold = false;
    this.syncControls();
    this.send({ type: "abort" });
    this.send({ type: "listen", state: "start", mode: "auto" });
    this.onStatus?.(this.flags.paused ? "paused" : "listening");
  }
  submit() {
    if (this.flags.paused || this.flags.muted) return;
    this.send({ type: "listen", state: "stop" });
  }
  play(bytes) {
    if (!this.context || this.closed || !this.acceptAudio || !bytes.byteLength || bytes.byteLength % 2) return;
    if (this.identifiedAudio && !this.currentSegment) return;
    const samples = new Int16Array(bytes), buffer = this.context.createBuffer(1, samples.length, 16000);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 32768;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    this.nextPlay = Math.max(this.nextPlay || 0, this.context.currentTime + 0.035);
    Object.assign(source, { voiceStart: this.nextPlay, voiceDuration: buffer.duration, voiceSegment: this.currentSegment });
    this.sources.add(source);
    source.start(this.nextPlay);
    this.nextPlay += buffer.duration;
    source.onended = () => {
      if (!this.sources.delete(source)) return;
      source.disconnect();
      if (source.voiceSegment) {
        source.voiceSegment.completedMs += source.voiceDuration * 1000;
        this.reportSegment(source.voiceSegment, true);
      }
      this.finishPlayback();
    };
  }
  reportSegment(segment, force = false, interrupted = false) {
    if (!segment) return;
    let playedMs = segment.completedMs;
    for (const source of this.sources) if (source.voiceSegment === segment)
      playedMs += Math.max(0, Math.min(source.voiceDuration, this.context.currentTime - source.voiceStart)) * 1000;
    playedMs = Math.round(playedMs);
    if (!force && playedMs <= segment.lastReported) return;
    const state = interrupted ? "interrupted" : !segment.started && playedMs > 0 ? "started" : segment.totalMs != null && playedMs >= segment.totalMs ? "complete" : "progress";
    if (playedMs > 0) segment.started = true;
    segment.lastReported = playedMs;
    this.send({ type: "playback", turn_id: segment.turnId, segment_id: segment.id, played_ms: playedMs, state });
  }
  reportPlayback() { for (const segment of this.segments.values()) this.reportSegment(segment); }
  finishPlayback() {
    if (this.closed || this.sources.size) return;
    if (this.playbackStopped) this.onStatus?.(this.flags.paused ? "paused" : "listening");
  }
  stopPlayback() {
    this.reportPlayback();
    for (const segment of this.segments.values()) this.reportSegment(segment, true, true);
    this.acceptAudio = false;
    this.playbackStopped = false;
    const sources = [...this.sources];
    this.sources.clear();
    for (const source of sources) { try { source.stop(); source.disconnect(); } catch {} }
    this.segments.clear();
    this.currentSegment = null;
    this.nextPlay = 0;
  }
  stop() {
    if (this.closed) return;
    this.stopPlayback();
    this.closed = true;
    this.ready = false;
    clearTimeout(this.resumeTimer);
    clearInterval(this.heartbeat);
    clearInterval(this.progressTimer);
    this.send({ type: "abort" });
    this.ws?.close();
    this.stream?.getTracks().forEach(t => t.stop());
    this.source?.disconnect();
    this.worklet?.disconnect();
    this.silentGain?.disconnect();
    this.context?.close().catch(() => {});
    this.captureContext?.close().catch(() => {});
    this.onLevel?.(0);
    this.onStatus?.("off");
  }
}
