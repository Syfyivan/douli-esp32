import { resolve } from "node:path";
import { createApplication } from "./app.mjs";
const app = await createApplication({
  dataDir: process.env.DOULI_DATA_DIR || resolve(".data"),
  gatewayPort: Number(process.env.DOULI_DEVICE_PORT || 8789),
});
await app.admin.listen({
  port: Number(process.env.DOULI_PORT || 8788),
  host: "127.0.0.1",
});
await app.device.listen({
  port: Number(process.env.DOULI_DEVICE_PORT || 8789),
  host: process.env.DOULI_DEVICE_HOST || "0.0.0.0",
});
console.log(
  "豆梨管理界面：http://127.0.0.1:" + (process.env.DOULI_PORT || 8788),
);
console.log("设备服务已启动；在管理界面的设备页开启配对。");
for (const name of ["SIGINT", "SIGTERM"])
  process.once(name, async () => {
    await app.close();
    process.exit(0);
  });
