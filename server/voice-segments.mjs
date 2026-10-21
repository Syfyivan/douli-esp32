export class SpeechSegments {
  constructor({ firstWaitMs = 350, onSegment, isActive = () => true }) {
    Object.assign(this, { firstWaitMs, onSegment, isActive });
    this.pending = "";
    this.count = 0;
    this.firstDeadlineReached = false;
  }
  push(text) {
    this.pending += text;
    this.drain(this.firstDeadlineReached && !this.count);
    if (!this.timer && this.pending && !this.count && !this.firstDeadlineReached) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.firstDeadlineReached = true;
        // Prefer a natural boundary; the hard bound prevents an unpunctuated
        // model answer from withholding all audio until generation finishes.
        this.drain(true);
      }, this.firstWaitMs);
      this.timer.unref?.();
    }
  }
  drain(timed) {
    while (this.pending && this.isActive()) {
      const min = this.count ? 24 : 5;
      let match = this.pending.match(/^[\s\S]*?[。！？!?\n]/);
      if (!match) match = this.pending.match(new RegExp(`^[\\s\\S]{${min},}?[，,；;：:]`));
      if (!match && (this.pending.length >= 100 || (timed && this.pending.length >= 12))) {
        // Avoid cutting a UTF-16 surrogate pair.
        const chars = Array.from(this.pending);
        const length = Math.min(chars.length, 60);
        match = [chars.slice(0, length).join("")];
      }
      if (!match) break;
      this.emit(match[0]);
      this.pending = this.pending.slice(match[0].length);
      timed = false;
    }
  }
  emit(text) {
    if (text.trim() && this.isActive()) {
      clearTimeout(this.timer); this.timer = null;
      this.count++; this.onSegment(text);
    }
  }
  finish() { clearTimeout(this.timer); this.emit(this.pending); this.pending = ""; }
  close() { clearTimeout(this.timer); this.pending = ""; }
}
