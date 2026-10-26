// Additive, transactional migration: legacy facts and their review state survive.
export function migrateMemory(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const columns = new Set(db.prepare("PRAGMA table_info(memories)").all().map(x => x.name));
    for (const [name, type] of Object.entries({
      subject: "TEXT NOT NULL DEFAULT 'user'",
      predicate: "TEXT NOT NULL DEFAULT ''",
      object: "TEXT NOT NULL DEFAULT ''",
      kind: "TEXT NOT NULL DEFAULT 'fact'",
      valid_from: "TEXT",
      valid_until: "TEXT",
      confidence: "REAL NOT NULL DEFAULT 1",
      origin: "TEXT NOT NULL DEFAULT 'manual'",
      change_action: "TEXT NOT NULL DEFAULT 'add'",
      target_id: "TEXT",
      target_hash: "TEXT",
    })) if (!columns.has(name)) db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${type}`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_evidence (
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        quote TEXT NOT NULL, observed_at TEXT NOT NULL,
        UNIQUE(memory_id,message_id,quote)
      );
      INSERT OR IGNORE INTO memory_evidence SELECT id,source_id,quote,created_at FROM memories
        WHERE source_id IS NOT NULL AND quote!='';
      CREATE TABLE IF NOT EXISTS memory_vectors (
        kind TEXT NOT NULL, record_id TEXT NOT NULL, content_hash TEXT NOT NULL,
        model_key TEXT NOT NULL, embedding TEXT NOT NULL, PRIMARY KEY(kind,record_id)
      );
      CREATE TABLE IF NOT EXISTS memory_summaries (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        day TEXT, text TEXT NOT NULL, source_hash TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS summary_sources (
        summary_id TEXT NOT NULL REFERENCES memory_summaries(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        PRIMARY KEY(summary_id,message_id)
      );
      CREATE TABLE IF NOT EXISTS memory_exclusions (
        message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS forgotten_facts (fingerprint TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS memory_jobs (
        message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        attempts INTEGER NOT NULL DEFAULT 0, next_at TEXT NOT NULL, error TEXT
      );
      CREATE TABLE IF NOT EXISTS memory_pending (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        payload TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_maintenance (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS memory_fact ON memories(subject,predicate,status);
      CREATE INDEX IF NOT EXISTS memory_evidence_source ON memory_evidence(message_id);
      CREATE INDEX IF NOT EXISTS summary_message ON summary_sources(message_id);
      CREATE TRIGGER IF NOT EXISTS memory_vector_delete AFTER DELETE ON memories BEGIN
        DELETE FROM memory_vectors WHERE kind='memory' AND record_id=OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS summary_vector_delete AFTER DELETE ON memory_summaries BEGIN
        DELETE FROM memory_vectors WHERE kind='summary' AND record_id=OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS message_summary_delete BEFORE DELETE ON messages BEGIN
        DELETE FROM memory_summaries WHERE id IN (SELECT summary_id FROM summary_sources WHERE message_id=OLD.id);
      END;
      DROP TRIGGER IF EXISTS message_summary_correct;
      CREATE TRIGGER message_summary_correct AFTER UPDATE OF text ON messages WHEN NEW.text != OLD.text BEGIN
        DELETE FROM memory_summaries WHERE id IN (SELECT summary_id FROM summary_sources WHERE message_id=OLD.id);
        DELETE FROM memory_pending WHERE source_id=OLD.id;
        UPDATE memories SET status='needs_review',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id IN (SELECT memory_id FROM memory_evidence WHERE message_id=OLD.id)
          AND status IN ('active','suggested','conflict');
      END;
    `);
    migrateIncrementalMemory(db);
    migrateDiary(db);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrateDiary(db) {
  const columns = new Set(db.prepare("PRAGMA table_info(memory_episodes)").all().map(c => c.name));
  for (const [name, type] of Object.entries({ topics: "TEXT NOT NULL DEFAULT '[]'", origin: "TEXT NOT NULL DEFAULT 'automatic'",
    revision: "INTEGER NOT NULL DEFAULT 1", deleted: "INTEGER NOT NULL DEFAULT 0" }))
    if (!columns.has(name)) db.exec(`ALTER TABLE memory_episodes ADD COLUMN ${name} ${type}`);
  db.exec(`CREATE INDEX IF NOT EXISTS diary_date ON memory_episodes(deleted,occurred_at,id);
    CREATE TRIGGER IF NOT EXISTS diary_invalidate_update AFTER UPDATE ON memory_episodes BEGIN
      DELETE FROM memory_summaries WHERE session_id IN (OLD.session_id,NEW.session_id)
        OR day IN (strftime('%Y-%m-%d',OLD.occurred_at,'localtime'),strftime('%Y-%m-%d',NEW.occurred_at,'localtime'));
    END;
    CREATE TRIGGER IF NOT EXISTS diary_invalidate_delete AFTER DELETE ON memory_episodes BEGIN
      DELETE FROM memory_summaries WHERE session_id=OLD.session_id OR day=strftime('%Y-%m-%d',OLD.occurred_at,'localtime');
    END;`);
}

