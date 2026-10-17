import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../server/app.mjs";

test("mobile platform uses Android network state and protects native shutdown", async () => {
  const directory=mkdtempSync(join(tmpdir(),"douli-mobile-"));
  const previous={mobile:process.env.DOULI_MOBILE,token:process.env.DOULI_STOP_TOKEN};
  process.env.DOULI_MOBILE="1"; process.env.DOULI_STOP_TOKEN="test-local-service-token";
  let app;
  try {
    writeFileSync(join(directory,"network.json"),'["192.0.2.10"]');
    app=await createApplication({dataDir:directory,gatewayPort:18789});
    const request=(url,options={})=>app.admin.inject({url,headers:{host:"127.0.0.1:8788",...options.headers},...options});
    const state=(await request("/api/state")).json();
    assert.equal(state.platform,"android");
    assert.deepEqual(state.gatewayAddresses,["http://192.0.2.10:18789/xiaozhi/ota/"]);
    assert.equal((await request("/api/mobile/stop",{method:"POST"})).statusCode,403);
    assert.equal((await request("/api/mobile/stop",{method:"POST",headers:{host:"127.0.0.1:8788",authorization:"Bearer wrong"}})).statusCode,403);
    writeFileSync(join(directory,"network.json"),'["192.0.2.20"]');
    assert.deepEqual((await request("/api/state")).json().gatewayAddresses,["http://192.0.2.20:18789/xiaozhi/ota/"]);
    writeFileSync(join(directory,"network.json"),'invalid');
    assert.deepEqual((await request("/api/state")).json().gatewayAddresses,[]);
  } finally {
    await app?.close();
    for(const [name,value] of [["DOULI_MOBILE",previous.mobile],["DOULI_STOP_TOKEN",previous.token]]) if(value===undefined) delete process.env[name]; else process.env[name]=value;
    rmSync(directory,{recursive:true,force:true});
  }
});
