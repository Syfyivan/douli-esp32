import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { PassThrough } from "node:stream";

// Public v3 bidirectional protocol. One connection can serve sequential sessions.
// https://www.volcengine.com/docs/6561/1329505
const integer = value => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; };
const field = bytes => Buffer.concat([integer(bytes.length), bytes]);
export function ttsPacket(event, payload = {}, sessionId) {
  const parts = [Buffer.from([0x11, 0x14, 0x10, 0]), integer(event)];
  if (sessionId != null) parts.push(field(Buffer.from(sessionId)));
  parts.push(field(Buffer.from(JSON.stringify(payload))));
  return Buffer.concat(parts);
}
export function readTtsPacket(value) {
  const data = Buffer.from(value);
  if (data.length < 8 || data[0] >> 4 !== 1) throw new Error("语音合成协议错误");
  const type = data[1] >> 4, flags = data[1] & 15, serialization = data[2] >> 4, compression = data[2] & 15;
  let offset = (data[0] & 15) * 4;
  const uint = () => {
    if (offset < 4 || offset + 4 > data.length) throw new Error("语音合成数据不完整");
    const n = data.readUInt32BE(offset); offset += 4; return n;
  };
  const bytes = () => {
    const n = uint();
    if (n > 4 * 1024 * 1024 || offset + n > data.length) throw new Error("语音合成数据长度无效");
    const b = data.subarray(offset, offset + n); offset += n; return b;
  };
  if (flags & 1) uint(); // Optional sequence number precedes the event.
  const code = type === 15 ? uint() : null;
  const event = flags & 4 ? uint() : null;
  let sessionId, connectId;
  if (event != null) {
    if (event >= 100) sessionId = bytes().toString();
    else if ([50, 51, 52].includes(event)) connectId = bytes().toString();
  }
  let payload = bytes();
  if (offset !== data.length) throw new Error("语音合成数据长度不匹配");
  if (compression === 1) payload = gunzipSync(payload, { maxOutputLength: 4 * 1024 * 1024 });
  else if (compression !== 0) throw new Error("不支持的语音合成压缩");
  if (serialization === 1) {
    try { payload = JSON.parse(payload.toString()); }
    catch { throw new Error("语音合成返回了无效 JSON"); }
  }
  else if (serialization !== 0) throw new Error("不支持的语音合成序列化");
  if (![9, 11, 15].includes(type)) throw new Error("未知的语音合成消息");
  return { type, event, sessionId, connectId, payload, code };
}

const deferred = () => {
  const value = Promise.withResolvers();
  value.promise.catch(() => {});
  return value;
};
export const isVolcengineTts = profile => {
  try { return new URL(profile.baseUrl).hostname === "openspeech.bytedance.com" && /^seed-(tts|icl)-/.test(profile.model); }
  catch { return false; }
};
export function speechProfile(settings) {
  return settings.input?.ttsProvider === "volcengine" ? settings.models.streamingTts : settings.models.tts;
}