function migrateIncrementalMemory(db) {
  const columns = new Set(db.prepare("PRAGMA table_info(memory_jobs)").all().map(c => c.name));
  for (const [name, type] of Object.entries({
    assistant_id: "TEXT REFERENCES messages(id) ON DELETE CASCADE",
    facts: "INTEGER NOT NULL DEFAULT 1", episodes: "INTEGER NOT NULL DEFAULT 1",
    revision: "INTEGER NOT NULL DEFAULT 1",
  })) if (!columns.has(name)) db.exec(`ALTER TABLE memory_jobs ADD COLUMN ${name} ${type}`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_episodes (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      text TEXT NOT NULL, kind TEXT NOT NULL, occurred_at TEXT NOT NULL, ended_at TEXT,
      recorded_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS episode_time ON memory_episodes(occurred_at);
    CREATE INDEX IF NOT EXISTS episode_turn ON memory_episodes(source_id);
    CREATE TABLE IF NOT EXISTS episode_sources (
      episode_id TEXT NOT NULL REFERENCES memory_episodes(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      quote TEXT NOT NULL, PRIMARY KEY(episode_id,message_id,quote)
    );
    CREATE TABLE IF NOT EXISTS memory_dependencies (
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      source_hash TEXT NOT NULL, PRIMARY KEY(memory_id,message_id)
    );
    CREATE TABLE IF NOT EXISTS episode_dependencies (
      episode_id TEXT NOT NULL REFERENCES memory_episodes(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      source_hash TEXT NOT NULL, PRIMARY KEY(episode_id,message_id)
    );
    CREATE TABLE IF NOT EXISTS memory_turn_inputs (
      turn_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      assistant_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      source_hash TEXT NOT NULL, PRIMARY KEY(turn_id,message_id)
    );
    CREATE TABLE IF NOT EXISTS memory_summary_jobs (key TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS memory_merge_jobs (subject TEXT NOT NULL, predicate TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1, cursor INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(subject,predicate));
    CREATE TRIGGER IF NOT EXISTS episode_vector_delete AFTER DELETE ON memory_episodes BEGIN
      DELETE FROM memory_vectors WHERE kind='episode' AND record_id=OLD.id;
    END;
  `);
  if (!db.prepare("PRAGMA table_info(memory_merge_jobs)").all().some(c => c.name === "cursor"))
    db.exec("ALTER TABLE memory_merge_jobs ADD COLUMN cursor INTEGER NOT NULL DEFAULT 0");
  // Queue only affected groups. No per-minute scan of all message text.
  for (const [event, row] of [["INSERT", "NEW"], ["DELETE", "OLD"]]) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS episode_dirty_${event} AFTER ${event} ON memory_episodes BEGIN
      INSERT INTO memory_summary_jobs(key) VALUES('session:' || ${row}.session_id)
        ON CONFLICT(key) DO UPDATE SET revision=revision+1;
      INSERT INTO memory_summary_jobs(key) VALUES('day:' || strftime('%Y-%m-%d',${row}.occurred_at,'localtime'))
        ON CONFLICT(key) DO UPDATE SET revision=revision+1;
    END;`);
  }
  db.exec(`CREATE TRIGGER IF NOT EXISTS episode_dirty_UPDATE AFTER UPDATE ON memory_episodes BEGIN
    DELETE FROM memory_vectors WHERE kind='episode' AND record_id=OLD.id;
    INSERT INTO memory_summary_jobs(key) VALUES('session:' || OLD.session_id)
      ON CONFLICT(key) DO UPDATE SET revision=revision+1;
    INSERT INTO memory_summary_jobs(key) VALUES('session:' || NEW.session_id)
      ON CONFLICT(key) DO UPDATE SET revision=revision+1;
    INSERT INTO memory_summary_jobs(key) VALUES('day:' || strftime('%Y-%m-%d',OLD.occurred_at,'localtime'))
      ON CONFLICT(key) DO UPDATE SET revision=revision+1;
    INSERT INTO memory_summary_jobs(key) VALUES('day:' || strftime('%Y-%m-%d',NEW.occurred_at,'localtime'))
      ON CONFLICT(key) DO UPDATE SET revision=revision+1;
  END;`);
  for (const event of ["INSERT", "UPDATE"]) db.exec(`
    DROP TRIGGER IF EXISTS memory_merge_${event};
    CREATE TRIGGER memory_merge_${event} AFTER ${event} ON memories BEGIN
      INSERT INTO memory_merge_jobs(subject,predicate) VALUES(NEW.subject,NEW.predicate)
        ON CONFLICT(subject,predicate) DO UPDATE SET revision=revision+1,cursor=0;
    END;
  `);
  // Changes to any context used by an extraction invalidate its derivatives too.
  for (const [name, on, ref, requeue] of [
    ["correct", "AFTER UPDATE OF text,status ON messages", "NEW.id", true],
    ["delete", "BEFORE DELETE ON messages", "OLD.id", false],
    ["exclude", "AFTER INSERT ON memory_exclusions", "NEW.message_id", false],
  ]) {
    db.exec(`DROP TRIGGER IF EXISTS incremental_${name};
      CREATE TRIGGER incremental_${name} ${on} ${name === "correct" ? "WHEN NEW.text != OLD.text OR NEW.status != OLD.status" : ""} BEGIN
      ${requeue ? `INSERT INTO memory_jobs(message_id,assistant_id,facts,episodes,next_at)
        SELECT DISTINCT turn_id,assistant_id,1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM memory_turn_inputs
        WHERE message_id=${ref} AND assistant_id IS NOT NULL
        ON CONFLICT(message_id) DO UPDATE SET attempts=0,next_at=excluded.next_at,revision=revision+1;` : ""}
      UPDATE memories SET status='needs_review',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id IN (SELECT memory_id FROM memory_dependencies WHERE message_id=${ref})
        AND status IN ('active','suggested','conflict');
      DELETE FROM memory_episodes WHERE source_id=${ref} OR id IN
        (SELECT episode_id FROM episode_sources WHERE message_id=${ref}) OR source_id IN
        (SELECT turn_id FROM memory_turn_inputs WHERE message_id=${ref}) OR id IN
        (SELECT episode_id FROM episode_dependencies WHERE message_id=${ref});
      DELETE FROM memory_summaries WHERE id IN (SELECT summary_id FROM summary_sources WHERE message_id=${ref});
      ${name === "exclude" ? `DELETE FROM memory_jobs WHERE message_id=${ref}; DELETE FROM memory_pending WHERE source_id=${ref};` : ""}
    END;`);
  }
  // Run once on upgrade; historic fact confirmation state is never rewritten.
  if (!db.prepare("SELECT 1 FROM memory_maintenance WHERE key='incremental_v1'").get()) {
    db.exec(`INSERT OR IGNORE INTO memory_merge_jobs(subject,predicate) SELECT subject,predicate FROM memories;
      INSERT OR IGNORE INTO memory_jobs(message_id,assistant_id,facts,episodes,next_at)
      SELECT u.id,a.id,0,1,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM messages a JOIN messages u ON u.rowid=
        (SELECT max(p.rowid) FROM messages p WHERE p.session_id=a.session_id AND p.rowid<a.rowid)
      WHERE a.role='assistant' AND u.role='user' AND a.status='complete' AND u.status='complete'
        AND NOT EXISTS(SELECT 1 FROM memory_exclusions WHERE message_id IN (a.id,u.id))
        AND COALESCE(json_extract(a.metadata,'$.memoryOperation'),0)=0 AND COALESCE(json_extract(u.metadata,'$.memoryOperation'),0)=0
        AND COALESCE(json_extract(a.metadata,'$.healthPrivate'),0)=0 AND COALESCE(json_extract(u.metadata,'$.healthPrivate'),0)=0
        AND COALESCE(json_extract(a.metadata,'$.assistantControl'),0)=0 AND COALESCE(json_extract(u.metadata,'$.assistantControl'),0)=0;
      INSERT INTO memory_maintenance VALUES('incremental_v1','true');`);
  }
}
