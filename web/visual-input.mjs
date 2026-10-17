export class VisualInput {
  constructor({ send, onStop }) { Object.assign(this, { send, onStop }); }
  async start(source, video) {
    this.stop();
    this.closed = false;
    const generation = this.generation;
    const stream = source === "screen"
      ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      : await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    if (this.closed || generation !== this.generation) { stream.getTracks().forEach(t => t.stop()); return false; }
    this.stream = stream; this.video = video; this.source = source;
    video.srcObject = stream; video.muted = true; video.playsInline = true;
    stream.getVideoTracks()[0].addEventListener("ended", () => this.stop(), { once: true });
    try { await video.play(); }
    catch (e) { this.stop(); throw e; }
    if (this.closed) return false;
    this.send({ type: "vision", action: "start", source });
    return true;
  }
  respond(event) {
    if (this.closed || !this.video?.videoWidth || this.video.readyState < 2) {
      this.send({ type: "vision_frame", turn_id: event.turn_id, unavailable: true }); return;
    }
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 1024 / Math.max(this.video.videoWidth, this.video.videoHeight));
    canvas.width = Math.round(this.video.videoWidth * scale); canvas.height = Math.round(this.video.videoHeight * scale);
    canvas.getContext("2d").drawImage(this.video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.75);
    this.send({ type: "vision_frame", turn_id: event.turn_id, source: this.source, capturedAt: Date.now(), dataUrl });
  }
  stop() {
    const sharing = !!this.stream;
    this.closed = true; this.generation = (this.generation || 0) + 1;
    this.stream?.getTracks().forEach(t => t.stop()); this.stream = null;
    if (this.video) { this.video.pause(); this.video.srcObject = null; }
    if (sharing) this.send?.({ type: "vision", action: "stop" });
    if (sharing) this.onStop?.();
  }
}
