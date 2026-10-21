import { PcmResampler, packAudio } from "./audio.mjs";

// A response from a native speech model has one conservative playback segment:
// audio/text alignment is not supplied by this provider, so an interrupted
// response is never represented as a guessed word-level spoken prefix.
export class StreamingPlayback {
  constructor(connection, turn, signal, active) {
    Object.assign(this, { connection, turn, signal, active });
    this.converter = new PcmResampler(24000); this.pending = Buffer.alloc(0);
    this.segment = { id: turn.segments.length, text: "", durationMs: 0, playedMs: 0, finished: false };
    turn.segments.push(this.segment);
  }
  async push(bytes, final = false) {
    const c = this.connection, s = this.segment;
    this.pending = Buffer.concat([this.pending, this.converter.push(bytes, final)]);
    while (this.pending.length >= 640 || (final && this.pending.length)) {
      const pacer = await c.paceOutput(this.turn, this.signal);
      if (!this.active()) return;
      if (c.call.holdingPlayback) continue;
      const frame = Buffer.alloc(640);
      this.pending.copy(frame, 0, 0, 640); this.pending = this.pending.subarray(Math.min(640, this.pending.length));
      const { pcmGain: gain, playbackGain } = c.outputVolume();
      if (gain !== 1) for (let i = 0; i < frame.length; i += 2) frame.writeInt16LE(Math.round(frame.readInt16LE(i) * gain), i);
      if (!this.started) {
        this.started = true; c.state = "speaking";
        c.mark(this.turn, "firstAudioMs", Date.now() - this.turn.lastSpeechAt);
        c.send({ type: "tts", state: "sentence_start", text: s.text, segment_id: s.id, turn_id: this.turn.id,
          ...(playbackGain != null ? { playback_gain: playbackGain } : {}) });
      }
      s.durationMs += 20;
      const data = c.options.browser ? frame : Buffer.from(c.encoder.encode(frame, 320));
      c.ws.send(packAudio(data, c.version)); pacer.sent();
      c.recordAudioSent(this.turn, pacer);
    }
  }
  async finish(text) {
    this.segment.text = text;
    await this.push(Buffer.alloc(0), true);
    if (!this.active()) return;
    this.segment.finished = true;
    this.connection.send({ type: "tts", state: "sentence_end", text, segment_id: this.segment.id,
      duration_ms: this.segment.durationMs, turn_id: this.turn.id });
  }
}
