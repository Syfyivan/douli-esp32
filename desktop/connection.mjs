// A failed health request is not proof of a stopped process. Keep the current
// page during brief interruptions and continue checking after the recovery page.
export function describeConnectionError(error) {
  const details = [];
  for (let current = error; current && details.length < 4; current = current.cause)
    details.push([current.name, current.code, current.message].filter(Boolean).join(": "));
  return details.join(" <- ");
}

export class ConnectionMonitor {
  constructor({ probe, onOffline, onRecovered, log, canCheck = () => true, intervalMs = 10000, failureThreshold = 3 }) {
    Object.assign(this, { probe, onOffline, onRecovered, log, canCheck, intervalMs, failureThreshold });
    this.generation = 0;
    this.failures = 0;
    this.offline = false;
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    if (this.timer) return;
    this.timer = setInterval(() => void this.check(), this.intervalMs);
    this.timer.unref?.();
  }

  reset({ offline = false } = {}) {
    this.generation++;
    this.failures = 0;
    this.offline = offline;
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = null;
    this.reset();
  }

  async check() {
    if (this.checking || this.stopped || !this.canCheck()) return;
    this.checking = true;
    const generation = this.generation;
    const current = () => !this.stopped && generation === this.generation && this.canCheck();
    try {
      let failure;
      try {
        if (!await this.probe()) throw Object.assign(new Error("Local service is not listening"), { code: "ECONNREFUSED" });
      } catch (error) { failure = error; }
      if (!current()) return;
      if (failure) {
        this.failures++;
        if (this.failures <= this.failureThreshold || this.failures % 6 === 0)
          this.log(`Service health check failed (${this.failures} consecutive): ${describeConnectionError(failure)}`);
        if (this.failures >= this.failureThreshold && !this.offline) {
          this.offline = true;
          await this.onOffline(failure);
        }
      } else {
        if (this.failures) this.log(`Service responded again after ${this.failures} failed health check(s).`);
        this.failures = 0;
        if (this.offline) {
          await this.onRecovered();
          if (current()) this.offline = false;
        }
      }
    } catch (error) {
      // A failed page load must not disable later recovery attempts.
      if (current()) this.offline = true;
      this.log("Service recovery failed: " + describeConnectionError(error));
    } finally { this.checking = false; }
  }
}
