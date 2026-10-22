export const routes = ["daily", "learning", "reasoning", "health", "debate"];
export const routeNames = {
  daily: "日常陪伴",
  learning: "知识学习",
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
  streamingTts: "豆包流式合成",
  realtime: "火山全双工语音",
};
export function deviceConfig(patch = {}, current = {}) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch))
    throw new Error("无效的设备语音设置");
  const result = { route: "auto", volume: 1, rmsThreshold: null, ...current };
  for (const key of ["route", "volume", "rmsThreshold"])
    if (Object.hasOwn(patch, key)) result[key] = patch[key];
  if (!["auto", ...routes].includes(result.route))
    throw new Error("未知的设备对话模式");
  if (!Number.isFinite(result.volume) || result.volume < 0 || result.volume > 1)
    throw new Error("设备音量应在 0–1 之间");
  if (
    result.rmsThreshold !== null &&
    (!Number.isFinite(result.rmsThreshold) ||
      result.rmsThreshold <= 0 ||
      result.rmsThreshold > 0.5)
  )
    throw new Error("设备收音阈值应在 0–0.5 之间，或留空跟随全局设置");
  return result;
}
export const defaults = {
  assistant: {
    name: "豆梨",
    persona:
      "你是一位温暖、坦诚、有分寸的语音陪伴助手。认真听用户说话，不一味附和，不编造共同经历。",
    tone: "自然温柔",
    replyLength: "简短",
    humor: 30,
    avoid: "不要每次回答都反问；不要自称唯一理解用户的人。",
    wakeWords: ["你好豆梨", "豆梨", "你好小智", "小智"],
    greeting: "我在，慢慢说。",
    night: { enabled: true, start: "22:00", end: "07:00", volume: 0.45 },
  },
  input: {
    mode: "conversation",
    asrProvider: "compatible",
    ttsProvider: "compatible",
    voiceMode: "cascade",
    refine: false,
    correctAssistantName: true,
    assistantAliases: ["豆离", "豆里", "豆黎", "豆粒", "逗梨", "老李"],
    asrTwoPass: true,
    silenceMs: 500,
    minSpeechMs: 120,
    rmsThreshold: 0.012,
    maxRecordingSeconds: 90,
    chunkMs: 3000,
    streamingUrl: "",
    streamingToken: "",
    finalTimeoutMs: 4500,
    vad: "webrtc",
    adaptiveEndpoint: true,
    semanticEndpoint: false,
    thinkingPauseMs: 2200,
    fastEndpointMs: 500,
    previewMs: 1200,
    interruptionMode: "intent",
  },
  privacy: { saveAudio: false, autoMemory: true },
  people: { voiceIdentification: false, groupId: "", members: [] },
  avatar: { apiKey: "", faceId: "66d1f5af-9b9b-49e2-a97f-6f5f3d59a2d5", faceName: "Tina（示例形象）", connectionMode: "sfu" },
  memory: {
    semantic: true,
    autoSummaries: true,
    maintenance: true,
    contextTokens: 2400,
    historyTokens: 5000,
    minSimilarity: 0.42,
    minRelevance: 0.01,
    queryTimeoutMs: 3500,
    backgroundIntervalMs: 60000,
  },
  models: Object.fromEntries(
    ["daily", "asr", "tts", "refine", "memory", "embedding", "rerank", "vision", "streamingAsr", "streamingTts", "realtime"].map((key) => [
      key,
      {
        baseUrl: "",
        apiKey: "",
        model: "",
        voice: "",
        pcmSampleRate: 24000,
        thinking: false,
      },
    ]),
  ),
  search: { enabled: true, provider: "auto", apiKey: "", deepseekApiKey: "" },
};
export function mergeSettings(current, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch))
    return current;
  const result = structuredClone(current);
  for (const [key, value] of Object.entries(patch)) {
    if (
      ["__proto__", "constructor", "prototype"].includes(key) ||
      !(key in result)
    )
      continue;
    if (value && typeof value === "object" && !Array.isArray(value))
      result[key] = mergeSettings(result[key] || {}, value);
    else result[key] = value;
  }
  return result;
}
export function normalizeSettings(value) {
  // Loading old backups/settings cannot restore retired routing profiles or thinking.
  const settings = mergeSettings(defaults, value);
  for (const model of Object.values(settings.models)) model.thinking = false;
  return settings;
}
export function validateSettings(s) {
  if (!s.search || typeof s.search.enabled !== "boolean" || !["auto", "deepseek", "bing", "brave"].includes(s.search.provider) ||
      !["apiKey", "deepseekApiKey"].every(k => typeof s.search[k] === "string" && s.search[k].length <= 512))
    throw new Error("无效的联网搜索设置");
  if (!s.avatar || !["apiKey", "faceId", "faceName"].every(k => typeof s.avatar[k] === "string") ||
      s.avatar.apiKey.length > 512 || s.avatar.faceName.length > 80 || !["sfu", "direct"].includes(s.avatar.connectionMode) ||
      (s.avatar.faceId && !/^[a-zA-Z0-9_-]{1,100}$/.test(s.avatar.faceId)))
    throw new Error("无效的实时形象设置");
  if (!s.people || typeof s.people.voiceIdentification !== "boolean" || typeof s.people.groupId !== "string" ||
      !Array.isArray(s.people.members) || s.people.members.length > 10 ||
      s.people.members.some(p => !p || ![p.personId, p.voiceId, p.voiceName].every(v => typeof v === "string" && v.length > 0 && v.length < 150)))
    throw new Error("无效的声纹设置");
  if (typeof s.input?.correctAssistantName !== "boolean" || typeof s.input?.asrTwoPass !== "boolean" ||
      !Array.isArray(s.input?.assistantAliases) || s.input.assistantAliases.length > 30 ||
      s.input.assistantAliases.some(word => typeof word !== "string" || !word.trim() || word.length > 30))
    throw new Error("无效的助手称呼纠错设置");
  if (!["cascade", "realtime"].includes(s.input?.voiceMode)) throw new Error("未知的实时语音模式");
  if (!["compatible", "volcengine"].includes(s.input?.asrProvider)) throw new Error("未知的语音识别服务");
  if (!["compatible", "volcengine"].includes(s.input?.ttsProvider)) throw new Error("未知的语音合成服务");
  for (const key of ["assistant", "input", "privacy", "models", "search", "memory"])
    if (!s[key] || typeof s[key] !== "object" || Array.isArray(s[key]))
      throw new Error("无效的设置分组");
  if (!s.assistant.night || !Array.isArray(s.assistant.wakeWords))
    throw new Error("无效的助手设置");
  for (const key of Object.keys(defaults.models)) {
    const m = s.models[key];
    if (
      !m ||
      typeof m.baseUrl !== "string" ||
      typeof m.model !== "string" ||
      typeof m.apiKey !== "string" ||
      typeof m.thinking !== "boolean"
    )
      throw new Error("无效的模型设置");
    if (m.baseUrl && !/^https?:\/\//i.test(m.baseUrl))
      throw new Error("模型地址需要以 http:// 或 https:// 开头");
    if (![8000, 16000, 24000, 32000, 44100, 48000].includes(m.pcmSampleRate))
      throw new Error("无效的合成采样率");
  }
  for (const key of [
    "silenceMs",
    "minSpeechMs",
    "rmsThreshold",
    "maxRecordingSeconds",
    "chunkMs",
  ]) {
    if (!Number.isFinite(s.input[key]) || s.input[key] <= 0)
      throw new Error(`无效的语音参数：${key}`);
  }
  if (
    s.input.maxRecordingSeconds > 180 ||
    s.input.silenceMs > 5000 ||
    s.input.rmsThreshold > 0.5
  )
    throw new Error("语音参数超出范围");
  if (!["conversation", "dictation"].includes(s.input.mode))
    throw new Error("未知的输入模式");
  if (!s.assistant.name.trim() || s.assistant.name.length > 50)
    throw new Error("请填写 1–50 字的助手名字");
  if (
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.assistant.night.start) ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.assistant.night.end)
  )
    throw new Error("夜间时间格式应为 HH:mm");
  if (
    !Number.isFinite(s.assistant.night.volume) ||
    s.assistant.night.volume < 0 ||
    s.assistant.night.volume > 1
  )
    throw new Error("音量应在 0–1 之间");
  if (s.input.streamingUrl && !/^wss?:\/\//.test(s.input.streamingUrl))
    throw new Error("流式识别桥接地址需要 ws:// 或 wss://");
  if (
    !Number.isFinite(s.input.finalTimeoutMs) ||
    s.input.finalTimeoutMs < 100 ||
    s.input.finalTimeoutMs > 30000
  )
    throw new Error("无效的识别回退时限");
  if (s.input.chunkMs > 10000 || s.input.minSpeechMs > 2000)
    throw new Error("语音分片或最短声音时间超出范围");
  if (!["webrtc", "energy"].includes(s.input.vad) || !["intent", "immediate"].includes(s.input.interruptionMode))
    throw new Error("无效的人声检测或插话方式");
  if (typeof s.input.adaptiveEndpoint !== "boolean" || typeof s.input.semanticEndpoint !== "boolean")
    throw new Error("无效的智能判停开关");
  for (const [key, min, max] of [["thinkingPauseMs", 850, 5000], ["fastEndpointMs", 350, 1000], ["previewMs", 0, 5000]])
    if (!Number.isInteger(s.input[key]) || s.input[key] < min || s.input[key] > max)
      throw new Error(`无效的语音参数：${key}`);
  for (const key of ["semantic", "autoSummaries", "maintenance"])
    if (typeof s.memory[key] !== "boolean") throw new Error("无效的记忆开关");
  for (const [key, min, max] of [["contextTokens", 500, 12000], ["historyTokens", 1000, 24000],
    ["queryTimeoutMs", 500, 15000], ["backgroundIntervalMs", 10000, 3600000]])
    if (!Number.isInteger(s.memory[key]) || s.memory[key] < min || s.memory[key] > max)
      throw new Error(`无效的记忆参数：${key}`);
  if (!Number.isFinite(s.memory.minSimilarity) || s.memory.minSimilarity < 0.2 || s.memory.minSimilarity > 0.95)
    throw new Error("无效的语义相似度阈值");
  if (!Number.isFinite(s.memory.minRelevance) || s.memory.minRelevance < 0 || s.memory.minRelevance > 1)
    throw new Error("无效的相关性阈值");
  return s;
}
export function isNight(settings, date = new Date()) {
  const n = settings.assistant.night;
  const now = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return (
    n.enabled &&
    (n.start > n.end
      ? now >= n.start || now < n.end
      : now >= n.start && now < n.end)
  );
}
