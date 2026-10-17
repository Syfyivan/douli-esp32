import { resolve } from "node:path";
import { createApplication } from "./app.mjs";

const app = await createApplication({ dataDir: process.env.DOULI_DATA_DIR, gatewayPort: Number(process.env.DOULI_DEVICE_PORT || 8789) });
// Registered by createApplication before Fastify becomes ready.
await app.admin.listen({ port: Number(process.env.DOULI_PORT || 8788), host: "127.0.0.1" });
await app.device.listen({ port: Number(process.env.DOULI_DEVICE_PORT || 8789), host: "0.0.0.0" });
console.log("Douli Android ready", process.version, resolve("."));
for (const name of ["SIGTERM", "SIGINT"])
  process.once(name, async () => { await app.close(); process.exit(0); });
