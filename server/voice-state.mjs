// Input and output can progress independently in the same call.
export class VoiceState {
  constructor(changed = () => {}) {
    this.changed = changed;
    this.connection = "connected";
    this.input = "off";
    this.output = "idle";
    this.paused = false;
    this.muted = false;
    this.playbackPaused = false;
    this.turnId = 0;
  }
  update(patch) {
    let dirty = false;
    for (const key of Object.keys(this.snapshot())) {
      if (Object.hasOwn(patch, key) && this[key] !== patch[key]) {
        this[key] = patch[key];
        dirty = true;
      }
    }
    if (dirty) this.changed(this.snapshot());
  }
  snapshot() {
    return Object.fromEntries(["connection", "input", "output", "paused", "muted", "playbackPaused", "turnId"].map(k => [k, this[k]]));
  }
  get acceptingAudio() { return this.connection === "connected" && this.input !== "off" && !this.paused && !this.muted; }
  get holdingPlayback() { return this.paused || this.playbackPaused; }
  get legacy() {
    if (this.connection !== "connected") return this.connection;
    if (this.paused) return "paused";
    if (this.output === "thinking" || this.output === "speaking") return this.output;
    return this.input === "off" ? "idle" : "listening";
  }
}

// Generated text is retained in the archive. Context should not assume the
// listener heard words which were queued but never played.
export function audibleContext(message) {
  const playback = message.metadata?.voicePlayback;
  if (message.role !== "assistant" || !playback || playback.status === "complete") return message.text;
  if (playback.status === "unverified") return message.text;
  const heard = playback.spokenText || "";
  return heard
    ? `${heard}\n[语音在此之后中断，后续生成内容没有确认播放；不要假定用户听过。]`
    : "[上一条语音回复尚未确认播出便被中断；不要假定用户听过生成内容。]";
}
