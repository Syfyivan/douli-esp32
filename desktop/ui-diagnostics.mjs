import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Called only by the opt-in acceptance runner with an isolated profile.
export async function diagnoseUi({ window, profile, check, evaluate, until }) {
  const click = (text, selector = "button") => evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`);
  const fill = (selector, value) => evaluate(`(() => {const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const capture = async name => { await evaluate("document.querySelector('.toast button')?.click()"); await delay(200); writeFileSync(join(profile, name + ".png"), (await window.webContents.capturePage()).toPNG()); };
  const noOverflow = async name => check("layout: " + name, await evaluate("document.documentElement.scrollWidth <= innerWidth + 1"));
  await until("document.querySelector('.thread-heading h1')?.textContent.includes('验收数据')");
  check("archive opens existing speaker conversation without composer", await evaluate("!document.querySelector('.composer') && document.querySelectorAll('.message').length===3 && document.querySelector('.thread-heading').textContent.includes('音箱')"));
  check("conversation export contains original transcript", await evaluate("fetch(document.querySelector('.conversation-top a').href).then(r=>r.text()).then(s=>s.includes('拖了很久'))"));
  await capture("01-history"); await noOverflow("history desktop");
  await fill('[aria-label="搜索对话"]', "公园");
  await until("document.querySelectorAll('.session-list>button').length===1 && document.querySelector('.session-list').textContent.includes('公园')");
  check("archive search matches message text", true);
  await fill('[aria-label="搜索对话"]', "");
  await click("继续文字对话"); await until("!!document.querySelector('.composer')");
  await click("收起输入"); await until("!document.querySelector('.composer')");
  check("optional composer opens and collapses", true);
  await click("我的助手", ".sidebar nav button");
  await until("!!document.querySelector('.assistant-preview')");
  await capture("02-assistant"); await noOverflow("assistant desktop");
  await fill('[aria-label="自定义语气"]', "验收语气");
  await click("保存偏好");
  await until("document.querySelector('.toast')?.textContent.includes('助手偏好已保存')");
  check("assistant edits persist", await evaluate("fetch('/api/state').then(r=>r.json()).then(s=>s.settings.assistant.tone==='验收语气')"));
  await click("我的资料", ".sidebar nav button");
  await until("!!document.querySelector('.pending-item')");
  await capture("03-memory"); await noOverflow("memory desktop");
  await click("确认记住", ".pending-item button");
  await until("!document.querySelector('.pending-item') && document.querySelector('.saved-memory-list').textContent.includes('一个已完成的小目标')");
  check("candidate moves to confirmed only after explicit click", true);
  await click("添加记忆");
  await fill('.memory-editor input[name="name"]', "界面保存检查");
  await fill('.memory-editor textarea[name="value"]', "通过新布局添加的记忆");
  await click("保存记忆");
  await until("!document.querySelector('.memory-editor') && document.querySelector('.saved-memory-list').textContent.includes('界面保存检查')");
  check("manual memory persists", true);
  await click("近期经历", ".profile-tabs button");
  await until("!!document.querySelector('.experience-entry')");
  await click("查看原话与来源");
  await until("!!document.querySelector('.experience-entry blockquote')");
  await capture("04-experiences");
  await click("打开原对话");
  await until("document.querySelector('.thread-heading h1')?.textContent.includes('验收数据')");
  check("experience source opens its original conversation", true);
  await click("我的资料", ".sidebar nav button");
  await click("健康资料", ".profile-tabs button");
  await until("!!document.querySelector('.health-collection')");
  await capture("05-health"); await noOverflow("health desktop");
  await click("查看", ".document-row button");
  await until("document.querySelector('.health-page input') && document.body.textContent.includes('核对报告')");
  await evaluate("(() => {const el=Array.from(document.querySelectorAll('.health-page label')).find(l=>l.textContent.includes('报告名称')).querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'已修改的验收报告');el.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await until("document.body.textContent.includes('保存为待核对草稿')");
  await click("保存为待核对草稿");
  await until("!document.querySelector('.health-note')");
  await click("资料概览", ".health-tabs button");
  await until("document.querySelector('.document-row')?.textContent.includes('已修改的验收报告') && document.querySelector('.document-row')?.textContent.includes('待核对')");
  check("editing report invalidates confirmation and persists draft", true);
  await click("设置", ".sidebar nav button");
  await until("!!document.querySelector('.model-status-grid')");
  await capture("06-settings"); await noOverflow("settings desktop");
  for (const label of ["声音与语音", "个人词典", "记录与隐私", "同步与备份", "桌面偏好", "运行记录", "功能显示"]) {
    await click(label, ".settings-nav button");
    await delay(80);
    check("settings category: " + label, await evaluate("!!document.querySelector('.settings-content .card')"));
  }
  await capture("07-modules");
  // Exercise the narrower Electron window without claiming phone or OS acceptance.
  window.setContentSize(840, 640); await delay(150);
  await noOverflow("modules at 840px");
  await click("我的资料", ".sidebar nav button"); await delay(100);
  await noOverflow("profile at 840px"); await capture("08-compact-profile");
  window.setContentSize(1280, 800); await delay(100);
  await click("对话记录", ".sidebar nav button");
}
