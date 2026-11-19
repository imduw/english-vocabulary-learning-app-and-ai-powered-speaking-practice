import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { loadMigrations, runMigrations } from '../scripts/migration-runner.mjs';

test('profile RLS isolates identities and transaction-local identity does not leak', async () => {
  const db = new PGlite();
  const a = '10000000-0000-4000-8000-000000000001';
  const b = '10000000-0000-4000-8000-000000000002';
  const c = '10000000-0000-4000-8000-000000000003';
  try {
    await db.exec('CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY)');
    const connection = { query: (sql, params) => params ? db.query(sql, params) : db.exec(sql).then(r => r.at(-1)) };
    await runMigrations(connection, await loadMigrations(new URL('../database/migrations/', import.meta.url)));
    await db.exec(await readFile(new URL('../database/local/seed.sql', import.meta.url), 'utf8'));
    await db.query('INSERT INTO auth.users VALUES ($1)', [c]);
    await db.exec('SET ROLE vocabulary_api');
    assert.equal((await db.query('SELECT * FROM app.profiles')).rows.length, 0);
    await db.exec('BEGIN');
    await db.query("SELECT set_config('app.user_id',$1,true)", [a]);
    assert.deepEqual((await db.query('SELECT user_id FROM app.profiles')).rows.map(r => r.user_id), [a]);
    assert.equal((await db.query('UPDATE app.profiles SET display_name=$1 WHERE user_id=$2 RETURNING user_id', ['attack', b])).rows.length, 0);
    await db.query('UPDATE app.profiles SET display_name=$1 WHERE user_id=$2', ['Cam', a]);
    await db.exec('COMMIT');
    assert.equal((await db.query('SELECT * FROM app.profiles')).rows.length, 0);
    await db.exec('BEGIN');
    await db.query("SELECT set_config('app.user_id',$1,true)", [a]);
    await assert.rejects(db.query('INSERT INTO app.profiles(user_id) VALUES ($1)', [c]), { code: '42501' });
    await db.exec('ROLLBACK');
    await db.exec('BEGIN');
    await db.query("SELECT set_config('app.user_id',$1,true)", [c]);
    await db.query('INSERT INTO app.profiles(user_id) VALUES ($1)', [c]);
    await db.exec('COMMIT');
    await assert.rejects(db.query('UPDATE app.profiles SET user_id=$1', [b]), { code: '42501' });
    await assert.rejects(db.query('DELETE FROM app.profiles'), { code: '42501' });
    assert.equal((await db.query('SELECT * FROM app.cards')).rows.length, 0);
    await db.exec('RESET ROLE');
    assert.equal((await db.query('SELECT display_name FROM app.profiles WHERE user_id=$1', [b])).rows[0].display_name, 'Learner B');
  } finally { await db.close(); }
});
