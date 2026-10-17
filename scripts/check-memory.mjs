// Live model check in an isolated temporary database. Does not add fictional facts to the user's data.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import assert from "node:assert/strict";
import { Store } from "../server/store.mjs";
import {
  extractMemory,
  putMemory,
  retrieveMemories,
} from "../server/memory.mjs";
import { HomeService } from "../server/home.mjs";
import { ChatEngine } from "../server/engine.mjs";
const actual = new Store(resolve(".data")),
  settings = actual.settings();
actual.close();
const root = resolve(".runtime"),
  directory = mkdtempSync(join(root, "memory-check-"));
let store = new Store(directory);
try {
  store.saveSettings(settings);
  const session = store.session();
  const user = store.message(
    session.id,
    "user",
    "我的名字是小南。我不吃香菜。",
  );
  await extractMemory(store, user, AbortSignal.timeout(30000));
  const suggested = store.all("memories");
  assert.ok(suggested.length > 0, "The model did not extract facts");
  assert.ok(
    suggested.every(
      (m) => m.status === "suggested" && user.text.includes(m.quote),
    ),
  );
  for (const item of suggested) putMemory(store, { ...item, status: "active" });
  store.close();
  store = new Store(directory);
  assert.ok(
    retrieveMemories(store, "饮食偏好香菜").some((m) =>
      m.value.includes("香菜"),
    ),
  );
  const config = store.settings();
  config.privacy.autoMemory = false;
  store.saveSettings(config);
  const engine = new ChatEngine(store, new HomeService(store));
  const response = await engine.run({
    text: "我的饮食偏好是什么？请只用一句话回答。",
  });
  assert.match(response.text, /香菜/);
  assert.match(response.text, /不/);
  const report = {
    isolated: true,
    extracted: suggested.length,
    evidenceQuotesVerified: true,
    persistedAfterReopen: true,
    answer: response.text,
    checkedAt: new Date().toISOString(),
  };
  writeFileSync(
    join(root, "memory-check.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  store.close();
  if (!resolve(directory).startsWith(root + sep))
    throw new Error("Unsafe cleanup path");
  rmSync(directory, { recursive: true, force: true });
}
