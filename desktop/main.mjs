import { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, shell, dialog, screen } from "electron";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, statSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DesktopService } from "./service.mjs";
import { port, isAppUrl, externalUrl, audioPermission, probeService } from "./policy.mjs";
import { ConnectionMonitor, describeConnectionError } from "./connection.mjs";

app.setName("Douli");
if (process.env.DOULI_DESKTOP_PROFILE) app.setPath("userData", resolve(process.env.DOULI_DESKTOP_PROFILE));
else app.setPath("userData", join(app.getPath("appData"), "Douli"));
const root = resolve(import.meta.dirname, "..");
const profile = app.getPath("userData");
mkdirSync(profile, { recursive: true });
const settingsPath = join(profile, "desktop.json");
const logs = join(profile, "logs");
mkdirSync(logs, { recursive: true });
const logFile = join(logs, "desktop.log");
if (existsSync(logFile) && statSync(logFile).size > 2 * 1024 * 1024)
  renameSync(logFile, logFile + ".previous");
const log = message => appendFileSync(logFile, new Date().toISOString() + " " + message + "\n");
let preferences = {};
try { preferences = JSON.parse(readFileSync(settingsPath, "utf8")); } catch { /* First launch. */ }
function savePreferences() { writeFileSync(settingsPath, JSON.stringify(preferences, null, 2)); }
const statusFile = join(root, "desktop/status.html");
const statusUrl = pathToFileURL(statusFile).href;
let window, tray, service, quitting = false, closing = false, connecting = false, errorMessage = "", monitor;
let origin, dataDir;
const selfTest = process.env.DOULI_DESKTOP_SELF_TEST === "1";

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => showWindow());
  app.on("activate", () => showWindow());
  app.on("window-all-closed", () => { if (!tray && !quitting) app.quit(); });
  app.on("before-quit", event => {
    quitting = true;
    if (closing) return;
    event.preventDefault();
    closing = true;
    monitor?.stop();
    window?.webContents.send("douli:background");
    void service?.stop().finally(() => {
      tray?.destroy();
      app.quit();
    });
    if (!service) app.quit();
  });
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", event => event.preventDefault());
  });
  // Finish evaluating the entry module before waiting for Electron readiness.
  log("Desktop bootstrap; waiting for app ready.");
  void app.whenReady().then(start).catch(error => {
    log(error.stack || error.message);
    dialog.showErrorBox("豆梨启动失败", error.message);
    app.quit();
  });
}

