// Bounded, temporary enrollment audio from the same microphone/codec path used
// in conversation. Start after wake-up and first speech, not from ambient audio.
export class VoiceSample {
  constructor({ onProgress = () => {}, durationMs = 20000, timeoutMs = 300000, recordingTimeoutMs = 35000 } = {}) {
    this.frames = []; this.bytes = 0; this.voicedBytes = 0; this.clipped = 0;
    this.started = false; this.done = false; this.onProgress = onProgress;
    this.recordingTimeoutMs = recordingTimeoutMs;
    this.limit = Math.min(30000, Math.max(5000, durationMs)) * 32;
    this.promise = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    this.timer = setTimeout(() => this.cancel("等待录音超时，请重新开始"), timeoutMs);
    this.timer.unref();
  }
  begin() {
    if (this.started || this.done) return;
    this.started = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.cancel("录音超时，请重新开始"), this.recordingTimeoutMs);
    this.timer.unref();
  }
  push(pcm, voiced) {
    if (this.done || !this.started || (!this.bytes && !voiced)) return;
    const frame = Buffer.from(pcm.subarray(0, this.limit - this.bytes));
    this.frames.push(frame); this.bytes += frame.length;
    if (voiced) this.voicedBytes += frame.length;
    for (let i = 0; i < frame.length; i += 2) if (Math.abs(frame.readInt16LE(i)) >= 32700) this.clipped++;
    this.onProgress({ status: "recording", seconds: this.bytes / 32000, speechSeconds: this.voicedBytes / 32000 });
    if (this.bytes >= this.limit) this.finish();
  }
  clear() {
    clearTimeout(this.timer);
    for (const frame of this.frames) frame.fill(0);
    this.frames = [];
  }
  finish() {
    if (this.done) return;
    if (this.bytes < 160000 || this.voicedBytes < 96000)
      return this.cancel("有效讲话太短，请自然连续说话约 20 秒后重试");
    if (this.clipped / (this.bytes / 2) > 0.01)
      return this.cancel("录音失真较多，请用平时的距离和音量重新录入");
    this.done = true;
    const pcm = Buffer.concat(this.frames, this.bytes);
    this.clear(); this.resolve(pcm);
  }
  cancel(message = "已取消录音") {
    if (this.done) return;
    this.done = true; this.clear(); this.reject(new Error(message));
  }
}
