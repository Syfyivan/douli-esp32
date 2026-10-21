import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { createApplication } from "../server/app.mjs";
import { VoiceConnection } from "../server/gateway.mjs";
import { identifySpeaker, asrCorpus } from "../server/volcengine-asr.mjs";
import { correctAssistantAddress, processInput, applyDictionary } from "../server/input.mjs";
import { defaults } from "../server/config.mjs";
import { voiceprintIdentifier } from "../server/people.mjs";

async function fixture(t, remote = false) {
  const dir = mkdtempSync(join(tmpdir(), "douli-people-"));
  const app = await createApplication({ dataDir: dir, remoteAccess: remote ? { enabled: true, origin: "https://fixture.invalid", port: 0 } : null });
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const request = async (id, url, method = "GET", payload) => {
    const response = await app.admin.inject({ url: "/api" + url, method, payload, headers: { host: "localhost", "x-douli-person": id } });
    assert.equal(response.statusCode, 200, response.body); return response.json();
  };
  return { app, dir, request };
}

test("concurrent personal routes isolate preferences, history, health and downloads; legacy stays intact", async t => {
  const { app, request } = await fixture(t);
  const old = app.store.session(); app.store.message(old.id, "user", "legacy-only");
  const a = app.people.create("我"), b = app.people.create("女朋友");
  await Promise.all([request(a.id, "/preferences", "PUT", { name: "口味", value: "A-only" }), request(b.id, "/preferences", "PUT", { name: "口味", value: "B-only" })]);
  const [sa, sb, sr] = await Promise.all([request(a.id, "/state"), request(b.id, "/state"), request("", "/state")]);
  assert.deepEqual(sa.preferences.map(p => p.value), ["A-only"]);
  assert.deepEqual(sb.preferences.map(p => p.value), ["B-only"]);
  assert.equal(sr.preferences.length, 0); assert.equal(sa.people.selectedId, a.id);
  await request(a.id, "/medical/facts", "PUT", { kind: "allergy", name: "A-private", confirmed: true });
  const exported = await request(a.id, "/medical/export");
  assert.equal(exported.facts[0].name, "A-private");
  assert.equal((await request(b.id, "/medical/export")).facts.length, 0);
  assert.equal((await request("", "/medical/export")).facts.length, 0);
  const session = await request(a.id, "/sessions", "POST", {});
  const bundle = app.people.bundle(a.id), message = bundle.store.message(session.id, "user", "A-history-only");
  bundle.store.saveAudio(message.id, Buffer.from("private-audio"));
  const audio = await app.admin.inject({ url: `/api/messages/${message.id}/audio?person=${a.id}`, headers: { host: "localhost" } });
  assert.equal(audio.body, "private-audio");
  assert.equal((await app.admin.inject({ url: `/api/messages/${message.id}/audio?person=${b.id}`, headers: { host: "localhost" } })).statusCode, 404);
  assert.ok(JSON.stringify(await request(a.id, `/sessions/${session.id}/export`)).includes("A-history-only"));
  const denied = await app.admin.inject({ url: `/api/sessions/${session.id}/export`, headers: { host: "localhost", "x-douli-person": b.id } });
  assert.equal(denied.statusCode, 400); assert.ok(!denied.body.includes("A-history-only"));
  assert.ok(!JSON.stringify(await request(b.id, "/memory/history?q=A-history-only")).includes("A-history-only"));
  assert.equal((await request("", `/sessions/${old.id}`)).messages[0].text, "legacy-only");
  assert.ok(!app.people.voiceContext().includes("A-only"));
  assert.equal((await app.admin.inject({ url: "/api/state", headers: { host: "localhost", "x-douli-person": "../" } })).statusCode, 404);
});

