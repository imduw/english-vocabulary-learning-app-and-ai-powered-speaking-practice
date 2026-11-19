import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { loadMigrations, runMigrations } from '../scripts/migration-runner.mjs';

const userA = '10000000-0000-4000-8000-000000000001';
const userB = '10000000-0000-4000-8000-000000000002';
const deckA = '20000000-0000-4000-8000-000000000001';
const deckB = '20000000-0000-4000-8000-000000000002';
const cardA = '30000000-0000-4000-8000-000000000001';

test('PostgreSQL schema, migration history and ownership constraints', async (t) => {
  const db = new PGlite();
  // Supabase Auth is intentionally NOT emulated beyond the referenced identity table.
  await db.exec('CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY)');
  const connection = { query: (sql, params) => params ? db.query(sql, params) : db.exec(sql).then(results => results.at(-1)) };
  const migrations = await loadMigrations(new URL('../database/migrations/', import.meta.url));
  const seed = await readFile(new URL('../database/local/seed.sql', import.meta.url), 'utf8');
  try {
    await t.test('migrates a clean DB, reruns without changes, rejects edited history', async () => {
      assert.deepEqual(await runMigrations(connection, migrations), migrations.map(m => m.name));
      assert.deepEqual(await runMigrations(connection, migrations), []);
      await assert.rejects(runMigrations(connection, [{ ...migrations[0], checksum: 'changed' }, ...migrations.slice(1)]), /history mismatch/);
      await db.exec(seed);
      await db.exec(seed);
      assert.equal((await db.query('SELECT count(*)::int AS count FROM app.cards')).rows[0].count, 2);
    });

    await t.test('failed migration rolls back both DDL and ledger', async () => {
      const bad = { name: '999_broken.sql', checksum: 'test', sql: 'CREATE TABLE app.should_rollback(id int); SELECT missing_column FROM app.cards;' };
      await assert.rejects(runMigrations(connection, [...migrations, bad]));
      assert.equal((await db.query("SELECT to_regclass('app.should_rollback') AS name")).rows[0].name, null);
      assert.equal((await db.query('SELECT count(*)::int AS count FROM app_migrations.history')).rows[0].count, migrations.length);
    });

    await t.test('same word in different contexts is valid; cross-owner references are not', async () => {
      assert.equal((await db.query("SELECT count(*)::int AS count FROM app.cards WHERE word = 'bank'")).rows[0].count, 2);
      await assert.rejects(db.query('UPDATE app.cards SET deck_id = $1 WHERE id = $2', [deckB, cardA]), { code: '23503' });
      await assert.rejects(db.query('UPDATE app.cards SET user_id = $1 WHERE id = $2', [userB, cardA]), { code: '23514' });
      await assert.rejects(db.query('DELETE FROM app.decks WHERE id = $1', [deckA]), { code: '23503' });
    });

    await t.test('validates content, timezones and server-controlled record versions', async () => {
      await assert.rejects(db.query("UPDATE app.cards SET word = '   ' WHERE id = $1", [cardA]), { code: '23514' });
      await assert.rejects(db.query("UPDATE app.profiles SET timezone = 'Invalid/Zone' WHERE user_id = $1", [userA]), { code: '23514' });
      await db.query('UPDATE app.cards SET is_favorite = true, version = 999 WHERE id = $1', [cardA]);
      const row = (await db.query('SELECT version, is_favorite FROM app.cards WHERE id = $1', [cardA])).rows[0];
      assert.equal(Number(row.version), 2);
      assert.equal(row.is_favorite, true);
    });

    await t.test('OCR documents require an image owned by the same account', async () => {
      const media = '40000000-0000-4000-8000-000000000001';
      const doc = '50000000-0000-4000-8000-000000000001';
      await db.query("INSERT INTO app.media_assets(id,user_id,kind,mime_type,size_bytes) VALUES ($1,$2,'audio','audio/wav',100)", [media, userA]);
      await assert.rejects(db.query("INSERT INTO app.source_documents(id,user_id,media_id,ocr_original_text,ocr_engine) VALUES ($1,$2,$3,'book','fixture')", [doc, userA, media]), { code: '23503' });
      await assert.rejects(db.query("UPDATE app.media_assets SET status = 'ready' WHERE id = $1", [media]), { code: '23514' });
      await db.query("UPDATE app.media_assets SET kind='image', mime_type='image/png', width=100, height=100 WHERE id=$1", [media]);
      await assert.rejects(db.query("INSERT INTO app.source_documents(id,user_id,media_id,ocr_original_text,ocr_engine) VALUES ($1,$2,$3,'book','fixture')", [doc, userB, media]), { code: '23503' });
      await db.query("INSERT INTO app.source_documents(id,user_id,media_id,ocr_original_text,ocr_engine) VALUES ($1,$2,$3,'bank','fixture')", [doc, userA, media]);
      await db.query('UPDATE app.cards SET source_document_id=$1 WHERE id=$2', [doc, cardA]);
      await db.query("UPDATE app.source_documents SET corrected_text='edited', deleted_at=now() WHERE id=$1", [doc]);
      assert.equal((await db.query('SELECT source_sentence FROM app.cards WHERE id=$1', [cardA])).rows[0].source_sentence, 'I went to the bank.');
    });

    await t.test('RLS denies an ordinary role even if table privileges are accidentally granted', async () => {
      await db.exec('CREATE ROLE test_client NOSUPERUSER NOBYPASSRLS; GRANT USAGE ON SCHEMA app TO test_client; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO test_client; SET ROLE test_client');
      try {
        assert.equal((await db.query('SELECT * FROM app.cards')).rows.length, 0);
        await assert.rejects(db.query('INSERT INTO app.decks(id,user_id,name) VALUES ($1,$2,$3)', ['20000000-0000-4000-8000-000000000099', userA, 'Denied']), { code: '42501' });
      } finally { await db.exec('RESET ROLE'); }
      const protectedTables = (await db.query("SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity")).rows[0].count;
      assert.equal(protectedTables, 13);
    });
  } finally { await db.close(); }
});
