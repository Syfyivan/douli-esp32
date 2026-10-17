import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Store } from "../server/store.mjs";
import { HealthStore, factData } from "../server/health-store.mjs";
import { SyncStore } from "../server/sync-store.mjs";
import { encryptSync, decryptSync } from "../server/sync-service.mjs";
import { Discovery, dnsAnswer, readQuestions } from "../server/discovery.mjs";
import { createApplication } from "../server/app.mjs";

function pair(t) {
  const dirs=[mkdtempSync(join(tmpdir(),"douli-sync-a-")),mkdtempSync(join(tmpdir(),"douli-sync-b-"))];
  const stores=dirs.map(d=>new Store(d)),vaults=stores.map(s=>new HealthStore(s)),replicas=stores.map(s=>new SyncStore(s));
  t.after(()=>{stores.forEach(s=>s.close());dirs.forEach(d=>rmSync(d,{recursive:true,force:true}));});
  return {stores,vaults,replicas};
}
test("encrypted transport rejects wrong keys, tampering and cross-protocol use",()=>{
  const key=randomBytes(32).toString("base64url"),box=encryptSync({secret:"private-health"},key);
  assert.ok(!JSON.stringify(box).includes("private-health"));
  assert.equal(decryptSync(box,key).secret,"private-health");
  assert.throws(()=>decryptSync(box,randomBytes(32).toString("base64url")));
  assert.throws(()=>decryptSync(box,key,"pair-request"));
  assert.throws(()=>decryptSync({...box,tag:randomBytes(16).toString("base64")},key));
});
test("chat, confirmed health data and model keys replicate under independent local keys",t=>{
  const {stores:[a,b],vaults:[va,vb],replicas:[sa,sb]}=pair(t);
  const session=a.session(),message=a.message(session.id,"user","cross-device-message");
  const settings=a.settings();settings.models.daily.apiKey="private-key";a.saveSettings(settings);
  const fact=va.put("fact",factData({kind:"allergy",name:"private-allergy",confirmed:true}));
  sb.apply(sa.snapshot());
  assert.equal(b.messages(session.id)[0].id,message.id);assert.equal(b.settings().models.daily.apiKey,"private-key");
  assert.equal(vb.get(fact.id).name,"private-allergy");assert.ok(!a.key.equals(b.key));
  assert.notEqual(a.db.prepare("SELECT payload FROM health_records WHERE id=?").get(fact.id).payload,b.db.prepare("SELECT payload FROM health_records WHERE id=?").get(fact.id).payload);
  va.remove(fact.id,fact.revision);sb.apply(sa.snapshot());assert.equal(vb.get(fact.id),null);
});
test("concurrent edits converge and parent deletion cannot resurrect chat children",t=>{
  const {stores:[a,b],replicas:[sa,sb]}=pair(t);
  const session=a.session(),message=a.message(session.id,"user","first");sb.apply(sa.snapshot());
  a.db.prepare("UPDATE messages SET text=? WHERE id=?").run("edited-a",message.id);
  b.db.prepare("UPDATE messages SET text=? WHERE id=?").run("edited-b",message.id);
  const left=sa.snapshot(),right=sb.snapshot();sa.apply(right);sb.apply(left);
  assert.equal(a.messages(session.id)[0].text,b.messages(session.id)[0].text);
  a.db.prepare("DELETE FROM sessions WHERE id=?").run(session.id);
  b.message(session.id,"user","offline child");
  sb.apply(sa.snapshot());sa.apply(sb.snapshot());
  assert.equal(a.db.prepare("SELECT COUNT(*) n FROM messages").get().n,0);
  assert.equal(b.db.prepare("SELECT COUNT(*) n FROM messages").get().n,0);
});
test("remote health edits invalidate a locally opened form even at the same revision", t => {
  const { vaults: [va, vb], replicas: [sa, sb] } = pair(t);
  const first = va.put("fact", factData({ kind: "allergy", name: "A", confirmed: true }));
  sb.apply(sa.snapshot());
  const opened = vb.get(first.id);
  va.put("fact", factData({ kind: "allergy", name: "B", confirmed: true }), first.id, first.revision);
  sb.apply(sa.snapshot());
  assert.throws(() => vb.put("fact", factData({ kind: "allergy", name: "stale", confirmed: true }), opened.id, opened.revision), /更新|修改/);
  assert.equal(vb.get(first.id).name, "B");
});
test("metadata sync preserves summaries, while remote forgetting clears local derived evidence", t => {
  const { stores: [a,b], replicas: [sa,sb] } = pair(t);
  const session=a.session(),message=a.message(session.id,"user","fictional evidence");sb.apply(sa.snapshot());
  b.db.prepare("INSERT INTO memory_summaries VALUES (?,?,?,?,?,?,?)").run("test-summary","day",session.id,"2026-10-15","fictional summary","hash",new Date().toISOString());
  b.db.prepare("INSERT INTO summary_sources VALUES (?,?)").run("test-summary",message.id);
  a.db.prepare("UPDATE messages SET metadata=? WHERE id=?").run('{"test":true}',message.id);sb.apply(sa.snapshot());
  assert.equal(b.db.prepare("SELECT COUNT(*) n FROM memory_summaries").get().n,1);
  a.db.prepare("INSERT INTO memory_exclusions VALUES (?)").run(message.id);sb.apply(sa.snapshot());
  assert.equal(b.db.prepare("SELECT COUNT(*) n FROM memory_summaries").get().n,0);
});
test("signed discovery selects available host and rejects forged beacons",()=>{
  const args={group:"group",key:"private",address:"127.0.0.1",hostname:"douli-test.local"};
  const phone=new Discovery({...args,id:"11111111-1111-1111-1111-111111111111",priority:10});
  const computer=new Discovery({...args,id:"22222222-2222-2222-2222-222222222222",priority:20});
  phone.receive(computer.packet(),{address:"127.0.0.2"});assert.equal(phone.leader(),computer.id);
  phone.peers.get(computer.id).seen=Date.now()-10000;assert.equal(phone.leader(),phone.id);
  phone.receive(Buffer.from('{"body":"forged","mac":"bad"}'),{address:"127.0.0.3"});assert.equal(phone.peers.size,1);
  assert.deepEqual(readQuestions(Buffer.alloc(2)),[]);assert.ok(dnsAnswer("douli-test.local","127.0.0.1").length>20);
});
test("two real HTTP hosts pair once and synchronize encrypted health originals in both directions",async t=>{
  const dirs=[mkdtempSync(join(tmpdir(),"douli-host-a-")),mkdtempSync(join(tmpdir(),"douli-host-b-"))];
  const apps=[];
  t.after(async()=>{for(const app of apps)await app.close();dirs.forEach(d=>rmSync(d,{recursive:true,force:true}));});
  for(const dir of dirs){const app=await createApplication({dataDir:dir});apps.push(app);app.sync.useDiscovery=false;app.sync.addresses=()=>["127.0.0.1"];
    await app.device.listen({port:0,host:"127.0.0.1"});app.sync.port=app.device.server.address().port;}
  const [a,b]=apps;
  const primary=a.store.settings();primary.models.daily.apiKey="inviter-key";a.store.saveSettings(primary);
  for(let n=0;n<4;n++) b.store.saveSettings(b.store.settings());
  const fact=a.health.vault.put("fact",factData({kind:"condition",name:"fictional-condition",confirmed:true}));
  const document=a.health.vault.put("report",{title:"test",confirmed:false,observations:[]});
  a.health.vault.saveFile(document.id,{name:"test.pdf",mime:"application/pdf",base64:Buffer.from("%PDF-1.7 test-original").toString("base64")});
  const invite=a.sync.invite();await b.sync.join(invite.invitation);
  assert.equal(b.store.settings().models.daily.apiKey,"inviter-key");
  assert.equal(b.health.vault.get(fact.id).name,"fictional-condition");
  assert.equal(b.health.vault.file(document.id).base64,a.health.vault.file(document.id).base64);
  await assert.rejects(()=>b.sync.join(invite.invitation),/未接受配对/);
  const second=b.health.vault.put("fact",factData({kind:"allergy",name:"second-fact",confirmed:true}));
  await b.sync.tick();assert.equal(a.health.vault.get(second.id).name,"second-fact");
  const invalid=await a.device.inject({method:"POST",url:"/douli/sync",payload:{v:1,data:"bad"}});assert.equal(invalid.statusCode,409);
});