test("enrollment requires consent, shares only expiring audio, cleans up on failure, and unlinks deleted voices", async t => {
  const { app, dir } = await fixture(t, true);
  const person = app.people.create("我");
  const settings = app.store.settings(); settings.models.streamingAsr.apiKey = "fixture-only"; app.store.saveSettings(settings);
  const input = { consent: true, pcm: Buffer.alloc(320000).toString("base64") };
  await assert.rejects(app.people.enroll(person.id, { ...input, consent: false }), /本人/);
  let path, failed = false;
  app.people.fetcher = async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith("CreateVoiceprintGroup")) return Response.json({ Result: { Code: 1000, GroupID: "fixture-group" } });
    if (body.Action === 2) return Response.json({ Result: { Code: 1000 } });
    path = new URL(body.AudioUrl).pathname;
    assert.equal(body.GroupId, "fixture-group");
    assert.equal(body.SpeakerName, "douli_" + person.id);
    const audio = await app.remote.inject({ url: path });
    assert.equal(audio.statusCode, 200); assert.equal(audio.rawPayload.length, 320044);
    assert.equal((await app.remote.inject({ url: "/api/state" })).statusCode, 401);
    if (failed) throw new Error("fixture-provider-failure");
    return Response.json({ Result: { Code: 1000, SpeakID: "fixture-voice" } });
  };
  await app.people.enroll(person.id, input);
  assert.equal(app.people.state().people[0].enrolled, true);
  assert.equal((await app.remote.inject({ url: path })).statusCode, 401);
  assert.equal(app.people.audio.size, 0);
  const files = readdirSync(dir, { recursive: true });
  assert.ok(!files.some(f => /\.(wav|pcm|mp3)$/.test(f)));
  failed = true; await assert.rejects(app.people.enroll(person.id, input), /fixture-provider-failure/);
  assert.equal(app.people.audio.size, 0); assert.equal(app.people.enrolling.size, 0);
  await app.people.removeVoice(person.id);
  assert.equal(app.people.voiceBundle({ status: "matched", personId: person.id }), null);
  assert.equal(app.store.settings().people.voiceIdentification, false);
  const token = "f".repeat(64); app.people.audio.set(token, { pcm: Buffer.alloc(32), expires: Date.now() - 1 });
  assert.equal((await app.remote.inject({ url: `/voiceprint-audio/${token}.wav` })).statusCode, 401);
});

test("voiceprint IDs accept live and documented spellings, and reject malformed or conflicting IDs", () => {
  for (const field of ["GroupID", "GroupId"]) assert.equal(voiceprintIdentifier({ [field]: "group" }, "group"), "group");
  for (const field of ["SpeakID", "SpeakId"]) assert.equal(voiceprintIdentifier({ [field]: "voice" }, "voice"), "voice");
  for (const result of [{}, { GroupID: 123 }, { GroupID: " " }, { GroupID: "a", GroupId: "b" }, { GroupID: "a".repeat(151) }])
    assert.throws(() => voiceprintIdentifier(result, "group"), /声纹组编号/);
  assert.equal(voiceprintIdentifier({}, "voice", "existing"), "existing");
  assert.equal(voiceprintIdentifier({ SpeakID: "new" }, "voice", "existing"), "new");
  assert.throws(() => voiceprintIdentifier({ SpeakID: "" }, "voice", "existing"), /声纹编号/);
});

test("final voice identity must match one registered person; anonymous, short or conflicting speech is unknown", () => {
  const s = structuredClone(defaults);
  s.people = { voiceIdentification: true, groupId: "g", members: [{ personId: "a", voiceName: "douli_a", voiceId: "v_a" }, { personId: "b", voiceName: "douli_b", voiceId: "v_b" }] };
  const result = (...ids) => ({ utterances: ids.map(speaker_id => ({ text: "测试", speaker_id })) });
  assert.equal(identifySpeaker(result("douli_a", "v_a"), s, 64000).personId, "a");
  for (const value of [result("0"), result("douli_a", "douli_b"), result("douli_a", undefined), {}])
    assert.equal(identifySpeaker(value, s, 64000).status, "unknown");
  assert.equal(identifySpeaker(result("douli_a"), s, 1000).status, "unknown");
  // Observed SAUC final-packet layout: additions.speaker_id, not the root.
  const actual = { utterances: [{ text: "测试", definite: true, additions: { source: "two_pass", speaker_id: "douli_a" } }] };
  assert.equal(identifySpeaker(actual, s, 64000).personId, "a");
  actual.utterances[0].additions = JSON.stringify({ speaker_id: "v_b" });
  assert.equal(identifySpeaker(actual, s, 64000).personId, "b");
  actual.utterances[0].additions = { speaker_id: "0" };
  assert.equal(identifySpeaker(actual, s, 64000).reason, "unmatched_voice");
  actual.utterances[0].additions = { speaker_id: "douli_b" }; actual.utterances[0].speaker_id = "douli_a";
  assert.equal(identifySpeaker(actual, s, 64000).reason, "conflicting_speaker_ids");
});

