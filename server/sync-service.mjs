import { randomBytes, randomUUID, createCipheriv, createDecipheriv, hkdfSync } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { SyncStore, newer } from "./sync-store.mjs";
import { Discovery } from "./discovery.mjs";

const privateIp = ip => /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|127\.)/.test(ip) && ip.split(".").length === 4 && ip.split(".").every(v => /^\d{1,3}$/.test(v) && Number(v) < 256);
const keyFor = (secret, purpose) => Buffer.from(hkdfSync("sha256", Buffer.from(secret, "base64url"), Buffer.from("douli-sync-v1"), Buffer.from(purpose), 32));
export function encryptSync(value, secret, purpose = "exchange") {
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", keyFor(secret,purpose), nonce);
  cipher.setAAD(Buffer.from(purpose));
  const data = Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(value)))), cipher.final()]);
  return { v:1, nonce:nonce.toString("base64"), tag:cipher.getAuthTag().toString("base64"), data:data.toString("base64") };
}
export function decryptSync(box, secret, purpose = "exchange") {
  if (box?.v !== 1 || typeof box.data !== "string" || box.data.length > 32*1024*1024 ||
    typeof box.nonce !== "string" || typeof box.tag !== "string") throw new Error("无效同步密文");
  const nonce=Buffer.from(box.nonce,"base64"), tag=Buffer.from(box.tag,"base64");
  if(nonce.length!==12 || tag.length!==16) throw new Error("无效同步密文");
  const decipher=createDecipheriv("aes-256-gcm",keyFor(secret,purpose),nonce); decipher.setAAD(Buffer.from(purpose)); decipher.setAuthTag(tag);
  const data=Buffer.concat([decipher.update(Buffer.from(box.data,"base64")),decipher.final()]);
  return JSON.parse(gunzipSync(data,{maxOutputLength:128*1024*1024}).toString());
}
const validId = value => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);

