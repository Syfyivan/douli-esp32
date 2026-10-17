import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  MessageCircle,
  Sparkles,
  Brain,
  Radio,
  Settings,
  Plus,
  Mic,
  MicOff,
  Send,
  Square,
  Search,
  ArrowUpRight,
  Download,
  Trash2,
  Check,
  X,
  Volume2,
  Pin,
  ChevronRight,
  Moon,
  RefreshCw,
  HeartPulse,
  BookOpen, FileText, LockKeyhole, Monitor, SlidersHorizontal, ShieldCheck, Cloud, ListChecks, ChevronDown,
} from "lucide-react";
import { BrowserVoice } from "./voice.mjs";
import { NativeVoice } from "./native-voice.mjs";
import { VisualInput } from "./visual-input.mjs";
import "./styles.css";
import { AssistantPage } from "./assistant.jsx";
import { SettingsWriter } from "./settings-writer.mjs";
import { SpeakerVolume } from "./speaker-volume.jsx";
import { MemoryPage } from "./memory.jsx";
import { HealthPage, EvidenceCards } from "./health.jsx";
import { SyncPanel } from "./sync.jsx";
import { BackendSelection } from "./backend-selection.jsx";
import { UI_STORAGE_KEY, normalizeUiPreferences, readUiPreferences, conversationSource, inDateRange } from "./ui-state.mjs";
import "./desktop-ui.css";