test("short-audio score responses identify registered members while rejecting low, tied and inconsistent matches", () => {
  const settings = { people: { voiceIdentification: true, members: [
    { personId: "a", voiceId: "v_a", voiceName: "douli_a" },
    { personId: "b", voiceId: "v_b", voiceName: "douli_b" },
  ] } };
  const match = (name, similarity) => ({ id: `v_${name}`, name: `douli_${name}`, similarity });
  const utterance = (...matches) => ({ text: "test only", additions: { speaker_id: "0", source: "two_pass" }, attributes: { voiceprint_matches: matches } });
  const identify = (...utterances) => identifySpeaker({ utterances }, settings, 160000);
  assert.equal(identify(utterance(match("b", 0.12), match("a", 0.78))).personId, "a");
  assert.equal(identify(utterance(match("a", 0.11), match("b", 0.8))).personId, "b");
  assert.equal(identify(utterance(match("a", 0.49), match("b", 0.1))).reason, "low_voiceprint_similarity");
  assert.equal(identify(utterance(match("a", 0.8), match("b", 0.75))).reason, "ambiguous_voiceprint");
  assert.equal(identify(utterance(match("outsider", 0.9), match("a", 0.78))).reason, "unmatched_voice");
  assert.equal(identify(utterance({ id: "v_a", name: "douli_b", similarity: 0.9 })).reason, "unmatched_voice");
  for (const score of [NaN, Infinity, "0.9", null, 90, -2])
    assert.equal(identify(utterance(match("a", score))).reason, "invalid_voiceprint_matches");
  const named = utterance(match("b", 0.85)); named.additions.speaker_id = "douli_a";
  assert.equal(identify(named).reason, "conflicting_speaker_ids");
  const serialized = utterance(match("a", 0.8)); serialized.attributes = JSON.stringify(serialized.attributes);
  assert.equal(identify(serialized).personId, "a");
  assert.equal(identify(utterance(match("a", 0.8)), utterance(match("b", 0.9))).reason, "mixed_speakers");
  assert.equal(identifySpeaker({ utterances: [utterance(match("a", 0.9))] }, settings, 16000).reason, "short_audio");
});

test("shared speaker answers unknown speakers without personal context, tools or persistence, and still routes known speakers", async t => {
  const { app } = await fixture(t);
  const a = app.people.create("我"), b = app.people.create("女朋友");
  for (const p of [a, b]) app.store.db.prepare("UPDATE people SET voice_id=?,voice_name=? WHERE id=?").run("v_" + p.id, "douli_" + p.id, p.id);
  const settings = app.store.settings(); settings.input.vad = "energy"; settings.people.voiceIdentification = true;
  settings.assistant.persona = "ROOT_PRIVATE_SENTINEL";
  settings.models.daily.baseUrl = settings.models.tts.baseUrl = "https://fixture.invalid";
  settings.models.daily.model = "fixture-chat"; settings.models.tts.model = "fixture-tts"; app.store.saveSettings(settings);
  const spoken = [];
  const guestRequests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith("/audio/speech")) { spoken.push(body.input); return new Response(Buffer.alloc(960)); }
    assert.ok(url.endsWith("/chat/completions"));
    guestRequests.push(body);
    if (!body.stream) return Response.json({ choices: [{ message: { content: '{"end":false}' } }] });
    return new Response('data: {"choices":[{"delta":{"content":"已收到你的话，可以继续聊。"}}]}\n\ndata: [DONE]\n\n');
  });
  app.store.db.prepare("INSERT INTO devices (id,name,approved,token,metadata) VALUES ('fixture','fixture',1,'fixture','{}')").run();
  const device = app.store.db.prepare("SELECT * FROM devices WHERE id='fixture'").get();
  const socket = new EventEmitter(), sent = [];
  Object.assign(socket, { readyState: WebSocket.OPEN, send: value => { if (typeof value === "string") sent.push(JSON.parse(value)); }, close() { this.readyState = WebSocket.CLOSED; this.emit("close"); }, ping() {} });
  const connection = new VoiceConnection(app.gateway, socket, { device });
  t.after(() => socket.close());
  t.mock.method(app.engine, "run", () => { throw new Error("Unknown speaker must never reach the legacy engine"); });
  t.mock.method(connection, "requestVision", () => { throw new Error("Unknown speaker must not request a camera frame"); });
  const calls = [];
  for (const person of [a, b]) app.people.bundle(person.id).engine.run = async input => {
    calls.push({ id: person.id, input });
    const store = app.people.bundle(person.id).store;
    const message = store.message(input.sessionId, "user", input.text);
    input.emit({ type: "done", message }); return { farewell: false };
  };
  await connection.process(null, "first-unknown-private", null, { status: "unknown" });
  assert.equal(app.store.db.prepare("SELECT count(*) AS n FROM sessions").get().n, 0, "a guest turn does not create a legacy session");
  connection.requestVision.mock.restore();
  for (const person of [a, b]) {
    await connection.process(null, person.name + "的偏好", null, { status: "matched", method: "voiceprint", personId: person.id });
    await connection.process(null, "unknown-after-" + person.id, null, { status: "unknown" });
  }
  await connection.process(null, "unknown-private-utterance", null, { status: "unknown" });
  assert.deepEqual(calls.map(c => c.id), [a.id, b.id]);
  assert.notEqual(calls[0].input.sessionId, calls[1].input.sessionId);
  assert.equal(app.store.db.prepare("SELECT count(*) AS n FROM messages").get().n, 0);
  for (const person of [a, b]) assert.ok(!JSON.stringify(app.people.bundle(person.id).store.sessions()).includes("unknown-private"));
  assert.ok(sent.some(e => e.type === "speaker" && e.status === "unknown"));
  assert.equal(spoken.length, 4, "every unknown turn receives an ordinary spoken answer");
  assert.ok(spoken.every(text => text === "已收到你的话，可以继续聊。"));
  assert.equal(connection.lastSpeaker.status, "unknown");
  assert.equal(connection.lastSpeaker.responseMode, "guest");
  assert.ok(!JSON.stringify(connection.lastSpeaker).includes("unknown-private-utterance"));
  assert.ok(!connection.asrContext().includes("偏好"));
  assert.equal(connection.turns.get(connection.call.turnId).generated, true);
  assert.equal(connection.call.output, "idle", "listen again after the complete reply");
  const replyCount = spoken.length;
  for (let i = 0; i < 3; i++) await connection.process(null, "more unknown input", null, { status: "unknown" });
  assert.equal(spoken.length, replyCount + 3, "guest conversation remains available throughout the wake session");
  assert.equal(calls.length, 2, "guest replies never reach another person's engine");
  t.mock.method(app.gateway.greetingAudio, "source", () => ({ audio: [], cacheHit: true }));
  await connection.greet();
  await connection.process(null, "unknown after next wake", null, { status: "unknown" });
  assert.equal(spoken.length, replyCount + 4);
  assert.equal(guestRequests.filter(r => r.stream).length, spoken.length);
  assert.equal(guestRequests.filter(r => !r.stream).length, spoken.length + calls.length);
  for (const request of guestRequests) {
    assert.equal(request.tools, undefined);
    assert.equal(request.messages.length, 2, "only a public system prompt and the current utterance are sent");
    assert.equal(request.messages[1].role, "user");
    const system = request.messages[0].content;
    assert.ok(!system.includes("ROOT_PRIVATE_SENTINEL"));
    assert.ok(!system.includes("的偏好"));
    assert.ok(!system.includes("unknown-private"));
  }
  const beforeFarewell = spoken.length;
  await connection.process(null, "再见，老李。", null, { status: "unknown" });
  assert.equal(connection.conversationEnded, true);
  assert.equal(spoken.length, beforeFarewell, "farewell ends without calling the guest model");
  assert.equal(app.store.db.prepare("SELECT count(*) AS n FROM messages").get().n, 0);
  for (const person of [a, b]) {
    const personal = app.people.bundle(person.id).store;
    assert.deepEqual(personal.db.prepare("SELECT text FROM messages").all().map(m => m.text), [person.name + "的偏好"]);
    assert.equal(personal.db.prepare("SELECT count(*) AS n FROM memories").get().n, 0);
  }
});

