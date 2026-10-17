// Local design export only. Does not connect to the running application or service.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

app.setPath('userData', path.join(os.tmpdir(), 'douli-design-v3-render'));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('disable-gpu');
const pages = [
  ['chat', '01-history.png'], ['assistant', '02-assistant.png'],
  ['memory', '03-profile-memory.png'], ['memory/experiences', '04-profile-experiences.png'],
  ['memory/health', '05-profile-health.png'], ['settings', '06-settings.png'],
  ['settings/modules', '07-settings-modules.png'],
];
const audit = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1440, height: 960, useContentSize: true,
    show: false, frame: false,
    webPreferences: {
      offscreen: true, nodeIntegration: false,
      contextIsolation: true, sandbox: true, backgroundThrottling: false,
    },
  });
  window.webContents.on('console-message', (_event, details) => {
    if (details.level === 'error') process.stderr.write(details.message + '\n');
  });
  for (const [page, file] of pages) {
    await window.loadFile(path.join(__dirname, 'preview.html'), { hash: page });
    await window.webContents.executeJavaScript("showDevices=false; localStorage.removeItem('douli-design-v3-devices'); render()");
    if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 960, deviceScaleFactor: 2, mobile: false,
    });
    await window.webContents.executeJavaScript('document.fonts.ready');
    await wait(350);
    await window.webContents.executeJavaScript('window.scrollTo(0,0);document.querySelector(".content")?.scrollTo(0,0)');
    const layout = await window.webContents.executeJavaScript(
      '(' + (() => {
        const page = document.querySelector('.desktop').dataset.page;
        const content = document.querySelector('.content');
        const overflow = [...document.querySelectorAll('main *')].filter(el => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 &&
            (rect.right > innerWidth + 2 || rect.bottom > innerHeight + 2);
        }).map(el => ({
          tag: el.tagName, class: el.className?.baseVal ?? el.className,
          text: el.textContent?.slice(0, 45),
        }));
        return {
          page, viewport: [innerWidth, innerHeight],
          route: location.hash,
          view: document.querySelector('.desktop').dataset.view,
          scrollTop: content?.scrollTop ?? 0,
          navigation: document.querySelectorAll('.nav [data-nav]').length,
          activeNavigation: document.querySelector('.nav .active')?.dataset.nav,
          contentScroll: content ? [content.clientHeight, content.scrollHeight] : null,
          overflow,
        };
      }).toString() + ')()'
    );
    const screenshot = await window.webContents.debugger.sendCommand('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true, fromSurface: true,
    });
    const png = Buffer.from(screenshot.data, 'base64');
    fs.writeFileSync(path.join(__dirname, file), png);
    audit.push({ ...layout, file, pixels: { width: png.readUInt32BE(16), height: png.readUInt32BE(20) } });
  }
  // Verify all tabs through the same sidebar the reviewer will use.
  for (const page of ['chat','assistant','memory','settings']) {
    await window.webContents.executeJavaScript(
      'document.querySelector(\'button[data-nav="' + page + '"]\').click()'
    );
    await wait(30);
    const active = await window.webContents.executeJavaScript(
      'document.querySelector(".desktop").dataset.page'
    );
    if (active !== page) throw new Error('Navigation failed: ' + page);
  }
  await window.webContents.executeJavaScript("location.hash='memory'");
  await wait(30);
  for (const view of ['memory/experiences','memory/health','memory']) {
    await window.webContents.executeJavaScript('document.querySelector(\'.profile-tabs [data-go="' + view + '"]\').click()');
    await wait(30);
    const current = await window.webContents.executeJavaScript('location.hash.slice(1)');
    if (current !== view) throw new Error('Profile tab failed: ' + view);
  }
  await window.webContents.executeJavaScript("location.hash='settings/modules'");
  await wait(30);
  for (const enabled of [true,false]) {
    await window.webContents.executeJavaScript('document.getElementById("devices-toggle").click()');
    const result = await window.webContents.executeJavaScript(
      '({visible:!!document.querySelector(".nav [data-nav=devices]"),saved:localStorage.getItem("douli-design-v3-devices")})'
    );
    if (result.visible !== enabled || result.saved !== String(enabled)) throw new Error('Device visibility preference failed');
  }
  await window.webContents.reload();
  await new Promise(resolve=>window.webContents.once('did-finish-load',resolve));
  const persisted = await window.webContents.executeJavaScript('!!document.querySelector(".nav [data-nav=devices]")');
  if (persisted) throw new Error('Hidden preference not restored');
  fs.writeFileSync(path.join(__dirname, 'render-audit.json'), JSON.stringify(audit, null, 2));
  window.destroy();
  app.quit();
}).catch(error => {
  process.stderr.write(error.stack + '\n');
  app.exit(1);
});
