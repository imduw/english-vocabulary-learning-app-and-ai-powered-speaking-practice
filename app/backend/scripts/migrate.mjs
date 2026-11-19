import pg from 'pg';
import { migrationConnection } from './database-config.mjs';
import { loadMigrations, runMigrations } from './migration-runner.mjs';

let client;
try {
  client = new pg.Client(migrationConnection());
  await client.connect();
  const migrations = await loadMigrations(new URL('../database/migrations/', import.meta.url));
  const applied = await runMigrations(client, migrations);
  console.log(JSON.stringify({ event: 'migrations_complete', applied }));
} catch {
  console.error('Migration failed. Check connection, auth.users prerequisite and migration history; no credentials logged.');
  process.exitCode = 1;
} finally {
  if (client) await client.end();
}
