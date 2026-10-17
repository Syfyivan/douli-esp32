import createVAD from "@ozymandiasthegreat/vad/lib/embedded.js";
import { rms } from "./audio.mjs";

// Embedded WASM is shipped by upstream. No native Node ABI or network download
// is needed on Windows, Electron or the Android Node host.
const VAD = await createVAD();
export class SpeechDetector {
  constructor(mode = 2) {
    this.vad = new VAD(mode, 16000);
    this.pending = Buffer.alloc(0);
    this.last = false;
  }
  detect(pcm, threshold = 0.012) {
    const data = Buffer.concat([this.pending, pcm]);
    let positive = 0, total = 0, at = 0;
    for (; at + 320 <= data.length; at += 320) {
      // Upstream processFrame copies the whole ArrayBuffer, so use an owned,
      // exactly sized Int16Array (never a view into Node's pooled buffers).
      const frame = new Int16Array(160);
      for (let i = 0; i < 160; i++) frame[i] = data.readInt16LE(at + i * 2);
      const result = this.vad.processFrame(frame);
      if (result < 0) throw new Error("人声检测无法处理当前音频");
      positive += result;
      total++;
    }
    this.pending = Buffer.from(data.subarray(at));
    if (total) this.last = positive / total >= 0.5;
    // VAD hangover must not turn literal silence into user activity.
    return this.last && rms(pcm) >= threshold;
  }
  close() { this.vad?.destroy(); this.vad = null; this.pending = Buffer.alloc(0); }
}
