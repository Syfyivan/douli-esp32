// Observe decoded remote samples on the render thread. No recordings leave the
// browser, and these measurements are not playback acknowledgements.
class AvatarMeter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.port.onmessage = ({ data }) => {
      this.turn = data?.type === "arm" ? { id: data.id, blocks: 0 } : null;
    };
  }
  process(inputs, outputs) {
    const input = inputs[0] || [], output = outputs[0] || [];
    for (let c = 0; c < output.length; c++) {
      const source = input[c] || input[0];
      if (source) output[c].set(source); else output[c].fill(0);
    }
    if (this.turn && input[0]) {
      let energy = 0;
      for (const sample of input[0]) energy += sample * sample;
      if (Math.sqrt(energy / input[0].length) > 0.003) {
        if (!this.turn.blocks) this.turn.firstAt = currentTime;
        if (++this.turn.blocks >= 2) {
          this.port.postMessage({ id: this.turn.id, renderTime: this.turn.firstAt });
          this.turn = null;
        }
      } else this.turn.blocks = 0;
    }
    return true;
  }
}
registerProcessor("douli-avatar-meter", AvatarMeter);
