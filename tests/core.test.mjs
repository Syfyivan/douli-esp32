import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../server/store.mjs";
import {
  defaults,
  mergeSettings,
  validateSettings,
} from "../server/config.mjs";
import {
  codec,
  rms,
  wav,
  resample,
  packAudio,
  unpackAudio,
  UtteranceBuffer,
} from "../server/audio.mjs";
import {
  applyDictionary,
  validateRefinement,
  recordCorrection,
} from "../server/input.mjs";
import { putMemory, retrieveMemories } from "../server/memory.mjs";
import { HomeService } from "../server/home.mjs";
import { requestsAction } from "../server/engine.mjs";

export function fixture(t) {
  const root = resolve(tmpdir()),
    dir = mkdtempSync(join(root, "douli-test-"));
  const store = new Store(dir);
  t.after(() => {
    if (!store.closed) store.close();
    if (
      !resolve(dir).startsWith(root + "\\") &&
      !resolve(dir).startsWith(root + "/")
    )
      throw new Error("Unsafe test cleanup");
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, dir };
}
const sound = (ms, amplitude = 8000) => {
  const pcm = Buffer.alloc(ms * 32);
  for (let i = 0; i < pcm.length / 2; i++)
    pcm.writeInt16LE(
      Math.round(Math.sin((i * Math.PI * 2 * 220) / 16000) * amplitude),
      i * 2,
    );
  return pcm;
};

test("Opus and v1/v2/v3 preserve playable audio, malformed framing is rejected", () => {
  const c = codec();
  try {
    const encoded = Buffer.from(c.encode(sound(20), 320));
    for (const version of [1, 2, 3])
      assert.deepEqual(
        unpackAudio(packAudio(encoded, version), version),
        encoded,
      );
    const decoded = Buffer.from(c.decode(encoded));
    assert.equal(decoded.length, 640);
    assert.ok(rms(decoded) > 0.01);
    assert.throws(() => unpackAudio(Buffer.alloc(10), 2));
    assert.throws(() => unpackAudio(Buffer.from([0, 0, 0, 4, 1]), 3));
  } finally {
    c.delete();
  }
  const pcm = sound(200);
  assert.equal(wav(pcm).readUInt32LE(24), 16000);
  assert.equal(resample(pcm, 16000, 24000).length, 9600);
});
test("endpointing accepts short utterances and manual mode retains speech across pauses", () => {
  const a = new UtteranceBuffer(defaults.input);
  assert.equal(a.push(sound(200)), null);
  const ready = a.push(sound(900, 0));
  assert.ok(ready.length > 0);
  const manual = new UtteranceBuffer(defaults.input);
  manual.push(sound(200), false);
  assert.equal(manual.push(sound(900, 0), false), null);
  assert.ok(manual.finish().length > 0);
  const quiet = new UtteranceBuffer(defaults.input);
  quiet.push(sound(50));
  quiet.push(sound(900, 0));
  assert.equal(quiet.finish(), null);
});
test("settings survive restart, secrets are encrypted and blank public output is safe", (t) => {
  const { store, dir } = fixture(t);
  const s = mergeSettings(defaults, {
    models: {
      daily: {
        apiKey: "secret-test-key",
        model: "test",
        baseUrl: "http://localhost:4321/v1",
      },
    },
  });
  store.saveSettings(s);
  assert.equal(store.publicSettings().models.daily.apiKey, "");
  assert.equal(store.publicSettings().models.daily.hasKey, true);
  assert.ok(
    !store.db
      .prepare("SELECT value FROM settings")
      .get()
      .value.includes("secret-test-key"),
  );
  store.close();
  const reopened = new Store(dir);
  assert.equal(reopened.settings().models.daily.apiKey, "secret-test-key");
  reopened.close();
  assert.throws(() =>
    validateSettings(
      mergeSettings(defaults, { assistant: { night: { volume: 9 } } }),
    ),
  );
});
test("input guards protect negation and numbers; dictionary suggestions require approval", (t) => {
  const { store } = fixture(t);
  assert.equal(
    validateRefinement(
      "我不想吃药，明天8点再说",
      "我想吃药，明天8点再说",
      "conversation",
    ),
    false,
  );
  assert.equal(
    validateRefinement("明天18点", "明天8点", "conversation"),
    false,
  );
  const entries = [
    { phrase: "cat", replacement: "猫", status: "active" },
    { phrase: "豆粒", replacement: "豆梨", status: "suggested" },
  ];
  assert.equal(
    applyDictionary("cat category 豆粒", entries),
    "猫 category 豆粒",
  );
  const session = store.session();
  const message = store.message(session.id, "user", "你好豆粒，我今天很开心");
  putMemory(store, { name: "状态", value: "今天开心", sourceId: message.id });
  assert.deepEqual(
    recordCorrection(store, message.id, "你好豆梨，我今天很开心"),
    { phrase: "豆粒", replacement: "豆梨" },
  );
  assert.equal(store.all("dictionary")[0].status, "suggested");
  assert.equal(store.all("memories")[0].status, "needs_review");
  assert.equal(
    store.messages(session.id)[0].raw_text,
    "你好豆粒，我今天很开心",
  );
});
test("memory conflicts do not silently overwrite and pinned evidence is retrieved", (t) => {
  const { store } = fixture(t);
  const a = putMemory(store, { name: "饮食", value: "不吃香菜", pinned: true });
  const b = putMemory(store, { name: "饮食", value: "喜欢香菜" });
  assert.equal(b.status, "conflict");
  assert.equal(retrieveMemories(store, "今天星期几")[0].id, a.id);
  putMemory(store, { ...b, status: "active", replace: true });
  assert.equal(
    store.all("memories").find((m) => m.id === a.id).status,
    "superseded",
  );
});
test("automation persists cooldown, ignores stale sensors and respects disable", async (t) => {
  const { store } = fixture(t);
  const home = new HomeService(store);
  let runs = 0;
  home.execute = async () => {
    runs++;
  };
  store.db
    .prepare("INSERT INTO actions VALUES (?,?,?,?)")
    .run(
      "light-off",
      "关灯",
      store.seal({ type: "http", url: "http://localhost/off" }),
      new Date().toISOString(),
    );
  store.db
    .prepare("INSERT INTO sensors VALUES (?,?,?,?,?)")
    .run("lux", "照度", "lux", 1, new Date().toISOString());
  const config = {
    type: "sensor",
    sensorId: "lux",
    operator: "below",
    threshold: 10,
    actionId: "light-off",
    cooldownSeconds: 300,
  };
  const id = home.saveRule({ name: "暗了关灯", enabled: false, config });
  await home.tick();
  assert.equal(runs, 0);
  home.saveRule({ id, name: "暗了关灯", enabled: true, config });
  await home.tick();
  await home.tick();
  assert.equal(runs, 1);
  await home.tick(new Date(Date.now() + 400000));
  assert.equal(runs, 1);
});
test("questions about switches and negated commands cannot actuate a device", () => {
  for (const text of [
    "关于智能家居你知道什么",
    "如何关闭灯",
    "不要关灯",
    "我不打算关闭空调",
  ])
    assert.equal(requestsAction(text), false);
  assert.equal(requestsAction("小智，帮我关灯"), true);
  assert.equal(requestsAction("请打开床头灯"), true);
});
test("repeated inferred facts stay one suggestion and corrected evidence invalidates pinned facts", (t) => {
  const { store } = fixture(t);
  const session = store.session();
  const source = store.message(session.id, "user", "我不吃香菜");
  const input = {
    name: "饮食偏好",
    value: "不吃香菜",
    quote: "我不吃香菜",
    sourceId: source.id,
    status: "suggested",
  };
  const one = putMemory(store, input),
    two = putMemory(store, input);
  assert.equal(one.id, two.id);
  assert.equal(store.all("memories").length, 1);
  putMemory(store, { ...one, status: "active", pinned: true });
  recordCorrection(store, source.id, "我喜欢吃香菜");
  assert.equal(store.all("memories")[0].status, "needs_review");
  assert.equal(retrieveMemories(store, "香菜").length, 0);
});
