import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.mjs";
import { HealthStore, factData, reportData } from "../server/health-store.mjs";
import { HealthService, verifyAnswer, redactQuery, medicationChecks } from "../server/health-service.mjs";
import { HealthEvidence } from "../server/health-evidence.mjs";
import { createApplication } from "../server/app.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "douli-health-"));
  const store = new Store(dir);
  t.after(() => { if (!store.closed) store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, dir, vault: new HealthStore(store) };
}
const report = (date, observations, confirmed = true) => reportData({ title: "检查报告", date, observations }, confirmed);
const source = { id: "pubmed-123", title: "Example paper", text: "Laboratory reference ranges can vary between different laboratories.", url: "https://pubmed.ncbi.nlm.nih.gov/123/" };
const answer = citations => JSON.stringify({ spoken: "先核对本次参考范围。", explanation: "应结合报告本身解释。[pubmed-123]", nextSteps: ["核对原件"], questions: [], urgency: "routine", citations });

test("urgent triage returns before retrieval; medication checks preserve unknowns", async t => {
  const { store } = fixture(t);
  const health = new HealthService(store, { model: async () => JSON.stringify({ zh: "胸痛", en: "chest pain", drugs: [], urgent: true }) });
  health.evidence.search = async () => { throw new Error("Emergency must not wait for retrieval"); };
  const result = await health.consult({ question: "当前危险症状测试" });
  assert.equal(result.answer.urgency, "emergency");
  assert.equal(result.answer.citations.length, 0);
  assert.equal(result.evidence.searchedAt, null);
  const check = medicationChecks([
    { factType: "medication", status: "active", name: "A", ingredients: "成分甲、成分乙" },
    { factType: "medication", status: "active", name: "B", ingredients: "成分甲" },
    { factType: "medication", status: "stopped", name: "C", ingredients: "成分乙" },
  ]);
  assert.deepEqual(check.repeatedIngredients, [{ ingredient: "成分甲", medicines: ["A", "B"] }]);
  assert.ok(check.missing[0].fields.includes("规格"));
});

test("health records and original attachments are encrypted, revisions prevent lost updates", t => {
  const { store, dir, vault } = fixture(t);
  assert.throws(() => factData({ kind: "allergy", name: "private-allergy" }), /确认/);
  const saved = vault.put("fact", factData({ kind: "allergy", name: "private-allergy", detail: "private-history", confirmed: true }));
  assert.equal(saved.factType, "allergy");
  assert.throws(() => vault.put("fact", saved, saved.id, 0), /已更新/);
  const document = vault.put("report", report("2026-10-15", [], false));
  vault.saveFile(document.id, { name: "private-report.pdf", mime: "application/pdf", base64: Buffer.from("%PDF-1.7 private-file-content").toString("base64") });
  assert.equal(vault.file(document.id).name, "private-report.pdf");
  assert.throws(() => vault.saveFile(document.id, { name: "x.pdf", mime: "application/pdf", base64: Buffer.from("not really a pdf file").toString("base64") }), /类型不符/);
  for (const row of store.db.prepare("SELECT payload FROM health_records UNION ALL SELECT payload FROM health_files").all()) assert.ok(!row.payload.includes("private"));
  store.close();
  const raw = readFileSync(join(dir, "douli.sqlite"));
  for (const marker of ["private-allergy", "private-history", "private-report", "private-file-content"]) assert.equal(raw.includes(Buffer.from(marker)), false);
  const reopened = new Store(dir);
  assert.equal(new HealthStore(reopened).get(saved.id).name, "private-allergy");
  reopened.close();
});

test("unconfirmed or uncertain reports cannot enter medical context; trends keep units and specimens separate", t => {
  const { vault } = fixture(t);
  const draft = vault.put("report", report("", [{ name: "钾", value: "4.1", unit: "mmol/L", uncertain: true }], false));
  assert.throws(() => vault.context([draft.id]), /核对/);
  assert.throws(() => reportData({ ...draft, date: "2026-02-30" }, true), /日期/);
  assert.throws(() => reportData({ ...draft, date: "2026-02-20" }, true), /不确定/);
  vault.put("report", report("2026-09-10", [{ name: "葡萄糖", value: "5.2", unit: "mmol/L", specimen: "血清", reference: "3.9–6.1" }]));
  vault.put("report", report("2026-10-10", [{ name: "葡萄糖", value: "6.0", unit: "mmol/L", specimen: "血清", reference: "4.1–5.9" }, { name: "葡萄糖", value: "108", unit: "mg/dL", specimen: "血清" }, { name: "葡萄糖", value: "<2", unit: "mmol/L", specimen: "尿液" }]));
  const trends = vault.trends(); assert.equal(trends.length, 2);
  assert.equal(trends.find(g => g.unit === "mmol/L").points.length, 2);
  assert.equal(trends.find(g => g.unit === "mmol/L").points[1].reference, "4.1–5.9");
});

