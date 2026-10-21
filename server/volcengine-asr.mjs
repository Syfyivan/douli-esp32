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
export function asrCorpus(settings, context) {
  let saved = {};
  try { saved = JSON.parse(context || "{}"); } catch {}
  const name = settings.assistant?.name || "豆梨";
  // Correct spellings only: supplying misrecognitions as hotwords reinforces them.
  const words = [...new Set([name, ...(Array.isArray(saved.vocabulary) ? saved.vocabulary : [])]
    .filter(word => typeof word === "string").map(word => word.trim()).filter(Boolean))];
  let remaining = 72;
  const hotwords = words.flatMap(word => {
    if (word.length > 30 || word.length > remaining) return [];
    remaining -= word.length;
    return [{ word }];
  });
  remaining = 550;
  const history = (Array.isArray(saved.recent) ? saved.recent : []).slice(-6).reverse().flatMap(item => {
    const text = String(item.text || "").slice(0, Math.max(0, Math.min(remaining, 160)));
    remaining -= text.length;
    return text ? [{ text }] : [];
  });
  return { context: JSON.stringify({ hotwords, context_type: "dialog_ctx", context_data: [
    { text: `用户正在与名叫“${name}”的语音助手对话，会用“${name}”称呼助手。` }, ...history,
  ] }) };
}
// Application rejection policy for SAUC mode 2 similarity scores (not
// probabilities). Keep an absolute floor AND separation from the runner-up.
export const VOICEPRINT_MIN_SIMILARITY = 0.5;
export const VOICEPRINT_MIN_MARGIN = 0.1;
export function identifySpeaker(result, settings, audioBytes) {
  const unknown = reason => ({ status: "unknown", method: "voiceprint", reason });
  if (!settings.people?.voiceIdentification) return unknown("not_enrolled");
  if (audioBytes < 32000) return unknown("short_audio");
  const utterances = result?.utterances?.filter(u => u.text?.trim()) || [];
  if (!utterances.length) return unknown("no_utterances");
  const people = [];
  for (const utterance of utterances) {
    // SAUC's actual final response puts speaker_id inside additions. Some
    // protocol variants serialize additions as JSON or put it at the top level.
    let additions = utterance.additions;
    if (typeof additions === "string") { try { additions = JSON.parse(additions); } catch { return unknown("invalid_speaker_metadata"); } }
    const ids = [utterance.speaker_id, additions?.speaker_id].filter(id => id != null);
    if (!ids.length && additions?.speaker != null) ids.push(additions.speaker);
    let attributes = utterance.attributes;
    if (typeof attributes === "string") { try { attributes = JSON.parse(attributes); } catch { return unknown("invalid_speaker_metadata"); } }
    // Observed mode-2 responses carry registered comparison scores separately
    // in attributes.voiceprint_matches; speaker_id may still be just "0".
    if (attributes && Object.hasOwn(attributes, "voiceprint_matches")) {
      const matches = attributes.voiceprint_matches;
      if (!Array.isArray(matches) || !matches.length || matches.length > 50) return unknown("invalid_voiceprint_matches");
      if (matches.some(m => !m || typeof m.id !== "string" || typeof m.name !== "string" ||
          typeof m.similarity !== "number" || !Number.isFinite(m.similarity) || m.similarity < -1 || m.similarity > 1))
        return unknown("invalid_voiceprint_matches");
      const ranked = [...matches].sort((a, b) => b.similarity - a.similarity);
      const best = ranked[0];
      const member = settings.people.members.find(p => p.voiceId === best.id && p.voiceName === best.name);
      if (!member) return unknown("unmatched_voice");
      if (best.similarity < VOICEPRINT_MIN_SIMILARITY) return unknown("low_voiceprint_similarity");
      if (ranked[1] && best.similarity - ranked[1].similarity < VOICEPRINT_MIN_MARGIN) return unknown("ambiguous_voiceprint");
      // A real named label must agree; numeric cluster indices carry no identity.
      if (ids.some(id => !/^\d+$/.test(String(id)) && id !== member.voiceId && id !== member.voiceName))
        return unknown("conflicting_speaker_ids");
      people.push(member.personId);
      continue;
    }
    if (!ids.length) return unknown("missing_speaker_id");
    const matched = ids.map(id => settings.people.members.find(p => id === p.voiceName || id === p.voiceId)?.personId);
    // Anonymous indices like "0" never identify a registered family member.
    if (matched.some(id => !id)) return unknown("unmatched_voice");
    if (new Set(matched).size !== 1) return unknown("conflicting_speaker_ids");
    people.push(matched[0]);
  }
  if (new Set(people).size !== 1) return unknown("mixed_speakers");
  return { status: "matched", method: "voiceprint", personId: people[0] };
}
export class VolcengineTranscriber {
  constructor(settings, context, onPartial = () => {}) {
    const profile = settings.models.streamingAsr;
    if (!profile?.baseUrl || !profile.model || !profile.apiKey) throw new Error("请先配置火山流式识别的地址、资源 ID 和 API Key");
    this.settings = settings; this.onPartial = onPartial; this.pending = [];
    this.pendingBytes = 0; this.totalBytes = 0; this.text = "";
    this.speaker = { status: "unknown", method: "voiceprint" };
    this.result = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    this.result.catch(() => {});
    const corpus = asrCorpus(settings, context);
    const url = new URL(profile.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    this.socket = new WebSocket(url, { headers: { "X-Api-Key": profile.apiKey, "X-Api-Resource-Id": profile.model, "X-Api-Connect-Id": randomUUID() }, handshakeTimeout: 5000, maxPayload: 1024 * 1024 });
    this.socket.on("open", () => {
      if (this.closed) return;
      this.socket.send(asrPacket(1, {
        user: { uid: "douli" }, audio: { format: "pcm", rate: 16000, bits: 16, channel: 1 },
        request: { model_name: "bigmodel", enable_itn: true, enable_punc: true, enable_ddc: false,
          enable_nonstream: settings.input.asrTwoPass !== false, show_utterances: true, corpus,
          ...(settings.people?.voiceIdentification && settings.people.groupId ? {
            enable_nonstream: true, enable_speaker_info: true, ssd_version: "200", ssd_mode: 2,
            voiceprints: [{ id: "", group_id: settings.people.groupId }],
          } : {}) },
      }));
      this.flush(!!this.finishing);
    });
    this.socket.on("message", raw => {
      if (this.closed) return;
      try {
        const event = readAsrPacket(raw), text = event.value.result?.text;
        if (typeof text === "string") { this.text = text; this.onPartial(text); }
        if (event.final) {
          this.speaker = identifySpeaker(event.value.result, settings, this.totalBytes);
          // Bounded, text-free diagnostics distinguish anonymous clustering
          // from a registered match without retaining audio or voice IDs.
          const utterances = event.value.result?.utterances || [];
          this.speaker.diagnostic = { audioMs: Math.round(this.totalBytes / 32),
            utterances: utterances.length, labels: utterances.slice(0, 12).map(u => {
              let additions = u.additions;
              if (typeof additions === "string") { try { additions = JSON.parse(additions); } catch {} }
              const id = u.speaker_id ?? additions?.speaker_id ?? additions?.speaker;
              if (id == null) return "missing";
              if (settings.people?.members?.some(p => p.voiceName === id || p.voiceId === id)) return "registered";
              return /^\d{1,3}$/.test(String(id)) ? `anonymous:${id}` : "unregistered";
            }), candidates: utterances.slice(0, 12).map(u => (Array.isArray(u.attributes?.voiceprint_matches)
              ? u.attributes.voiceprint_matches : []).slice(0, 10).map(match => ({
              personId: settings.people?.members?.find(p => p.voiceId === match.id && p.voiceName === match.name)?.personId || null,
              similarity: typeof match.similarity === "number" && Number.isFinite(match.similarity) ? match.similarity : null,
            }))) };
          this.resolve(this.text);
        }
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
