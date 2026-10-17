// The origin-checked native prompt bridge is installed by the Android activity.
// Audio never traverses the WebView: the foreground service owns the socket.
export class NativeVoice {
  constructor(callbacks) {
    Object.assign(this, callbacks);
    this.native = true;
    this.listener = e => this.receive(e.detail);
    window.addEventListener("douli-native-voice", this.listener);
  }
  bridge(value) {
    const result = window.douliNativeVoice.send(value);
    if (result.error) throw new Error(result.error);
    return result;
  }
  async start(sessionId, route) { this.starting = true; this.bridge({ action: "start", sessionId, route }); }
  restore() { this.receive(this.bridge({ action: "snapshot" })); }
  receive(event) {
    if (this.closed) return;
    if (event.type === "native_snapshot") {
      // Returning from Android's permission sheet can publish the pre-service
      // snapshot before the foreground service starts. Keep the pending client.
      if (this.starting && !event.active) return;
      if (event.active) this.starting = false;
      this.onStatus?.(event.active ? event.status : "off");
      this.onEvent?.({ ...event, type: "voice_controls" });
      this.onEvent?.({ type: "native_screen", active: !!event.screenSharing });
      if (event.active && event.session_id && this.sessionId !== event.session_id) {
        this.sessionId = event.session_id;
        this.onEvent?.({ type: "native_restore", session_id: event.session_id });
      }
      if (!event.active) this.detach();
      return;
    }
    if (event.nativeStartFailed || (this.starting && event.type === "error")) { this.starting = false; this.onStatus?.("off"); this.detach(); }
    this.onEvent?.(event);
  }
  send(command) { this.bridge({ action: "command", command }); }
  control(action, enabled) { this.send({ type: "voice_control", action, enabled }); }
  interrupt() { this.send({ type: "abort" }); this.send({ type: "listen", state: "start", mode: "auto" }); }
  submit() { this.send({ type: "listen", state: "stop" }); }
  shareScreen() { this.bridge({ action: "screen_start" }); }
  stopScreen() { this.bridge({ action: "screen_stop" }); }
  detach() { this.closed = true; window.removeEventListener("douli-native-voice", this.listener); }
  stop() {
    if (this.closed) return;
    this.send({ type: "end" }); this.detach(); this.onStatus?.("off");
  }
}
