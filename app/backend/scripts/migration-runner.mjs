import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

export async function loadMigrations(directory) {
  const names = (await readdir(directory)).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  return Promise.all(names.map(async name => {
    const sql = await readFile(new URL(name, directory), 'utf8');
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));
}

// All queries must use the SAME connection, not independent Pool.query calls.
export async function runMigrations(connection, migrations) {
  await connection.query('BEGIN');
  try {
    await connection.query('SELECT pg_advisory_xact_lock(741852963)');
    await connection.query(`CREATE SCHEMA IF NOT EXISTS app_migrations`);
    await connection.query('REVOKE ALL ON SCHEMA app_migrations FROM PUBLIC');
    await connection.query(`CREATE TABLE IF NOT EXISTS app_migrations.history (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await connection.query('SELECT name, checksum FROM app_migrations.history ORDER BY name');
    // Applied migrations must be an exact prefix: no deletion, edit or insertion into history.
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].name !== migrations[i]?.name || rows[i].checksum !== migrations[i]?.checksum) {
        throw new Error('Migration history mismatch; add a new migration instead of editing history');
      }
    }
    const applied = [];
    for (const migration of migrations.slice(rows.length)) {
      await connection.query(migration.sql);
      await connection.query('INSERT INTO app_migrations.history(name, checksum) VALUES ($1, $2)', [migration.name, migration.checksum]);
      applied.push(migration.name);
    }
    await connection.query('COMMIT');
    return applied;
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  }
}
