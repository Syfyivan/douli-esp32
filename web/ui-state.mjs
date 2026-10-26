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
export function inDateRange(value, range, now = new Date()) {
  if (!range || range === "all") return true;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (range === "week") start.setDate(start.getDate() - 6);
  if (range === "month") start.setDate(start.getDate() - 29);
  return new Date(value).getTime() >= start.getTime();
}
