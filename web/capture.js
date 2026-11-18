// Streaming resampling preserves fractional position across AudioWorklet blocks.
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.carry = new Float32Array(4);
    this.carryLen = 0;
    this.buf = new Float32Array(256);
    this.position = 0;
    this.frame = new Int16Array(320);
    this.frameOffset = 0;
    this.power = 0;
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel?.length) return true;
    const total = this.carryLen + channel.length;
    if (this.buf.length < total) this.buf = new Float32Array(total + 128);
    if (this.carryLen) this.buf.set(this.carry.subarray(0, this.carryLen), 0);
    this.buf.set(channel, this.carryLen);
    const step = sampleRate / 16000;
    while (this.position + 1 < total) {
      const left = Math.floor(this.position),
        part = this.position - left;
      const sample =
        this.buf[left] * (1 - part) + this.buf[left + 1] * part;
      const pcm = Math.round(Math.max(-1, Math.min(1, sample)) * 32767);
      this.frame[this.frameOffset++] = pcm;
      this.power += (pcm / 32768) ** 2;
      this.position += step;
      if (this.frameOffset === 320) {
        const out = this.frame.slice();
        this.port.postMessage(
          { pcm: out.buffer, level: Math.sqrt(this.power / 320) },
          [out.buffer],
        );
        this.frameOffset = 0;
        this.power = 0;
      }
    }
    const consumed = Math.min(Math.floor(this.position), total);
    this.carryLen = total - consumed;
    if (this.carry.length < this.carryLen) this.carry = new Float32Array(this.carryLen);
    for (let i = 0; i < this.carryLen; i++) this.carry[i] = this.buf[consumed + i];
    this.position -= consumed;
    return true;
  }
}
registerProcessor("douli-capture", Capture);
