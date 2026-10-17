// Streaming resampling preserves fractional position across AudioWorklet blocks.
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.input = [];
    this.position = 0;
    this.frame = [];
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (const value of channel) this.input.push(value);
    const step = sampleRate / 16000;
    while (this.position + 1 < this.input.length) {
      const left = Math.floor(this.position),
        part = this.position - left;
      const sample =
        this.input[left] * (1 - part) + this.input[left + 1] * part;
      this.frame.push(Math.round(Math.max(-1, Math.min(1, sample)) * 32767));
      this.position += step;
      if (this.frame.length === 320) {
        const pcm = Int16Array.from(this.frame);
        let power = 0;
        for (const value of this.frame) power += (value / 32768) ** 2;
        this.port.postMessage(
          { pcm: pcm.buffer, level: Math.sqrt(power / 320) },
          [pcm.buffer],
        );
        this.frame = [];
      }
    }
    const consumed = Math.floor(this.position);
    this.input.splice(0, consumed);
    this.position -= consumed;
    return true;
  }
}
registerProcessor("douli-capture", Capture);
