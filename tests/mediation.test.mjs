import test from "node:test";
import assert from "node:assert/strict";
import { Mediation, requestsMediation } from "../server/mediation.mjs";

const settings = { assistant: { name: "豆梨", persona: "private-persona" }, models: { daily: { baseUrl: "http://localhost/v1", model: "fixture" } } };
const speaker = id => ({ status: "matched", personId: id });

function session() {
  const room = new Mediation();
  return { room, say: (text, id, signal) => room.reply(text, settings, id ? speaker(id) : null, signal) };
}

async function ready(say) {
  for (const word of ["开始评理", "第一位同意", "第二位同意", "我们约的是七点。", "第一位确认", "我通知过你。", "第二位确认"])
    await say(word);
}

test("only a complete invitation starts a case; roles and confirmations are explicit", async () => {
  assert.equal(requestsMediation("小白，帮我们评评理！", "小白"), true);
  for (const text of ["别帮我们评理", "如果我说开始评理会怎样？", "他说帮我们评评理"])
    assert.equal(requestsMediation(text, "豆梨"), false);
  const { room, say } = session();
  await say("开始评理"); await say("第一位同意", "alice");
  assert.match(await say("第二位同意", "alice"), /第二位本人/);
  await say("第二位同意", "bob");
  assert.match(await say("不该收的原话", "bob"), /分开说/);
  assert.match(await room.reply("同时说的话", settings, { reason: "mixed_speakers" }), /归属不清/);
  await say("我说错了", "alice"); await say("我的修订", "alice");
  assert.match(await say("请判断", "alice"), /本人说“第一位确认”/);
  assert.equal(room.case.draft, "我的修订", "premature judge command must not overwrite draft statement");
  assert.match(await say("第二位确认", "bob"), /轮到第一位/);
  await say("第一位确认", "alice");
  assert.deepEqual(room.case.statements, { A: "我的修订" });
  await say("取消评理", "bob");
  assert.equal(room.active, false);
});

test("model sees only confirmed facts, must ask a named party, then can reconsider", async t => {
  const { say } = session();
  const payloads = [];
  t.mock.method(globalThis, "fetch", async (_, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.tools, undefined);
    assert.ok(!JSON.stringify(body).includes("private-persona"));
    const data = JSON.parse(body.messages[1].content);
    payloads.push(data);
    const result = payloads.length === 1 ? { kind: "question", to: "A", text: "你当时同意改约吗？" }
      : { kind: "verdict", text: "按双方确认过的新约定判断。" };
    return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
  });
  await ready(say);
  assert.equal(payloads.length, 0);
  assert.match(await say("请评理"), /请第一位补充/);
  await say("我同意改到七点半。"); await say("请评理");
  assert.equal(payloads.length, 1);
  await say("第一位确认"); assert.match(await say("请评理"), /新约定/);
  assert.deepEqual(payloads[1].clarifications, [{ to: "A", question: "你当时同意改约吗？", answer: "我同意改到七点半。" }]);
  await say("更正第二位陈述"); await say("我只发了消息，没收到回复。"); await say("第二位确认");
  await say("请评理");
  assert.deepEqual(payloads[2].statements, { A: "我们约的是七点。", B: "我只发了消息，没收到回复。" });
  assert.deepEqual(payloads[2].clarifications, []);
});

test("bad replies can be retried; an aborted or closed case cannot accept a late verdict", async t => {
  const { room, say } = session();
  await ready(say);
  let release;
  t.mock.method(globalThis, "fetch", async () => Response.json({ choices: [] }));
  assert.match(await say("请评理"), /重|再说/);
  const wait = new Promise(resolve => { release = resolve; });
  t.mock.method(globalThis, "fetch", async () => {
    await wait;
    return Response.json({ choices: [{ message: { content: '{"kind":"verdict","text":"旧结果"}' } }] });
  });
  const control = new AbortController();
  const old = say("请评理", null, control.signal);
  control.abort();
  await say("退出评理"); await say("开始评理"); release();
  await assert.rejects(old, { name: "AbortError" });
  assert.equal(room.case.phase, "consent");
});

test("safety exit and changed recipient close the case before submitting anything", async t => {
  const model = t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected model call"); });
  const { room, say } = session();
  await ready(say);
  assert.match(await say("我现在不安全"), /停止/);
  assert.equal(room.active, false);
  await ready(say);
  const changed = { ...settings, models: { daily: { ...settings.models.daily, baseUrl: "https://other.invalid/v1" } } };
  assert.match(await room.reply("请评理", changed), /接收方/);
  assert.equal(room.active, false);
  assert.equal(model.mock.callCount(), 0);
});

test("either participant can correct a statement before both statements are ready", async t => {
  const model = t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected model call"); });
  const { room, say } = session();
  await say("开始评理");
  await say("更正第二位陈述", "bob");
  assert.equal(room.case.phase, "consent", "correction cannot skip consent");
  await say("第一位同意", "alice");
  await say("第二位同意", "bob");
  await say("我们约的是七点。", "alice");
  assert.match(await say("更正第二位陈述", "alice"), /第二位本人/);
  assert.equal(room.case.draft, "我们约的是七点。");
  assert.match(await say("更正第二位陈述", "bob"), /第二位重新讲/);
  await say("第二位确认", "bob");
  assert.equal(room.case.phase, "statement", "a correction command cannot become a statement");
  await say("我记得是八点。", "bob");
  assert.match(await say("第二位确认", "bob"), /请第一位/);
  assert.deepEqual(room.case.statements, { B: "我记得是八点。" });
  await say("请评理", "bob");
  assert.equal(model.mock.callCount(), 0);
  await say("约定改到了八点。", "alice");
  await say("第一位确认", "alice");
  assert.equal(room.case.phase, "ready");
  assert.deepEqual(room.case.statements, { A: "约定改到了八点。", B: "我记得是八点。" });
});

test("correction during a clarification discards the old question and waits for confirmation", async t => {
  const { room, say } = session();
  const payloads = [];
  t.mock.method(globalThis, "fetch", async (_, options) => {
    payloads.push(JSON.parse(JSON.parse(options.body).messages[1].content));
    const result = payloads.length === 1
      ? { kind: "question", to: "A", text: "当时有答应吗？" }
      : { kind: "verdict", text: "按更正后的约定判断。" };
    return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
  });
  await ready(say);
  await say("请评理");
  await say("我需要更正最初的时间。");
  assert.match(await say("更正第一位陈述"), /第一位重新讲/);
  await say("第一位确认");
  assert.equal(room.case.phase, "statement");
  await say("最初约定是八点。");
  await say("第一位确认");
  await say("请评理");
  assert.deepEqual(payloads[1].statements, { A: "最初约定是八点。", B: "我通知过你。" });
  assert.deepEqual(payloads[1].clarifications, []);
});
