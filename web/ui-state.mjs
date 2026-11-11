export const UI_STORAGE_KEY = "douli.desktop.ui.v1";
export function normalizeUiPreferences(value) {
  return {
    showDevices: value?.showDevices === true,
    defaultPage: ["chat", "assistant", "memory", "settings"].includes(value?.defaultPage) ? value.defaultPage : "chat",
  };
}
export function readUiPreferences(storage) {
  try { return normalizeUiPreferences(JSON.parse((storage || window.localStorage).getItem(UI_STORAGE_KEY))); }
  catch { return normalizeUiPreferences(null); }
}
export function conversationSource(source, devices = []) {
  if (source === "diary") return { kind: "text", label: "手动生活记录" };
  if (source === "browser") return { kind: "text", label: "电脑文字" };
  if (source === "browser-voice") return { kind: "voice", label: "电脑语音" };
  if (!source) return { kind: "unknown", label: "来源未记录" };
  return { kind: "speaker", label: devices.find(d => d.id === source)?.name || "音箱对话" };
}
export function speakerResultLabel(speaker) {
  if (speaker?.status === "matched") return `匹配到${speaker.name || "已录入的成员"}`;
  if (speaker?.status !== "unknown") return "";
  const reason = {
    short_audio: "语音不足一秒",
    low_voiceprint_similarity: "与已录入的声音相似度低",
    ambiguous_voiceprint: "两个候选人的分数接近",
    mixed_speakers: "不同语音片段匹配到不同成员",
    not_enrolled: "声纹识别未启用",
  }[speaker.reason];
  const mode = speaker.responseMode === "guest" ? "访客模式" : "未确认成员";
  return reason ? `${mode}（${reason}）` : mode;
}
export function inDateRange(value, range, now = new Date()) {
  if (!range || range === "all") return true;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (range === "week") start.setDate(start.getDate() - 6);
  if (range === "month") start.setDate(start.getDate() - 29);
  return new Date(value).getTime() >= start.getTime();
}
