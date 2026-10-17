import { randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
  codec,
  packAudio,
  unpackAudio,
  resample,
  PcmResampler,
  rms,
  BargeInBuffer,
  UtteranceBuffer,
  wav,
} from "./audio.mjs";
import { LiveTranscriber, streamSpeech, synthesize } from "./providers.mjs";
import { VoiceState } from "./voice-state.mjs";
import { SpeechDetector } from "./speech-detector.mjs";
import { SpeechSegments } from "./voice-segments.mjs";
import { TurnDetector, isBackchannel, isExplicitInterruption } from "./turn-detector.mjs";
import { validateFrame } from "./vision.mjs";
import { isNight, deviceConfig } from "./config.mjs";
import { isFarewell } from "./voice-commands.mjs";
import { controlSpeaker } from "./speaker-control.mjs";
import { isLocalOrigin } from "./local-origin.mjs";
import { RealtimeVoice } from "./realtime-voice.mjs";
import { StreamingPlayback } from "./streaming-playback.mjs";
import { GreetingAudio } from "./greeting-audio.mjs";
import { AudioPacer } from "./audio-pacer.mjs";
import { audibleContext } from "./voice-state.mjs";

const DEVICE_STANDBY_MS = 30 * 60 * 1000;

function equalSecret(a, b) {
  const x = Buffer.from(a || ""),
    y = Buffer.from(b || "");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
export class Gateway {
  constructor(store, engine, { adminPort = 8788 } = {}) {
    this.store = store;
    this.engine = engine;
    this.connections = new Map();
    this.pairingUntil = 0;
    this.wsServers = [];
    this.activations = new Map();
    this.adminPort = adminPort;
    this.greetingAudio = new GreetingAudio();
  }
  warmGreeting() {
    if (this.connections.size) return this.greetingAudio.warm(this.store.settings());
    return Promise.resolve();
  }
  pair() {
    this.pairingUntil = Date.now() + 5 * 60 * 1000;
    return this.pairingUntil;
  }
  authorized(request) {
    const id = String(request.headers["device-id"] || "");
    const device = this.store.db
      .prepare("SELECT * FROM devices WHERE id=?")
      .get(id);
    return device?.approved &&
      equalSecret(
        String(request.headers.authorization || "").replace(/^Bearer /, ""),
        device.token,
      )
      ? device
      : null;
  }
  ota(request, gatewayPort, remoteOrigin = null) {
    const id = String(request.headers["device-id"] || "");
    if (!/^[A-Za-z0-9:_-]{5,100}$/.test(id))
      throw new Error("缺少有效 Device-Id");
    let device = this.store.db
      .prepare("SELECT * FROM devices WHERE id=?")
      .get(id);
    if (!device) {
      if (Date.now() > this.pairingUntil)
        return {
          activation: {
            code: "000000",
            message: "请先在豆梨的设备页面开启配对",
            challenge: "pairing-required",
            timeout_ms: 30000,
          },
        };
      this.store.db
        .prepare("INSERT INTO devices VALUES (?,?,0,?,?,?,?)")
        .run(
          id,
          `ESP32 ${id.slice(-5)}`,
          randomBytes(32).toString("hex"),
          String(request.body?.application?.version || ""),
          new Date().toISOString(),
          "{}",
        );
      device = this.store.db
        .prepare("SELECT * FROM devices WHERE id=?")
        .get(id);
    }
    if (!device.approved) {
      for (const [key, value] of this.activations)
        if (value.expires < Date.now()) this.activations.delete(key);
      let pending = this.activations.get(id);
      if (!pending) {
        pending = {
          code: String(randomInt(100000, 1000000)),
          challenge: randomBytes(24).toString("hex"),
          clientId: String(request.headers["client-id"] || ""),
          expires: Date.now() + 5 * 60000,
        };
        this.activations.set(id, pending);
      }
      return {
        activation: {
          code: pending.code,
          challenge: pending.challenge,
          timeout_ms: 30000,
          message: "请在豆梨的设备页确认这块 ESP32",
        },
      };
    }
    const firmware = String(
      request.body?.application?.version || device.firmware || "",
    ).slice(0, 80);
    this.store.db
      .prepare("UPDATE devices SET firmware=?,last_seen=? WHERE id=?")
      .run(firmware, new Date().toISOString(), device.id);
    const host = this.serviceHostname?.() || String(request.headers.host || "").replace(/:\d+$/, "");
    if (!remoteOrigin && !/^[A-Za-z0-9.\-]+$/.test(host)) throw new Error("无效的设备服务地址");
    const websocketUrl = remoteOrigin
      ? `${remoteOrigin.replace(/^https:/, "wss:")}/xiaozhi/v1/`
      : `ws://${host}:${gatewayPort}/xiaozhi/v1/`;
    return {
      server_time: {
        timestamp: Date.now(),
        timezone_offset: -new Date().getTimezoneOffset(),
      },
      websocket: {
        url: websocketUrl,
        token: device.token,
        version: 1,
      },
      firmware: {
        version: String(
          request.body?.application?.version || device.firmware || "0.0.0",
        ),
        url: "",
      },
    };
  }
  activationStatus(request) {
    const id = String(request.headers["device-id"] || "");
    const device = this.store.db
      .prepare("SELECT approved FROM devices WHERE id=?")
      .get(id);
    const pending = this.activations.get(id);
    if (!device?.approved || !pending || pending.expires < Date.now())
      return false;
    if (pending.clientId && request.headers["client-id"] !== pending.clientId)
      return false;
    if (request.body?.challenge && request.body.challenge !== pending.challenge)
      return false;
    // Activation v1 sends {}, v2 includes a challenge/HMAC. Local approval is
    // our trust boundary; we do not claim to verify the manufacturer's eFuse key.
    return true;
  }
  attach(server, browser = false, { remote = false } = {}) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: (browser ? 768 : 128) * 1024 });
    this.wsServers.push(wss);
    server.on("upgrade", (request, socket, head) => {
      let url;
      try {
        url = new URL(request.url, "http://localhost");
      } catch {
        socket.destroy();
        return;
      }
      const allowedPath = browser ? "/api/voice" : "/xiaozhi/v1/";
      if (url.pathname !== allowedPath) {
        socket.destroy();
        return;
      }
      let device;
      if (browser) {
        if (!isLocalOrigin(request.headers.origin, this.adminPort)) {
          socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
          return;
        }
      } else {
        device = this.authorized(request);
        if (!device) {
          socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
          return;
        }
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        try {
          const previous = device && this.connections.get(device.id);
          previous?.saveConversation();
          const connection = new VoiceConnection(this, ws, {
            browser,
            remote,
            device,
            sessionId: browser ? url.searchParams.get("session") : null,
            route: url.searchParams.get("route") || "auto",
          });
          if (device) {
            if (previous) {
              previous.superseded = true;
              previous.abort();
            }
            this.connections.set(device.id, connection);
            previous?.close();
          }
        } catch {
          ws.close(1011, "Cannot open session");
        }
      });
    });
  }
  async call(id, tool, args, signal) {
    const connection = this.connections.get(id);
    if (!connection) throw new Error("设备未连接");
    if (!connection.tools.some((t) => t.name === tool))
      throw new Error("设备未提供这个工具");
    const result = await connection.rpc(
      "tools/call",
      { name: tool, arguments: args },
      signal,
    );
    if (result.isError) throw new Error("设备报告执行失败");
    return {
      acknowledged: true,
      verified: false,
      message: "设备已返回执行结果",
      result,
    };
  }
  devices() {
    return this.store.all("devices").map(({ token, ...d }) => ({
      ...d,
      online: this.connections.has(d.id),
      state: this.connections.get(d.id)?.state || "offline",
      connection: this.connections.has(d.id) ? {
        remote: !!this.connections.get(d.id).options.remote,
        persistent: this.connections.get(d.id).persistent,
        standby: this.connections.get(d.id).standby,
        standbyConfirmed: this.connections.get(d.id).standbyConfirmed,
        connectedAt: this.connections.get(d.id).connectedAt,
        audioFramesReceived: this.connections.get(d.id).audioFramesReceived,
        deviceAec: this.connections.get(d.id).features?.device_aec === true,
        bargeInCount: this.connections.get(d.id).bargeInCount,
        lastBargeInAt: this.connections.get(d.id).lastBargeInAt,
        lastBargeCandidate: this.connections.get(d.id).lastBargeCandidate ?? null,
        heartbeatRttMs: this.connections.get(d.id).heartbeatRttMs ?? null,
        lastWake: this.connections.get(d.id).lastWake ?? null,
        lastReply: this.connections.get(d.id).lastReply ?? null,
        greetingAudio: this.greetingAudio.snapshot(),
        voice: this.connections.get(d.id).call.snapshot(),
      } : null,
      tools: this.connections.get(d.id)?.tools || [],
      config: deviceConfig(JSON.parse(d.metadata || "{}").config),
      activationCode: !d.approved
        ? this.activations.get(d.id)?.code
        : undefined,
    }));
  }
  close() {
    this.greetingAudio.close();
    // WebSocket close events may arrive after the application closes SQLite.
    for (const connection of this.connections.values()) connection.saveConversation();
    for (const wss of this.wsServers) {
      for (const ws of wss.clients) ws.close();
      wss.close();
    }
  }
}

