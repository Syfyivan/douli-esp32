// Owned by App, so leaving a settings page cannot discard an in-flight edit.
// Only changed fields are sent; later edits replace queued values, and writes
// never race one another. A failed batch rolls back to the last saved state.
export class SettingsWriter {
  constructor({ write, saved, changed, failed }) {
    Object.assign(this, { write, saved, changed, failed });
    this.pending = new Map();
    this.running = null;
    this.error = "";
  }
  snapshot() {
    return { patch: Object.fromEntries([...this.pending].map(([key, entry]) => [key, entry.value])),
      status: this.pending.size ? "saving" : this.error ? "error" : "saved", error: this.error };
  }
  update(patch) {
    for (const [key, value] of Object.entries(patch)) this.pending.set(key, { value });
    this.error = "";
    this.changed(this.snapshot());
    this.running ||= this.flush().finally(() => { this.running = null; });
    return this.running;
  }
  async flush() {
    while (this.pending.size) {
      const batch = new Map(this.pending);
      try {
        const result = await this.write(Object.fromEntries([...batch].map(([key, entry]) => [key, entry.value])));
        this.saved(result);
        this.error = "";
      } catch (error) {
        this.error = error.message;
        this.failed(error);
      }
      for (const [key, entry] of batch) if (this.pending.get(key) === entry) this.pending.delete(key);
      this.changed(this.snapshot());
    }
  }
}