function showWindow() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
function status() {
  return { version: app.getVersion(), mode: service?.mode || "stopped", error: errorMessage,
    origin, dataDir: service?.mode === "attached" ? null : dataDir,
    pid: process.pid, servicePid: service?.child?.pid || null, packaged: app.isPackaged };
}
async function showFailure(error) {
  if (quitting) return;
  errorMessage = error.message;
  monitor?.reset({ offline: true });
  log(describeConnectionError(error));
  await window.loadFile(statusFile);
  updateMenus();
}
async function connect() {
  if (connecting || quitting) return;
  connecting = true;
  monitor?.reset();
  errorMessage = "";
  try {
    await service.start();
    if (quitting) { await service.stop(); return; }
    await window.loadURL(origin);
    updateMenus();
    return true;
  } catch (error) { await showFailure(error); }
  finally { connecting = false; }
}
function trusted(event) {
  return event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame &&
    (event.senderFrame.url === statusUrl || isAppUrl(event.senderFrame.url, origin));
}
function registerIpc() {
  for (const [channel, action] of [
    ["douli:status", () => status()],
    ["douli:retry", () => connect()],
    ["douli:logs", () => shell.openPath(logs)],
  ]) ipcMain.handle(channel, (event) => {
    if (!trusted(event)) throw new Error("不允许此页面调用桌面功能");
    return action();
  });
}
async function chooseDataDirectory() {
  const result = await dialog.showOpenDialog(window, { title: "选择豆梨数据目录（包含数据库和加密密钥的整个目录）",
    defaultPath: dataDir, properties: ["openDirectory", "createDirectory"] });
  if (result.canceled) return;
  if (existsSync(join(result.filePaths[0], "douli.sqlite")) && !existsSync(join(result.filePaths[0], "local.key"))) {
    await dialog.showMessageBox(window, { type: "error", message: "此目录缺少 local.key 加密密钥", detail: "请使用包含原数据库及密钥的完整数据目录。" });
    return;
  }
  preferences.dataDir = result.filePaths[0];
  savePreferences();
  app.relaunch();
  app.quit();
}
function updateMenus() {
  const serviceLabel = service?.mode === "attached" ? "已连接现有服务（由原启动器管理）"
    : service?.mode === "owned" ? "本地服务运行中" : "本地服务未连接";
  const quitItem = { label: service?.mode === "attached" ? "退出桌面端（保留现有服务）" : "退出豆梨并停止本地服务",
    accelerator: "CmdOrCtrl+Q", click: () => app.quit() };
  const openData = { label: "打开数据目录", enabled: service?.mode === "owned", click: () => void shell.openPath(dataDir) };
  const loginSupported = app.isPackaged && ["win32", "darwin"].includes(process.platform) && !process.env.PORTABLE_EXECUTABLE_FILE;
  const desktopMenu = [
    { label: "显示豆梨", click: showWindow },
    { label: "重新连接", click: () => void connect() },
    { type: "separator" },
    { label: "关闭窗口后在托盘运行", type: "checkbox", checked: preferences.closeToTray !== false,
      enabled: !!tray, click: item => { preferences.closeToTray = item.checked; savePreferences(); } },
    { label: "登录系统时启动", type: "checkbox", enabled: loginSupported,
      checked: loginSupported && app.getLoginItemSettings().openAtLogin,
      click: item => app.setLoginItemSettings({ openAtLogin: item.checked, path: process.execPath, args: ["--hidden"] }) },
    { type: "separator" }, openData,
    { label: "选择数据目录并重启…", enabled: service?.mode === "owned" && !process.env.DOULI_DATA_DIR,
      click: () => void chooseDataDirectory() },
    { label: "打开运行日志", click: () => void shell.openPath(logs) },
    { type: "separator" }, quitItem,
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "豆梨", submenu: desktopMenu },
    { label: "编辑", submenu: [ { role: "undo", label: "撤销" }, { role: "redo", label: "重做" },
      { type: "separator" }, { role: "cut", label: "剪切" }, { role: "copy", label: "复制" },
      { role: "paste", label: "粘贴" }, { role: "selectAll", label: "全选" } ] },
    { label: "视图", submenu: [ { label: "刷新", accelerator: "CmdOrCtrl+R", click: () => window.reload() },
      { role: "resetZoom", label: "实际大小" }, { role: "zoomIn", label: "放大" }, { role: "zoomOut", label: "缩小" },
      { role: "togglefullscreen", label: "全屏" },
      ...(!app.isPackaged ? [{ role: "toggleDevTools", label: "开发者工具" }] : []) ] },
    { label: "帮助", submenu: [ { label: serviceLabel, enabled: false },
      { label: "关于豆梨", click: () => void dialog.showMessageBox(window, { type: "info", title: "关于豆梨",
        message: "豆梨桌面版 " + app.getVersion(), detail: "你的个人语音助手\n\n" + serviceLabel +
          "\n关闭窗口默认保留托盘和 ESP32 服务。\n\nElectron " + process.versions.electron }) } ] },
  ]));
  tray?.setToolTip("豆梨 · " + serviceLabel);
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: "打开豆梨", click: showWindow }, { label: serviceLabel, enabled: false },
    { type: "separator" }, openData, { label: "打开运行日志", click: () => void shell.openPath(logs) },
    { type: "separator" }, quitItem,
  ]));
}
async function start() {
  log("Electron ready; creating desktop window.");
  app.setAppUserModelId("cn.douli.desktop");
  const adminPort = port(process.env.DOULI_PORT, 8788), devicePort = port(process.env.DOULI_DEVICE_PORT, 8789);
  if (adminPort === devicePort) throw new Error("管理端口与设备端口不能相同");
  origin = "http://127.0.0.1:" + adminPort;
  dataDir = resolve(process.env.DOULI_DATA_DIR || preferences.dataDir || (app.isPackaged ? join(profile, "data") : join(root, ".data")));
  if (existsSync(join(dataDir, "douli.sqlite")) && !existsSync(join(dataDir, "local.key")))
    throw new Error("数据目录缺少 local.key 加密密钥，请从完整备份恢复。");
  mkdirSync(dataDir, { recursive: true });
  service = new DesktopService({ root, origin, adminPort, devicePort, dataDir, log });
  service.on("failed", error => void showFailure(error));
  const icon = nativeImage.createFromPath(join(root, "desktop/assets/icon.png"));
  try {
    tray = new Tray(icon.resize({ width: process.platform === "win32" ? 32 : 22 }));
    tray.on("click", showWindow);
    tray.on("double-click", showWindow);
  } catch (error) { log("Tray unavailable: " + error.message); }
  const saved = preferences.bounds;
  const visible = saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) &&
    screen.getAllDisplays().some(({ workArea: r }) => saved.x + 100 > r.x && saved.y + 100 > r.y && saved.x < r.x + r.width && saved.y < r.y + r.height);
  window = new BrowserWindow({ title: "豆梨", width: 1280, height: 850, minWidth: 840, minHeight: 600,
    ...(visible ? { x: saved.x, y: saved.y, width: Math.max(840, saved.width), height: Math.max(600, saved.height) } : {}),
    show: false, icon, backgroundColor: "#f6f5f0",
    webPreferences: { preload: join(root, "desktop/preload.cjs"), nodeIntegration: false,
      contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: false,
      backgroundThrottling: false, partition: "persist:douli" },
  });
  registerIpc();
  const contents = window.webContents, ses = contents.session;
  // Local app requests bypass OS proxies. Model requests stay in the service.
  await ses.setProxy({ mode: "direct" });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) =>
    wc === contents && isAppUrl(requestingOrigin, origin) && audioPermission(permission, details));
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(wc === contents && isAppUrl(details.requestingUrl, origin) &&
      details.isMainFrame === true && audioPermission(permission, details));
  });
  ses.on("will-download", (event, item, wc) => {
    const url = item.getURL();
    if (wc !== contents || !(isAppUrl(url, origin) || url.startsWith("blob:" + origin + "/"))) event.preventDefault();
  });
  ses.webRequest.onHeadersReceived({ urls: [origin + "/*"] }, (details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders,
      "Content-Security-Policy": ["default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' wss://api.simli.ai ws://127.0.0.1:" + adminPort + "; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-src 'none'; frame-ancestors 'none'"],
    } });
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (externalUrl(url) && !isAppUrl(url, origin)) void shell.openExternal(url);
    return { action: "deny" };
  });
  const navigate = (event, url) => {
    if (isAppUrl(url, origin)) return;
    event.preventDefault();
    if (externalUrl(url)) void shell.openExternal(url);
  };
  contents.on("will-navigate", navigate);
  contents.on("will-redirect", navigate);
  contents.on("page-title-updated", event => { event.preventDefault(); window.setTitle("豆梨"); });
  contents.on("render-process-gone", (_event, details) => void showFailure(new Error("界面已停止（" + details.reason + "），请重新连接。")));
  window.on("hide", () => contents.send("douli:background"));
  window.on("minimize", () => contents.send("douli:background"));
  window.on("close", event => {
    if (!window.isMaximized()) preferences.bounds = window.getBounds();
    preferences.maximized = window.isMaximized();
    savePreferences();
    if (!quitting && tray && preferences.closeToTray !== false) {
      event.preventDefault();
      window.hide();
      if (!preferences.trayExplained && !selfTest && process.platform === "win32") {
        tray.displayBalloon({ title: "豆梨仍在运行", content: "点击托盘图标可打开豆梨。右键选择退出可停止桌面端。", noSound: true });
        preferences.trayExplained = true; savePreferences();
      }
    } else if (!quitting) { event.preventDefault(); app.quit(); }
  });
  updateMenus();
  await window.loadFile(statusFile);
  if (preferences.maximized) window.maximize();
  if (!process.argv.includes("--hidden") || !tray) window.show();
  await connect();
  monitor = new ConnectionMonitor({
    probe: () => probeService(origin), log,
    canCheck: () => !connecting && !quitting,
    onOffline: cause => showFailure(new Error("本机服务暂时没有响应，正在自动重连。你也可以点击“重新连接”再试一次。", { cause })),
    onRecovered: async () => {
      if (await connect()) log("Service connection restored automatically.");
    },
  });
  monitor.reset({ offline: !!errorMessage });
  monitor.start();
  log("Desktop ready: " + JSON.stringify(status()));
  if (selfTest) {
    const { diagnose } = await import("./diagnostics.mjs");
    await diagnose({ app, window, service, status, connect, showWindow, tray, root, monitor });
  }
}