test("assistant correction only changes direct voice addresses and corpus retains correct terms", async t => {
  const { app } = await fixture(t);
  const settings = app.store.settings(); settings.input.refine = false; app.store.saveSettings(settings);
  assert.equal(correctAssistantAddress("再见，老李。", settings), "再见，豆梨。");
  assert.equal(correctAssistantAddress("老李，帮我记一下", settings), "豆梨，帮我记一下");
  for (const text of ["我朋友老李今天来", "他说：再见，老李。", "“你好老李”是他说的", "老李今天吃了2片药"])
    assert.equal(correctAssistantAddress(text, settings), text);
  assert.equal((await processInput(app.store, "你好老李", "", null)).text, "你好老李");
  assert.equal((await processInput(app.store, "你好老李", "", null, { voice: true })).text, "你好，豆梨");
  const dictionary = [{ phrase: "老李", replacement: "豆梨", status: "active", scope: "assistant_address" }];
  assert.equal(applyDictionary("我朋友老李", dictionary, { voice: true }), "我朋友老李");
  const corpus = JSON.parse(asrCorpus(settings, JSON.stringify({ vocabulary: ["豆梨", "树莓派"], recent: [{ text: "旧" }, { text: "新" }] })).context);
  assert.deepEqual(corpus.hotwords, [{ word: "豆梨" }, { word: "树莓派" }]);
  assert.equal(corpus.context_data[1].text, "新");
});

test("voiceprint identification cannot open the encrypted health vault", async t => {
  const { app } = await fixture(t);
  const person = app.people.create("我"), bundle = app.people.bundle(person.id);
  const settings = app.store.settings(); settings.input.refine = false; app.store.saveSettings(settings);
  bundle.health.consult = async () => { throw new Error("Must not read personal health records"); };
  const result = await bundle.engine.run({ text: "帮我看一下我的检查报告", route: "health", speaker: { method: "voiceprint", personId: person.id }, outputMode: "voice" });
  assert.ok(result.text.includes("页面选择自己的档案"));
  assert.ok(!bundle.store.messages(result.session.id).some(m => m.text.includes("帮我看一下")));
});