export class VolcengineTts {
  constructor(profile, { Socket = WebSocket, url, timeoutMs = 8000 } = {}) {
    this.profile = { ...profile };
    this.Socket = Socket;
    this.url = url || "wss://openspeech.bytedance.com/api/v3/tts/bidirection";
    this.timeoutMs = timeoutMs;
  }
  open() {
    if (this.connection) return this.connection.promise;
    const ready = this.connection = deferred();
    if (!this.profile.apiKey || !this.profile.voice || !this.profile.model) {
      this.fail(new Error("请先配置豆包语音合成的密钥、资源 ID 和音色"));
      return ready.promise;
    }
    let socket;
    try {
      socket = this.socket = new this.Socket(this.url, {
        headers: { "X-Api-Key": this.profile.apiKey, "X-Api-Resource-Id": this.profile.model, "X-Api-Connect-Id": randomUUID() },
        handshakeTimeout: this.timeoutMs, maxPayload: 4 * 1024 * 1024,
      });
    } catch {
      this.fail(new Error("豆包语音合成连接配置无效，请检查密钥和资源 ID"));
      return ready.promise;
    }
    this.connectTimer = setTimeout(() => this.fail(new Error("豆包语音合成连接超时")), this.timeoutMs);
    this.connectTimer.unref?.();
    socket.on("open", () => { if (this.socket === socket) socket.send(ttsPacket(1)); });
    socket.on("message", data => {
      if (this.socket !== socket) return;
      try { this.receive(readTtsPacket(data)); }
      catch (error) { this.fail(error); }
    });
    socket.on("unexpected-response", (_req, response) => {
      response.resume();
      if (this.socket !== socket) return;
      this.fail(new Error(response.statusCode === 403
        ? "豆包语音合成未授权，请在火山控制台开通对应的语音合成资源"
        : `豆包语音合成连接失败（HTTP ${response.statusCode}）`));
    });
    socket.on("error", () => { if (this.socket === socket) this.fail(new Error("豆包语音合成连接失败")); });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      if (this.current) this.fail(new Error("豆包语音合成中途断开"));
      else this.close();
    });
    return ready.promise;
  }
  session(signal) {
    if (this.current) throw new Error("上一轮语音合成尚未结束");
    signal?.throwIfAborted();
    clearTimeout(this.idleTimer);
    const audio = new PassThrough({ highWaterMark: 64 * 1024 });
    // The consumer can be created after connection errors, without unhandled errors.
    audio.on("error", () => {});
    const done = deferred();
    const s = this.current = {
      id: randomUUID(), audio, done, pending: [], characters: 0, text: "",
      finishing: false, started: false, bytes: 0, signal,
    };
    const abort = s.abort = () => this.fail(signal.reason || new Error("语音合成已取消"));
    signal?.addEventListener("abort", abort, { once: true });
    const touch = s.touch = () => {
      clearTimeout(s.timer);
      s.timer = setTimeout(() => this.fail(new Error("豆包语音合成响应超时")), 20000);
      s.timer.unref?.();
    };
    touch();
    const ready = this.open().then(() => {
      if (this.current !== s) return;
      this.socket.send(ttsPacket(100, {
        user: { uid: "douli" }, namespace: "BidirectionalTTS", event: 100,
        req_params: { speaker: this.profile.voice, audio_params: { format: "pcm", sample_rate: this.profile.pcmSampleRate || 24000 } },
      }, s.id));
    }).catch(error => { if (this.current === s) this.fail(error); });
    ready.catch(() => {});
    return {
      audio, completion: done.promise,
      write: text => {
        if (this.current !== s || s.finishing) return;
        if (typeof text !== "string" || !text) return;
        s.characters += text.length;
        if (s.characters > 20000) { this.fail(new Error("单轮语音文字过长")); return; }
        s.text += text; s.pending.push(text); this.flush(s);
      },
      finish: () => { if (this.current === s) { s.finishing = true; this.flush(s); } return done.promise; },
      cancel: () => { if (this.current === s) this.fail(new Error("语音合成已取消")); },
      get text() { return s.text; },
    };
  }
  flush(s) {
    if (this.current !== s || !s.started || this.socket?.readyState !== WebSocket.OPEN) return;
    if (s.pending.length) {
      // Only coalesce bytes already waiting for connection; never wait to form sentences.
      this.socket.send(ttsPacket(200, { event: 200, namespace: "BidirectionalTTS", req_params: { text: s.pending.join("") } }, s.id));
      s.pending.length = 0; s.touch();
    }
    if (s.finishing && !s.finishSent) {
      s.finishSent = true;
      this.socket.send(ttsPacket(102, {}, s.id));
    }
  }
  receive(message) {
    const { event, type, sessionId, payload } = message;
    if (sessionId && sessionId !== this.current?.id) return;
    if (type === 15 || event === 51 || event === 153) {
      // Service error payloads may contain submitted text; expose only the code.
      const code = message.code || (Number.isInteger(payload?.status_code) ? payload.status_code : event);
      this.fail(new Error(`豆包语音合成服务错误（${code}）`));
      return;
    }
    if (event === 50) { clearTimeout(this.connectTimer); this.connection?.resolve(); return; }
    if (event === 52) { this.close(); return; }
    const s = this.current;
    if (!s || sessionId !== s.id) return;
    s.touch();
    if (event === 150) { s.started = true; this.flush(s); }
    if (event === 352 && type === 11 && Buffer.isBuffer(payload)) {
      s.bytes += payload.length;
      if (s.bytes > 64 * 1024 * 1024 || s.audio.readableLength + s.audio.writableLength + payload.length > 4 * 1024 * 1024) {
        this.fail(new Error("语音合成音频积压过多")); return;
      }
      s.audio.write(payload);
    }
    if (event === 152) {
      if (!s.finishing || !s.bytes || s.bytes % 2) { this.fail(new Error("豆包语音合成没有返回完整音频")); return; }
      clearTimeout(s.timer); s.signal?.removeEventListener("abort", s.abort);
      this.current = null; s.audio.end(); s.done.resolve();
      // Reuse the link for the next turn, but do not retain idle sockets indefinitely.
      this.idleTimer = setTimeout(() => this.close(), 30000); this.idleTimer.unref?.();
    }
    if (event === 151) this.fail(new Error("语音合成已取消"));
  }
  fail(error) {
    const s = this.current; this.current = null;
    if (s) {
      clearTimeout(s.timer); s.signal?.removeEventListener("abort", s.abort);
      s.audio.destroy(error); s.done.reject(error);
    }
    this.connection?.reject(error);
    this.close();
  }
  close() {
    clearTimeout(this.connectTimer); clearTimeout(this.idleTimer);
    if (this.current) { this.fail(new Error("语音合成已关闭")); return; }
    const socket = this.socket;
    this.connection?.reject(new Error("语音合成连接已关闭"));
    this.socket = null; this.connection = null;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(ttsPacket(2)); socket.close();
    } else if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }
}

export async function* streamVolcengineSpeech(profile, text, signal) {
  const client = new VolcengineTts(profile);
  try {
    const session = client.session(signal);
    session.write(text); void session.finish().catch(() => {});
    yield* session.audio;
    await session.completion;
  } finally { client.close(); }
}