test("references must match actual source excerpts; absent evidence is visible", () => {
  const good = verifyAnswer(answer([{ sourceId: source.id, excerpt: "reference ranges can vary", claim: "参考范围可能不同" }]), [source]);
  assert.equal(good.citations.length, 1);
  const bad = verifyAnswer(answer([{ sourceId: source.id, excerpt: "You can double your medicine dose", claim: "加量" }, { sourceId: "invented", excerpt: "x" }]), [source]);
  assert.equal(bad.citations.length, 0); assert.ok(bad.citationWarnings.length); assert.ok(bad.explanation.includes("来源未核实"));
  assert.ok(!redactQuery("姓名：张三 电话：13800138000 邮箱 me@example.com 病历号：123456789 血糖高").includes("13800138000"));
});

test("PubMed adapter parses abstracts and excludes retracted publications", async t => {
  const { vault } = fixture(t); let calls = 0;
  const evidence = new HealthEvidence(vault, { fetcher: async url => {
    calls++;
    if (String(url).includes("esearch")) return new Response(JSON.stringify({ esearchresult: { idlist: ["123", "456"] } }));
    return new Response(`<PubmedArticleSet>${[123,456].map(id => `<PubmedArticle><MedlineCitation><PMID>${id}</PMID><Article><ArticleTitle>Test</ArticleTitle><Abstract><AbstractText Label="METHODS">Real abstract ${id}</AbstractText></Abstract><PublicationTypeList><PublicationType>${id === 456 ? "Retracted Publication" : "Review"}</PublicationType></PublicationTypeList></Article></MedlineCitation></PubmedArticle>`).join("")}</PubmedArticleSet>`);
  } });
  const result = await evidence.pubmed("glucose", AbortSignal.timeout(3000));
  assert.equal(calls, 2); assert.equal(result.length, 1); assert.equal(result[0].pmid, "123"); assert.equal(result[0].coverage, "abstract");
});

test("consultation uses confirmed health context and sends only topic plan to evidence providers", async t => {
  const { store } = fixture(t); const calls = [];
  const service = new HealthService(store, { model: async (profile, messages) => {
    calls.push(messages);
    if (messages[0].content.includes("转换为查资料")) return JSON.stringify({ zh: "血糖 检查", en: "blood glucose", drugs: [] });
    return answer([{ sourceId: source.id, excerpt: "reference ranges can vary", claim: "参考范围可能不同" }]);
  } });
  service.vault.put("fact", factData({ kind: "allergy", name: "private-allergy", confirmed: true }));
  let outgoing;
  service.evidence.search = async plan => { outgoing = JSON.stringify(plan); return { sources: [source], services: [], searchedAt: new Date().toISOString() }; };
  const result = await service.consult({ question: "我的血糖报告怎么看" }, AbortSignal.timeout(5000));
  assert.equal(result.answer.citations.length, 1);
  assert.ok(calls[1][1].content.includes("private-allergy"));
  assert.ok(!outgoing.includes("private-allergy"));
  assert.ok(!calls[0][1].content.includes("private-allergy"));
  assert.equal(service.vault.list("consultation").length, 1);
});

test("medical API is localhost only and browser/voice engine stores no plaintext health turn", async t => {
  const dir = mkdtempSync(join(tmpdir(), "douli-health-api-"));
  const app = await createApplication({ dataDir: dir });
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal((await app.admin.inject({ url: "/api/medical/state", remoteAddress: "192.168.0.2" })).statusCode, 403);
  const result = await app.admin.inject({ method: "POST", url: "/api/medical/reports", payload: { title: "手动报告" } });
  assert.equal(result.statusCode, 200);
  const events = [];
  app.health.model = async (p, messages) => messages[0].content.includes("转换为查资料") ? JSON.stringify({ zh: "症状", en: "symptom", drugs: [] }) : answer([]);
  app.health.evidence.search = async () => ({ sources: [], services: [], searchedAt: new Date().toISOString() });
  const turn = await app.engine.run({ text: "我的私人症状-private-test", route: "health", emit: e => events.push(e) });
  assert.ok(events.some(e => e.type === "done" && e.message.metadata.health));
  assert.ok(!JSON.stringify(app.store.db.prepare("SELECT * FROM messages").all()).includes("private-test"));
  const history = (await app.admin.inject({ url: "/api/sessions/" + turn.session.id })).json();
  assert.ok(history.messages.some(m => m.text.includes("private-test")));
  const privateMessage = history.messages.find(m => m.role === "user");
  assert.equal((await app.admin.inject({ method: "POST", url: "/api/messages/" + privateMessage.id + "/correction", payload: { text: "private-correction" } })).statusCode, 409);
  assert.ok(!JSON.stringify(app.store.db.prepare("SELECT * FROM messages").all()).includes("private-correction"));
  assert.equal(app.store.db.prepare("SELECT COUNT(*) AS n FROM memory_jobs").get().n, 0);
});
