import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { migrationConnection } from './database-config.mjs';

let client;
try {
  const config = migrationConnection();
  const url = new URL(config.connectionString);
  if (process.env.NODE_ENV !== 'development' || !['127.0.0.1', 'localhost', 'db'].includes(url.hostname)
    || url.pathname !== '/vocabulary' || url.username !== 'cam_migrator') {
    throw new Error('Seed is restricted to the local development database');
  }
  client = new pg.Client(config);
  await client.connect();
  await client.query('BEGIN');
  try {
    await client.query(await readFile(new URL('../database/local/seed.sql', import.meta.url), 'utf8'));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  console.log('Local demo data ready. These are not login accounts.');
} catch {
  console.error('Seed failed. Use only the documented local development database after migrations.');
  process.exitCode = 1;
} finally {
  if (client) await client.end();
}
