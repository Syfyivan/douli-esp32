import { setTimeout as delay } from "node:timers/promises";

// ESP32 consumes audio immediately and has no start-up jitter buffer. Build a
// small lead gradually, within its 20-packet decode queue (400 ms at 20 ms).
// Use a media clock, not a fresh timer per frame, so timer lateness can recover.
export class AudioPacer {
  constructor({ leadMs = 0, now = () => performance.now(), sleep = (ms, signal) => delay(ms, undefined, { signal }) } = {}) {
    Object.assign(this, { leadMs, now, sleep });
    this.origin = null;
    this.mediaMs = 0;
    this.lastSent = null;
  }
  async wait(signal) {
    signal.throwIfAborted();
    const now = this.now();
    this.origin ??= now;
    // A provider stall or suspended process must not release seconds of stale
    // schedule as an unbounded burst. Rebuild only the bounded lead.
    if (now > this.origin + this.mediaMs + Math.max(100, this.leadMs))
      this.origin = now - this.mediaMs;
    const due = Math.max(this.origin + this.mediaMs - this.leadMs,
      this.lastSent == null ? now : this.lastSent + (this.leadMs ? 5 : 0));
    if (due > now) await this.sleep(due - now, signal);
    signal.throwIfAborted();
  }
  sent(durationMs = 20) { this.mediaMs += durationMs; this.lastSent = this.now(); }
  postpone(ms) {
    if (this.origin != null) this.origin += ms;
    if (this.lastSent != null) this.lastSent += ms;
  }
  async drain(signal) {
    signal.throwIfAborted();
    if (this.origin == null) return;
    const remaining = this.origin + this.mediaMs - this.now();
    if (remaining > 0) await this.sleep(remaining, signal);
    signal.throwIfAborted();
  }
}
