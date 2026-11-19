import 'package:sqflite_common/sqlite_api.dart';

/// Version 1 holds learning data and its durable outbox. Version 2 adds
/// recoverable conflict records, immutable batches and fenced worker leases.
Future<void> migrateLocal(Database db, int from, int to) async {
  if (from < 1 && to >= 1) {
    await db.execute('''CREATE TABLE records (
      owner TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('deck','card')),
      id TEXT NOT NULL, parent_kind TEXT, parent_id TEXT, data TEXT NOT NULL, server_data TEXT,
      search_text TEXT NOT NULL DEFAULT '', deleted_at TEXT,
      sync_version TEXT NOT NULL DEFAULT '0', synced_at TEXT,
      is_dirty INTEGER NOT NULL DEFAULT 0 CHECK(is_dirty IN (0,1)),
      local_revision INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(owner,kind,id),
      CHECK((kind='deck' AND parent_kind IS NULL AND parent_id IS NULL) OR
        (kind='card' AND parent_kind='deck' AND parent_id IS NOT NULL)),
      FOREIGN KEY(owner,parent_kind,parent_id) REFERENCES records(owner,kind,id)
    )''');
    await db.execute('''CREATE TABLE outbox (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL,
      operation_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('create','update','delete')),
      base_version TEXT, payload TEXT NOT NULL, base_snapshot TEXT,
      local_revision INTEGER NOT NULL, created_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_ms INTEGER NOT NULL DEFAULT 0,
      blocked_reason TEXT,
      FOREIGN KEY(owner,kind,entity_id) REFERENCES records(owner,kind,id)
    )''');
    await db.execute(
      'CREATE INDEX records_list ON records(owner,kind,deleted_at,parent_id)',
    );
    await db.execute('CREATE INDEX outbox_fifo ON outbox(owner,seq)');
    await db.execute(
      'CREATE INDEX outbox_entity ON outbox(owner,kind,entity_id,seq)',
    );
    await db.execute(
      'CREATE TABLE sync_state(owner TEXT PRIMARY KEY,cursor TEXT)',
    );
  }
  if (from < 2 && to >= 2) {
    await db.execute(
      'ALTER TABLE sync_state ADD COLUMN pull_next_ms INTEGER NOT NULL DEFAULT 0',
    );
    await db.execute(
      'ALTER TABLE sync_state ADD COLUMN pull_attempts INTEGER NOT NULL DEFAULT 0',
    );
    await db.execute(
      'ALTER TABLE sync_state ADD COLUMN pull_blocked INTEGER NOT NULL DEFAULT 0',
    );
    await db.execute('''CREATE TABLE conflicts (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL,
      entity_id TEXT NOT NULL, reason TEXT NOT NULL, resolution TEXT NOT NULL,
      local_snapshot TEXT NOT NULL, server_snapshot TEXT, mutations TEXT NOT NULL,
      created_at TEXT NOT NULL
    )''');
    await db.execute(
      'CREATE INDEX conflict_owner ON conflicts(owner,created_at,id)',
    );
    await db.execute('''CREATE TABLE prepared_batches (
      owner TEXT PRIMARY KEY, batch_id TEXT NOT NULL, items TEXT NOT NULL
    )''');
    await db.execute('''CREATE TABLE sync_leases (
      owner TEXT PRIMARY KEY, token TEXT NOT NULL, expires_ms INTEGER NOT NULL
    )''');
  }
}
