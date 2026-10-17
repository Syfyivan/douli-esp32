export function port(value, fallback) {
  const number = Number(value || fallback);
  if (!Number.isInteger(number) || number < 1024 || number > 65535)
    throw new Error("端口必须是 1024–65535 之间的整数");
  return number;
}

export function isAppUrl(value, origin) {
  try { const url = new URL(value); return url.origin === origin && !url.username && !url.password; }
  catch { return false; }
}

export function externalUrl(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

export function audioPermission(permission, details = {}) {
  if (permission !== "media") return false;
  const types = details.mediaTypes || (details.mediaType ? [details.mediaType] : []);
  return types.length > 0 && types.every(type => type === "audio");
}

export async function probeService(origin, { timeoutMs = 5000 } = {}) {
  let response, data;
  try {
    response = await fetch(`${origin}/api/health`, { headers: { Connection: "close" }, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    data = await response.json().catch(error => { if (error instanceof SyntaxError) return null; throw error; });
  }
  catch (error) {
    // A timeout or redirect does not establish that the port is free.
    if (error.cause?.code === "ECONNREFUSED") return false;
    throw new Error("本机服务未响应，请检查端口占用后重试。", { cause: error });
  }
  if (!response.ok) throw new Error(`本机服务暂时返回 HTTP ${response.status}，请稍后重试。`);
  if (!data?.ok || data.name !== "douli-esp32" || data.memoryVersion !== 2)
    throw new Error("管理端口已被其他程序或不兼容的豆梨服务占用。请关闭冲突程序后重试。");
  return true;
}
