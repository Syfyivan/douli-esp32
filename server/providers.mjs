import WebSocket from "ws";
import { VolcengineTranscriber } from "./volcengine-asr.mjs";
import { wav } from "./audio.mjs";
import { isVolcengineTts, streamVolcengineSpeech } from "./volcengine-tts.mjs";
export { speechProfile } from "./volcengine-tts.mjs";

export class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigurationError";
  }
}
const combined = (signal, ms = 60000) =>
  signal
    ? AbortSignal.any([signal, AbortSignal.timeout(ms)])
    : AbortSignal.timeout(ms);
function endpoint(profile, suffix) {
  if (!profile?.baseUrl || !profile.model)
    throw new ConfigurationError(
      "请先在设置中配置相应模型的服务地址和模型名称",
    );
  return profile.baseUrl.replace(/\/$/, "") + suffix;
}
function headers(p) {
  return p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {};
}
function providerOptions(p) {
  // Do not send vendor-specific fields to unrelated compatible endpoints.
  const host = new URL(p.baseUrl).hostname;
  if (host === "api.deepseek.com")
    return { thinking: { type: "disabled" } };
  return /(^|\.)siliconflow\.(cn|com)$/i.test(host) &&
    /Qwen3|DeepSeek-V[34]/i.test(p.model)
    ? { enable_thinking: false }
    : {};
}
async function checked(response, p) {
  if (!response.ok) {
    let detail = (await response.text()).slice(0, 350);
    if (p.apiKey) detail = detail.replaceAll(p.apiKey, "[redacted]");
    throw new Error(`模型服务返回 ${response.status}：${detail}`);
  }
  return response;
}
export async function complete(profile, messages, signal, options = {}) {
  const { timeoutMs = 60000, ...requestOptions } = options;
  const r = await fetch(endpoint(profile, "/chat/completions"), {
    method: "POST",
    headers: { ...headers(profile), "Content-Type": "application/json" },
    body: JSON.stringify({
      model: profile.model,
      messages,
      temperature: 0.2,
      max_tokens: 1200,
      ...requestOptions,
      ...providerOptions(profile),
    }),
    signal: combined(signal, timeoutMs),
  });
  const data = await (await checked(r, profile)).json();
  return data.choices?.[0]?.message?.content || "";
}
export async function embed(profile, input, signal) {
  const response = await fetch(endpoint(profile, "/embeddings"), {
    method: "POST",
    headers: { ...headers(profile), "Content-Type": "application/json" },
    body: JSON.stringify({ model: profile.model, input, encoding_format: "float" }),
    signal: combined(signal, 15000),
  });
  const data = await (await checked(response, profile)).json();
  const rows = [...(data.data || [])].sort((a, b) => a.index - b.index);
  if (rows.length !== input.length || rows.some((r, i) => r.index !== i ||
      !Array.isArray(r.embedding) || !r.embedding.length || r.embedding.length > 16384 ||
      !r.embedding.every(Number.isFinite) || r.embedding.length !== rows[0].embedding.length ||
      !r.embedding.some(v => v !== 0))) throw new Error("向量服务返回无效数据");
  return rows.map(r => r.embedding);
}
export async function rerank(profile, query, documents, signal) {
  const response = await fetch(endpoint(profile, "/rerank"), {
    method: "POST", headers: { ...headers(profile), "Content-Type": "application/json" },
    body: JSON.stringify({ model: profile.model, query, documents, return_documents: false, top_n: documents.length }),
    signal: combined(signal, 15000),
  });
  const data = await (await checked(response, profile)).json();
  if (!Array.isArray(data.results) || data.results.length !== documents.length ||
    new Set(data.results.map(r => r.index)).size !== documents.length || data.results.some(r =>
      !Number.isInteger(r.index) || r.index < 0 || r.index >= documents.length || !Number.isFinite(r.relevance_score)))
    throw new Error("重排服务返回无效数据");
  return data.results;
}
export async function* streamChat(profile, messages, signal, tools = []) {
  const r = await fetch(endpoint(profile, "/chat/completions"), {
    method: "POST",
    headers: { ...headers(profile), "Content-Type": "application/json" },
    body: JSON.stringify({
      model: profile.model,
      messages,
      stream: true,
      temperature: 0.65,
      max_tokens: 1800,
      ...providerOptions(profile),
      ...(tools.length ? { tools } : {}),
    }),
    signal: combined(signal, 120000),
  });
  await checked(r, profile);
  const decoder = new TextDecoder();
  let pending = "";
  const calls = new Map();
  let reportedModel;
  let reasoningContent;
  for await (const chunk of r.body) {
    pending += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (!line.startsWith("data:") || line.slice(5).trim() === "[DONE]")
        continue;
      const data = JSON.parse(line.slice(5));
      if (data.error) throw new Error(data.error.message || "模型流返回错误");
      if (data.usage && typeof data.usage === "object") {
        const usage = {};
        for (const key of ["prompt_tokens", "completion_tokens", "total_tokens", "prompt_cache_hit_tokens", "prompt_cache_miss_tokens"])
          if (Number.isSafeInteger(data.usage[key]) && data.usage[key] >= 0) usage[key] = data.usage[key];
        if (Object.keys(usage).length) yield { type: "usage", usage };
      }
      if (typeof data.model === "string" && data.model.length <= 200 && data.model !== reportedModel) {
        reportedModel = data.model;
        yield { type: "model", model: data.model };
      }
      const delta = data.choices?.[0]?.delta;
      // Keep provider reasoning internal, only for continuing this tool round.
      if (typeof delta?.reasoning_content === "string")
        reasoningContent = (reasoningContent || "") + delta.reasoning_content;
      if (delta?.content) yield { type: "text", text: delta.content };
      for (const item of delta?.tool_calls || []) {
        const c = calls.get(item.index) || {
          id: "",
          type: "function",
          function: { name: "", arguments: "" },
        };
        if (item.id) c.id = item.id;
        if (item.function?.name) c.function.name += item.function.name;
        if (item.function?.arguments)
          c.function.arguments += item.function.arguments;
        calls.set(item.index, c);
      }
    }
  }
  if (calls.size) yield { type: "tools", calls: [...calls.values()], reasoningContent };
}
export async function transcribe(profile, pcm, context, signal) {
  const form = new FormData();
  form.set(
    "file",
    new Blob([wav(pcm)], { type: "audio/wav" }),
    "utterance.wav",
  );
  form.set("model", profile.model);
  form.set("response_format", "json");
  if (context) form.set("prompt", context.slice(0, 3000));
  const r = await fetch(endpoint(profile, "/audio/transcriptions"), {
    method: "POST",
    headers: headers(profile),
    body: form,
    signal: combined(signal),
  });
  return (await (await checked(r, profile)).json()).text || "";
}
export async function synthesize(profile, text, signal, { maxBytes = 64 * 1024 * 1024 } = {}) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of streamSpeech(profile, text, signal)) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error("单段合成音频过长");
    chunks.push(chunk);
  }
  signal?.throwIfAborted();
  if (bytes % 2) throw new Error("合成音频包含不完整 PCM 样本");
  return { pcm: Buffer.concat(chunks), sampleRate: profile.pcmSampleRate || 24000 };
}
export async function* streamSpeech(profile, text, signal) {
  if (isVolcengineTts(profile)) { yield* streamVolcengineSpeech(profile, text, signal); return; }
  const r = await fetch(endpoint(profile, "/audio/speech"), {
    method: "POST",
    headers: { ...headers(profile), "Content-Type": "application/json" },
    body: JSON.stringify({
      model: profile.model,
      input: text,
      voice: profile.voice || "alloy",
      response_format: "pcm",
      ...(/(^|\.)siliconflow\.(cn|com)$/.test(new URL(profile.baseUrl).hostname)
        ? { sample_rate: profile.pcmSampleRate || 24000, stream: true }
        : {}),
    }),
    signal: combined(signal),
  });
  await checked(r, profile);
  let received = 0;
  for await (const chunk of r.body) {
    signal?.throwIfAborted();
    received += chunk.byteLength;
    if (received > 64 * 1024 * 1024) throw new Error("单段合成音频过长");
    if (chunk.byteLength) yield Buffer.from(chunk);
  }
  if (!received) throw new Error("语音合成返回空音频");
}

