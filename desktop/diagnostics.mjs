// Opt-in acceptance runner, always invoked with a dedicated temporary profile.
// No remote debugging endpoint or arbitrary renderer IPC is exposed.
import assert from "node:assert/strict";
import { writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export async function diagnose({ app, window, service, status, connect, showWindow, tray, root, monitor }) {
  const profile = app.getPath("userData"), report = join(profile, "result.json");
  const checks = [], mode = process.env.DOULI_DESKTOP_TEST_MODE || "owned";
  const check = (name, value) => { assert.ok(value, name); checks.push(name); };
  const evaluate = code => window.webContents.executeJavaScript(code, true);
  async function capture() {
    for (let attempt = 0; ; attempt++) {
      try { return (await window.webContents.capturePage()).toPNG(); }
      catch (error) {
        if (error.message !== "UnknownVizError" || attempt >= 2) throw error;
        await delay(300);
      }
    }
  }
  async function until(code) {
    for (let i = 0; i < 80; i++) { if (await evaluate(code)) return; await delay(100); }
    throw new Error("Renderer condition timed out: " + code);
  }
  try {
    check("isolated profile", existsSync(join(profile, "self-test-marker")) &&
      resolve(service.dataDir) === resolve(profile, "data"));
    if (mode === "conflict" || mode === "device-conflict") {
      check("conflict shown", !!status().error);
      check("local recovery screen", window.webContents.getURL().startsWith("file:"));
      check("retry available", await evaluate("!document.querySelector('#actions').hidden"));
      check("no owned child left", !service.child);
    } else {
      check("expected service ownership", status().mode === mode);
      await until("document.querySelectorAll('.sidebar nav button').length === 4");
      check("renderer isolated", await evaluate("typeof require === 'undefined' && typeof process === 'undefined' && !!window.douliDesktop"));
      check("preload bridge restricted", await evaluate("Object.keys(window.douliDesktop).sort().join(',') === 'getStatus,onBackground,openLogs,retry'"));
      const prefs = window.webContents.getLastWebPreferences();
      check("sandbox and isolation", prefs.sandbox && prefs.contextIsolation && !prefs.nodeIntegration && prefs.webSecurity);
      check("tray available", !!tray && !tray.isDestroyed());
      if (mode === "owned") {
        const { diagnoseUi } = await import("./ui-diagnostics.mjs");
        await diagnoseUi({ window, profile, check, evaluate, until });
      }
      for (const label of ["我的助手", "我的资料", "设置", "对话记录"]) {
        await evaluate(`Array.from(document.querySelectorAll('.sidebar nav button')).find(b => b.textContent === ${JSON.stringify(label)}).click()`);
        await until(`document.querySelector('main header').textContent.includes(${JSON.stringify(label)})`);
        await delay(180);
        check("page: " + label, await evaluate("!document.querySelector('.loading')"));
      }
      await evaluate("document.querySelectorAll('.sidebar nav button')[2].click()");
      await until("document.querySelectorAll('.profile-tabs button').length === 3");
      check("profile groups memory experiences and health", await evaluate("Array.from(document.querySelectorAll('.profile-tabs button')).map(b=>b.textContent).join(',') === '偏好与记忆,近期经历,健康资料'"));
      await evaluate("document.querySelectorAll('.profile-tabs button')[2].click()");
      await until("!!document.querySelector('.health-collection')");
      check("health opens as a document collection", await evaluate("!document.body.textContent.includes('说说你想了解的问题') && !document.querySelector('.health-page textarea')"));
      await evaluate("document.querySelectorAll('.sidebar nav button')[3].click()");
      await until("!!document.querySelector('.settings-nav')");
      await evaluate("Array.from(document.querySelectorAll('.settings-nav button')).find(b=>b.textContent==='功能显示').click()");
      await until("!!document.querySelector('.module-layout input[type=checkbox]')");
      await evaluate("document.querySelector('.module-layout input[type=checkbox]').click()");
      await until("document.querySelectorAll('.sidebar nav button').length === 5");
      check("devices are explicitly enabled", await evaluate("JSON.parse(localStorage.getItem('douli.desktop.ui.v1')).showDevices === true"));
      await window.reload();
      await until("document.querySelectorAll('.sidebar nav button').length === 5");
      check("module visibility survives reload", true);
      await evaluate("document.querySelectorAll('.sidebar nav button')[3].click()");
      await until("document.querySelector('main header').textContent.includes('设备与家居')");
      check("optional devices page remains accessible", true);
      await evaluate("document.querySelectorAll('.sidebar nav button')[4].click()");
      await until("!!document.querySelector('.settings-nav')");
      await evaluate("Array.from(document.querySelectorAll('.settings-nav button')).find(b=>b.textContent==='功能显示').click()");
      await until("!!document.querySelector('.module-layout input[type=checkbox]')");
      await evaluate("document.querySelector('.module-layout input[type=checkbox]').click()");
      await until("document.querySelectorAll('.sidebar nav button').length === 4");
      check("hiding devices preserves service", (await fetch(service.origin + "/api/health").then(r => r.json())).ok);
      // Real SQLite, encryption, HTTP and UI rendering; cloud output is not tested.
      await evaluate(`fetch('/api/preferences', {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({id:'desktop-acceptance',name:'桌面验收',value:'持久化检查'})}).then(r=>{if(!r.ok)throw Error('write failed')})`);
      await window.reload();
      await until("document.querySelectorAll('.sidebar nav button').length === 4");
      check("SQLite data survives reload", await evaluate("fetch('/api/state').then(r=>r.json()).then(s=>s.preferences.some(p=>p.id==='desktop-acceptance'))"));
      check("camera denied", await evaluate("navigator.mediaDevices.getUserMedia({video:true}).then(s=>{s.getTracks().forEach(t=>t.stop());return false},e=>e.name==='NotAllowedError')"));
      // Exercise a real Chromium media stream with its synthetic audio source.
      check("audio request allowed", await evaluate("navigator.mediaDevices.getUserMedia({audio:true}).then(s=>{s.getTracks().forEach(t=>t.stop());return true},e=>({error:e.name,message:e.message}))").then(value => value === true));
      const { codec } = await import("../server/audio.mjs");
      const opus = codec();
      try { check("bundled Opus codec", opus.decode(opus.encode(Buffer.alloc(640), 320)).length === 640); }
      finally { opus.delete(); }
      await evaluate(`fetch('/api/settings', {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({privacy:{autoMemory:false},models:Object.fromEntries(['daily','asr','tts'].map(k=>[k,{baseUrl:location.origin+'/acceptance-only',model:'acceptance'}]))})})`);
      const loaded = new Promise(resolve => window.webContents.once("did-finish-load", resolve));
      window.reload(); await loaded;
      await until("document.querySelectorAll('.sidebar nav button').length === 4");
      await evaluate(`window.acceptanceTracks=[];const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async c=>{const s=await original(c);window.acceptanceTracks.push(...s.getTracks());return s;};Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='电脑语音').click()`);
      await until("document.body.textContent.includes('正在听你说')");
      check("voice WebSocket and AudioWorklet active", await evaluate("window.acceptanceTracks.some(t=>t.readyState==='live')"));
      window.close(); await delay(350);
      check("close hides to tray", !window.isDestroyed() && !window.isVisible());
      await until("window.acceptanceTracks.every(t=>t.readyState==='ended')");
      check("hiding ends microphone stream", true);
      check("service survives hidden window", (await fetch(service.origin + "/api/health").then(r => r.json())).ok);
      showWindow(); await delay(250);
      check("tray restores window", window.isVisible());
      let secondInstance = false;
      app.once("second-instance", () => { secondInstance = true; });
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.DOULI_DESKTOP_SELF_TEST;
      const second = spawn(process.execPath, app.isPackaged ? [] : [root], { env, windowsHide: true, stdio: "ignore" });
      await new Promise((resolve, reject) => { second.once("exit", resolve); second.once("error", reject); setTimeout(() => reject(new Error("Second instance did not exit")), 10000).unref(); });
      check("single instance focuses existing app", secondInstance);
      if (mode === "owned") {
        const originalPid = service.child.pid;
        await connect();
        check("reconnect preserves running owned service", service.child.pid === originalPid && status().mode === "owned");
        service.child.kill();
        for (let i = 0; i < 50 && !status().error; i++) await delay(100);
        check("service crash shown", !!status().error);
        await connect();
        await until("document.querySelectorAll('.sidebar nav button').length === 4");
        check("service restarts", status().mode === "owned" && !status().error);
        check("data survives service restart", await evaluate("fetch('/api/state').then(r=>r.json()).then(s=>s.preferences.some(p=>p.id==='desktop-acceptance'))"));
      }
      if (mode === "attached") {
        const control = async action => {
          const response = await fetch(process.env.DOULI_DESKTOP_TEST_CONTROL + action, { method: "POST", signal: AbortSignal.timeout(10000) });
          assert.ok(response.ok, "acceptance control: " + action);
        };
        await evaluate("window.connectionAcceptanceMarker = 'preserved'");
        await control("/health-error"); await monitor.check();
        check("transient health failure preserves page", !status().error && await evaluate("window.connectionAcceptanceMarker === 'preserved'"));
        await control("/healthy"); await monitor.check();
        check("transient recovery does not reload page", !status().error && await evaluate("window.connectionAcceptanceMarker === 'preserved'"));
        await control("/stop");
        for (let i = 0; i < 3; i++) await monitor.check();
        check("sustained disconnection shows recovery page", !!status().error && window.webContents.getURL().startsWith("file:"));
        await connect();
        check("retry never replaces stopped external service", status().mode === "attached" && !service.child && !!status().error);
        await control("/start");
        // Exercise the real timer, without clicking retry or invoking connect.
        for (let i = 0; i < 150 && status().error; i++) await delay(100);
        await until("document.querySelectorAll('.sidebar nav button').length === 4");
        check("external restart automatically restores UI", status().mode === "attached" && !service.child && !status().error);
        check("external data survives automatic recovery", await evaluate("fetch('/api/state').then(r=>r.json()).then(s=>s.preferences.some(p=>p.id==='desktop-acceptance'))"));
      }
      await delay(200);
      writeFileSync(join(profile, "desktop.png"), await capture());
      await evaluate("fetch('/api/preferences/desktop-acceptance', {method:'DELETE'})");
    }
    writeFileSync(report, JSON.stringify({ ok: true, mode, checks, state: status(), electron: process.versions.electron, node: process.versions.node }, null, 2));
  } catch (error) {
    const page = await evaluate("document.body.innerText").catch(() => "unavailable");
    await capture().then(png => writeFileSync(join(profile, "failure.png"), png)).catch(() => {});
    writeFileSync(report, JSON.stringify({ ok: false, mode, checks, error: error.stack, page, state: status() }, null, 2));
  } finally { app.quit(); }
}
