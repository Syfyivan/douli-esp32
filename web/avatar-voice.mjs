import { BrowserVoice } from "./voice.mjs";
import { SimliTransport } from "./simli.mjs";

export class AvatarVoice extends BrowserVoice {
  constructor({ video, audio, volume, Transport = SimliTransport, onAvatarStatus, ...callbacks }) {
    super(callbacks);
    // Simli's ACK means received, not heard. Never claim sample-accurate playback.
    this.playbackAcknowledged = false;
    this.avatarAudio = true;
    this.avatar = new Transport({ video, audio, volume,
      onError: message => { this.onEvent?.({ type: "error", message }); this.stop(); },
      onSpeaking: speaking => { this.avatarSpeaking = speaking; if (!speaking) this.finishPlayback(); },
      onAudioBlocked: () => onAvatarStatus?.("audio-blocked"),
      onProgress: status => onAvatarStatus?.(status),
      onConnected: timings => this.onEvent?.({ type: "metric", name: "avatarConnectMs", value: timings.totalMs }),
      onMetric: metric => {
        if (this.closed || this.flags.paused || metric.turn_id !== this.turnId || metric.turn_id <= this.rejectedThrough) return;
        this.send({ type: "avatar_metric", ...metric });
        this.onEvent?.({ type: "metric", ...metric });
      },
    });
    this.onAvatarStatus = onAvatarStatus;
  }
  async start(sessionId, route) {
    try {
      // Unlock audio during the original click, before waiting for cloud signalling.
      this.context = new AudioContext(); this.captureContext = new AudioContext();
      void this.context.resume(); void this.captureContext.resume();
      await this.avatar.prepareAudio(this.context);
      this.onAvatarStatus?.("connecting");
      await this.avatar.start();
      if (this.closed) return;
      this.onAvatarStatus?.(this.avatar.audioBlocked ? "audio-blocked" : "ready");
      await super.start(sessionId, route);
    } catch (error) { this.stop(); if (error.message !== "通话已取消") throw error; }
  }
  setVolume(value) { this.avatar.setVolume(value); }
  play(bytes) {
    if (this.closed || !this.acceptAudio || this.flags.paused || !bytes.byteLength || bytes.byteLength % 2) return;
    if (this.identifiedAudio && !this.currentSegment) return;
    this.avatar.send(bytes, this.currentSegment?.turnId);
    this.avatarSpeaking = true;
  }
  receive(event) {
    // Sending the last PCM packet does not mean the remote stream has finished.
    if (event.type === "voice_state" && event.output === "idle" && this.avatarSpeaking && !event.paused)
      event = { ...event, output: "speaking" };
    super.receive(event);
    if (event.type === "tts" && event.state === "sentence_start" && this.acceptAudio &&
        this.currentSegment?.turnId === event.turn_id && this.currentSegment?.id === event.segment_id) {
      // Listening volume belongs after animation, never in the model's input PCM.
      this.avatar.setPlaybackGain(event.playback_gain);
    }
  }
  reportSegment() {} // No synthetic playback receipts from a local clock.
  reportPlayback() {}
  finishPlayback() {
    if (!this.closed && !this.avatarSpeaking && this.playbackStopped)
      this.onStatus?.(this.flags.paused ? "paused" : "listening");
  }
  stopPlayback() {
    super.stopPlayback();
    this.avatar?.clear();
    this.avatarSpeaking = false;
  }
  control(action, enabled) {
    // A live stream cannot resume an old frame/audio buffer. Pause ends this answer.
    if (action === "pause") this.interrupt();
    if (action === "playback_pause" || action === "playback_resume") return;
    super.control(action, enabled);
  }
  stop() {
    if (this.closed) return;
    super.stop(); this.avatar.stop(); this.onAvatarStatus?.("off");
  }
}