export class VoiceConnection {
  constructor(gateway, socket, options) {
    this.gateway = gateway;
    this.store = gateway.store;
    this.engine = gateway.engine;
    this.ws = socket;
    this.options = options;
    this.call = new VoiceState(state => { if (this.hello) this.send({ type: "voice_state", ...state }); });
    this.turns = new Map();
    this.outputWaiters = new Set();
    this.state = "connected";
    this.version = 1;
    this.format = options.browser ? "pcm" : "opus";
    this.inputRate = 16000;
    this.tools = [];
    this.pendingRpc = new Map();
    this.pendingBackend = new Map();
    this.rpcId = 10;
    const metadata = options.device
      ? JSON.parse(this.store.db.prepare("SELECT metadata FROM devices WHERE id=?").get(options.device.id)?.metadata || "{}")
      : {};
    this.config = deviceConfig(metadata.config);
    let previous = null;
    const saved = metadata.voiceSession;
    if (options.device && saved?.active === true && typeof saved.id === "string" && saved.id &&
        Number.isFinite(saved.lastActivity) && Date.now() - saved.lastActivity < DEVICE_STANDBY_MS) {
      const found = this.store.db.prepare("SELECT * FROM sessions WHERE id=?").get(saved.id);
      if (found?.source === options.device.id) previous = found;
      else if (!found && saved.persisted === false) previous = { id: saved.id, source: options.device.id };
    }
    // Reserve an ID for the wire protocol; save the row only after real speech.
    // Unmarked legacy sessions are history, not evidence of an ongoing chat.
    this.session = options.device
      ? previous || { id: randomUUID(), source: options.device.id }
      : this.store.session(options.sessionId, "browser-voice");
    this.sessionPersisted = !options.device || !!previous?.created_at;
    this.conversationStarted = !!previous;
    this.conversationEnded = false;
    this.buffer = new UtteranceBuffer(this.inputSettings());
    this.bargeIn = new BargeInBuffer();
    this.speechDetector = new SpeechDetector();
    this.turnDetector = new TurnDetector(this.store.settings());
    this.bargeInCount = 0;
    this.lastBargeInAt = null;
    this.decoder = codec();
    this.encoder = codec();
    this.generation = 0;
    this.alive = true;
    this.lastActivity = Date.now();
    this.connectedAt = new Date().toISOString();
    this.audioFramesReceived = 0;
    this.lastConversationActivity = previous ? saved.lastActivity : this.lastActivity;
    this.hello = false;
    this.persistent = false;
    this.standby = false;
    this.standbyConfirmed = false;
    this.timer = setInterval(() => {
      if (!this.alive || Date.now() - this.lastActivity > 180000)
        return this.close();
      // Transport traffic (including silent audio) does not extend a conversation.
      // Let recognition, generation and playback finish before entering standby.
      if (
        options.device && this.hello && !this.standby &&
        !["thinking", "speaking"].includes(this.state) &&
        Date.now() - this.lastConversationActivity >= DEVICE_STANDBY_MS
      ) {
        this.endConversation("inactivity");
        if (!this.persistent) return;
      }
      this.alive = false;
      if (this.persistent) {
        this.heartbeatSentAt = Date.now();
        this.send({ type: "ping" });
        void this.gateway.warmGreeting?.();
      }
      else this.ws.ping();
    }, 30000);
    this.timer.unref();
    socket.on("pong", () => {
      this.alive = true;
    });
    socket.on("message", (raw, binary) => {
      this.lastActivity = Date.now();
      try {
        if (binary) {
          this.audioFramesReceived++;
          this.audio(raw);
        }
        else this.message(JSON.parse(raw.toString()));
      } catch (e) {
        this.error(e);
      }
    });
    socket.on("error", () => this.close());
    socket.on("close", () => {
      this.saveConversation();
      this.realtime?.close();
      clearInterval(this.timer);
      clearTimeout(this.standbyTimer);
      this.abort();
      this.call.update({ connection: "closed" });
      this.speechDetector.close();
      this.turnDetector.close();
      clearTimeout(this.pauseTimer);
      this.decoder.delete();
      this.encoder.delete();
      for (const p of this.pendingRpc.values())
        p.reject(new Error("设备连接已断开"));
      for (const p of this.pendingBackend.values()) p.reject(new Error("切换尚未确认，设备连接已断开"));
      if (options.device && gateway.connections.get(options.device.id) === this)
        gateway.connections.delete(options.device.id);
    });
  }
  get state() { return this.call.legacy; }
  set state(value) {
    if (value === "connected") return this.call.update({ connection: value });
    if (value === "idle") return this.call.update({ input: "off", output: "idle" });
    if (value === "listening") return this.call.update({ input: "listening", output: "idle" });
    if (["thinking", "speaking"].includes(value)) this.call.update({ input: "listening", output: value });
  }
  send(message) {
    if (this.ws.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify({ session_id: this.session.id, turn_id: this.call.turnId, ...message }));
  }
  startTurn(lastSpeechAt = this.lastSpeechAt || Date.now()) {
    const turn = { id: this.generation, startedAt: Date.now(), lastSpeechAt, segments: [], timings: {}, acknowledged: !!this.features?.playback_ack };
    this.turns.set(turn.id, turn);
    while (this.turns.size > 6) this.turns.delete(this.turns.keys().next().value);
    this.call.update({ turnId: turn.id });
    this.mark(turn, "endpointMs", Math.max(0, turn.startedAt - turn.lastSpeechAt));
    return turn;
  }
  mark(turn, name, value) {
    if (!turn || Object.hasOwn(turn.timings, name)) return;
    turn.timings[name] = value;
    this.send({ type: "metric", turn_id: turn.id, name, value });
  }
  savePlayback(turn) {
    if (!turn?.messageId || this.store.closed) return;
    const row = this.store.db.prepare("SELECT metadata FROM messages WHERE id=?").get(turn.messageId);
    if (!row) return;
    const metadata = JSON.parse(row.metadata || "{}");
    const segments = turn.segments;
    const playedMs = segments.reduce((n, s) => n + (s.playedMs || 0), 0);
    const totalMs = segments.reduce((n, s) => n + s.durationMs, 0);
    const complete = turn.generated && segments.length > 0 && segments.every(s => s.finished && s.playedMs >= s.durationMs);
    const playback = { turnId: turn.id, playedMs, totalMs, status: turn.interrupted ? "interrupted" : !turn.acknowledged ? "unverified" : complete ? "complete" : "playing", spokenText: metadata.healthPrivate ? "" : segments.filter(s => s.finished && s.playedMs >= s.durationMs).map(s => s.text).join(""), timings: turn.timings };
    if (turn.audioDelivery) playback.audioDelivery = turn.audioDelivery;
    // Health answers remain exclusively in the encrypted vault. Playback
    // accounting must never copy their words into ordinary message metadata.
    this.store.db.prepare("UPDATE messages SET metadata=? WHERE id=?").run(JSON.stringify({ ...metadata, voicePlayback: playback }), turn.messageId);
    this.send({ type: "playback", turn_id: turn.id, message_id: turn.messageId, ...playback });
    this.syncRealtimeContext(turn);
  }
  syncRealtimeContext(turn) {
    if (!turn?.remoteContext || this.store.closed) return;
    const { remote, remoteTurn, text } = turn.remoteContext;
    const row = turn.messageId && this.store.db.prepare("SELECT * FROM messages WHERE id=?").get(turn.messageId);
    const metadata = row ? JSON.parse(row.metadata || "{}") : {};
    const privateTurn = metadata.healthPrivate || metadata.memoryOperation || metadata.assistantControl || !row;
    const heard = privateTurn ? "" : audibleContext({ ...row, metadata });
    if (turn.cloudContext === heard) return;
    turn.cloudContext = heard;
    remote.replaceContext(remoteTurn, privateTurn ? "" : text, heard);
  }
  playback(m) {
    const turn = this.turns.get(m.turn_id);
    if (!turn?.acknowledged || !Number.isInteger(m.segment_id)) return;
    const segment = turn.segments[m.segment_id];
    if (!segment || !Number.isFinite(m.played_ms) || m.played_ms < 0) return;
    segment.playedMs = Math.max(segment.playedMs || 0, Math.min(m.played_ms, segment.durationMs));
    if (m.state === "started") this.mark(turn, "firstPlaybackMs", Date.now() - turn.lastSpeechAt);
    if (m.state === "interrupted" && turn.interruptedAt) this.mark(turn, "stopPlaybackMs", Date.now() - turn.interruptedAt);
    this.savePlayback(turn);
    if (!turn.interrupted && turn.id === this.call.turnId && turn.generated && turn.segments.every(s => s.finished && s.playedMs >= s.durationMs))
      this.call.update({ output: "idle" });
  }
  releaseOutput() { for (const release of this.outputWaiters) release(); this.outputWaiters.clear(); }
  async waitOutput(signal) {
    while (this.call.holdingPlayback && !signal.aborted) {
      await new Promise((resolve, reject) => {
        const abort = () => { this.outputWaiters.delete(done); reject(signal.reason); };
        const done = () => { signal.removeEventListener("abort", abort); resolve(); };
        this.outputWaiters.add(done);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
    signal.throwIfAborted();
  }
  async paceOutput(turn, signal, drain = false) {
    const pacer = turn.pacer ||= new AudioPacer({ leadMs: this.options.browser ? 0 : 200 });
    do {
      if (this.call.holdingPlayback) {
        const started = performance.now();
        await this.waitOutput(signal);
        pacer.postpone(performance.now() - started);
      }
      if (drain) await pacer.drain(signal);
      else await pacer.wait(signal);
    } while (this.call.holdingPlayback);
    return pacer;
  }
  recordAudioSent(turn, pacer) {
    if (!turn) return;
    const now = Date.now();
    const delivery = turn.wake || (turn.audioDelivery ??= {
      receivedAt: new Date(turn.startedAt).toISOString(), turnId: turn.id,
      firstAudioSentMs: now - turn.startedAt,
    });
    delivery.audioFramesSent = (delivery.audioFramesSent || 0) + 1;
    delivery.maxAudioSendGapMs = Math.max(delivery.maxAudioSendGapMs || 0,
      turn.lastAudioSentAt == null ? 0 : now - turn.lastAudioSentAt);
    turn.lastAudioSentAt = now;
    delivery.audioSendSpanMs = now - (turn.firstAudioSentAt ??= now);
    delivery.audioDurationMs = delivery.audioFramesSent * 20;
    delivery.bufferLeadMs = pacer.leadMs;
    if (!turn.wake) this.lastReply = delivery;
  }
  control(m) {
    if (!this.options.browser && !this.features?.voice_controls) return;
    if (!["pause", "resume", "mute", "playback_pause", "playback_resume"].includes(m.action)) return;
    if (m.action === "mute") this.call.update({ muted: m.enabled === true });
    if (m.action === "pause") this.call.update({ paused: true });
    if (m.action === "resume") this.call.update({ paused: false });
    if (m.action === "playback_pause") this.call.update({ playbackPaused: true });
    if (m.action === "playback_resume") this.call.update({ playbackPaused: false });
    if (!this.call.acceptingAudio) {
      this.buffer.reset(); this.live?.close(); this.live = null;
      this.turnDetector.reset(); this.cancelBarge();
    }
    this.realtime?.setMuted(!this.call.acceptingAudio);
    clearTimeout(this.pauseTimer);
    if (this.call.paused) {
      this.pauseTimer = setTimeout(() => this.endConversation("pause_timeout"), 10 * 60000);
      this.pauseTimer.unref();
    }
    this.releaseOutput();
    this.send({ type: "voice_state", ...this.call.snapshot() });
  }
  configureBackend(plan) {
    if (this.features?.backend_selection !== 1 || this.pendingBackend.size)
      throw new Error("设备不支持切换或已有切换正在进行");
    this.endConversation("manual");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("板子未在规定时间内确认切换")), 10000);
      const finish = (error, value) => {
        clearTimeout(timer);
        this.pendingBackend.delete(plan.revision);
        if (error) reject(error); else resolve(value);
      };
      this.pendingBackend.set(plan.revision, { resolve: value => finish(null, value), reject: error => finish(error) });
      this.send({ type: "backend", action: "configure", request_id: plan.revision, plan });
    });
  }
  recordBackend(m) {
    if (!this.options.device || this.features?.backend_selection !== 1) return;
    const backend = m.backend;
    if (!backend || !["computer", "phone", "auto"].includes(backend.mode) ||
        !["applied", "trial", "legacy"].includes(backend.phase)) return;
    const clean = { mode: backend.mode, phase: backend.phase };
    for (const key of ["revision", "targetId", "failedRevision"])
      clean[key] = typeof backend[key] === "string" ? backend[key].slice(0, 64) : "";
    this.backendStatus = clean;
    const d = this.store.db.prepare("SELECT metadata FROM devices WHERE id=?").get(this.options.device.id);
    if (d) this.store.db.prepare("UPDATE devices SET metadata=? WHERE id=?")
      .run(JSON.stringify({ ...JSON.parse(d.metadata || "{}"), backendStatus: clean }), this.options.device.id);
  }
  inputSettings() {
    const input = this.store.settings().input;
    if (this.config.rmsThreshold !== null)
      input.rmsThreshold = this.config.rmsThreshold;
    return input;
  }
  error(e) {
    this.send({
      type: "alert",
      status: "暂时无法完成",
      message: e.message,
      emotion: "neutral",
    });
    if (this.options.browser) this.send({ type: "error", message: e.message });
  }
  abort(cancelRealtime = true) {
    if (cancelRealtime) this.realtime?.cancel();
    this.pendingVision?.resolve(null);
    this.pendingVision = null;
    const turn = this.turns.get(this.call.turnId);
    if (turn && !turn.interrupted && (!turn.generated || turn.segments.some(s => !s.finished || (turn.acknowledged && s.playedMs < s.durationMs)))) {
      turn.interrupted = true;
      turn.interruptedAt = Date.now();
      this.savePlayback(turn);
    }
    this.generation++;
    this.greetingGeneration = null;
    this.controller?.abort();
    // This connection owns its controller; a stale connection must not abort a
    // new connection or a text request that happens to share the same session.
    this.live?.close();
    this.live = null;
    this.buffer.reset();
    this.bargeIn.reset();
    this.cancelBarge();
    this.turnDetector.reset();
    this.releaseOutput();
    this.send({ type: "tts", state: "stop", interrupted: true });
    this.state = "idle";
  }
  close() {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
    else if (this.ws.readyState === WebSocket.CONNECTING) this.ws.terminate();
  }
  saveConversation() {
    const id = this.options.device?.id;
    if (!id || this.store.closed || this.superseded || (!this.conversationStarted && !this.conversationEnded)) return;
    const owner = this.gateway.connections.get(id);
    if (owner && owner !== this) return;
    const device = this.store.db.prepare("SELECT metadata FROM devices WHERE id=?").get(id);
    if (!device) return;
    // Read the latest metadata so a session checkpoint cannot undo settings or pairing changes.
    const metadata = JSON.parse(device.metadata || "{}");
    metadata.voiceSession = { id: this.session.id, active: !this.conversationEnded,
      persisted: this.sessionPersisted, lastActivity: this.lastConversationActivity };
    this.store.db.prepare("UPDATE devices SET metadata=? WHERE id=?").run(JSON.stringify(metadata), id);
  }
  ensureSession() {
    if (this.sessionPersisted) return;
    this.session = this.store.createSession(this.options.device.id, this.session.id);
    this.sessionPersisted = true;
    this.conversationStarted = true;
  }
  finishConversation() {
    this.conversationEnded = true;
    this.saveConversation();
    this.realtime?.close(); this.realtime = null;
    this.abort();
  }
  awaitStandby() {
    clearTimeout(this.standbyTimer);
    // Fall back to disconnection if the device cannot confirm microphone stop.
    this.standbyTimer = setTimeout(() => this.close(), 5000);
    this.standbyTimer.unref();
  }
  endConversation(reason = "farewell") {
    this.finishConversation();
    if (this.persistent) {
      this.standby = true;
      this.standbyConfirmed = false;
      this.awaitStandby();
      this.send({ type: "session", state: "standby", reason });
    } else {
      if (this.options.browser) this.send({ type: "farewell" });
      this.close();
    }
  }
  resumeConversation() {
    clearTimeout(this.standbyTimer);
    this.initialStandby = false;
    if (this.options.device) {
      if (this.conversationEnded || (this.standby && this.conversationStarted &&
          Date.now() - this.lastConversationActivity >= DEVICE_STANDBY_MS)) {
        this.session = { id: randomUUID(), source: this.options.device.id };
        this.sessionPersisted = false;
        this.conversationEnded = false;
      }
      this.conversationStarted = true;
    }
    if (this.standby) this.lastConversationActivity = Date.now();
    this.standby = false;
    this.standbyConfirmed = false;
    this.saveConversation();
  }
  message(m) {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (m.type === "hello") {
      if (this.hello) return;
      this.version = Number(m.version || 1);
      if (
        ![1, 2, 3].includes(this.version) ||
        m.audio_params?.channels !== 1 ||
        ![8000, 16000, 24000, 48000].includes(m.audio_params?.sample_rate)
      )
        throw new Error("音频协议或采样率不支持");
      if (!this.options.browser && m.audio_params.format !== "opus")
        throw new Error("ESP32 需要 Opus 音频");
      this.format = m.audio_params.format;
      this.inputRate = m.audio_params.sample_rate;
      this.decoder.delete();
      this.decoder = codec(this.inputRate);
      this.hello = true;
      this.features = m.features || {};
      this.recordBackend(m);
      this.persistent = !!this.options.device && this.features.persistent_connection === true;
      if (this.persistent) {
        this.initialStandby = true;
        this.standby = true;
        this.state = "idle";
        this.awaitStandby();
      }
      this.send({
        type: "hello",
        transport: "websocket",
        version: this.version,
        features: { persistent_connection: this.persistent, voice_controls: true, playback_ack: true, turn_ids: true },
        backend: this.options.device ? this.gateway.backendIdentity?.() : undefined,
        server_time: { timestamp: Date.now(), timezone_offset: -new Date().getTimezoneOffset() },
        audio_params: {
          format: this.options.browser ? "pcm" : "opus",
          sample_rate: 16000,
          channels: 1,
          frame_duration: 20,
        },
      });
      if (this.options.device)
        this.store.db
          .prepare("UPDATE devices SET last_seen=? WHERE id=?")
          .run(new Date().toISOString(), this.options.device.id);
      if (this.features.mcp) void this.discover();
      if (this.options.device) void this.gateway.warmGreeting?.();
      return;
    }
    if (!this.hello) throw new Error("需要先发送 hello");
    if (m.type === "backend" && this.options.device) {
      if (m.action === "status") this.recordBackend(m);
      if (m.action === "ack") {
        const pending = this.pendingBackend.get(m.request_id);
        if (m.accepted === true) pending?.resolve({ accepted: true });
        else pending?.reject(new Error("板子拒绝切换，可能正在连接或无法保存配置"));
      }
      return;
    }
    if (m.type === "pong") {
      this.alive = true;
      if (this.heartbeatSentAt != null) {
        this.heartbeatRttMs = Date.now() - this.heartbeatSentAt;
        this.heartbeatSentAt = null;
      }
      return;
    }
    if (m.type === "voice_control") { this.control(m); return; }
    if (m.type === "playback") { this.playback(m); return; }
    if (m.type === "vision" && this.options.browser) {
      if (m.action === "start" && ["camera", "screen"].includes(m.source)) this.visionSource = m.source;
      if (m.action === "stop") { this.visionSource = null; this.pendingVision?.resolve(null); this.pendingVision = null; }
      return;
    }
    if (m.type === "vision_frame" && this.options.browser && this.pendingVision?.turnId === m.turn_id) {
      const pending = this.pendingVision;
      this.pendingVision = null;
      try { pending.resolve(m.unavailable ? null : validateFrame(m)); }
      catch (e) { pending.resolve(null); this.error(e); }
      return;
    }
    if (m.type === "session" && m.state === "standby" && this.persistent) {
      clearTimeout(this.standbyTimer);
      // Reconnection starts with a transport standby acknowledgement. It must
      // not end an ongoing chat; subsequent device-initiated standby does.
      if (this.initialStandby) this.abort();
      else this.finishConversation();
      this.initialStandby = false;
      this.standby = true;
      this.standbyConfirmed = true;
      return;
    }
    if (m.type === "abort") {
      this.abort();
      return;
    }
    if (m.type === "ping") {
      this.send({ type: "pong" });
      return;
    }
    if (m.type === "listen") {
      this.mode = m.mode || this.mode || "auto";
      if (m.state === "start") {
        this.resumeConversation();
        // ESP32 sends detect then start for the same wake-up. Starting capture
        // is not an interruption of the greeting triggered by that detect.
        // Explicit abort/standby and actual speech interruption still cancel it.
        if (this.options.device && this.greetingGeneration === this.generation)
          return;
        this.abort();
        this.state = "listening";
        this.startedAt = Date.now();
        if (this.store.settings().input.voiceMode === "realtime") void this.startRealtime();
      }
      if (m.state === "stop") {
        if (this.standby) return;
        if (this.realtime) { this.realtime.commit(); return; }
        const pcm = this.buffer.finish();
        if (pcm?.length) void this.process(pcm);
        else {
          this.live?.close();
          this.live = null;
          this.send({ type: "tts", state: "stop" });
          this.startedAt = Date.now();
        }
      }
      if (m.state === "detect" && m.text) {
        this.resumeConversation();
        const words = this.store.settings().assistant.wakeWords;
        if (words.some((w) => m.text.replace(/[，。！？\s]/g, "").includes(w)))
          void this.greet();
        else void this.process(null, m.text);
      }
    }
    if (m.type === "text" && this.options.browser)
      void this.process(null, String(m.text || "").slice(0, 16000));
    if (
      m.type === "mcp" &&
      m.payload?.id &&
      this.pendingRpc.has(m.payload.id)
    ) {
      const p = this.pendingRpc.get(m.payload.id);
      this.pendingRpc.delete(m.payload.id);
      if (m.payload.error) p.reject(new Error("设备工具返回错误"));
      else p.resolve(m.payload.result);
    }
  }
  audio(raw) {
    if (!this.hello || this.standby || !this.call.acceptingAudio || this.ws.readyState !== WebSocket.OPEN) return;
    const frame = unpackAudio(raw, this.version);
    const decoded =
      this.format === "pcm"
        ? Buffer.from(frame)
        : Buffer.from(this.decoder.decode(frame));
    if (decoded.length % 2) throw new Error("无效 PCM 数据");
    const pcm = resample(decoded, this.inputRate);
    if (this.realtime) { this.realtime.push(pcm); return; }
    const input = this.inputSettings();
    const voiced = input.vad === "energy" ? rms(pcm) >= input.rmsThreshold : this.speechDetector.detect(pcm, input.rmsThreshold);
    if (voiced) this.lastSpeechAt = Date.now();
    if (this.bargeCandidate) { this.captureBarge(pcm, voiced); return; }
    if (
      ["speaking", "thinking"].includes(this.call.output) &&
      (this.options.browser || this.features.aec === true || this.features.device_aec === true)
    ) {
      const frames = this.bargeIn.push(pcm, input.rmsThreshold, voiced);
      if (!frames) return;
      if (input.interruptionMode === "intent") {
        this.beginBarge(frames);
        return;
      }
      this.abort();
      this.bargeInCount++;
      this.lastBargeInAt = new Date().toISOString();
      this.state = "listening";
      this.startedAt = Date.now();
      // Feed separately so quiet pre-roll cannot dilute the first syllable's
      // energy or cause the utterance detector to drop the start of a correction.
      for (const frame of frames) this.capture(frame, rms(frame) >= Math.min(input.rmsThreshold, 0.004));
      return;
    }
    this.capture(pcm, voiced);
  }
  cancelBarge() {
    const candidate = this.bargeCandidate;
    this.bargeCandidate = null;
    candidate?.control.abort(); candidate?.live.close();
    if (candidate) {
      Object.assign(candidate.diagnostic, { state: "dismissed", elapsedMs: Date.now() - candidate.startedAt });
      this.send({ type: "barge", state: "resume", turn_id: candidate.turnId });
    }
    this.releaseOutput();
  }
  beginBarge(frames) {
    const candidate = { turnId: this.call.turnId, startedAt: Date.now(), frames: [], speechMs: 0, silenceMs: 0, control: new AbortController() };
    candidate.diagnostic = this.lastBargeCandidate = {
      at: new Date(candidate.startedAt).toISOString(), turnId: candidate.turnId, state: "checking", elapsedMs: 0,
    };
    const turn = this.turns.get(candidate.turnId);
    if (turn?.wake) turn.wake.bargeCandidates = (turn.wake.bargeCandidates || 0) + 1;
    candidate.live = new LiveTranscriber(this.store.settings(), this.engine.context(this.session.id), text => {
      if (this.bargeCandidate === candidate && isExplicitInterruption(text)) this.confirmBarge(candidate);
    });
    this.bargeCandidate = candidate;
    // A short sound may be a backchannel, noise or residual echo. Continue
    // playback while classifying it; only a confirmed interruption may stop
    // the sentence. Holding here inserts an ASR-length gap into ordinary speech.
    this.send({ type: "barge", state: "candidate", turn_id: candidate.turnId });
    for (const frame of frames) this.captureBarge(frame, rms(frame) >= Math.min(this.inputSettings().rmsThreshold, 0.004));
  }
  captureBarge(pcm, voiced) {
    const candidate = this.bargeCandidate;
    if (!candidate) return;
    // Preserve continuation while the short-utterance classifier is pending.
    // New speech invalidates that result and confirms an interruption.
    if (candidate.finishing) {
      candidate.frames.push(pcm);
      if (voiced) this.confirmBarge(candidate);
      return;
    }
    candidate.frames.push(pcm);
    candidate.live.push(pcm, voiced);
    if (voiced) { candidate.speechMs += pcm.length / 32; candidate.silenceMs = 0; }
    else candidate.silenceMs += pcm.length / 32;
    if (candidate.speechMs >= 600) { this.confirmBarge(candidate); return; }
    if (candidate.silenceMs >= 240) {
      candidate.finishing = true;
      void candidate.live.finish(AbortSignal.any([candidate.control.signal, AbortSignal.timeout(3500)])).then(text => {
        if (this.bargeCandidate !== candidate) return;
        if (!text.trim() || isBackchannel(text)) this.cancelBarge();
        else {
          const pcm = Buffer.concat(candidate.frames);
          this.confirmBarge(candidate, false);
          void this.process(pcm, text);
        }
      }).catch(() => { if (this.bargeCandidate === candidate) this.cancelBarge(); });
    }
  }
  confirmBarge(candidate, capture = true) {
    if (this.bargeCandidate !== candidate) return;
    Object.assign(candidate.diagnostic, { state: "confirmed", elapsedMs: Date.now() - candidate.startedAt });
    const frames = candidate.frames;
    this.bargeCandidate = null;
    candidate.control.abort(); candidate.live.close();
    this.abort();
    this.bargeInCount++;
    this.lastBargeInAt = new Date().toISOString();
    this.state = "listening";
    this.startedAt = Date.now();
    if (capture) for (const frame of frames) this.capture(frame, rms(frame) >= Math.min(this.inputSettings().rmsThreshold, 0.004));
  }
  capture(pcm, voiced = rms(pcm) >= this.inputSettings().rmsThreshold) {
    if (!this.call.acceptingAudio || this.call.output !== "idle") return;
    const input = this.buffer.config;
    if (
      voiced &&
      this.buffer.speechMs + pcm.length / 32 >= input.minSpeechMs
    ) {
      // Use the same level and minimum duration as utterance detection. A lone
      // short click or below-threshold background sound must not reset standby.
      this.lastConversationActivity = Date.now();
    }
    if (voiced) this.turnDetector.speech();
    else this.turnDetector.observeSilence(this.buffer.silenceMs);
    const finished = this.buffer.push(pcm, this.mode !== "manual", voiced, this.turnDetector.threshold());
    this.call.update({ input: this.buffer.started ? "recognizing" : "listening" });
    if (!this.live && (this.buffer.started || finished)) {
      this.live = new LiveTranscriber(
        this.store.settings(),
        this.engine.context(this.session.id),
        (text) => { this.turnDetector.partial(text); this.send({ type: "partial", text }); },
      );
      // Include only bounded pre-roll and this utterance, not the idle minutes.
      this.live.push(finished || Buffer.concat(this.buffer.frames));
      this.startedAt = Date.now();
    } else if (this.live) this.live.push(pcm, voiced);
    if (finished) {
      void this.process(finished);
      return;
    }
    if (!this.buffer.started && this.live) {
      this.live.close();
      this.live = null;
    }
    if (
      Date.now() - this.startedAt >
      this.store.settings().input.maxRecordingSeconds * 1000
    ) {
      const rest = this.buffer.finish();
      if (rest) void this.process(rest);
      else {
        this.live?.close();
        this.live = null;
        this.startedAt = Date.now();
      }
    }
  }
  async startRealtime() {
    if (this.realtime) { this.realtime.setMuted(!this.call.acceptingAudio); return; }
    const settings = this.store.settings();
    const tools = this.engine.voiceTools();
    const instructions = this.engine.systemPrompt({ settings,
      model: settings.models.realtime.model, outputMode: "voice", nativeAudio: true,
      tools, memoryContext: JSON.parse(this.engine.context(this.session.id)) });
    const recent = this.store.messages(this.session.id).filter(m => !m.metadata?.healthPrivate && !m.metadata?.memoryOperation && !m.metadata?.assistantControl &&
      !this.store.db.prepare("SELECT 1 FROM memory_exclusions WHERE message_id=?").get(m.id)).slice(-20);
    const history = [];
    let user;
    for (const m of recent) {
      if (m.role === "user") user = m;
      else if (m.role === "assistant" && user) {
        for (const entry of [user, m]) history.push({ id: entry.id, type: "message", role: entry.role, content: [{ type: "input_text", text: audibleContext(entry).slice(0, 1600) }] });
        user = null;
      }
    }
    const remote = this.realtime = new RealtimeVoice(settings.models.realtime, {
      instructions, history, tools,
      onStart: () => { this.abort(false); this.state = "listening"; this.lastSpeechAt = Date.now(); },
      onPartial: text => { this.call.update({ input: "recognizing" }); this.lastSpeechAt = Date.now(); this.send({ type: "partial", text }); },
      onTranscript: (text, turn) => { this.lastSpeechAt = Date.now(); void this.process(null, text, turn); },
      onError: error => { this.abort(); this.error(error); this.close(); },
    });
    try {
      remote.setMuted(!this.call.acceptingAudio);
      await remote.open();
      if (this.realtime === remote) this.send({ type: "voice_mode", mode: "realtime", reason: "实时语音已连接" });
    } catch (error) {
      if (this.realtime === remote) { this.error(error); this.close(); }
    }
  }
  async process(pcm, text, remoteTurn) {
    const remote = this.realtime;
    const live = this.live;
    this.live = null;
    this.controller?.abort();
    const control = (this.controller = new AbortController());
    const signal = control.signal;
    const generation = ++this.generation;
    const turn = this.startTurn();
    this.bargeIn.reset();
    this.state = "thinking";
    this.buffer.reset();
    let speech = Promise.resolve();
    let preparation = Promise.resolve();
    let speechError = null;
    let speaking = false;
    let nativeUsed = false, nativePlayback = null;
    const active = () =>
      !signal.aborted &&
      generation === this.generation &&
      this.ws.readyState === WebSocket.OPEN;
    const enqueue = (value) => {
      if (!value.trim()) return;
      const previousPlayback = speech;
      const settings = this.store.settings();
      // Prepare complete short clauses so provider packet gaps cannot cut a
      // word in half. The next clause can synthesize while this one plays.
      // Gate the third preparation on the first playback: at most the current
      // and one following clause hold PCM (4 MiB each), with one HTTP request.
      const ready = preparation.then(async () => {
        if (!active() || speechError) return null;
        const started = Date.now();
        const audio = await synthesize(settings.models.tts, value, signal, { maxBytes: 4 * 1024 * 1024 });
        this.mark(turn, "ttsFirstReadyMs", Date.now() - turn.startedAt);
        turn.timings.ttsPreparationMaxMs = Math.max(turn.timings.ttsPreparationMaxMs || 0, Date.now() - started);
        return audio;
      });
      // Observe failures immediately even when the preceding clause is paused.
      ready.catch(e => { speechError ||= e; });
      preparation = ready.catch(() => {}).then(() => previousPlayback);
      speech = previousPlayback
        .then(async () => {
          const audio = await ready;
          if (!audio || !active() || speechError) return;
          if (!speaking) {
            speaking = true;
            this.send({ type: "tts", state: "start" });
          }
          await this.speak(value, signal, active, turn, [audio.pcm], settings);
        })
        .catch((e) => {
          speechError ||= e;
        });
    };
    const segments = new SpeechSegments({ onSegment: enqueue, isActive: active });
    try {
      const asrStarted = Date.now();
      if (text == null) {
        if (live) text = await live.finish(signal);
        else {
          const transcriber = new LiveTranscriber(
            this.store.settings(),
            this.engine.context(this.session.id),
          );
          transcriber.push(pcm);
          text = await transcriber.finish(signal);
        }
        if (active())
          this.send({
            type: "metric",
            name: "asrMs",
            value: Date.now() - asrStarted,
          });
      }
      if (!active()) return;
      this.mark(turn, "asrMs", Date.now() - turn.startedAt);
      this.turnDetector.reset();
      if (!text.trim()) {
        this.send({ type: "tts", state: "stop" });
        this.state = "listening";
        this.startedAt = Date.now();
        return;
      }
      this.lastConversationActivity = Date.now();
      this.ensureSession();
      this.saveConversation();
      this.send({ type: "stt", text });
      if (isFarewell(text, this.store.settings().assistant.name)) {
        // End before refinement, routing, memory, chat or speech generation.
        // Cancel outstanding work and stop any audio already queued by clients.
        const message = this.store.message(this.session.id, "user", text, {
          metadata: { voiceCommand: "farewell" },
        });
        if (this.options.browser) this.send({ type: "user", message });
        this.endConversation();
        return;
      }
      const visual = await this.requestVision(turn, signal);
      if (!active()) return;
      const result = await this.engine.run({
        sessionId: this.session.id,
        text,
        source: this.options.browser ? "browser-voice" : this.options.device.id,
        outputMode: "voice",
        volumeControl: this.options.device ? (operation, controlSignal) => controlSpeaker(this, operation, controlSignal) : undefined,
        route: this.options.browser ? this.options.route : this.config.route,
        signal,
        visual,
        rawAudio: pcm ? wav(pcm) : null,
        realtime: remoteTurn && remote ? {
          model: remote.profile.model,
          cancel: () => { remote.cancel(remoteTurn); if (active()) this.send({ type: "voice_mode", mode: "cascade", reason: "本轮使用现有场景模型与确认流程" }); },
          stream: (...args) => { nativeUsed = true; return remote.stream(remoteTurn, ...args); },
        } : undefined,
        emit: (event) => {
          if (["done", "interrupted"].includes(event.type) && event.message) {
            turn.messageId = event.message.id;
            this.savePlayback(turn);
          }
          if (!active()) return;
          if (event.type === "audio") {
            if (!speaking) { speaking = true; this.send({ type: "tts", state: "start" }); }
            nativePlayback ||= new StreamingPlayback(this, turn, signal, active);
            return nativePlayback.push(event.audio);
          }
          if (event.type === "audio_end") return nativePlayback?.finish(remoteTurn.text);
          if (this.options.browser) this.send(event);
          if (event.type === "delta") {
            this.mark(turn, "firstTextMs", Date.now() - turn.lastSpeechAt);
            if (!nativeUsed) { remote?.cancel(remoteTurn); segments.push(event.text); }
          }
        },
      });
      segments.finish();
      await speech;
      turn.generated = true;
      this.savePlayback(turn);
      if (active() && turn.pacer) await this.paceOutput(turn, signal, true);
      if (speechError && active()) {
        turn.interrupted = true;
        this.savePlayback(turn);
        this.error(
          new Error("文字已生成，但语音播放失败：" + speechError.message),
        );
      }
      if (active()) {
        this.send({ type: "tts", state: "stop", ...(speechError ? { interrupted: true } : {}) });
        if (speechError || !turn.acknowledged || turn.segments.every(s => s.finished && s.playedMs >= s.durationMs))
          this.state = result.farewell ? "idle" : "listening";
        this.startedAt = Date.now();
        this.lastConversationActivity = this.startedAt;
        this.saveConversation();
        if (result.farewell) {
          this.endConversation();
        }
      }
    } catch (e) {
      if (active()) {
        // Cancel queued and in-flight audio before returning to listening.
        // Otherwise a slow synthesis can start playing after the error stop.
        control.abort();
        await speech;
        if (
          generation === this.generation &&
          this.ws.readyState === WebSocket.OPEN
        ) {
          this.error(e);
          this.send({ type: "tts", state: "stop", interrupted: true });
          this.state = "listening";
          this.startedAt = Date.now();
        }
      }
    } finally {
      segments.close();
      live?.close();
      if (remoteTurn && remote && !this.store.closed) {
        // Cloud context must follow what was actually heard. Health details and
        // memory/settings operation transcripts are never seeded as chat history.
        turn.remoteContext = { remote, remoteTurn, text };
        this.syncRealtimeContext(turn);
      }
    }
  }
  async requestVision(turn, signal) {
    if (!this.visionSource || this.call.paused) return null;
    return await new Promise(resolve => {
      let timer;
      const done = value => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (this.pendingVision?.turnId === turn.id) this.pendingVision = null;
        resolve(value);
      };
      const abort = () => done(null);
      this.pendingVision = { turnId: turn.id, resolve: done };
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => { this.send({ type: "vision_status", message: "本轮没有收到新画面，按语音内容回答" }); done(null); }, 1800);
      this.send({ type: "vision_request", turn_id: turn.id });
      if (signal.aborted) abort();
    });
  }
  async speak(text, signal, active, turn = this.turns.get(this.call.turnId), source = null, settings = this.store.settings()) {
    const segment = { id: turn?.segments.length || 0, text, durationMs: 0, playedMs: 0, finished: false };
    turn?.segments.push(segment);
    const converter = new PcmResampler(settings.models.tts.pcmSampleRate || 24000);
    const gain =
      this.config.volume *
      (isNight(settings) ? settings.assistant.night.volume : 1);
    let pending = Buffer.alloc(0), first = true;
    const sendFrames = async (bytes, final = false) => {
      pending = Buffer.concat([pending, bytes]);
      while (pending.length >= 640 || (final && pending.length)) {
        const pacer = await this.paceOutput(turn, signal);
        if (!active()) return;
        if (this.call.holdingPlayback) continue;
        const frame = Buffer.alloc(640);
        pending.copy(frame, 0, 0, 640);
        pending = pending.subarray(Math.min(640, pending.length));
        if (gain !== 1) for (let i = 0; i < frame.length; i += 2)
          frame.writeInt16LE(Math.round(frame.readInt16LE(i) * gain), i);
        if (first) {
          first = false;
          this.state = "speaking";
          this.mark(turn, "firstAudioMs", Date.now() - (turn?.lastSpeechAt || Date.now()));
          if (turn?.wake) turn.wake.firstAudioSentMs = Date.now() - turn.startedAt;
          this.send({ type: "tts", state: "sentence_start", text, segment_id: segment.id, turn_id: turn?.id ?? this.call.turnId });
        }
        segment.durationMs += 20;
        const data = this.options.browser ? frame : Buffer.from(this.encoder.encode(frame, 320));
        this.ws.send(packAudio(data, this.version));
        pacer.sent();
        this.recordAudioSent(turn, pacer);
      }
    };
    for await (const bytes of source || streamSpeech(settings.models.tts, text, signal)) {
      if (!active()) return;
      await sendFrames(converter.push(bytes));
    }
    await sendFrames(converter.push(Buffer.alloc(0), true), true);
    if (!active()) return;
    segment.finished = true;
    this.send({ type: "tts", state: "sentence_end", segment_id: segment.id, duration_ms: segment.durationMs, turn_id: turn?.id ?? this.call.turnId });
  }
  async greet() {
    this.abort();
    this.lastConversationActivity = Date.now();
    this.state = "thinking";
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const generation = this.generation;
    const turn = this.startTurn(Date.now());
    const settings = this.store.settings();
    const prepared = this.gateway.greetingAudio?.source(settings, signal);
    turn.wake = this.lastWake = { receivedAt: new Date(turn.startedAt).toISOString(),
      cacheHit: prepared?.cacheHit ?? false, firstAudioSentMs: null };
    this.greetingGeneration = generation;
    this.send({ type: "tts", state: "start" });
    try {
      await this.speak(
        settings.assistant.greeting,
        signal,
        () => !signal.aborted && generation === this.generation,
        turn,
        prepared?.audio,
        settings,
      );
      if (!signal.aborted && turn.pacer) await this.paceOutput(turn, signal, true);
    } catch (e) {
      if (!signal.aborted) this.error(e);
    }
    if (this.greetingGeneration === generation) this.greetingGeneration = null;
    if (!signal.aborted) {
      turn.generated = true;
      this.send({ type: "tts", state: "stop" });
      if (!turn.acknowledged || turn.segments.every(s => s.finished && s.playedMs >= s.durationMs)) this.state = "listening";
      this.startedAt = Date.now();
      this.lastConversationActivity = this.startedAt;
      this.saveConversation();
      if (this.store.settings().input.voiceMode === "realtime" && !this.standby) await this.startRealtime();
    }
  }
  rpc(method, params, signal) {
    const id = ++this.rpcId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpc.delete(id);
        reject(new Error("设备响应超时"));
      }, 10000);
      const done = (fn) => (value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        fn(value);
      };
      const abort = () => {
        this.pendingRpc.delete(id);
        done(reject)(new Error("设备操作已取消"));
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort, { once: true });
      this.pendingRpc.set(id, { resolve: done(resolve), reject: done(reject) });
      this.send({
        type: "mcp",
        payload: { jsonrpc: "2.0", id, method, params },
      });
    });
  }
  async discover() {
    try {
      await this.rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "douli", version: "0.1.0" },
      });
      this.send({
        type: "mcp",
        payload: { jsonrpc: "2.0", method: "notifications/initialized" },
      });
      const tools = new Map(),
        seen = new Set();
      let cursor;
      do {
        const page = await this.rpc("tools/list", cursor ? { cursor } : {});
        if (!Array.isArray(page?.tools))
          throw new Error("Invalid device tools");
        for (const tool of page.tools)
          if (typeof tool.name === "string") tools.set(tool.name, tool);
        cursor = page.nextCursor;
        if (cursor) {
          if (seen.has(cursor) || tools.size > 256 || seen.size >= 32)
            throw new Error("Device tool pagination limit");
          seen.add(cursor);
        }
      } while (cursor);
      this.tools = [...tools.values()];
    } catch {
      this.error(new Error("设备已连接，但工具发现尚未完成"));
    }
  }
}
