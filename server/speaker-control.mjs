import { deviceConfig } from "./config.mjs";

export function speakerVolume(result) {
  const objects = [result?.structuredContent];
  for (const entry of result?.content || []) if (entry.type === "text") {
    try { objects.push(JSON.parse(entry.text)); } catch {}
  }
  for (const object of objects) {
    const value = object?.audio_speaker?.volume;
    if (Number.isInteger(value) && value >= 0 && value <= 100) return value;
  }
  throw new Error("设备未返回有效音量");
}

export async function controlSpeaker(connection, operation, signal) {
  signal?.throwIfAborted();
  const id = connection.options.device?.id;
  if (!id) throw new Error("未指定音箱");
  const hardware = ["self.get_device_status", "self.audio_speaker.set_volume"].every(name => connection.tools.some(t => t.name === name));
  if (!hardware && connection.features?.mcp && !connection.tools.length)
    throw new Error("音箱的控制工具尚未准备好，请稍后再试");
  const metadata = () => JSON.parse(connection.store.db.prepare("SELECT metadata FROM devices WHERE id=?").get(id)?.metadata || "{}");
  const call = async (name, args = {}) => (await connection.gateway.call(id, name, args, signal)).result;
  const previous = hardware ? speakerVolume(await call("self.get_device_status")) : Math.round(connection.config.volume * 100);
  const label = hardware ? "扬声器音量" : "播放音量";
  if (operation.mode === "query") return { status: "read", value: previous, hardware, text: `这台音箱的${label}是百分之${previous}。` };
  const lastKey = hardware ? "lastHardwareVolume" : "lastPlaybackVolume";
  const value = Math.max(0, Math.min(100, operation.mode === "set" ? operation.value : operation.mode === "delta"
    ? previous + operation.value : previous || metadata().voiceControl?.[lastKey] || 50));
  if (!Number.isInteger(value)) throw new Error("无效的音量");
  if (value === previous) return { status: "applied", value, hardware, text: `这台音箱的${label}已经是百分之${value}了。` };
  signal?.throwIfAborted();
  if (hardware) {
    await call("self.audio_speaker.set_volume", { volume: value });
    // Acknowledgement alone is not proof that the speaker reached the requested volume.
    let actual;
    try { actual = speakerVolume(await call("self.get_device_status")); }
    catch { signal?.throwIfAborted(); return { status: "unverified", requested: value, hardware, text: `已发送音量调整指令，但暂时没能核实音箱的实际音量。` }; }
    if (actual !== value) return { status: "unverified", requested: value, value: actual, hardware, text: `音箱报告的音量仍是百分之${actual}，这次没有调到目标音量。` };
  }
  signal?.throwIfAborted();
  const next = metadata();
  next.voiceControl = { ...next.voiceControl, ...(previous > 0 ? { [lastKey]: previous } : {}), ...(hardware ? { speakerVolume: value } : {}) };
  if (!hardware) next.config = deviceConfig({ volume: value / 100 }, next.config);
  connection.store.db.prepare("UPDATE devices SET metadata=? WHERE id=?").run(JSON.stringify(next), id);
  if (!hardware) connection.config = next.config;
  return { status: "applied", value, hardware, text: `这台音箱的${label}已调到百分之${value}。` };
}
