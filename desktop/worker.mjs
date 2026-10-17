import { createApplication } from "../server/app.mjs";

let application, stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => process.exit(1), 8000);
  timeout.unref();
  try { await application?.close(); }
  finally { process.exit(code); }
}
process.parentPort.on("message", ({ data }) => {
  if (data?.type === "stop") void stop();
});
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => void stop());
try {
  application = await createApplication({
    dataDir: process.env.DOULI_DATA_DIR,
    distDir: process.env.DOULI_DIST_DIR,
    adminPort: Number(process.env.DOULI_PORT),
    gatewayPort: Number(process.env.DOULI_DEVICE_PORT),
  });
  await application.admin.listen({ port: Number(process.env.DOULI_PORT), host: "127.0.0.1" });
  await application.device.listen({ port: Number(process.env.DOULI_DEVICE_PORT), host: process.env.DOULI_DEVICE_HOST || "0.0.0.0" });
  process.parentPort.postMessage({ type: "ready", node: process.version });
} catch (error) {
  console.error(error);
  process.parentPort.postMessage({ type: "failed", message: error.code === "EADDRINUSE"
    ? "服务端口被占用，请检查管理端口和 ESP32 设备端口。" : error.message });
  await stop(1);
}
