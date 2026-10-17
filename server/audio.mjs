import OpusScript from "opusscript";

export function rms(pcm) {
  let power = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2)
    power += (pcm.readInt16LE(i) / 32768) ** 2;
  return Math.sqrt(power / Math.max(1, pcm.length / 2));
}
export function wav(pcm, rate = 16000) {
  const header = Buffer.alloc(44);
  header.write("RIFF");
  header.writeUInt32LE(pcm.length + 36, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
export function resample(pcm, from, to = 16000) {
  if (from === to) return pcm;
  const count = Math.floor(((pcm.length / 2) * to) / from);
  const output = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) {
    const at = (i * from) / to;
    const left = Math.min(Math.floor(at), pcm.length / 2 - 1);
    const right = Math.min(left + 1, pcm.length / 2 - 1);
    output.writeInt16LE(
      Math.round(
        pcm.readInt16LE(left * 2) * (1 - (at - left)) +
          pcm.readInt16LE(right * 2) * (at - left),
      ),
      i * 2,
    );
  }
  return output;
}
// Preserve fractional position and a boundary sample across HTTP chunks.
export class PcmResampler {
  constructor(from, to = 16000) { this.from = from; this.to = to; this.pending = Buffer.alloc(0); this.position = 0; }
  push(bytes, final = false) {
    const pcm = Buffer.concat([this.pending, bytes]);
    const size = Math.floor(pcm.length / 2);
    if (this.from === this.to) {
      this.pending = Buffer.from(pcm.subarray(size * 2));
      if (final && this.pending.length) throw new Error("合成音频包含不完整 PCM 样本");
      return pcm.subarray(0, size * 2);
    }
    const values = [];
    const step = this.from / this.to;
    while (this.position + (final ? 0 : 1) < size) {
      const left = Math.floor(this.position), part = this.position - left;
      const right = Math.min(left + 1, size - 1);
      values.push(Math.round(pcm.readInt16LE(left * 2) * (1 - part) + pcm.readInt16LE(right * 2) * part));
      this.position += step;
    }
    const consumed = Math.min(Math.floor(this.position), size);
    this.position -= consumed;
    this.pending = Buffer.from(pcm.subarray(consumed * 2));
    if (final && pcm.length % 2) throw new Error("合成音频包含不完整 PCM 样本");
    const output = Buffer.alloc(values.length * 2);
    values.forEach((value, i) => output.writeInt16LE(value, i * 2));
    return output;
  }
}
export function unpackAudio(data, version = 1) {
  const b = Buffer.from(data);
  if (version === 1) return b;
  if (version === 2) {
    if (
      b.length < 16 ||
      b.readUInt16BE(0) !== 2 ||
      b.readUInt16BE(2) !== 0 ||
      b.readUInt32BE(12) !== b.length - 16
    )
      throw new Error("Invalid v2 audio frame");
    return b.subarray(16);
  }
  if (version === 3) {
    if (b.length < 4 || b[0] !== 0 || b.readUInt16BE(2) !== b.length - 4)
      throw new Error("Invalid v3 audio frame");
    return b.subarray(4);
  }
  throw new Error("Unsupported audio protocol version");
}
export function packAudio(data, version = 1) {
  if (version === 1) return data;
  const h = Buffer.alloc(version === 2 ? 16 : 4);
  if (version === 2) {
    h.writeUInt16BE(2, 0);
    h.writeUInt32BE(data.length, 12);
  } else h.writeUInt16BE(data.length, 2);
  return Buffer.concat([h, data]);
}
export function codec(rate = 16000) {
  return new OpusScript(rate, 1, OpusScript.Application.VOIP);
}

// Energy detection on echo-cancelled PCM. Keep the onset, tolerate brief gaps
// between syllables, and bound history even during hours of silent playback.
export class BargeInBuffer {
  constructor() { this.reset(); }
  reset() {
    this.frames = [];
    this.totalMs = 0;
    this.speechMs = 0;
    this.silenceMs = 0;
  }
  push(pcm, threshold, voiced = rms(pcm) >= threshold, minimumMs = 140) {
    const ms = pcm.length / 32;
    this.frames.push(pcm);
    this.totalMs += ms;
    if (voiced) {
      this.speechMs += ms;
      this.silenceMs = 0;
    } else {
      this.silenceMs += ms;
      if (this.silenceMs >= 100) this.speechMs = 0;
    }
    const keepMs = this.speechMs ? 500 : 200;
    while (this.frames.length > 1 && this.totalMs > keepMs) {
      this.totalMs -= this.frames.shift().length / 32;
    }
    if (this.speechMs < minimumMs) return null;
    const frames = this.frames;
    this.reset();
    return frames;
  }
}

// The gateway supplies WebRTC VAD decisions; energy-only callers remain supported.
export class UtteranceBuffer {
  constructor(settings) {
    this.config = settings;
    this.reset();
  }
  reset() {
    this.frames = [];
    this.preRoll = [];
    this.speechMs = 0;
    this.silenceMs = 0;
    this.totalMs = 0;
    this.started = false;
  }
  push(pcm, autoEnd = true, voiced = rms(pcm) >= this.config.rmsThreshold, silenceMs = this.config.silenceMs) {
    const ms = pcm.length / 32;
    if (!this.started) {
      this.preRoll.push(pcm);
      while (
        this.preRoll.reduce((sum, b) => sum + b.length, 0) > 6400 &&
        this.preRoll.length > 1
      )
        this.preRoll.shift();
      if (!voiced) return null;
      this.started = true;
      this.frames = [...this.preRoll];
      this.totalMs = this.frames.reduce((sum, b) => sum + b.length / 32, 0);
    } else {
      this.frames.push(pcm);
      this.totalMs += ms;
    }
    if (voiced) {
      this.speechMs += ms;
      this.silenceMs = 0;
    } else this.silenceMs += ms;
    if (
      this.totalMs >= this.config.maxRecordingSeconds * 1000 ||
      (autoEnd && this.silenceMs >= silenceMs)
    )
      return this.finish();
    return null;
  }
  finish() {
    const result =
      this.speechMs >= this.config.minSpeechMs
        ? Buffer.concat(this.frames)
        : null;
    this.reset();
    return result;
  }
}
