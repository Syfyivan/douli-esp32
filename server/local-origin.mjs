// Shared by HTTP and browser voice WebSocket endpoints.
export function isLocalOrigin(value, adminPort = 8788) {
  try {
    const origin = new URL(value);
    return origin.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) &&
      ["8788", "8790", String(adminPort)].includes(origin.port);
  } catch { return false; }
}
