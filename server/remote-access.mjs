import Fastify from "fastify";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function validateRemoteAccess(value) {
  if (!value || value.enabled !== true) return null;
  const url = new URL(value.origin);
  if (url.protocol !== "https:" || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash)
    throw new Error("远程入口必须是 HTTPS 域名和端口，不能包含路径或凭据");
  const port = value.port ?? 8792;
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("远程入口的本机端口无效");
  return { enabled: true, origin: url.origin, port };
}

export function readRemoteAccess(directory) {
  const path = join(directory, "remote-access.json");
  return existsSync(path)
    ? validateRemoteAccess(JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")))
    : null;
}

// This listener is exclusively for an HTTPS tunnel. It deliberately registers
// only authenticated device discovery and the existing authenticated socket.
// Local pairing, sync, management and personal records have no routes here.
export async function createRemoteGateway(gateway, config) {
  if (!config) return null;
  const remote = Fastify({ logger: false, bodyLimit: 16 * 1024, requestTimeout: 10000 });
  remote.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!gateway.authorized(request))
      return reply.code(401).send({ error: "设备未授权" });
  });
  for (const url of ["/xiaozhi/ota", "/xiaozhi/ota/"])
    remote.route({
      method: ["GET", "POST"], url,
      handler: async request => gateway.ota(request, 0, config.origin),
    });
  remote.setErrorHandler((error, request, reply) => {
    reply.code(error.statusCode === 413 ? 413 : 400).send({ error: "无效设备请求" });
  });
  await remote.ready();
  gateway.attach(remote.server, false, { remote: true });
  await remote.listen({ host: "127.0.0.1", port: config.port });
  return remote;
}
