import { randomUUID } from "node:crypto";

// Replicate durable user data; runtime jobs, embeddings, audio and event logs stay local.
const collections = {
  settings:["id"], preferences:["id"], dictionary:["id"], sessions:["id"], messages:["id"],
  memories:["id"], devices:["id"], forgotten_memories:["fingerprint"],
  memory_evidence:["memory_id","message_id","quote"],
  memory_dependencies:["memory_id","message_id"],
  memory_episodes:["id"], episode_sources:["episode_id","message_id","quote"],
  episode_dependencies:["episode_id","message_id"],
  memory_exclusions:["message_id"], forgotten_facts:["fingerprint"],
  health_records:["id"], health_files:["record_id"],
};
const quote = name => `"${name.replaceAll('"','""')}"`;
// IDs are never reused. A deletion must beat an offline child writing its
// parent's updated_at, or that stale device could resurrect a removed session.
export const newer = (a,b) => !b || (a.deleted !== b.deleted ? a.deleted > b.deleted :
  a.clock > b.clock || (a.clock === b.clock && a.author > b.author));
const sealedColumn = table => table === "settings" ? "value" : ["health_records", "health_files"].includes(table) ? "payload" : null;

export class SyncStore {
  constructor(store) {
    this.store=store; this.db=store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_state (id INTEGER PRIMARY KEY CHECK(id=1), node TEXT NOT NULL, clock INTEGER NOT NULL DEFAULT 0, applying INTEGER NOT NULL DEFAULT 0, config TEXT);
      CREATE TABLE IF NOT EXISTS sync_rows (collection TEXT NOT NULL, key TEXT NOT NULL, clock INTEGER NOT NULL, author TEXT NOT NULL, deleted INTEGER NOT NULL, PRIMARY KEY(collection,key));
    `);
    this.db.prepare("INSERT OR IGNORE INTO sync_state(id,node) VALUES(1,?)").run(randomUUID());
    this.id=this.db.prepare("SELECT node FROM sync_state WHERE id=1").get().node;
    this.tables={};
    for(const [table,keys] of Object.entries(collections)) {
      const columns=this.db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(c=>c.name);
      if(!columns.length) continue;
      this.tables[table]={keys,columns};
      for(const [event,row,deleted] of [["INSERT","NEW",0],["UPDATE","NEW",0],["DELETE","OLD",1]]) {
        this.db.exec(`CREATE TRIGGER IF NOT EXISTS sync_${table}_${event} AFTER ${event} ON ${quote(table)}
          WHEN (SELECT applying FROM sync_state WHERE id=1)=0 BEGIN
          UPDATE sync_state SET clock=clock+1 WHERE id=1;
          INSERT INTO sync_rows(collection,key,clock,author,deleted)
          SELECT '${table}',json_array(${keys.map(k=>`${row}.${quote(k)}`).join(",")}),clock,node,${deleted} FROM sync_state WHERE id=1
          ON CONFLICT(collection,key) DO UPDATE SET clock=excluded.clock,author=excluded.author,deleted=excluded.deleted;
          END;`);
      }
      // Existing installations join without rewriting their data or changing IDs.
      this.db.exec(`INSERT OR IGNORE INTO sync_rows SELECT '${table}',json_array(${keys.map(quote).join(",")}),0,'${this.id}',0 FROM ${quote(table)}`);
    }
  }
  config(value) {
    if(value !== undefined) this.db.prepare("UPDATE sync_state SET config=? WHERE id=1").run(value ? this.store.seal(value) : null);
    const data=this.db.prepare("SELECT config FROM sync_state WHERE id=1").get().config;
    return data ? this.store.unseal(data) : null;
  }
  schema() { return Object.fromEntries(Object.entries(this.tables).map(([table,value])=>[table,value.columns])); }
  manifest() {
    // Cascading deletes can originate from remote transactions. Retain explicit
    // tombstones so a later disconnected device cannot resurrect their children.
    for (const meta of this.db.prepare("SELECT * FROM sync_rows WHERE deleted=0").all()) {
      const shape = this.tables[meta.collection]; if (!shape) continue;
      const exists = this.db.prepare(`SELECT 1 FROM ${quote(meta.collection)} WHERE ${shape.keys.map(k => `${quote(k)} IS ?`).join(" AND ")}`).get(...JSON.parse(meta.key));
      if (!exists) {
        this.db.exec("UPDATE sync_state SET clock=clock+1 WHERE id=1");
        this.db.prepare("UPDATE sync_rows SET clock=(SELECT clock FROM sync_state WHERE id=1),author=?,deleted=1 WHERE collection=? AND key=?").run(this.id,meta.collection,meta.key);
      }
    }
    return this.db.prepare("SELECT * FROM sync_rows ORDER BY collection,key").all();
  }
  needs(manifest) {
    if (!Array.isArray(manifest) || manifest.length > 100000) throw new Error("同步清单过大");
    return manifest.filter(meta => {
      if (!this.tables[meta.collection] || typeof meta.key !== "string" || meta.key.length > 10000 ||
          !Number.isSafeInteger(meta.clock) || meta.clock < 0 || !/^[a-f0-9-]{36}$/.test(meta.author) || ![0,1].includes(meta.deleted)) throw new Error("无效同步清单");
      return newer(meta, this.db.prepare("SELECT * FROM sync_rows WHERE collection=? AND key=?").get(meta.collection,meta.key));
    });
  }
  snapshot(requested) {
    const wanted = requested ? new Set(requested.map(r => JSON.stringify([r.collection,r.key]))) : null;
    const rows=this.manifest().filter(r => !wanted || wanted.has(JSON.stringify([r.collection,r.key]))).map(meta=> {
      const shape=this.tables[meta.collection];
      if(!shape) return null;
      const key=JSON.parse(meta.key);
      let row=meta.deleted ? null : this.db.prepare(`SELECT * FROM ${quote(meta.collection)} WHERE ${shape.keys.map(k=>`${quote(k)} IS ?`).join(" AND ")}`).get(...key);
      // A local schema trigger may cascade a removal while remote writes are suppressed.
      const result={...meta,deleted:row ? 0 : 1,row:row || null};
      const encrypted = sealedColumn(meta.collection);
      if(row && encrypted) result.row={...row,[encrypted]:this.store.unseal(row[encrypted])};
      return result;
    }).filter(Boolean);
    return { v:1,schema:this.schema(),rows };
  }
  apply(snapshot) {
    if(snapshot?.v !== 1 || !Array.isArray(snapshot.rows) || snapshot.rows.length>100000) throw new Error("无效的同步数据");
    if(JSON.stringify(snapshot.schema)!==JSON.stringify(this.schema())) throw new Error("两端数据结构不同，请更新到相同版本后同步");
    const incoming=[];
    for(const change of snapshot.rows) {
      const shape=this.tables[change.collection];
      if(!shape || typeof change.key!=="string" || !Number.isSafeInteger(change.clock) || change.clock<0 || !/^[a-f0-9-]{36}$/.test(change.author) || ![0,1].includes(change.deleted)) throw new Error("无效的同步记录");
      const key=JSON.parse(change.key);
      if(!Array.isArray(key) || key.length!==shape.keys.length || key.some(v=>v!==null && typeof v!=="string")) throw new Error("无效的同步主键");
      if(!change.deleted) {
        if(!change.row || Object.keys(change.row).sort().join()!==[...shape.columns].sort().join() || shape.keys.some((k,i)=>change.row[k]!==key[i])) throw new Error("同步记录与结构不符");
        for(const [name,value] of Object.entries(change.row)) if(value!==null && !["string","number"].includes(typeof value) && name!==sealedColumn(change.collection)) throw new Error("无效的同步字段");
      }
      const local=this.db.prepare("SELECT * FROM sync_rows WHERE collection=? AND key=?").get(change.collection,change.key);
      if(newer(change,local)) incoming.push({...change,keyValues:key});
    }
    if(!incoming.length) return 0;
    this.db.exec("BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON; UPDATE sync_state SET applying=1 WHERE id=1;");
    try {
      // Parents first on insertion, children first on deletion. The final FK
      // check makes the whole exchange atomic; partial histories never appear.
      const order=Object.keys(this.tables);
      incoming.sort((a,b)=>a.deleted-b.deleted || (a.deleted ? -1 : 1)*(order.indexOf(a.collection)-order.indexOf(b.collection)));
      for(const change of incoming) {
        const shape=this.tables[change.collection];
        const where=shape.keys.map(k=>`${quote(k)} IS ?`).join(" AND ");
        if(change.deleted) this.db.prepare(`DELETE FROM ${quote(change.collection)} WHERE ${where}`).run(...change.keyValues);
        else {
          const row={...change.row};
          // Revision is a local editor guard: even equal remote revisions must
          // invalidate a form opened before this exchange.
          if (change.collection === "health_records") {
            const previous = this.db.prepare("SELECT revision FROM health_records WHERE id=?").get(row.id);
            if (previous) row.revision = Math.max(previous.revision + 1, row.revision);
          }
          const parent = change.collection === "messages" ? ["sessions", "id", row.session_id] :
            change.collection === "health_files" ? ["health_records", "id", row.record_id] :
            ["memory_evidence", "memory_dependencies"].includes(change.collection) ? ["memories", "id", row.memory_id] :
            change.collection === "memory_episodes" ? ["messages", "id", row.source_id] :
            ["episode_sources", "episode_dependencies"].includes(change.collection) ? ["memory_episodes", "id", row.episode_id] :
            change.collection === "memory_exclusions" ? ["messages", "id", row.message_id] : null;
          if (parent && !this.db.prepare(`SELECT 1 FROM ${quote(parent[0])} WHERE ${quote(parent[1])}=?`).get(parent[2])) {
            const tombstone = this.db.prepare("SELECT deleted FROM sync_rows WHERE collection=? AND key=?").get(parent[0],JSON.stringify([parent[2]]));
            if (!tombstone?.deleted) throw new Error("同步缺少父记录，等待下一次完整交换");
            change.deleted = 1;
            this.db.prepare("INSERT OR REPLACE INTO sync_rows VALUES(?,?,?,?,1)").run(change.collection,change.key,change.clock,change.author);
            this.db.prepare("UPDATE sync_state SET clock=MAX(clock,?) WHERE id=1").run(change.clock);
            continue;
          }
          if (change.collection === "memories" && row.source_id && !this.db.prepare("SELECT 1 FROM messages WHERE id=?").get(row.source_id)) row.source_id=null;
          if (["memory_evidence", "memory_dependencies", "episode_sources", "episode_dependencies"].includes(change.collection) && row.message_id && !this.db.prepare("SELECT 1 FROM messages WHERE id=?").get(row.message_id)) {
            this.db.prepare("INSERT OR REPLACE INTO sync_rows VALUES(?,?,?,?,1)").run(change.collection,change.key,change.clock,change.author);
            continue;
          }
          const encrypted = sealedColumn(change.collection);
          if(encrypted) row[encrypted]=this.store.seal(row[encrypted]);
          const exists=this.db.prepare(`SELECT * FROM ${quote(change.collection)} WHERE ${where}`).get(...change.keyValues);
          if(exists) {
            // UPDATE OF text triggers memory correction even when the value is
            // unchanged. Only write changed columns to preserve valid evidence.
            const changed=shape.columns.filter(k=>exists[k]!==row[k]);
            if(changed.length) this.db.prepare(`UPDATE ${quote(change.collection)} SET ${changed.map(k=>`${quote(k)}=?`).join(",")} WHERE ${where}`).run(...changed.map(k=>row[k]),...change.keyValues);
          }
          else this.db.prepare(`INSERT INTO ${quote(change.collection)}(${shape.columns.map(quote).join(",")}) VALUES(${shape.columns.map(()=>"?").join(",")})`).run(...shape.columns.map(k=>row[k]));
          if(change.collection==="memory_exclusions") {
            this.db.prepare("DELETE FROM memory_summaries WHERE id IN (SELECT summary_id FROM summary_sources WHERE message_id=?)").run(row.message_id);
            this.db.prepare("DELETE FROM memory_jobs WHERE message_id=?").run(row.message_id);
            this.db.prepare("DELETE FROM memory_pending WHERE source_id=?").run(row.message_id);
          }
        }
        this.db.prepare("INSERT OR REPLACE INTO sync_rows VALUES(?,?,?,?,?)").run(change.collection,change.key,change.clock,change.author,change.deleted);
        this.db.prepare("UPDATE sync_state SET clock=MAX(clock,?) WHERE id=1").run(change.clock);
      }
      this.db.exec("DELETE FROM memory_maintenance WHERE key='profile'; UPDATE sync_state SET applying=0 WHERE id=1; COMMIT;");
      return incoming.length;
    } catch(error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
