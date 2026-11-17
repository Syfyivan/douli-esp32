import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  randomUUID,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { normalizeSettings } from "./config.mjs";
import { migrateMemory } from "./memory-schema.mjs";

export class Store {
  constructor(directory) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true });
    const keyPath = join(directory, "local.key");
    if (!existsSync(keyPath))
      writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
    this.key = readFileSync(keyPath);
    this.db = new DatabaseSync(join(directory, "douli.sqlite"));
    this.db
      .exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, role TEXT NOT NULL, text TEXT NOT NULL, raw_text TEXT, route TEXT, status TEXT NOT NULL DEFAULT 'complete', metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audio (message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, data BLOB NOT NULL, mime TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS preferences (id TEXT PRIMARY KEY, name TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, name TEXT NOT NULL, value TEXT NOT NULL, quote TEXT NOT NULL DEFAULT '', source_id TEXT REFERENCES messages(id) ON DELETE SET NULL, status TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, previous_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dictionary (id TEXT PRIMARY KEY, phrase TEXT NOT NULL, replacement TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, approved INTEGER NOT NULL DEFAULT 0, token TEXT NOT NULL, firmware TEXT, last_seen TEXT, metadata TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE IF NOT EXISTS actions (id TEXT PRIMARY KEY, name TEXT NOT NULL, config TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sensors (id TEXT PRIMARY KEY, name TEXT NOT NULL, unit TEXT NOT NULL, value REAL, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS sensor_sources (id TEXT PRIMARY KEY REFERENCES sensors(id) ON DELETE CASCADE, config TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS forgotten_memories (fingerprint TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, config TEXT NOT NULL, last_fired TEXT);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, kind TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS session_updated ON sessions(updated_at DESC);
      CREATE INDEX IF NOT EXISTS message_session ON messages(session_id,created_at);
      CREATE INDEX IF NOT EXISTS memory_source ON memories(source_id);
    `);
    migrateMemory(this.db);
    if (!this.db.prepare("PRAGMA table_info(dictionary)").all().some(column => column.name === "scope")) {
      this.db.exec("ALTER TABLE dictionary ADD COLUMN scope TEXT NOT NULL DEFAULT 'global'");
      this.db.prepare("UPDATE dictionary SET scope='assistant_address' WHERE replacement=?").run(this.settings().assistant.name);
    }
    this.getSettingsStmt = this.db.prepare("SELECT value FROM settings WHERE id=?");
    this.listSessionsStmt = this.db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 200");
    this.searchSessionsStmt = this.db.prepare(
      "SELECT * FROM sessions s WHERE s.title LIKE ? OR EXISTS (SELECT 1 FROM messages m WHERE m.session_id=s.id AND m.text LIKE ?) ORDER BY s.updated_at DESC LIMIT 200",
    );
    this.listMessagesStmt = this.db.prepare(
      "SELECT m.*, EXISTS(SELECT 1 FROM audio a WHERE a.message_id=m.id) AS has_audio FROM messages m WHERE session_id=? ORDER BY created_at,rowid",
    );
    this.lastMessageStmt = this.db.prepare(
      "SELECT * FROM messages WHERE session_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    );
    this.excludedMessagesStmt = this.db.prepare(
      "SELECT message_id FROM memory_exclusions WHERE message_id IN (SELECT id FROM messages WHERE session_id=?)",
    );
  }
  seal(value) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const data = Buffer.concat([
      cipher.update(JSON.stringify(value)),
      cipher.final(),
    ]);
    return [nonce, cipher.getAuthTag(), data]
      .map((b) => b.toString("base64"))
      .join(".");
  }
  unseal(value) {
    const [nonce, tag, data] = value
      .split(".")
      .map((v) => Buffer.from(v, "base64"));
    const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);
    decipher.setAuthTag(tag);
    return JSON.parse(
      Buffer.concat([decipher.update(data), decipher.final()]).toString(),
    );
  }
  settings() {
    const stmt = this.getSettingsStmt || (this.getSettingsStmt = this.db.prepare("SELECT value FROM settings WHERE id=?"));
    const raw = stmt.get("config")?.value || "";
    if (this.settingsCache?.raw !== raw) {
      this.settingsCache = {
        raw,
        value: normalizeSettings(raw ? this.unseal(raw) : {}),
      };
    }
    return structuredClone(this.settingsCache.value);
  }
  saveSettings(value) {
    const normalized = normalizeSettings(value);
    const sealed = this.seal(normalized);
    this.db
      .prepare("INSERT OR REPLACE INTO settings VALUES (?,?)")
      .run("config", sealed);
    this.settingsCache = { raw: sealed, value: normalized };
  }
  publicSettings() {
    const s = this.settings();
    for (const m of Object.values(s.models)) {
      m.hasKey = !!m.apiKey;
      m.apiKey = "";
    }
    s.search.hasDeepseekKey = !!s.search.deepseekApiKey;
    s.search.deepseekApiKey = "";
    s.search.hasKey = !!s.search.apiKey;
    s.search.apiKey = "";
    s.avatar.hasKey = !!s.avatar.apiKey;
    s.avatar.apiKey = "";
    s.input.hasStreamingToken = !!s.input.streamingToken;
    s.input.streamingToken = "";
    return s;
  }
  all(table) {
    if (
      ![
        "preferences",
        "memories",
        "dictionary",
        "devices",
        "actions",
        "sensors",
        "rules",
      ].includes(table)
    )
      throw new Error("Unknown collection");
    return this.db.prepare(`SELECT * FROM ${table}`).all();
  }
  session(id, source = "browser") {
    if (id) {
      const found = this.db
        .prepare("SELECT * FROM sessions WHERE id=?")
        .get(id);
      if (!found) throw new Error("会话不存在");
      return found;
    }
    return this.createSession(source);
  }
  createSession(source = "browser", id = randomUUID()) {
    const now = new Date().toISOString();
    const row = {
      id,
      title: "新的对话",
      source,
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare("INSERT INTO sessions VALUES (?,?,?,?,?)")
      .run(...Object.values(row));
    return row;
  }
  sessions(query = "") {
    if (!query) return this.listSessionsStmt.all();
    return this.searchSessionsStmt.all(`%${query}%`, `%${query}%`);
  }
  messages(id) {
    return this.listMessagesStmt
      .all(id)
      .map((m) => ({ ...m, metadata: JSON.parse(m.metadata) }));
  }
  lastMessage(id) {
    const row = id ? this.lastMessageStmt.get(id) : null;
    return row ? { ...row, metadata: JSON.parse(row.metadata) } : undefined;
  }
  excludedIds(sessionId) {
    if (!sessionId) return new Set();
    return new Set(this.excludedMessagesStmt.all(sessionId).map(r => r.message_id));
  }
  message(sessionId, role, text, fields = {}) {
    const row = {
      id: randomUUID(),
      session_id: sessionId,
      role,
      text,
      raw_text: fields.rawText ?? null,
      route: fields.route ?? null,
      status: fields.status || "complete",
      metadata: JSON.stringify(fields.metadata || {}),
      created_at: new Date().toISOString(),
    };
    this.db.exec("SAVEPOINT message_write");
    try {
      this.db
        .prepare("INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?)")
        .run(...Object.values(row));
      this.db
        .prepare(
          "UPDATE sessions SET updated_at=?, title=CASE WHEN title=? THEN ? ELSE title END WHERE id=?",
        )
        .run(row.created_at, "新的对话", text.slice(0, 32), sessionId);
      this.db.exec("RELEASE message_write");
    } catch (error) {
      this.db.exec("ROLLBACK TO message_write; RELEASE message_write");
      throw error;
    }
    return { ...row, metadata: fields.metadata || {} };
  }
  saveAudio(id, data, mime = "audio/wav") {
    this.db
      .prepare("INSERT OR REPLACE INTO audio VALUES (?,?,?)")
      .run(id, data, mime);
  }
  event(kind, detail) {
    this.db
      .prepare("INSERT INTO events VALUES (?,?,?,?)")
      .run(
        randomUUID(),
        kind,
        JSON.stringify(detail),
        new Date().toISOString(),
      );
    this.db
      .prepare(
        "DELETE FROM events WHERE rowid <= COALESCE((SELECT rowid FROM events ORDER BY rowid DESC LIMIT 1 OFFSET 1000), 0)",
      )
      .run();
  }
  close() {
    this.closed = true;
    this.db.close();
  }
}
