import { randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { WebSocket } from "ws";

// Public v3 SAUC binary protocol: https://www.volcengine.com/docs/6561/1354869
// Separate from Seeduplex's JSON conversation protocol.
export function asrPacket(type, payload, final = false) {
  const data = gzipSync(Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload)));
  const header = Buffer.from([0x11, (type << 4) | (final ? 2 : 0), (type === 1 ? 0x10 : 0) | 1, 0]);
  const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  return Buffer.concat([header, size, data]);
}
export function readAsrPacket(data) {
  const packet = Buffer.from(data);
  if (packet.length < 8 || packet[0] >> 4 !== 1) throw new Error("流式识别协议错误");
  const type = packet[1] >> 4, flags = packet[1] & 15;
  let offset = (packet[0] & 15) * 4;
  if (offset < 4 || offset + 4 > packet.length) throw new Error("流式识别包头错误");
  if (type === 15) throw new Error(`流式识别服务错误（${packet.readUInt32BE(offset)}）`);
  if (type !== 9) throw new Error("未知的流式识别事件");
  if (flags & 1) offset += 4;
  if (offset + 4 > packet.length) throw new Error("流式识别事件不完整");
  const size = packet.readUInt32BE(offset); offset += 4;
  if (size !== packet.length - offset || size > 1024 * 1024) throw new Error("流式识别结果长度无效");
  let payload = packet.subarray(offset);
  if ((packet[2] & 15) === 1) payload = gunzipSync(payload, { maxOutputLength: 4 * 1024 * 1024 });
  else if ((packet[2] & 15) !== 0) throw new Error("不支持的流式识别压缩格式");
  if (packet[2] >> 4 !== 1) throw new Error("流式识别需要 JSON 结果");
  return { value: JSON.parse(payload.toString("utf8")), final: !!(flags & 2) };
}
export class VolcengineTranscriber {
  constructor(settings, context, onPartial = () => {}) {
    const profile = settings.models.streamingAsr;
    if (!profile?.baseUrl || !profile.model || !profile.apiKey) throw new Error("请先配置火山流式识别的地址、资源 ID 和 API Key");
    this.settings = settings; this.onPartial = onPartial; this.pending = [];
    this.pendingBytes = 0; this.totalBytes = 0; this.text = "";
    this.result = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    this.result.catch(() => {});
    let corpus;
    try {
      const saved = JSON.parse(context || "{}");
      let remaining = 700;
      const history = (saved.recent || []).slice(-6).reverse().flatMap(item => {
        const text = String(item.text || "").slice(0, Math.max(0, Math.min(remaining, 180)));
        remaining -= text.length;
        return text ? [{ text }] : [];
      });
      const hotwords = (saved.vocabulary || []).slice(0, 12).map(word => ({ word: String(word).slice(0, 8) }));
      corpus = { context: JSON.stringify({ context_type: "dialog_ctx", context_data: history, hotwords }) };
    } catch {} // Optional context must not prevent audio recognition.
    const url = new URL(profile.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    this.socket = new WebSocket(url, { headers: { "X-Api-Key": profile.apiKey, "X-Api-Resource-Id": profile.model, "X-Api-Connect-Id": randomUUID() }, handshakeTimeout: 5000, maxPayload: 1024 * 1024 });
    this.socket.on("open", () => {
      if (this.closed) return;
      this.socket.send(asrPacket(1, {
        user: { uid: "douli" }, audio: { format: "pcm", rate: 16000, bits: 16, channel: 1 },
        request: { model_name: "bigmodel", enable_itn: true, enable_punc: true, enable_ddc: false, show_utterances: true, ...(corpus ? { corpus } : {}) },
      }));
      this.flush(!!this.finishing);
    });
    this.socket.on("message", raw => {
      if (this.closed) return;
      try {
        const event = readAsrPacket(raw), text = event.value.result?.text;
        if (typeof text === "string") { this.text = text; this.onPartial(text); }
        if (event.final) this.resolve(this.text);
      } catch (error) { this.reject(error); this.close(); }
    });
    this.socket.on("error", () => { this.reject(new Error("火山流式识别连接失败，请检查密钥、资源和网络")); this.close(); });
    this.socket.on("close", () => this.reject(new Error("火山流式识别提前断开")));
  }
  push(pcm) {
    if (this.closed || this.finishing) return;
    this.totalBytes += pcm.length;
    if (this.totalBytes > this.settings.input.maxRecordingSeconds * 32000 + 6400) { this.reject(new Error("录音超出限制")); this.close(); return; }
    this.pending.push(pcm); this.pendingBytes += pcm.length;
    if (this.pendingBytes >= 6400) this.flush();
  }
  flush(final = false) {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN || (this.sentFinal && final)) return;
    if (!this.pendingBytes && !final) return;
    if (this.socket.bufferedAmount > 128000) { this.reject(new Error("流式识别网络发送积压")); this.close(); return; }
    this.socket.send(asrPacket(2, Buffer.concat(this.pending), final));
    this.pending = []; this.pendingBytes = 0;
    if (final) this.sentFinal = true;
  }
  async finish(signal) {
    this.finishing = true; this.flush(true);
    let timer, abort;
    try {
      return await Promise.race([this.result, new Promise((_, reject) => {
        abort = () => reject(signal.reason);
        signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => reject(new Error("火山流式识别结果等待超时")), this.settings.input.finalTimeoutMs);
        if (signal?.aborted) abort();
      })]);
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); this.close(); }
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.pending = []; this.pendingBytes = 0;
    this.reject(new Error("流式识别已取消"));
    if (this.socket.readyState === WebSocket.CONNECTING) this.socket.terminate();
    else this.socket.close();
  }
}