// Optional provider bridge contract, NOT Typeless's private endpoint:
// JSON start/context/stop + raw 16k mono PCM; responses partial/final/error.
export class LiveTranscriber {
  constructor(settings, context, onPartial = () => {}) {
    if (settings.input.asrProvider === "volcengine") return new VolcengineTranscriber(settings, context, onPartial);
    this.settings = settings;
    this.context = context;
    this.onPartial = onPartial;
    this.frames = [];
    this.pending = [];
    this.closed = false;
    this.bytes = 0;
    this.speechBytes = 0;
    this.lastPreviewAt = Date.now();
    this.id = crypto.randomUUID();
    this.result = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    this.result.catch(() => {});
    if (settings.input.streamingUrl) {
      this.socket = new WebSocket(settings.input.streamingUrl, {
        headers: settings.input.streamingToken
          ? { Authorization: `Bearer ${settings.input.streamingToken}` }
          : {},
        handshakeTimeout: 5000,
      });
      this.socket.on("open", () => {
        this.socket.send(
          JSON.stringify({
            type: "start",
            id: this.id,
            sampleRate: 16000,
            channels: 1,
            context,
          }),
        );
        this.flush();
        if (this.finishing) this.sendStop();
      });
      this.socket.on("message", (raw) => {
        try {
          const m = JSON.parse(raw.toString());
          if (m.id && m.id !== this.id) return;
          if (m.type === "partial") this.onPartial(String(m.text || ""));
          if (m.type === "final") {
            if (String(m.text || "").trim()) this.resolve(m.text);
            else this.reject(new Error("流式识别结果为空"));
          }
          if (m.type === "error") this.reject(new Error("流式识别服务失败"));
        } catch {
          this.reject(new Error("流式识别协议错误"));
        }
      });
      this.socket.on("error", () => this.reject(new Error("流式识别连接失败")));
      this.socket.on("close", () => this.reject(new Error("流式识别连接关闭")));
    }
  }
  push(pcm, speech = true) {
    if (this.closed) return;
    this.frames.push(pcm);
    this.bytes += pcm.length;
    if (speech) this.speechBytes = this.bytes;
    this.pending.push(pcm);
    if (
      this.pending.reduce((s, b) => s + b.length, 0) >=
      Math.min(this.settings.input.chunkMs, 200) * 32
    )
      this.flush();
    if (!this.socket && this.settings.input.previewMs && !this.previewControl &&
        this.speechBytes > (this.previewResult?.speechBytes || 0) &&
        Date.now() - this.lastPreviewAt >= this.settings.input.previewMs) this.preview();
  }
  preview() {
    const control = this.previewControl = new AbortController();
    const speechBytes = this.speechBytes;
    this.lastPreviewAt = Date.now();
    void transcribe(this.settings.models.asr, Buffer.concat(this.frames), this.context,
      AbortSignal.any([control.signal, AbortSignal.timeout(3000)])).then(text => {
      if (this.closed || control.signal.aborted || !text?.trim()) return;
      this.previewResult = { text, speechBytes };
      this.onPartial(text);
    }).catch(() => {}).finally(() => { if (this.previewControl === control) this.previewControl = null; });
  }
  flush() {
    if (this.socket?.readyState === WebSocket.OPEN && this.pending.length) {
      this.socket.send(Buffer.concat(this.pending));
      this.pending = [];
    }
  }
  async finish(signal) {
    const pcm = Buffer.concat(this.frames);
    const fallback = new AbortController();
    let timer, onAbort;
    try {
      if (!this.socket && this.previewResult?.speechBytes === this.speechBytes)
        return this.previewResult.text;
      if (!this.socket)
        return await transcribe(
          this.settings.models.asr,
          pcm,
          this.context,
          signal,
        );
      this.finishing = true;
      this.flush();
      this.sendStop();
      const delayedHttp = new Promise((resolve, reject) => {
        let started = false;
        const run = () => {
          if (started || fallback.signal.aborted) return;
          started = true;
          clearTimeout(timer);
          transcribe(
            this.settings.models.asr,
            pcm,
            this.context,
            fallback.signal,
          ).then(resolve, reject);
        };
        timer = setTimeout(run, this.settings.input.finalTimeoutMs);
        this.result.catch(run);
      });
      const aborted = new Promise((_, reject) => {
        onAbort = () => reject(signal.reason);
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
      return await Promise.race([
        Promise.any([this.result, delayedHttp]),
        aborted,
      ]);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(timer);
      fallback.abort();
      this.close();
    }
  }
  sendStop() {
    if (!this.sentStop && this.socket?.readyState === WebSocket.OPEN) {
      this.sentStop = true;
      this.socket.send(JSON.stringify({ type: "stop", id: this.id }));
    }
  }
  close() {
    this.closed = true;
    this.previewControl?.abort();
    this.pending = [];
    this.frames = [];
    if (this.socket?.readyState === WebSocket.CONNECTING)
      this.socket.terminate();
    else this.socket?.close();
  }
}