const names = {
  auto: "自动选择",
  daily: "日常陪伴",
  learning: "知识学习",
  router: "路由分类",
  strong: "强模型",
  reasoning: "思考与解题",
  health: "健康问答",
  debate: "讨论与辨析",
  asr: "语音识别",
  tts: "语音合成",
  refine: "输入整理",
  memory: "记忆提取",
  embedding: "记忆向量",
  rerank: "记忆重排",
  vision: "画面理解",
  streamingAsr: "火山流式识别",
  realtime: "火山全双工语音",
};
const time = (value) =>
  value
    ? new Date(value).toLocaleString("zh-CN", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "暂无数据";
async function api(path, method = "GET", body) {
  const r = await fetch("/api" + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || `请求失败 ${r.status}`);
  return data;
}
function Button({ icon: Icon, children, primary, danger, ...props }) {
  return (
    <button
      className={`${primary ? "primary" : ""} ${danger ? "danger" : ""}`}
      {...props}
    >
      {Icon && <Icon size={16} />}
      {children}
    </button>
  );
}
function Field({ label, children, hint }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
function Toggle({ label, checked, onChange, hint }) {
  return (
    <label className="toggle">
      <span>
        {label}
        {hint && <small>{hint}</small>}
      </span>
      <input
        type="checkbox"
        checked={!!checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <i />
    </label>
  );
}
function Empty({ children }) {
  return <div className="empty-small">{children}</div>;
}
function Section({ title, subtitle, children, action }) {
  return (
    <section className="card">
      <div className="section-head">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
function Form({ submit, children, label = "保存", icon = Check }) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit(new FormData(e.currentTarget), e.currentTarget);
      }}
    >
      {children}
      <div className="form-actions">
        <Button primary icon={icon} type="submit">
          {label}
        </Button>
      </div>
    </form>
  );
}

function App() {
  const [ui, setUi] = useState(readUiPreferences);
  const [state, setState] = useState(null),
    [page, setPage] = useState(() => readUiPreferences().defaultPage),
    [toast, setToast] = useState(null),
    [fatal, setFatal] = useState("");
  const [profileTab, setProfileTab] = useState("memory");
  const [requestedSession, setRequestedSession] = useState(null);
  const stateRevision = useRef(0);
  const [nightSave, setNightSave] = useState({ patch: {}, status: "idle", error: "" });
  const nightWriter = useRef(null);
  if (!nightWriter.current) nightWriter.current = new SettingsWriter({
    write: night => api("/settings", "PUT", { assistant: { night } }),
    saved: settings => {
      stateRevision.current++;
      setState(old => old && ({ ...old, settings: { ...old.settings, assistant: {
        ...old.settings.assistant, night: settings.assistant.night,
      } } }));
    },
    changed: setNightSave,
    failed: error => setToast({ message: "夜间设置未保存：" + error.message, error: true }),
  });
  const saveNight = (key, value) => nightWriter.current.update({ [key]: value });
  const updateUi = (patch) => {
    const next = normalizeUiPreferences({ ...ui, ...patch });
    try { localStorage.setItem(UI_STORAGE_KEY, JSON.stringify(next)); }
    catch { notify("显示设置暂时无法保存，关闭应用后可能恢复默认值", true); }
    setUi(next);
    if (!next.showDevices && page === "devices") setPage("settings");
  };
  const openConversation = (id) => { setRequestedSession({ id, at: Date.now() }); setPage("chat"); };
  const openExperiences = () => { setProfileTab("experiences"); setPage("memory"); };
  const reload = async () => {
    const revision = ++stateRevision.current;
    const value = await api("/state");
    if (revision === stateRevision.current) setState(value);
    return value;
  };
  const notify = (message, error = false) => setToast({ message, error });
  const act = async (action) => {
    try {
      const result = await action();
      await reload();
      return result;
    } catch (e) {
      notify(e.message, true);
    }
  };
  useEffect(() => {
    reload().catch((e) => setFatal(e.message));
  }, []);
  useEffect(() => { window.scrollTo(0, 0); }, [page, profileTab]);
  useEffect(() => {
    if (page === "chat") return;
    reload().catch((e) => notify(e.message, true));
    if (["memory", "assistant"].includes(page)) {
      const timer = setInterval(() => reload().catch(() => {}), 5000);
      return () => clearInterval(timer);
    }
  }, [page]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(t);
  }, [toast]);
  if (!state)
    return (
      <div className="loading">
        <div className="bean">d.</div>
        <p>{fatal || "正在打开你的豆梨…"}</p>
        {fatal && <Button onClick={() => location.reload()}>重新连接</Button>}
      </div>
    );
  const shared = { state, reload, act, notify, setPage, ui, updateUi, openConversation, openExperiences, saveNight, nightSave };
  return (
    <div className="app">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage("chat");
          }}
        >
          <span className="bean">d.</span>
          <span>
            豆梨<small>你的日常陪伴</small>
          </span>
        </a>
        <div className="nav-label">我的空间</div>
        <nav>
          {[
            ["chat", MessageCircle, "对话记录"],
            ["assistant", Sparkles, "我的助手"],
            ["memory", BookOpen, "我的资料"],
            ...(ui.showDevices ? [["devices", Radio, "设备与家居"]] : []),
            ["settings", Settings, "设置"],
          ].map(([id, Icon, label]) => (
            <button
              key={id}
              className={page === id ? "selected" : ""}
              aria-current={page === id ? "page" : undefined}
              onClick={() => setPage(id)}
            >
              <Icon size={19} />
              {label}
              {page === id && <span className="nav-dot" />}
            </button>
          ))}
        </nav>
        <p className="sidebar-note">在音箱上聊日常，<br />在这里回看和整理。</p>
        <div className="sidebar-bottom">
          <span className="status-dot" />
          本机服务已连接<p><LockKeyhole size={14} /> 我的个人空间</p>
          <small>{window.douliDesktop ? "豆梨桌面版 · 0.1" : "douli-esp32 · 0.1"}</small>
        </div>
      </aside>
      <main>
        <header>
          <span className="breadcrumb"><span>我的空间</span><ChevronRight size={14} /><b>
            {
              {
                chat: "对话记录",
                assistant: "我的助手",
                memory: "我的资料",
                devices: "设备与家居",
                settings: "设置",
              }[page]
            }
          </b></span>
          <span className="local-badge"><LockKeyhole size={13} /> 本机空间</span>
        </header>
        {page === "chat" && <Chat {...shared} requestedSession={requestedSession} />}
        {page !== "chat" && (
          <div className="page-content">
            {page === "assistant" && <AssistantPage {...shared} {...{ api, Section, Field, Button, Toggle }} />}{" "}
            {page === "memory" && <>
              <div className="page-title"><span className="eyebrow">YOUR PERSONAL SPACE</span><h1>我的资料</h1><p>那些重要的小事，和一起走过的日子。</p></div>
              <div className="profile-tabs" role="tablist" aria-label="我的资料">{[["memory", "偏好与记忆", Brain], ["experiences", "近期经历", BookOpen], ["health", "健康资料", HeartPulse]].map(([id, label, Icon]) => <button key={id} role="tab" aria-selected={profileTab === id} onClick={() => setProfileTab(id)}><Icon size={16} />{label}</button>)}</div>
              {profileTab === "health" ? <HealthPage {...shared} {...{ api, Section, Field, Button }} /> : <MemoryPage {...shared} view={profileTab} {...{ api, Section, Field, Form, Button }} />}
            </>}
            {page === "devices" && <Devices {...shared} />}{" "}
            {page === "settings" && <SettingsPage {...shared} />}
          </div>
        )}
      </main>
      {toast && (
        <div className={`toast ${toast.error ? "error" : ""}`} role="status">
          {toast.error ? <X size={18} /> : <Check size={18} />}
          <span>{toast.message}</span>
          <button aria-label="关闭提示" onClick={() => setToast(null)}>
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

function Chat({ state, act, notify, setPage, requestedSession, openExperiences }) {
  const [composing, setComposing] = useState(false), [sourceFilter, setSourceFilter] = useState("all"), [dateFilter, setDateFilter] = useState("all");
  const initialized = useRef(false), opening = useRef(0), listing = useRef(0);
  const [sessions, setSessions] = useState([]),
    [session, setSession] = useState(null),
    [messages, setMessages] = useState([]),
    [query, setQuery] = useState(""),
    [text, setText] = useState(""),
    [route, setRoute] = useState("auto"),
    [showHistory, setShowHistory] = useState(false);
  const [pending, setPending] = useState(""),
    [routeInfo, setRouteInfo] = useState(null),
    [busy, setBusy] = useState(false),
    [voiceState, setVoiceState] = useState("off"),
    [level, setLevel] = useState(0),
    [partial, setPartial] = useState(""),
    [metrics, setMetrics] = useState(null);
  const [voiceFlags, setVoiceFlags] = useState({}), [captions, setCaptions] = useState(() => localStorage.getItem("douli.captions") !== "off"), [spokenCaption, setSpokenCaption] = useState("");
  const voiceTurn = useRef(0);
  const [voiceModeLabel, setVoiceModeLabel] = useState("");
  const visual = useRef(null), visualPreview = useRef(null);
  const [visualSource, setVisualSource] = useState(""), [visionStatus, setVisionStatus] = useState("");
  const voice = useRef(null),
    controller = useRef(null),
    bottom = useRef(null),
    scrollPane = useRef(null),
    activeSession = useRef(null),
    delta = useRef("");
  useEffect(() => { if (!composing && scrollPane.current) scrollPane.current.scrollTop = 0; }, [session?.id]);
  const loadSessions = async () => {
    const request = ++listing.current;
    try {
      const rows = await api("/sessions?q=" + encodeURIComponent(query));
      if (request !== listing.current) return;
      setSessions(rows);
      if (!initialized.current && !requestedSession) {
        initialized.current = true;
        if (rows.length) await open(rows[0]);
      }
    } catch (e) { notify(e.message, true); }
  };
  useEffect(() => {
    const t = setTimeout(loadSessions, 150);
    const poll = setInterval(loadSessions, 5000);
    return () => { clearTimeout(t); clearInterval(poll); listing.current++; };
  }, [query]);
  useEffect(() => {
    if (requestedSession) open(requestedSession).catch(e => notify(e.message, true));
  }, [requestedSession]);
  useEffect(() => {
    if (!session?.id || composing || voiceState !== "off") return;
    let disposed = false;
    const id = session.id;
    const poll = setInterval(() => api("/sessions/" + id).then(data => {
      if (!disposed && activeSession.current?.id === id) {
        setCurrent(data.session);
        setMessages(old => JSON.stringify(old) === JSON.stringify(data.messages) ? old : data.messages);
      }
    }).catch(() => {}), 5000);
    return () => { disposed = true; clearInterval(poll); };
  }, [session?.id, composing, voiceState]);
  useEffect(
    () => () => {
      visual.current?.stop();
      if (voice.current?.native) voice.current.detach();
      else voice.current?.stop();
      controller.current?.abort();
      opening.current++;
      listing.current++;
    },
    [],
  );
  useEffect(() => {
    if ((composing || voiceState !== "off") && (messages.length || pending || partial))
      bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, pending, partial]);
  const setCurrent = (value) => {
    activeSession.current = value;
    setSession(value);
  };
  const append = (message) =>
    setMessages((old) => [...old.filter((m) => m.id !== message.id), message]);
  const event = (e) => {
    if (e.type === "voice_mode") setVoiceModeLabel(e.reason);
    if (e.type === "native_screen") { setVisualSource(old => e.active ? "screen" : old === "screen" ? "" : old); setVisionStatus(old => e.active ? "正在共享手机屏幕，每轮提问发送一帧给画面理解模型" : old.startsWith("正在共享手机屏幕") ? "" : old); }
    if (e.type === "vision_request") visual.current?.respond(e);
    if (e.type === "vision_status") setVisionStatus(e.message);
    if (e.type === "native_restore") {
      initialized.current = true;
      opening.current++;
      setCurrent({ id: e.session_id, title: "语音对话" });
      api("/sessions/" + e.session_id).then(d => { if (activeSession.current?.id === e.session_id) { setSession(d.session); setMessages(d.messages); } }).catch(() => {});
    }
    if (e.type === "voice_state" || e.type === "voice_controls") setVoiceFlags(old => ({ ...old, ...e }));
    if (e.type === "voice_controls" && typeof e.caption === "string") setSpokenCaption(e.caption);
    if (e.type === "voice_state" && e.turnId > voiceTurn.current) {
      voiceTurn.current = e.turnId;
      setMetrics(null);
      setSpokenCaption("");
    }
    if (e.type === "tts" && e.state === "sentence_start") setSpokenCaption(e.text);
    if (e.type === "tts" && e.interrupted) { setSpokenCaption(""); setBusy(false); }
    if (e.type === "playback") setMessages(old => old.map(m => m.id === e.message_id ? { ...m, metadata: { ...m.metadata, voicePlayback: e } } : m));
    if (e.type === "hello" && e.session_id && !activeSession.current)
      setCurrent({ id: e.session_id, title: "语音对话" });
    if (e.type === "session") setCurrent(e.session);
    if (e.type === "partial") setPartial(e.text);
    if (e.type === "stt") {
      setRouteInfo(null);
      setPartial(e.text);
      setBusy(true);
    }
    if (e.type === "user") {
      append(e.message);
      setPartial("");
      delta.current = "";
      setPending("");
      setBusy(true);
    }
    if (e.type === "route") setRouteInfo(e.routing);
    if (e.type === "delta") {
      delta.current += e.text;
      setPending(delta.current);
    }
    if (e.type === "done") {
      if (e.message) append(e.message);
      delta.current = "";
      setPending("");
      setBusy(false);
      setMetrics((old) => ({ ...old, ...e.timings }));
      loadSessions();
    }
    if (e.type === "metric")
      setMetrics((old) => ({ ...old, [e.name]: e.value }));
    if (["error", "aborted"].includes(e.type)) {
      setBusy(false);
      if (e.type === "error") notify(e.message, true);
      delta.current = "";
      setPending("");
      if (activeSession.current)
        api("/sessions/" + activeSession.current.id)
          .then((d) => setMessages(d.messages))
          .catch(() => {});
    }
  };
  const stop = () => {
    visual.current?.stop();
    controller.current?.abort();
    voice.current?.stop();
    voice.current = null;
    setBusy(false);
    setPartial("");
    setSpokenCaption("");
  };
  useEffect(() => {
    const background = () => { visual.current?.stop(); if (!voice.current?.native) stop(); };
    window.addEventListener("douli-background", background);
    const unsubscribe = window.douliDesktop?.onBackground(background);
    return () => {
      window.removeEventListener("douli-background", background);
      unsubscribe?.();
    };
  }, []);
  useEffect(() => {
    const attach = () => {
      if (!window.douliNativeVoice || (voice.current && !voice.current.closed)) return;
      const snapshot = window.douliNativeVoice.send({ action: "snapshot" });
      if (snapshot.active) {
        const client = new NativeVoice({ onEvent: event, onStatus: setVoiceState });
        voice.current = client;
        client.restore();
      }
    };
    window.addEventListener("douli-native-ready", attach);
    attach();
    return () => window.removeEventListener("douli-native-ready", attach);
  }, []);
  const open = async (item) => {
    initialized.current = true;
    const request = ++opening.current;
    stop();
    const data = await api("/sessions/" + item.id);
    if (request !== opening.current) return;
    setCurrent(data.session);
    setRouteInfo(null);
    setMessages(data.messages);
    setPending("");
    setShowHistory(false);
    setComposing(false);
    setText("");
    setMetrics(null);
  };
  const fresh = () => {
    initialized.current = true;
    opening.current++;
    stop();
    setCurrent(null);
    setRouteInfo(null);
    setMessages([]);
    setPending("");
    setMetrics(null);
    setShowHistory(false);
    setComposing(true);
    setText("");
  };
  const send = async () => {
    if (!text.trim() || busy) return;
    const input = text.trim();
    setText("");
    setBusy(true);
    setRouteInfo(null);
    setPending("");
    delta.current = "";
    if (voice.current && voiceState !== "off") {
      voice.current.interrupt();
      voice.current.send({ type: "text", text: input });
      return;
    }
    controller.current = new AbortController();
    try {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: input,
          sessionId: activeSession.current?.id,
          route,
        }),
        signal: controller.current.signal,
      });
      if (!r.ok) throw new Error((await r.json()).error);
      const reader = r.body.getReader(),
        decoder = new TextDecoder();
      let data = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        data += decoder.decode(value, { stream: true });
        let at;
        while ((at = data.indexOf("\n")) !== -1) {
          const line = data.slice(0, at);
          data = data.slice(at + 1);
          if (line) event(JSON.parse(line));
        }
      }
    } catch (e) {
      if (e.name !== "AbortError") notify(e.message, true);
    } finally {
      setBusy(false);
      loadSessions();
    }
  };
  const startVoice = async () => {
    if (voiceState !== "off") return stop();
    // An initial archive fetch must not stop a microphone the user just started.
    initialized.current = true;
    opening.current++;
    if (
      !state.configured.daily ||
      !(state.settings.input.voiceMode === "realtime" ? state.configured.realtime : state.settings.input.asrProvider === "volcengine" ? state.configured.streamingAsr : state.configured.asr) ||
      !state.configured.tts
    ) {
      notify("请先配置日常对话、所选语音服务和语音合成模型", true);
      setPage("settings");
      return;
    }
    setVoiceState("connecting");
    setVoiceFlags({});
    voiceTurn.current = 0;
    const Client = window.douliNativeVoice ? NativeVoice : BrowserVoice;
    const client = new Client({
      onEvent: event,
      onStatus: (s) => {
        setVoiceState(s);
        if (s === "off") { setBusy(false); visual.current?.stop(); }
      },
      onLevel: setLevel,
    });
    voice.current = client;
    try {
      await client.start(activeSession.current?.id, route);
    } catch (e) {
      notify(e.message, true);
    }
  };
  const shareVisual = async source => {
    if (!state.configured.vision) { notify("请先在模型设置中配置“画面理解”模型", true); return; }
    try {
      if (source === "screen" && voice.current?.native) { visual.current?.stop(); voice.current.shareScreen(); return; }
      const capture = visual.current || (visual.current = new VisualInput({ send: m => voice.current?.send(m), onStop: () => { setVisualSource(""); setVisionStatus(""); } }));
      if (await capture.start(source, visualPreview.current)) { setVisualSource(source); setVisionStatus("每轮提问时发送一帧给画面理解模型，原图不保存"); }
    } catch (e) { notify(e.name === "NotAllowedError" ? "没有开启画面分享" : e.message, true); }
  };
  const beginText = () => { initialized.current = true; opening.current++; setComposing(true); };
  const visibleSessions = sessions.filter(s => (sourceFilter === "all" || conversationSource(s.source).kind === sourceFilter) && inDateRange(s.updated_at, dateFilter));
  const summary = (state.memorySummaries || []).find(s => s.session_id === session?.id);
  const source = conversationSource(session?.source, state.devices);
  return (
    <div className={`chat-layout ${showHistory ? "show-history" : ""}`}>
      <aside className="history">
        <button className="mobile-history" onClick={() => setShowHistory(false)}><X size={16} /> 返回对话</button>
        <div className="archive-title"><h1>对话记录</h1><span>{visibleSessions.length} 段</span></div>
        <div className="search"><Search size={16} /><input aria-label="搜索对话" placeholder="搜索聊过的内容" value={query} onChange={e => setQuery(e.target.value)} /></div>
        <div className="archive-filters">
          <select aria-label="对话来源" value={sourceFilter} onChange={e => setSourceFilter(e.target.value)}><option value="all">全部来源</option><option value="speaker">音箱</option><option value="voice">电脑语音</option><option value="text">电脑文字</option><option value="unknown">未记录来源</option></select>
          <select aria-label="对话日期" value={dateFilter} onChange={e => setDateFilter(e.target.value)}><option value="all">全部日期</option><option value="today">今天</option><option value="week">最近 7 天</option><option value="month">最近 30 天</option></select>
        </div>
        <div className="archive-list-label"><span>最近的对话</span><button aria-label="开始新的文字对话" title="开始新的文字对话" onClick={fresh}><Plus size={17} /></button></div>
        <div className="session-list">
          {visibleSessions.map(s => <button key={s.id} className={session?.id === s.id ? "active" : ""} onClick={() => open(s).catch(e => notify(e.message, true))}><span><strong>{s.title}</strong><small>{time(s.updated_at)}</small><small><Monitor size={12} />{conversationSource(s.source, state.devices).label}</small></span></button>)}
          {!visibleSessions.length && <p className="empty-small">{query || sourceFilter !== "all" || dateFilter !== "all" ? "没有符合条件的对话，试试其他关键词或日期。" : "和豆梨聊过后，对话会出现在这里。"}</p>}
        </div>
        <div className="archive-bottom"><LockKeyhole size={13} />记录保存在本机，可以搜索和导出</div>
      </aside>
      <div className="conversation">
        <div className="conversation-top">
          <button className="mobile-history" onClick={() => setShowHistory(!showHistory)} aria-label="打开聊天记录"><MessageCircle size={18} /></button>
          <div className="thread-heading"><h1>{session?.title || (composing ? "新的文字对话" : "回看那些聊过的日常")}</h1><small>{session ? <>{source.label} · {time(session.created_at)} · {messages.length} 条消息</> : "音箱上的对话，也会留在这里"}</small></div>
          {session && <div className="row-actions"><a className="button" href={`/api/sessions/${session.id}/export`}><Download size={15} />导出</a><details className="action-menu"><summary aria-label="更多对话操作">•••</summary><div><Button danger icon={Trash2} onClick={() => {
            if (confirm("删除这段对话？其中未固定的来源记忆和保存的录音也会删除。")) act(async () => { stop(); await api("/sessions/" + session.id, "DELETE"); fresh(); setComposing(false); loadSessions(); });
          }}>删除这段对话</Button></div></details></div>}
        </div>
        <div className="messages" ref={scrollPane}>
          {summary && <div className="archive-context"><BookOpen size={22} /><div><strong>这次聊到</strong><p>{summary.text}</p></div><button onClick={openExperiences}>查看经历<ChevronRight size={14} /></button></div>}
          {!messages.length && !pending && <div className="archive-empty"><span className="empty-icon"><MessageCircle size={30} /></span><h2>{composing ? "慢慢说，豆梨在这里" : "把聊过的日子，收在这里"}</h2><p>{composing ? "写下想聊的事，开启一段新的对话。" : "选择左侧的一段对话，回看原文、修正识别或导出记录。"}</p><Button icon={Plus} onClick={fresh}>开始文字对话</Button>{!state.configured.daily && <button className="setup-prompt" onClick={() => setPage("settings")}>连接你的模型<ChevronRight size={15} /></button>}</div>}
          {session && !!messages.length && <div className="date-divider">{time(session.created_at)}</div>}
          {messages.map((m) => (
            <Message
              key={m.id}
              message={m}
              name={state.settings.assistant.name}
              onCorrect={(value) =>
                act(async () => {
                  await api("/messages/" + m.id + "/correction", "POST", {
                    text: value,
                  });
                  const d = await api("/sessions/" + m.session_id);
                  setMessages(d.messages);
                  notify("已更正原文；可到设置中审核词典建议");
                })
              }
            />
          ))}
          {pending && (voiceState === "off" || captions) && (
            <div className="message assistant">
              <div className="avatar">d.</div>
              <div>
                <RoutingDetails routing={routeInfo} />
                <span className="message-name">
                  {state.settings.assistant.name}
                </span>
                <p>
                  {pending}
                  <span className="typing-cursor" />
                </p>
              </div>
            </div>
          )}
          {busy && !pending && (
            <div className="thinking">
              {routeInfo ? `${names[routeInfo.route]} · ${routeInfo.tier === "strong" ? "质量优先" : "快速回答"}` : "正在理解你的问题"}<span>···</span>
            </div>
          )}
          <div ref={bottom} />
        </div>
        <div className="compose-area">
          {partial && (voiceState === "off" || captions) && <div className="partial">听到：{partial}</div>}
          {voiceState !== "off" && (
            <div className="call-panel">
            <div className="voice-strip">
              <span
                className="pulse"
                style={{ transform: `scale(${1 + Math.min(level * 8, 1)})` }}
              />
              <span>
                {
                  {
                    connecting: "准备麦克风…",
                    listening: "正在听你说，停顿后会自动回复",
                    thinking: "正在处理你的话…",
                    speaking: "正在回答，可以直接打断",
                    paused: "通话已暂停",
                  }[voiceState]
                }
              </span>
              <Button disabled={voiceFlags.paused || voiceFlags.muted} onClick={() => voice.current?.submit()}>说完了</Button>
              <Button icon={Square} onClick={() => voice.current?.interrupt()}>
                打断
              </Button>
            </div>
            <div className="call-controls">
              <Button icon={voiceFlags.muted ? MicOff : Mic} onClick={() => voice.current?.control("mute", !voiceFlags.muted)}>{voiceFlags.muted ? "开启麦克风" : "麦克风静音"}</Button>
              <Button onClick={() => voice.current?.control(voiceFlags.playbackPaused ? "playback_resume" : "playback_pause")}>{voiceFlags.playbackPaused ? "继续播放" : "暂停播放"}</Button>
              <Button onClick={() => voice.current?.control(voiceFlags.paused ? "resume" : "pause")}>{voiceFlags.paused ? "继续通话" : "暂停通话"}</Button>
              <Button onClick={() => { setCaptions(!captions); localStorage.setItem("douli.captions", captions ? "off" : "on"); }}>{captions ? "隐藏字幕" : "显示字幕"}</Button>
              <Button onClick={stop}>结束通话</Button>
              {!visualSource && <Button disabled={voiceState === "connecting"} onClick={() => shareVisual("camera")}>开启摄像头</Button>}
              {!visualSource && (voice.current?.native || navigator.mediaDevices?.getDisplayMedia) && <Button disabled={voiceState === "connecting"} onClick={() => shareVisual("screen")}>共享屏幕</Button>}
              {visualSource && <Button onClick={() => { if (voice.current?.native && visualSource === "screen") voice.current.stopScreen(); else visual.current?.stop(); }}>停止画面分享</Button>}
              {voice.current?.native && <select aria-label="通话音频设备" value={voiceFlags.audioRoute || "auto"} onChange={e => voice.current?.send({ type: "audio_route", route: e.target.value })}><option value="auto">系统音频设备</option><option value="speaker">扬声器</option><option value="earpiece">听筒</option><option value="bluetooth">蓝牙耳机</option></select>}
            </div>
            {captions && spokenCaption && <div className="spoken-caption" aria-live="polite"><span>正在说</span>{spokenCaption}</div>}
            <video className="call-preview" ref={visualPreview} hidden={!visualSource || (voice.current?.native && visualSource === "screen")} muted playsInline aria-label={visualSource === "screen" ? "共享屏幕预览" : "摄像头预览"} />
            {visionStatus && <p className="small muted" role="status">{visionStatus}</p>}
            {voiceModeLabel && <p className="small muted">{voiceModeLabel}</p>}
            {(voiceFlags.muted || voiceFlags.playbackPaused) && <p className="small muted">{voiceFlags.muted ? "麦克风已静音。" : ""}{voiceFlags.playbackPaused ? "回答已暂停播放，仍可听你说话。" : ""}</p>}
            {metrics && <div className="call-metrics">{[["endpointMs", "判停"], ["asrMs", "识别"], ["firstAudioMs", "首音发送"], ["firstPlaybackMs", "首音播放"]].filter(([key]) => metrics[key] != null).map(([key, label]) => <span key={key}>{label} {(metrics[key] / 1000).toFixed(2)} 秒</span>)}</div>}
            </div>
          )}
          {composing && <div className="composer">
            <textarea
              aria-label="消息"
              placeholder="接着这段对话，写点什么…"
              rows={2}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <div className="composer-controls">
              <Button
                icon={voiceState === "off" ? Mic : MicOff}
                onClick={startVoice}
              >
                {voiceState === "off" ? "电脑语音" : "结束语音"}
              </Button>
              <select aria-label="对话模式" value={route} disabled={voiceState !== "off" || busy} onChange={e => setRoute(e.target.value)}>{["auto", "daily", "learning", "reasoning", "health", "debate"].map(k => <option value={k} key={k}>{names[k]}</option>)}</select>
              <Button disabled={busy || voiceState !== "off"} onClick={() => setComposing(false)}>收起输入</Button>
              <span className="small muted">
                Enter 发送 · Shift + Enter 换行
              </span>
              {busy && voiceState === "off" ? (
                <Button
                  icon={Square}
                  onClick={() => {
                    controller.current?.abort();
                    if (session)
                      api(
                        "/sessions/" + session.id + "/abort",
                        "POST",
                        {},
                      ).catch(() => {});
                  }}
                >
                  停止
                </Button>
              ) : (
                <Button
                  primary
                  icon={Send}
                  disabled={!text.trim() || busy}
                  onClick={send}
                >
                  发送
                </Button>
              )}
            </div>
          </div>
          }
          {composing && <div className="compose-foot">
            <span>对话保存在本机 · 使用云模型时会发送相应内容</span>
            {metrics?.asrMs != null && (
              <span>识别 {(metrics.asrMs / 1000).toFixed(1)} 秒</span>
            )}
            {metrics?.firstTokenMs != null && (
              <span>首字 {(metrics.firstTokenMs / 1000).toFixed(1)} 秒</span>
            )}
          </div>}
        </div>

        {!composing && <div className="archive-footer"><span><Radio size={14} />音箱对话会保存在这里</span><div className="row-actions"><Button icon={voiceState === "off" ? Mic : MicOff} onClick={startVoice}>{voiceState === "off" ? "电脑语音" : "结束语音"}</Button><Button icon={MessageCircle} onClick={beginText}>{session ? "继续文字对话" : "开始文字对话"}</Button></div></div>}
      </div>
    </div>
  );
}
function Message({ message: m, name, onCorrect }) {
  const [editing, setEditing] = useState(false),
    [value, setValue] = useState(m.text),
    [raw, setRaw] = useState(false);
  return (
    <div className={`message ${m.role}`}>
      <div className="avatar">{m.role === "user" ? "我" : "d."}</div>
      <div className="message-body">
        <span className="message-name">
          {m.role === "user" ? "你" : name}
          <small>{m.created_at && new Date(m.created_at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</small>
          <small>
            {m.route && names[m.route]}
            {m.status !== "complete"
              ? " · " + { error: "未完成", interrupted: "已打断" }[m.status]
              : ""}
          </small>
          {m.metadata?.voicePlayback && <small className="playback-badge">{{ complete: "已播完", interrupted: "播放已打断", playing: "播放中", unverified: "已发送语音" }[m.metadata.voicePlayback.status]}{m.metadata.voicePlayback.playedMs > 0 ? ` · 已播 ${(m.metadata.voicePlayback.playedMs / 1000).toFixed(1)} 秒` : ""}</small>}
        </span>
        {editing ? (
          <div className="edit-message">
            <textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-label="更正识别内容"
            />
            <Button
              primary
              onClick={() => {
                onCorrect(value);
                setEditing(false);
              }}
            >
              保存更正
            </Button>
            <Button onClick={() => setEditing(false)}>取消</Button>
          </div>
        ) : (
          <p>{raw ? m.raw_text : m.text}</p>
        )}
        <ToolResults items={m.metadata?.tools} />
        {m.metadata?.health && <>
          <details className="tool-results"><summary>健康回答的详细解释</summary><p className="health-prose">{m.metadata.health.answer.explanation}</p>
            {m.metadata.health.answer.nextSteps?.map((s, i) => <p key={i}>{s}</p>)}
            {m.metadata.health.answer.questions?.map((s, i) => <p key={i}>{s}</p>)}
          </details>
          <EvidenceCards answer={m.metadata.health.answer} evidence={m.metadata.health.evidence} />
        </>}
        {m.role === "assistant" && <RoutingDetails routing={m.metadata?.routing} />}
        <div className="message-actions">
          {m.role === "user" && !m.metadata?.healthPrivate && (
            <>
              <button
                onClick={() => {
                  setValue(m.text);
                  setEditing(true);
                }}
              >
                更正
              </button>
              {m.raw_text && (
                <button onClick={() => setRaw(!raw)}>
                  {raw ? "显示整理后" : "查看原文"}
                </button>
              )}
            </>
          )}
          {m.has_audio ? (
            <audio
              controls
              preload="none"
              src={"/api/messages/" + m.id + "/audio"}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function RoutingDetails({ routing: r }) {
  if (!r) return null;
  const classifier = { success: "已分类", skipped: "无需分类", timeout: "分类超时", invalid: "分类结果无效", error: "分类服务失败", unconfigured: "未配置分类模型" };
  return <details className="tool-results routing-details">
    <summary>{r.tier === "strong" ? "质量优先" : "快速回答"} · {r.model || "模型未配置"}{r.degraded ? " · 已回退" : ""}</summary>
    <p>{r.reason}{r.thinking ? " · 已请求深度思考" : ""}</p>
    <p>{classifier[r.classifierStatus]} · 路由耗时 {((r.routingMs || 0) / 1000).toFixed(1)} 秒{r.personalDecision ? " · 涉及个人重要决策" : ""}</p>
    {r.degraded && <p role="status">{r.degradation}</p>}
    {r.searchStatus === "unconfigured" && <p>本轮需要核查来源，但尚未配置联网搜索。</p>}
    {r.searchStatus === "failed" && <p>本轮联网检索未获得可用结果。</p>}
  </details>;
}

function ToolResults({ items }) {
  return items?.length ? (
    <details className="tool-results">
      <summary>本轮工具结果 · {items.length} 项</summary>
      {items.map((tool, i) => (
        <div key={i}>
          {tool.name === "home_action" ? (
            <p>
              {tool.result.error
                ? "执行失败：" + tool.result.error
                : tool.result.verified
                  ? "设备实际状态已核实"
                  : "指令已被接收；实际状态未核实"}
            </p>
          ) : tool.name === "web_search" && Array.isArray(tool.result) ? (
            tool.result.map((r, j) => (
              <p key={j}>
                <a
                  href={/^https?:\/\//.test(r.url) ? r.url : undefined}
                  target="_blank"
                  rel="noreferrer"
                >
                  {r.title}
                </a>
              </p>
            ))
          ) : (
            <pre>{JSON.stringify(tool.result, null, 2)}</pre>
          )}
        </div>
      ))}
    </details>
  ) : null;
}
function SettingsPage({ state, act, notify, ui, updateUi }) {
  const [s, setS] = useState(structuredClone(state.settings)),
    [kind, setKind] = useState("daily"),
    [testBusy, setTestBusy] = useState(false),
    [events, setEvents] = useState([]),
    [preview, setPreview] = useState("");
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );
  const model = s.models[kind];
  const updateModel = (key, value) =>
    setS((old) => ({
      ...old,
      models: { ...old.models, [kind]: { ...old.models[kind], [key]: value } },
    }));
  const update = (section, key, value) =>
    setS((old) => ({ ...old, [section]: { ...old[section], [key]: value } }));
  const save = () =>
    act(async () => {
      const result = await api("/settings", "PUT", s);
      setS(result);
      notify("设置已保存");
    });
  const preset = () => {
    setS((old) => {
      const next = structuredClone(old);
      const baseUrl = "https://api.siliconflow.cn/v1";
      next.models.daily = {
        ...next.models.daily,
        baseUrl,
        model: "Qwen/Qwen3.5-122B-A10B",
        thinking: false,
      };
      next.models.asr = {
        ...next.models.asr,
        baseUrl,
        model: "Qwen/Qwen3-ASR-1.7B",
      };
      next.models.tts = {
        ...next.models.tts,
        baseUrl,
        model: "FunAudioLLM/CosyVoice2-0.5B",
        voice: "FunAudioLLM/CosyVoice2-0.5B:claire",
        pcmSampleRate: 24000,
      };
      return next;
    });
    notify("已填写起步配置，请填写 API Key 后保存");
  };
  const [panel, setPanel] = useState("models");
  const [desktopStatus, setDesktopStatus] = useState(null);
  useEffect(() => { window.douliDesktop?.getStatus().then(setDesktopStatus).catch(e => notify(e.message, true)); }, []);
  const panels = [["models", "模型连接", Sparkles], ["voice", "声音与语音", Volume2], ["dictionary", "个人词典", BookOpen], ["privacy", "记录与隐私", ShieldCheck], ["sync", "同步与备份", Cloud], ["modules", "功能显示", SlidersHorizontal], ["desktop", "桌面偏好", Monitor], ["events", "运行记录", ListChecks]];
  return <>
    <div className="page-title title-with-action"><div><span className="eyebrow">MAKE YOURSELF AT HOME</span><h1>设置</h1><p>让声音、连接和习惯，都按你的方式运转。</p></div>{["models", "voice", "privacy"].includes(panel) && <Button primary icon={Check} onClick={save}>保存设置</Button>}</div>
    <div className="settings-layout"><nav className="settings-nav" aria-label="设置分类">{panels.map(([id, label, Icon]) => <button key={id} aria-current={panel === id ? "page" : undefined} onClick={() => setPanel(id)}><Icon size={16} />{label}</button>)}</nav>
      <div className="settings-content">
      {panel === "models" && <>
        <div className="model-status-grid">{[["daily", MessageCircle], ["asr", Mic], ["tts", Volume2]].map(([id, Icon]) => <button key={id} className={kind === id ? "active" : ""} onClick={() => setKind(id)}><Icon size={20} /><strong>{names[id]}</strong><span className={state.configured[id] ? "tag" : "tag amber"}>{state.configured[id] ? "已配置" : "待配置"}</span><small>{s.models[id].model || "选择一个适合你的模型"}</small></button>)}</div>
        <div className="model-layout"><div>      <Section
        title="模型连接"
        subtitle="可分别配置路由分类、强模型与各场景模型。分类调用会关闭思考；记忆提取可沿用日常模型。"
      >
        <div className="model-tabs">
          {Object.entries(names)
            .filter(([k]) => k !== "auto")
            .map(([k, name]) => (
              <button
                key={k}
                className={kind === k ? "selected" : ""}
                onClick={() => setKind(k)}
              >
                {name}
                <span className={state.configured[k] ? "dot green" : "dot"} />
              </button>
            ))}
        </div>
        <div className="grid two">
          <Field
            label="服务地址"
            hint="当前支持 OpenAI 兼容的聊天、转写和 PCM 合成接口。"
          >
            <input
              value={model.baseUrl}
              placeholder="https://api.siliconflow.cn/v1"
              onChange={(e) => updateModel("baseUrl", e.target.value)}
            />
          </Field>
          <Field label={kind === "streamingAsr" ? "资源 ID（如 volc.seedasr.sauc.duration）" : "模型名称"}>
            <input
              value={model.model}
              placeholder="完整模型 ID"
              onChange={(e) => updateModel("model", e.target.value)}
            />
          </Field>
        </div>
        <Field
          label="API Key"
          hint={
            model.hasKey
              ? "已有密钥。留空保留原密钥；填写新内容会替换。"
              : "仅存于本机配置中；不会回显完整密钥。"
          }
        >
          <input
            type="password"
            value={model.apiKey}
            autoComplete="off"
            placeholder={model.hasKey ? "已保存 · 留空保留" : "sk-…"}
            onChange={(e) => updateModel("apiKey", e.target.value)}
          />
        </Field>
        {["tts", "realtime"].includes(kind) && (
          <div className="grid two">
            <Field label="音色">
              <input
                value={model.voice}
                placeholder="FunAudioLLM/CosyVoice2-0.5B:claire"
                onChange={(e) => updateModel("voice", e.target.value)}
              />
            </Field>
            <Field label="PCM 采样率">
              <select
                value={model.pcmSampleRate}
                onChange={(e) => updateModel("pcmSampleRate", +e.target.value)}
              >
                {[16000, 24000, 32000, 44100, 48000].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </Field>
          </div>
        )}
        {!["asr", "tts", "embedding", "rerank", "streamingAsr", "realtime"].includes(kind) && (
          <Toggle
            label="深度思考"
            hint="支持 DeepSeek 官方接口，以及硅基流动 Qwen3、DeepSeek V3/V4 的思考开关；分类和连接测试始终关闭思考。"
            checked={model.thinking}
            onChange={(v) => updateModel("thinking", v)}
          />
        )}
        <div className="row-actions">
          <Button primary icon={Check} onClick={save}>
            保存设置
          </Button>
          {!["asr", "tts", "streamingAsr", "realtime"].includes(kind) && (
            <Button
              disabled={testBusy}
              onClick={() =>
                act(async () => {
                  setTestBusy(true);
                  try {
                    await api("/settings", "PUT", s);
                    const r = await api("/models/test", "POST", { kind });
                    notify(
                      `${r.output} · ${(r.latencyMs / 1000).toFixed(1)} 秒`,
                    );
                  } finally {
                    setTestBusy(false);
                  }
                })
              }
            >
              {testBusy ? "正在测试…" : "保存并测试连接"}
            </Button>
          )}
          <Button
            danger
            onClick={() =>
              act(async () => {
                if (confirm("清除这个模型已保存的 API Key？")) {
                  const result = await api("/settings", "PUT", {
                    models: { [kind]: { apiKey: "" } },
                    clearKeys: [kind],
                  });
                  setS(result);
                  notify("已清除密钥");
                }
              })
            }
          >
            清除密钥
          </Button>
        </div>
        {kind === "tts" && (
          <div className="row-actions" style={{ marginTop: 16 }}>
            <Button
              icon={Volume2}
              onClick={() =>
                act(async () => {
                  await api("/settings", "PUT", s);
                  const r = await fetch("/api/models/voice-preview", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      text: "你好，我是豆梨。我在，慢慢说。",
                    }),
                  });
                  if (!r.ok) throw new Error((await r.json()).error);
                  setPreview(URL.createObjectURL(await r.blob()));
                })
              }
            >
              保存并生成试听
            </Button>
            {preview && <audio controls src={preview} />}
          </div>
        )}
      </Section><details className="setup-details"><summary>服务商起步配置<ChevronDown size={15} /></summary>      <Section
        title="快速开始"
        subtitle="硅基流动的三个接口可以使用同一个 API Key。这里只填写配置，不会自动购买或充值。"
        action={
          <Button icon={Sparkles} onClick={preset}>
            填写起步配置
          </Button>
        }
      >
        <Field label="共用 API Key（只应用到日常对话、识别和合成）">
          <div className="inline-input">
            <input
              type="password"
              id="shared-key"
              autoComplete="off"
              placeholder="粘贴后点击应用"
            />
            <Button
              onClick={() => {
                const input = document.getElementById("shared-key"),
                  key = input.value.trim();
                if (!key) return;
                setS((old) => {
                  const next = structuredClone(old);
                  for (const k of ["daily", "asr", "tts"])
                    next.models[k].apiKey = key;
                  return next;
                });
                input.value = "";
                notify("密钥已填入，点击保存设置后生效");
              }}
            >
              应用
            </Button>
          </div>
        </Field>
        <a
          href="https://cloud.siliconflow.cn/account/ak"
          target="_blank"
          rel="noreferrer"
        >
          去服务商创建 API Key ↗
        </a>
      </Section></details></div><aside>      <Section title="智能模型路由" subtitle="结合问题和最近几轮对话判断场景、复杂度及个人决策；医学、学习和复杂问题优先使用强模型。">
        <Toggle label="启用模型自动分类" checked={s.routing?.enabled ?? true} onChange={v => update("routing", "enabled", v)} hint="明确的问候、设备指令和简短追问会直接处理；其余问题增加一次分类调用。" />
        <Toggle label="不确定时优先质量" checked={s.routing?.qualityFirst ?? true} onChange={v => update("routing", "qualityFirst", v)} hint="分类超时、失败或把握较低时优先强模型；会增加用量。" />
        <div className="grid two">
          <Field label="分类等待上限（秒）"><input type="number" min="0.5" max="15" step="0.5" value={(s.routing?.timeoutMs ?? 6000) / 1000} onChange={e => update("routing", "timeoutMs", Math.round(Number(e.target.value) * 1000))} /></Field>
          <Field label="分类参考最近消息数"><input type="number" min="2" max="20" step="1" value={s.routing?.historyMessages ?? 8} onChange={e => update("routing", "historyMessages", Number(e.target.value))} /></Field>
        </div>
        <p>日常使用日常模型；其他场景优先使用其专用模型，留空时使用强模型。强模型也未配置时会显示回退提示。路由分类留空时沿用日常模型。</p>
        <Button primary icon={Check} onClick={save}>保存路由设置</Button>
      </Section><div className="profile-help"><LockKeyhole size={20} /><h3>连接由你掌握</h3><p>密钥保存在本机。使用云模型时，相应的对话内容会发送给你配置的服务商。</p></div></aside></div>
      </>}
      {panel === "voice" && <>      <Section
        title="语音输入"
        subtitle="陪伴模式保留口语、犹豫和情绪。短句也会识别，不因少于半秒直接丢弃。"
      >
        <Field label="整理模式">
          <select
            value={s.input.mode}
            onChange={(e) => update("input", "mode", e.target.value)}
          >
            <option value="conversation">陪伴聊天 · 保留原本表达</option>
            <option value="dictation">口述整理 · 改善文字可读性</option>
          </select>
        </Field>
        <div className="grid two">
          <Field label="人声检测"><select value={s.input.vad} onChange={e => update("input", "vad", e.target.value)}><option value="webrtc">WebRTC 人声检测</option><option value="energy">按音量检测（兼容模式）</option></select></Field>
          <Field label="插话方式"><select value={s.input.interruptionMode} onChange={e => update("input", "interruptionMode", e.target.value)}><option value="intent">短附和后继续回答</option><option value="immediate">检测到说话立即打断</option></select></Field>
        </div>
        <Field label="通话引擎" hint="全双工模式在模型页配置“火山全双工语音”：https://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue，模型 1.2.6.1。日常陪伴直接使用实时语音；复杂问题、记忆确认、设置与健康问答沿用现有流程和语音合成。更改后下次通话生效。"><select value={s.input.voiceMode} onChange={e => update("input", "voiceMode", e.target.value)}><option value="cascade">现有模型组合</option><option value="realtime">火山原生全双工</option></select></Field>
        <Field label="语音识别服务" hint="火山模式在模型页配置“火山流式识别”，地址填写 https://openspeech.bytedance.com/api/v3/sauc/bigmodel，模型栏填写已开通的资源 ID。"><select value={s.input.asrProvider} onChange={e => update("input", "asrProvider", e.target.value)}><option value="compatible">兼容接口／流式桥接</option><option value="volcengine">火山原生双向流式识别</option></select></Field>
        <Toggle label="自然判停" checked={s.input.adaptiveEndpoint} onChange={v => update("input", "adaptiveEndpoint", v)} hint="遇到‘因为、然后、我想…’等未完表达，留更长时间继续说。" />
        <Toggle label="语义辅助判停" checked={s.input.semanticEndpoint} onChange={v => update("input", "semanticEndpoint", v)} hint="配置路由模型后，使用短时分类判断是否说完；不可用时沿用停顿检测。" />
        <div className="grid two">
          <Field label="犹豫时等待（毫秒）"><input type="number" min="850" max="5000" value={s.input.thinkingPauseMs} onChange={e => update("input", "thinkingPauseMs", +e.target.value)} /></Field>
          <Field label="转写预览间隔（毫秒）" hint="未接流式识别时，预览会额外调用识别接口；填 0 关闭。"><input type="number" min="0" max="5000" step="100" value={s.input.previewMs} onChange={e => update("input", "previewMs", +e.target.value)} /></Field>
        </div>
        <Toggle
          label="开启模型精修"
          hint="需配置“输入整理”模型，会增加一次模型调用。默认关闭。"
          checked={s.input.refine}
          onChange={(v) => update("input", "refine", v)}
        />
        <div className="grid three">
          <Field label="停顿多久后回复（毫秒）">
            <input
              type="number"
              min="200"
              max="5000"
              value={s.input.silenceMs}
              onChange={(e) => update("input", "silenceMs", +e.target.value)}
            />
          </Field>
          <Field label="声音检测阈值" hint="轻声容易漏听时可适当调低。">
            <input
              type="number"
              step="0.001"
              min="0.001"
              max="0.5"
              value={s.input.rmsThreshold}
              onChange={(e) => update("input", "rmsThreshold", +e.target.value)}
            />
          </Field>
          <Field label="每段最长录音（秒）">
            <input
              type="number"
              min="5"
              max="180"
              value={s.input.maxRecordingSeconds}
              onChange={(e) =>
                update("input", "maxRecordingSeconds", +e.target.value)
              }
            />
          </Field>
        </div>
        <details>
          <summary>高级：流式识别桥接</summary>
          <p className="small muted">
            需使用项目文档中的桥接协议；不能直接填写任意厂商的 WebSocket
            地址。留空时使用整句识别。
          </p>
          <Field label="桥接 WebSocket 地址">
            <input
              value={s.input.streamingUrl}
              placeholder="ws://127.0.0.1:端口"
              onChange={(e) => update("input", "streamingUrl", e.target.value)}
            />
          </Field>
          <Field label="桥接令牌">
            <input
              type="password"
              value={s.input.streamingToken}
              placeholder={
                s.input.hasStreamingToken ? "已有令牌 · 留空保留" : ""
              }
              onChange={(e) =>
                update("input", "streamingToken", e.target.value)
              }
            />
          </Field>
        </details>
        <Button primary onClick={save}>
          保存语音设置
        </Button>
      </Section></>}
      {panel === "dictionary" && <>      <Section
        title="个人词典"
        subtitle="更正识别结果后可能生成建议，经你确认才会用于后续输入。"
      >
        <Form
          label="添加词条"
          icon={Plus}
          submit={(f, form) =>
            act(async () => {
              await api("/dictionary", "PUT", {
                phrase: f.get("phrase"),
                replacement: f.get("replacement"),
              });
              form.reset();
            })
          }
        >
          <div className="grid two">
            <Field label="容易识别成">
              <input name="phrase" placeholder="豆粒" required />
            </Field>
            <Field label="正确写法">
              <input name="replacement" placeholder="豆梨" required />
            </Field>
          </div>
        </Form>
        {state.dictionary.map((d) => (
          <div className="data-row" key={d.id}>
            <div>
              <b>
                {d.phrase} → {d.replacement}
              </b>
              <small>{d.status === "active" ? "已启用" : "待确认建议"}</small>
            </div>
            <div className="row-actions">
              {d.status !== "active" && (
                <Button
                  icon={Check}
                  onClick={() =>
                    act(() =>
                      api("/dictionary", "PUT", { ...d, status: "active" }),
                    )
                  }
                >
                  接受
                </Button>
              )}
              <Button
                icon={Trash2}
                onClick={() => act(() => api("/dictionary/" + d.id, "DELETE"))}
              />
            </div>
          </div>
        ))}
      </Section></>}
      {panel === "privacy" && <>      <Section title="记录与搜索">
        <Toggle label="语义记忆检索" hint="换一种说法也能查找。向量模型留空时可复用已配置的硅基流动账号；其他服务请配置“记忆向量”。相关文字会发送给该服务。"
          checked={s.memory.semantic} onChange={v => update("memory", "semantic", v)} />
        <Toggle label="整理近期经历" hint="后台调用记忆模型生成带原话来源的会话和每日摘要。关闭后停止生成，已有摘要保留。"
          checked={s.memory.autoSummaries} onChange={v => update("memory", "autoSummaries", v)} />
        <Toggle label="后台整理记忆" hint="合并等价事实、归档到期状态，并整理已确认的稳定资料。不会自动确认新的记忆建议。"
          checked={s.memory.maintenance} onChange={v => update("memory", "maintenance", v)} />
        <div className="grid two">
          <Field label="每次带入的记忆预算" hint="估算 token 数，包含重要资料、相关事实和近期经历。"><input type="number" min="500" max="12000" value={s.memory.contextTokens} onChange={e => update("memory", "contextTokens", +e.target.value)} /></Field>
          <Field label="近期对话预算"><input type="number" min="1000" max="24000" value={s.memory.historyTokens} onChange={e => update("memory", "historyTokens", +e.target.value)} /></Field>
        </div>
        <Toggle
          label="保存语音输入录音"
          hint="默认不保存。开启后可在对话中回听，占用本机磁盘；关闭不删除已保存录音。"
          checked={s.privacy.saveAudio}
          onChange={(v) => update("privacy", "saveAudio", v)}
        />
        <Toggle
          label="从聊天中生成记忆建议"
          hint="生成建议会调用记忆模型；需要你确认才会正式记住。"
          checked={s.privacy.autoMemory}
          onChange={(v) => update("privacy", "autoMemory", v)}
        />
        <Field
          label="Brave Search API Key（可选）"
          hint="未配置时助手没有联网检索能力。"
        >
          <input
            type="password"
            value={s.search.apiKey}
            placeholder={
              s.search.hasKey ? "已配置 · 留空保留" : "用于有来源的联网回答"
            }
            onChange={(e) => update("search", "apiKey", e.target.value)}
          />
        </Field>
        <Button primary onClick={save}>
          保存
        </Button>
      </Section></>}
      {panel === "sync" && <SyncPanel {...{ api, Section, Field, Button, notify }} />}
      {panel === "events" && <>      <Section
        title="运行记录"
        action={
          <Button
            icon={RefreshCw}
            onClick={() => act(async () => setEvents(await api("/events")))}
          >
            刷新
          </Button>
        }
      >
        {events.length ? (
          events.map((e) => (
            <div className="data-row" key={e.id}>
              <div>
                <b>{e.kind}</b>
                <p className="small">{JSON.stringify(e.detail)}</p>
                <small>{time(e.created_at)}</small>
              </div>
            </div>
          ))
        ) : (
          <Empty>点击刷新查看最近的设备动作、错误和处理记录。</Empty>
        )}
      </Section></>}
      {panel === "modules" && <div className="module-layout"><div><Section title="选择你需要的功能" subtitle="保持侧栏简单，需要的时候再开启。"><Toggle label="设备与家居" checked={ui.showDevices} onChange={v => updateUi({ showDevices: v })} hint="在侧栏显示设备管理、家居控制和自动化入口。" /><div className="module-explanation"><Radio size={20} /><p>隐藏入口不会断开音箱，也不会停用现有自动化。音箱对话仍会保存到「对话记录」。</p></div></Section><Section title="打开应用时"><Field label="默认页面"><select value={ui.defaultPage} onChange={e => updateUi({ defaultPage: e.target.value })}><option value="chat">对话记录</option><option value="assistant">我的助手</option><option value="memory">我的资料</option><option value="settings">设置</option></select></Field><p className="small muted">显示偏好立即保存，仅影响当前客户端。</p></Section></div><aside className="nav-preview"><span className="eyebrow">侧栏预览</span><div className="brand"><span className="bean">d.</span><b>豆梨</b></div>{["对话记录", "我的助手", "我的资料", ...(ui.showDevices ? ["设备与家居"] : []), "设置"].map(label => <div key={label} className={label === "设置" ? "selected" : ""}>{label}</div>)}<p>只留下你需要的入口</p></aside></div>}
      {panel === "desktop" && <Section title="桌面偏好" subtitle="管理当前客户端的打开方式与运行状态。"><Field label="默认页面"><select value={ui.defaultPage} onChange={e => updateUi({ defaultPage: e.target.value })}>{[["chat", "对话记录"], ["assistant", "我的助手"], ["memory", "我的资料"], ["settings", "设置"]].map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></Field>{desktopStatus ? <><div className="data-row"><span>桌面版本</span><b>{desktopStatus.version}</b></div><div className="data-row"><span>服务连接</span><b>{desktopStatus.mode === "attached" ? "连接已有本机服务" : "桌面端管理本机服务"}</b></div><p className="muted">关闭后驻留托盘、开机启动和数据目录，可在窗口顶部「豆梨」菜单中设置。</p><Button onClick={() => window.douliDesktop.openLogs()}>打开运行日志</Button></> : <p className="muted">当前通过浏览器访问。桌面窗口与托盘选项在豆梨桌面应用中管理。</p>}</Section>}
      </div>
    </div>
  </>;
}

function Devices({ state, act, notify, reload }) {
  const [type, setType] = useState("http"),
    [ruleType, setRuleType] = useState("time"),
    [deviceId, setDeviceId] = useState("");
  useEffect(() => {
    const timer = setInterval(() => reload().catch(() => {}), 5000);
    return () => clearInterval(timer);
  }, []);
  return (
    <>
      <div className="page-title">
        <span className="eyebrow">A VOICE IN YOUR ROOM</span>
        <h1>把陪伴放到床边</h1>
        <p>让 ESP32 连接这台{state.platform === "android" ? "手机" : "电脑"}，为你提供语音陪伴。</p>
      </div>
      <SyncPanel {...{ api, Section, Button, Field }} />
      <Section
        title="我的 ESP32"
        subtitle="开启五分钟配对窗口，把下方 OTA 地址配置到小智兼容固件中，再确认出现的设备。"
        action={
          <Button
            primary
            icon={Plus}
            onClick={() =>
              act(async () => {
                await api("/devices/pair", "POST", {});
                notify("配对已开启，五分钟内有效");
              })
            }
          >
            添加设备
          </Button>
        }
      >
        {state.pairingUntil > Date.now() && (
          <div className="notice">配对窗口已开启，等待设备连接。</div>
        )}
        <div className="address-list">
          {state.gatewayAddresses.map((url) => (
            <div key={url}>
              <code>{url}</code>
              <Button
                onClick={() =>
                  navigator.clipboard
                    .writeText(url)
                    .then(() => notify("地址已复制"))
                    .catch(() => notify("请手动复制地址", true))
                }
              >
                复制
              </Button>
            </div>
          ))}
        </div>
        {!state.devices.length ? (
          <Empty>
            <Radio size={26} />
            <p>还没有连接的 ESP32</p>
            <small>电脑试聊不需要等待设备到货。</small>
          </Empty>
        ) : (
          state.devices.map((d) => (
            <div className="device-card" key={d.id}>
              <div className="row-title">
                <Radio size={20} />
                <b>{d.name}</b>
                <span className={"tag " + (d.online ? "" : "gray")}>
                  {d.online ? "连接本机" : d.approved ? "未连接本机" : "待确认"}
                </span>
              </div>
              <p className="small muted">
                {d.id} · 固件 {d.firmware || "未知"} · {d.tools.length} 个工具
              </p>
              {d.activationCode && (
                <p>
                  设备配对码：<strong>{d.activationCode}</strong>
                </p>
              )}
              <div className="row-actions">
                {!d.approved && (
                  <Button
                    primary
                    icon={Check}
                    onClick={() =>
                      act(() =>
                        api("/devices/" + d.id, "PUT", { approved: true }),
                      )
                    }
                  >
                    确认这是我的设备
                  </Button>
                )}
                <Button
                  onClick={() => {
                    const name = prompt("设备名称", d.name);
                    if (name)
                      act(() => api("/devices/" + d.id, "PUT", { name }));
                  }}
                >
                  改名
                </Button>
                <Button
                  danger
                  icon={Trash2}
                  onClick={() => {
                    if (confirm("移除设备并撤销连接权限？"))
                      act(() => api("/devices/" + d.id, "DELETE"));
                  }}
                >
                  移除
                </Button>
              </div>
              {d.approved && <BackendSelection id={d.id} {...{ api, Button, Field, notify }} />}
              {d.approved && <SpeakerVolume device={d} {...{ api, Button, Field, notify }} />}
              {d.approved && (
                <details>
                  <summary>这台设备的语音设置</summary>
                  <Form
                    label="保存设备设置"
                    submit={(f) =>
                      act(async () => {
                        await api("/devices/" + d.id, "PUT", {
                          config: {
                            route: f.get("route"),
                            volume: Number(f.get("volume")) / 100,
                            rmsThreshold:
                              f.get("rmsThreshold") === ""
                                ? null
                                : Number(f.get("rmsThreshold")),
                          },
                        });
                        notify("已保存，设备重新连接后生效");
                      })
                    }
                  >
                    <div className="grid three">
                      <Field label="对话模式">
                        <select name="route" defaultValue={d.config.route}>
                          {[
                            "auto",
                            "daily",
                            "learning",
                            "reasoning",
                            "health",
                            "debate",
                          ].map((key) => (
                            <option key={key} value={key}>
                              {names[key]}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field
                        label="播放音量比例（%）"
                        hint="在扬声器音量基础上降低播放强度；夜间模式还会进一步降低。"
                      >
                        <input
                          name="volume"
                          type="number"
                          min="0"
                          max="100"
                          step="1"
                          required
                          defaultValue={Math.round(d.config.volume * 100)}
                        />
                      </Field>
                      <Field
                        label="收音阈值"
                        hint="留空跟随全局。越小越容易触发，也更易收进噪声。"
                      >
                        <input
                          name="rmsThreshold"
                          type="number"
                          min="0.001"
                          max="0.5"
                          step="0.001"
                          defaultValue={d.config.rmsThreshold ?? ""}
                          placeholder="跟随全局"
                        />
                      </Field>
                    </div>
                  </Form>
                </details>
              )}
              {d.tools.length > 0 && (
                <details>
                  <summary>设备支持的工具</summary>
                  {d.tools.map((t) => (
                    <p className="small" key={t.name}>
                      <b>{t.name}</b> · {t.description}
                    </p>
                  ))}
                </details>
              )}
            </div>
          ))
        )}
      </Section>
      <Section
        title="家居动作"
        subtitle="开灯和关灯分别登记，助手才知道该按哪个方向。设备收到指令与灯确实改变状态会分开显示。"
      >
        {!state.actions.length && (
          <Empty>还没有动作。等手指机器人型号确定后，填入它提供的接口。</Empty>
        )}
        {state.actions.map((a) => (
          <div className="data-row" key={a.id}>
            <div>
              <b>{a.name}</b>
              <small>
                {a.type} · {a.target}
              </small>
            </div>
            <div className="row-actions">
              <Button
                onClick={() =>
                  act(async () => {
                    const result = await api(
                      "/actions/" + a.id + "/run",
                      "POST",
                      {},
                    );
                    notify(
                      result.message ||
                        (result.verified
                          ? "状态已核实"
                          : "指令已收到，状态未核实"),
                    );
                  })
                }
              >
                执行
              </Button>
              <Button
                danger
                icon={Trash2}
                onClick={() => act(() => api("/actions/" + a.id, "DELETE"))}
              />
            </div>
          </div>
        ))}
        <details>
          <summary>添加动作</summary>
          <Form
            label="登记动作"
            submit={(f, form) =>
              act(async () => {
                const config = { type };
                if (type === "http")
                  Object.assign(config, {
                    url: f.get("url"),
                    method: f.get("method"),
                    headers: JSON.parse(f.get("headers") || "{}"),
                    body: f.get("body") ? JSON.parse(f.get("body")) : undefined,
                  });
                if (type === "homeassistant")
                  Object.assign(config, {
                    baseUrl: f.get("baseUrl"),
                    token: f.get("token"),
                    entityId: f.get("entityId"),
                    service: f.get("service"),
                    expectedState: f.get("expectedState"),
                  });
                if (type === "device")
                  Object.assign(config, {
                    deviceId,
                    tool: f.get("tool"),
                    arguments: JSON.parse(f.get("arguments") || "{}"),
                  });
                await api("/actions", "PUT", { name: f.get("name"), config });
                form.reset();
                notify("动作已登记，尚未执行");
              })
            }
          >
            <div className="grid two">
              <Field label="动作名称">
                <input name="name" placeholder="关闭床头灯" required />
              </Field>
              <Field label="连接方式">
                <select value={type} onChange={(e) => setType(e.target.value)}>
                  <option value="http">设备 HTTP 接口</option>
                  <option value="homeassistant">Home Assistant</option>
                  <option value="device">ESP32 提供的工具</option>
                </select>
              </Field>
            </div>
            {type === "http" && (
              <>
                <Field label="接口地址">
                  <input
                    type="url"
                    name="url"
                    placeholder="http://设备地址/关灯接口"
                    required
                  />
                </Field>
                <Field label="请求方式">
                  <select name="method">
                    <option>POST</option>
                    <option>GET</option>
                    <option>PUT</option>
                  </select>
                </Field>
                <details>
                  <summary>接口参数</summary>
                  <Field label="请求头（JSON）">
                    <textarea
                      name="headers"
                      defaultValue={'{"Content-Type":"application/json"}'}
                    />
                  </Field>
                  <Field label="请求内容（JSON，可留空）">
                    <textarea name="body" />
                  </Field>
                </details>
              </>
            )}
            {type === "homeassistant" && (
              <>
                <Field label="Home Assistant 地址">
                  <input
                    type="url"
                    name="baseUrl"
                    placeholder="http://homeassistant.local:8123"
                    required
                  />
                </Field>
                <Field label="长期访问令牌">
                  <input type="password" name="token" required />
                </Field>
                <div className="grid three">
                  <Field label="实体 ID">
                    <input
                      name="entityId"
                      placeholder="light.bedroom"
                      required
                    />
                  </Field>
                  <Field label="服务">
                    <input
                      name="service"
                      placeholder="light.turn_off"
                      required
                    />
                  </Field>
                  <Field label="预期状态（可选）">
                    <input name="expectedState" placeholder="off" />
                  </Field>
                </div>
              </>
            )}
            {type === "device" && (
              <>
                <Field label="设备">
                  <select
                    value={deviceId}
                    onChange={(e) => setDeviceId(e.target.value)}
                    required
                  >
                    <option value="">选择设备</option>
                    {state.devices
                      .filter((d) => d.online)
                      .map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label="工具">
                  <select name="tool" required>
                    <option value="">选择工具</option>
                    {state.devices
                      .find((d) => d.id === deviceId)
                      ?.tools.map((t) => (
                        <option key={t.name}>{t.name}</option>
                      ))}
                  </select>
                </Field>
                <Field label="工具参数（JSON）">
                  <textarea name="arguments" defaultValue="{}" />
                </Field>
              </>
            )}
          </Form>
        </details>
      </Section>
      <Section
        title="传感器"
        subtitle="登记后由已授权设备上报数值；可用于照度、温度等。不会把过期数值当作最新状态。"
      >
        {state.sensors.map((s) => (
          <div className="data-row" key={s.id}>
            <div>
              <b>{s.name}</b>
              <small>ID：{s.id}</small>
              <small>
                {time(s.updated_at)}
                {s.updated_at && Date.now() - Date.parse(s.updated_at) > 120000
                  ? " · 数据已过期"
                  : ""}
              </small>
            </div>
            <span className="sensor-value">
              {s.value ?? "—"}
              <small>{s.unit}</small>
            </span>
            <Button
              icon={Trash2}
              onClick={() => act(() => api("/sensors/" + s.id, "DELETE"))}
            />
          </div>
        ))}
        <details>
          <summary>登记传感器</summary>
          <Form
            label="添加"
            submit={(f, form) =>
              act(async () => {
                await api("/sensors", "PUT", {
                  name: f.get("name"),
                  unit: f.get("unit"),
                  ...(f.get("haUrl")
                    ? {
                        source: {
                          baseUrl: f.get("haUrl"),
                          entityId: f.get("haEntity"),
                          token: f.get("haToken"),
                        },
                      }
                    : {}),
                });
                form.reset();
              })
            }
          >
            <div className="grid two">
              <Field label="名称">
                <input name="name" placeholder="卧室照度" required />
              </Field>
              <Field label="单位">
                <input name="unit" placeholder="lux" />
              </Field>
            </div>
            <details>
              <summary>从 Home Assistant 读取（可选）</summary>
              <Field label="服务地址">
                <input
                  name="haUrl"
                  type="url"
                  placeholder="http://homeassistant.local:8123"
                />
              </Field>
              <Field label="实体 ID">
                <input
                  name="haEntity"
                  placeholder="sensor.bedroom_illuminance"
                />
              </Field>
              <Field label="长期访问令牌">
                <input name="haToken" type="password" />
              </Field>
              <p className="small muted">
                每 30 秒读取数值；留空时由已授权 ESP32 上报。
              </p>
            </details>
          </Form>
        </details>
      </Section>
      <Section
        title="自动化"
        subtitle="规则默认关闭，确认后再启用。传感器数据超过两分钟未更新时不触发；数值回到阈值另一侧后才重新触发。"
      >
        {state.rules.map((r) => (
          <div className="rule" key={r.id}>
            <Toggle
              label={r.name}
              hint={
                r.config.type === "time"
                  ? `每天 ${r.config.time}`
                  : `传感器${r.config.operator === "above" ? "高于" : "低于"} ${r.config.threshold}`
              }
              checked={r.enabled}
              onChange={(enabled) =>
                act(() => api("/rules", "PUT", { ...r, enabled }))
              }
            />
            <Button
              icon={Trash2}
              onClick={() => act(() => api("/rules/" + r.id, "DELETE"))}
            />
          </div>
        ))}
        <details>
          <summary>创建规则</summary>
          <Form
            label="创建（默认停用）"
            submit={(f, form) =>
              act(async () => {
                await api("/rules", "PUT", {
                  name: f.get("name"),
                  enabled: false,
                  config: {
                    type: ruleType,
                    time: f.get("time"),
                    sensorId: f.get("sensorId"),
                    operator: f.get("operator"),
                    threshold: Number(f.get("threshold")),
                    actionId: f.get("actionId"),
                    cooldownSeconds: Number(f.get("cooldown")),
                  },
                });
                form.reset();
              })
            }
          >
            <Field label="规则名称">
              <input name="name" placeholder="晚上十一点关灯" required />
            </Field>
            <Field label="触发条件">
              <select
                value={ruleType}
                onChange={(e) => setRuleType(e.target.value)}
              >
                <option value="time">每天固定时间</option>
                <option value="sensor">传感器条件</option>
              </select>
            </Field>
            {ruleType === "time" ? (
              <Field label="时间（电脑本地时间）">
                <input type="time" name="time" required />
              </Field>
            ) : (
              <div className="grid three">
                <Field label="传感器">
                  <select name="sensorId" required>
                    <option value="">请选择</option>
                    {state.sensors.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="条件">
                  <select name="operator">
                    <option value="above">高于</option>
                    <option value="below">低于</option>
                  </select>
                </Field>
                <Field label="阈值">
                  <input type="number" step="any" name="threshold" required />
                </Field>
              </div>
            )}
            <div className="grid two">
              <Field label="执行动作">
                <select name="actionId" required>
                  <option value="">选择动作</option>
                  {state.actions.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="两次触发最短间隔（秒）">
                <input
                  type="number"
                  name="cooldown"
                  min="60"
                  defaultValue="300"
                  required
                />
              </Field>
            </div>
          </Form>
        </details>
      </Section>
    </>
  );
}

createRoot(document.getElementById("root")).render(<App />);