export class SyncService {
  constructor(store, { addresses, port=8789, onChange=()=>{}, discovery=true } = {}) {
    this.store=store; this.replica=new SyncStore(store); this.addresses=addresses; this.port=port; this.onChange=onChange;
    this.useDiscovery=discovery; this.peers=new Map(); this.replays=new Map(); this.pendingInvite=null; this.closed=false; this.errors=[];
  }
  status() {
    const config=this.replica.config();
    return { enabled:!!config, nodeId:this.replica.id, name:config?.name || (process.env.DOULI_MOBILE==="1" ? "我的手机" : "我的电脑"),
      hostname:config?.hostname, priority:config?.priority, address:this.addresses?.().find(privateIp), port:this.port,
      leader:this.discovery?.leader(), discovery:!!this.discovery, ready:this.ready(),
      peers:[...this.peers.values()].map(p=>({id:p.id,name:p.name || p.id.slice(0,8),address:p.address,lastSync:p.lastSync,error:p.error,online:Date.now()-(p.seen||0)<15000})),
      errors:this.errors.slice(-3), scope:["聊天记录","已确认和待确认记忆","健康档案与报告原件","模型与语音设置","ESP32配对"],
      inviteUntil:this.pendingInvite?.expires || null };
  }
  ready() {
    const config=this.replica.config(); const model=this.store.settings().models.daily;
    return !!config && config.initialSync!==false && !!model.baseUrl && !!model.model;
  }
  ensureConfig() {
    let config=this.replica.config();
    if (!config) {
      const group=randomUUID();
      config={group,key:randomBytes(32).toString("base64url"),hostname:`douli-${group.slice(0,8)}.local`,
        priority:process.env.DOULI_MOBILE==="1" ? 10 : 20,name:process.env.DOULI_MOBILE==="1" ? "我的手机" : "我的电脑",peers:[],initialSync:true};
      this.replica.config(config);
    }
    return config;
  }
  invite() {
    const address=this.addresses?.().find(privateIp); if(!address) throw new Error("未找到局域网地址，请连接与手机相同的网络");
    this.ensureConfig(); const token=randomBytes(32).toString("base64url");
    this.pendingInvite={token,expires:Date.now()+10*60*1000}; void this.refreshDiscovery();
    return { invitation:Buffer.from(JSON.stringify({v:1,address,port:this.port,token,expires:this.pendingInvite.expires})).toString("base64url"), expires:this.pendingInvite.expires };
  }
  acceptPair(box, address) {
    if(!this.pendingInvite || this.pendingInvite.expires<Date.now() || !privateIp(address)) throw new Error("配对已过期，请在电脑重新生成");
    const secret=this.pendingInvite.token;
    const input=decryptSync(box,secret,"pair-request");
    if(!validId(input.id) || input.id===this.replica.id || !Number.isInteger(input.port) || input.port<1024 || input.port>65535) throw new Error("配对请求无效");
    const config=this.ensureConfig(); this.rememberPeer({id:input.id,address,port:input.port,name:String(input.name||"另一台设备").slice(0,50)});
    this.pendingInvite=null;
    return encryptSync({id:this.replica.id,group:config.group,key:config.key,hostname:config.hostname,name:config.name},secret,"pair-response");
  }
  async join(invitation) {
    if(typeof invitation!=="string" || invitation.length>3000) throw new Error("配对信息无效");
    const value=JSON.parse(Buffer.from(invitation.trim(),"base64url").toString());
    if(value.v!==1 || !privateIp(value.address) || !Number.isInteger(value.port) || value.port<1024 || value.port>65535 ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.token) || !Number.isFinite(value.expires) || value.expires<Date.now()) throw new Error("配对信息无效或已过期");
    const name=process.env.DOULI_MOBILE==="1" ? "我的手机" : "我的电脑";
    const response=await fetch(`http://${value.address}:${value.port}/douli/pair`,{method:"POST",redirect:"error",headers:{"Content-Type":"application/json"},
      body:JSON.stringify(encryptSync({id:this.replica.id,port:this.port,name},value.token,"pair-request")),signal:AbortSignal.timeout(20000)});
    if(!response.ok) throw new Error("另一台设备未接受配对，请检查地址和配对有效期");
    const paired=decryptSync(await response.json(),value.token,"pair-response");
    if(!validId(paired.id) || !validId(paired.group) || !/^[A-Za-z0-9_-]{43}$/.test(paired.key) || !/^douli-[a-f0-9]{8}\.local$/.test(paired.hostname)) throw new Error("配对响应无效");
    await this.stopDiscovery(); this.peers.clear();
    const peer={id:paired.id,address:value.address,port:value.port,name:paired.name};
    this.replica.config({group:paired.group,key:paired.key,hostname:paired.hostname,name,priority:process.env.DOULI_MOBILE==="1" ? 10 : 20,peers:[peer],initialSync:false});
    // Joining explicitly adopts the inviter's model and assistant configuration.
    // Fresh installations otherwise tie at clock zero and could erase its keys.
    this.store.db.exec("DELETE FROM sync_rows WHERE collection IN ('settings','preferences')");
    this.rememberPeer(peer); await this.syncPeer(peer);
    const config=this.replica.config(); config.initialSync=true; this.replica.config(config); await this.refreshDiscovery();
    return this.status();
  }
  rememberPeer(peer) {
    const old=this.peers.get(peer.id)||{}; this.peers.set(peer.id,{...old,...peer,seen:Date.now()});
    const config=this.replica.config(); if(!config) return;
    const durable={id:peer.id,address:peer.address,port:peer.port,name:peer.name||old.name,kind:peer.kind||old.kind};
    const list=(config.peers||[]).filter(p=>p.id!==peer.id); list.push(durable); config.peers=list.slice(-8); this.replica.config(config);
  }
  receive(box,address) {
    const config=this.replica.config(); if(!config || !privateIp(address)) throw new Error("未配对设备");
    const input=decryptSync(box,config.key);
    if(!validId(input.sender) || input.sender===this.replica.id || !validId(input.requestId) || !Number.isFinite(input.at) || Math.abs(Date.now()-input.at)>120000)
      throw new Error("同步请求身份或时间无效");
    if(this.replays.has(input.requestId)) throw new Error("重复的同步请求");
    for(const [id,at] of this.replays) if(Date.now()-at>120000) this.replays.delete(id);
    if(this.replays.size>1000) throw new Error("同步请求过于频繁");
    this.replays.set(input.requestId,Date.now());
    let result;
    if(input.op==="manifest") result={schema:this.replica.schema(),rows:this.replica.manifest(),name:config.name,kind:process.env.DOULI_MOBILE==="1"?"phone":"computer"};
    else if(input.op==="pull") {
      if(!Array.isArray(input.keys) || input.keys.length>100000) throw new Error("同步清单无效");
      result=this.replica.snapshot(input.keys);
    } else if(input.op==="push") { result={applied:this.replica.apply(input.snapshot)}; this.onChange(); }
    else if(input.op==="backend" && this.peers.has(input.sender) && this.onBackendControl) result=this.onBackendControl(input.command,input.body);
    else throw new Error("未知同步请求");
    const old=this.peers.get(input.sender); if(old) this.peers.set(input.sender,{...old,seen:Date.now()});
    const respond=result=>encryptSync({requestId:input.requestId,sender:this.replica.id,result},config.key);
    return result?.then ? result.then(respond) : respond(result);
  }
  async call(peer,op,data={}, {timeoutMs=30000}={}) {
    if(!privateIp(peer.address)) throw new Error("同步只连接局域网设备");
    const config=this.replica.config(); if(!config) throw new Error("同步已关闭");
    const requestId=randomUUID();
    const response=await fetch(`http://${peer.address}:${peer.port}/douli/sync`,{method:"POST",redirect:"error",headers:{"Content-Type":"application/json"},
      body:JSON.stringify(encryptSync({sender:this.replica.id,requestId,at:Date.now(),op,...data},config.key)),signal:AbortSignal.timeout(timeoutMs)});
    if(!response.ok) throw new Error(`同步服务返回 ${response.status}`);
    const output=decryptSync(await response.json(),config.key);
    if(output.requestId!==requestId || output.sender!==peer.id) throw new Error("同步响应身份不符");
    return output.result;
  }
  async syncPeer(peer) {
    const remote=await this.call(peer,"manifest");
    if(JSON.stringify(remote.schema)!==JSON.stringify(this.replica.schema())) throw new Error("两端版本不同，请先更新 App 和电脑服务");
    this.rememberPeer({...peer,name:remote.name,kind:remote.kind});
    const needed=this.replica.needs(remote.rows);
    const batches=[needed.filter(r=>r.collection!=="health_files"),...needed.filter(r=>r.collection==="health_files").map(r=>[r])].filter(r=>r.length);
    for(const keys of batches) this.replica.apply(await this.call(peer,"pull",{keys}));
    // Re-read after the pull: locally merged deletions and foreign-key cascades
    // must be sent back too. File bodies travel one at a time to bound memory.
    const known=new Map(remote.rows.map(r=>[JSON.stringify([r.collection,r.key]),r]));
    const outgoing=this.replica.manifest().filter(r=>newer(r,known.get(JSON.stringify([r.collection,r.key]))));
    const pushes=[outgoing.filter(r=>r.collection!=="health_files"),...outgoing.filter(r=>r.collection==="health_files").map(r=>[r])].filter(r=>r.length);
    for(const keys of pushes) await this.call(peer,"push",{snapshot:this.replica.snapshot(keys)});
    this.onChange(); this.peers.set(peer.id,{...this.peers.get(peer.id),seen:Date.now(),lastSync:new Date().toISOString(),error:null});
    const config=this.replica.config(); if(config?.initialSync===false){config.initialSync=true;this.replica.config(config);}
  }
  async tick() {
    if(this.running || this.closed) return;
    this.running=true;
    try {
      await this.refreshDiscovery();
      for(const peer of this.peers.values()) {
        if(this.closed) break;
        try { await this.syncPeer(peer); }
        catch(error){ this.peers.set(peer.id,{...this.peers.get(peer.id),error:error.message}); }
      }
    } finally { this.running=false; }
  }
  async refreshDiscovery() {
    const config=this.replica.config(), address=this.addresses?.().find(privateIp);
    if(!this.useDiscovery || !config || !address || this.closed) return;
    if(this.discovery && this.discovery.address===address && this.discovery.group===config.group) return;
    await this.stopDiscovery();
    const candidate=new Discovery({id:this.replica.id,group:config.group,key:config.key,address,port:this.port,priority:config.priority,hostname:config.hostname,
      ready:()=>this.ready(),onPeer:peer=>this.rememberPeer(peer),onError:error=>{this.errors.push(error.message);this.errors=this.errors.slice(-3);}});
    try { await candidate.start(); this.discovery=candidate; }
    catch(error){ this.errors.push("局域网自动发现未启动："+error.message); this.errors=this.errors.slice(-3); }
  }
  async stopDiscovery(){this.discovery?.close();this.discovery=null;}
  start(){const config=this.replica.config();for(const peer of config?.peers||[])this.peers.set(peer.id,peer);this.timer=setInterval(()=>void this.tick(),8000);this.timer.unref();void this.tick();}
  async close(){this.closed=true;clearInterval(this.timer);await this.stopDiscovery();while(this.running)await new Promise(r=>setTimeout(r,50));}
  async disconnect(){await this.stopDiscovery();this.replica.config(null);this.peers.clear();this.pendingInvite=null;}
}

export function registerSyncRoutes(admin,device,sync) {
  admin.get("/api/sync/state",async()=>sync.status());
  admin.post("/api/sync/invite",async()=>sync.invite());
  admin.post("/api/sync/join",async req=>sync.join(req.body?.invitation));
  admin.post("/api/sync/run",async()=>{await sync.tick();return sync.status();});
  admin.delete("/api/sync",async()=>{await sync.disconnect();return{ok:true};});
  device.post("/douli/pair",{bodyLimit:4096},async(req,reply)=>{try{return sync.acceptPair(req.body,req.ip.replace(/^::ffff:/,""));}catch{return reply.code(403).send({error:"配对未被接受"});}});
  device.post("/douli/sync",{bodyLimit:32*1024*1024},async(req,reply)=>{try{return await sync.receive(req.body,req.ip.replace(/^::ffff:/,""));}catch{return reply.code(409).send({error:"同步校验未通过，请检查两端版本、时钟与配对状态"});}});
}
