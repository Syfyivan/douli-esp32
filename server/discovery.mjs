import dgram from "node:dgram";
import { createHmac, timingSafeEqual } from "node:crypto";

function equal(a, b) {
  const x = Buffer.from(a || ""), y = Buffer.from(b || "");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
function dnsName(name) {
  return Buffer.concat([...name.split(".").map(label => Buffer.concat([Buffer.from([Buffer.byteLength(label)]), Buffer.from(label)])), Buffer.from([0])]);
}
export function readQuestions(packet) {
  if (packet.length < 12 || packet.readUInt16BE(2) & 0x8000) return [];
  const count = packet.readUInt16BE(4);
  if (count > 30) return [];
  let offset = 12;
  const readName = (position, visited = new Set()) => {
    const labels = []; let end;
    for (let i = 0; i < 128; i++) {
      if (position >= packet.length || visited.has(position)) throw new Error("Invalid DNS name");
      visited.add(position);
      const length = packet[position++];
      if (!length) return { name: labels.join("."), end: end ?? position };
      if ((length & 0xc0) === 0xc0) {
        if (position >= packet.length) throw new Error("Invalid pointer");
        const pointer = ((length & 0x3f) << 8) | packet[position++];
        end ??= position;
        const suffix = readName(pointer, visited); labels.push(suffix.name);
        return { name: labels.join("."), end };
      }
      if (length > 63 || position + length > packet.length) throw new Error("Invalid label");
      labels.push(packet.subarray(position, position + length).toString()); position += length;
    }
    throw new Error("DNS name too long");
  };
  const result = [];
  try {
    for (let i = 0; i < count; i++) {
      const value = readName(offset); offset = value.end;
      if (offset + 4 > packet.length) return [];
      result.push({ name: value.name.toLowerCase(), type: packet.readUInt16BE(offset), unicast: !!(packet.readUInt16BE(offset + 2) & 0x8000) }); offset += 4;
    }
  } catch { return []; }
  return result;
}
export function dnsAnswer(name, address, id = 0, ttl = 3, questionType = 0) {
  const header = Buffer.alloc(12); header.writeUInt16BE(id); header.writeUInt16BE(0x8400,2); header.writeUInt16BE(1,6);
  const question = questionType ? Buffer.concat([dnsName(name), Buffer.from([0,questionType,0,1])]) : Buffer.alloc(0);
  if (questionType) header.writeUInt16BE(1,4);
  const rr = Buffer.alloc(10); rr.writeUInt16BE(1); rr.writeUInt16BE(0x8001,2); rr.writeUInt32BE(ttl,4); rr.writeUInt16BE(4,8);
  return Buffer.concat([header,question,dnsName(name),rr,Buffer.from(address.split(".").map(Number))]);
}

// Discovery packets contain identity/availability only. A shared group key
// authenticates them; chat, API keys and memories travel in encrypted HTTP.
export class Discovery {
  constructor({ id, group, key, address, port = 8789, priority = 10, hostname, ready = () => true, onPeer = () => {}, onError = () => {} }) {
    Object.assign(this,{ id,group,key,address,port,priority,hostname,ready,onPeer,onError });
    this.peers = new Map(); this.sockets = []; this.started = Date.now();
  }
  leader() {
    const candidates = [{ id:this.id, priority:this.priority, ready:this.ready() }, ...[...this.peers.values()].filter(p => Date.now() - p.seen < 9000)];
    return candidates.filter(p => p.ready).sort((a,b) => b.priority-a.priority || a.id.localeCompare(b.id))[0]?.id;
  }
  names() {
    if (!this.ready()) return [];
    const own = `douli-node-${this.id.slice(0, 8)}.local`;
    return this.leader() === this.id ? [own, this.hostname] : [own];
  }
  packet() {
    const body = JSON.stringify({ v:1, group:this.group, id:this.id, priority:this.priority, port:this.port, ready:this.ready(), now:Date.now() });
    return Buffer.from(JSON.stringify({ body, mac:createHmac("sha256",this.key).update(body).digest("hex") }));
  }
  receive(bytes, remote) {
    try {
      if (bytes.length > 1500) return;
      const envelope = JSON.parse(bytes);
      if (typeof envelope.body !== "string" || !equal(envelope.mac,createHmac("sha256",this.key).update(envelope.body).digest("hex"))) return;
      const value = JSON.parse(envelope.body);
      if (value.v !== 1 || value.group !== this.group || value.id === this.id || !/^[a-f0-9-]{36}$/.test(value.id) || Math.abs(Date.now()-value.now)>30000 || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 || ![0,10,20].includes(value.priority)) return;
      const old = this.peers.get(value.id);
      if (old && old.now >= value.now) return;
      const peer = {...value,address:remote.address,seen:Date.now()}; this.peers.set(value.id,peer); this.onPeer(peer);
    } catch {}
  }
  async start() {
    const connect = (port, group, callback) => new Promise((resolve,reject) => {
      const socket = dgram.createSocket({type:"udp4",reuseAddr:true}); this.sockets.push(socket);
      socket.on("message", callback); socket.once("error",reject);
      socket.bind(port, "0.0.0.0", () => {
        try { socket.addMembership(group,this.address); socket.setMulticastInterface(this.address); socket.setMulticastTTL(1); }
        catch(e) { reject(e); return; }
        socket.off("error",reject); socket.on("error",this.onError); resolve(socket);
      });
    });
    try {
      this.beacons = await connect(8791,"239.255.87.91",(bytes,remote) => this.receive(bytes,remote));
      this.dns = await connect(5353,"224.0.0.251",(bytes,remote) => {
        if (Date.now()-this.started < 3500) return;
        const names=this.names();
        const questions=readQuestions(bytes).filter(q => names.includes(q.name) && [1,255].includes(q.type));
        if (!questions.length) return;
        const unicast=remote.port!==5353 || questions.some(q=>q.unicast);
        for (const q of questions) this.dns.send(dnsAnswer(q.name,this.address,unicast ? bytes.readUInt16BE(0) : 0,3,unicast ? q.type : 0),unicast ? remote.port : 5353,unicast ? remote.address : "224.0.0.251",()=>{});
      });
      const tick=()=> {
        for(const [id,peer] of this.peers) if(Date.now()-peer.seen>60000) this.peers.delete(id);
        this.beacons.send(this.packet(),8791,"239.255.87.91",()=>{});
        if(Date.now()-this.started>3500) for(const name of this.names()) this.dns.send(dnsAnswer(name,this.address),5353,"224.0.0.251",()=>{});
      };
      tick(); this.timer=setInterval(tick,2500); this.timer.unref();
    } catch(error) { this.close(); throw error; }
  }
  close() { clearInterval(this.timer); for(const socket of this.sockets) { try{ socket.close(); }catch{} } this.sockets=[]; }
}
