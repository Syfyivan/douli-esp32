// Host smoke test of the mobile entrypoint, not an Android/hardware acceptance test.
// Run --launch, then --verify from a separate shell after the launcher exits.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, openSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
const root=resolve(import.meta.dirname,"..");
const dir=join(root,".runtime/android/host-smoke");
const url="http://127.0.0.1:18888";
mkdirSync(dir,{recursive:true});
if(process.argv.includes("--launch")) {
  if(await fetch(url+"/api/health").then(()=>true).catch(()=>false)) throw new Error("Smoke port already occupied");
  const token=randomBytes(32).toString("hex");
  writeFileSync(join(dir,"network.json"),'["192.0.2.10"]');
  const child=spawn(process.execPath,[join(root,"server/mobile.mjs")],{
    cwd:root,detached:true,windowsHide:true,
    env:{...process.env,DOULI_MOBILE:"1",DOULI_DATA_DIR:dir,DOULI_PORT:"18888",DOULI_DEVICE_PORT:"18889",DOULI_STOP_TOKEN:token},
    stdio:["ignore",openSync(join(dir,"stdout.log"),"w"),openSync(join(dir,"stderr.log"),"w")],
  }); child.unref();
  writeFileSync(join(dir,"process.json"),JSON.stringify({pid:child.pid,token,startedAt:new Date().toISOString()}));
  console.log(`Independent mobile-entry smoke process launched: ${child.pid}. Verify from another shell.`);
} else if(process.argv.includes("--verify")) {
  const state=JSON.parse(readFileSync(join(dir,"process.json")));
  const health=await fetch(url+"/api/health").then(r=>r.json()); assert.equal(health.ok,true);
  const snapshot=await fetch(url+"/api/state").then(r=>r.json()); assert.equal(snapshot.platform,"android");
  assert.deepEqual(snapshot.gatewayAddresses,["http://192.0.2.10:18889/xiaozhi/ota/"]);
  assert.equal((await fetch("http://127.0.0.1:18889/health").then(r=>r.json())).ok,true);
  assert.equal((await fetch(url+"/api/mobile/stop",{method:"POST"})).status,403);
  assert.equal((await fetch(url+"/api/mobile/stop",{method:"POST",headers:{Authorization:`Bearer ${state.token}`}})).status,200);
  let stopped=false;
  for(let i=0;i<30;i++) { await new Promise(r=>setTimeout(r,100)); if(!await fetch(url+"/api/health").then(()=>true).catch(()=>false)) {stopped=true;break;} }
  assert.equal(stopped,true);
  writeFileSync(join(dir,"result.json"),JSON.stringify({ok:true,checkedAt:new Date().toISOString(),scope:"Windows host only; mobile entrypoint survives launcher exit, isolated storage and shutdown checked"},null,2));
  console.log("Host smoke passed: detached startup, both ports, Android address feed, authenticated shutdown. Android device verification remains separate.");
} else throw new Error("Use --launch or --verify");
