import { readFileSync } from 'node:fs';

export function migrationConnection(env = process.env) {
  const connectionString = env.MIGRATION_DATABASE_URL;
  if (!connectionString) throw new Error('MIGRATION_DATABASE_URL is required');
  let url;
  try { url = new URL(connectionString); } catch { throw new Error('Invalid database URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2) {
    throw new Error('Invalid database URL');
  }
  if ([...url.searchParams.keys()].some(key => key.toLowerCase().startsWith('ssl'))) {
    throw new Error('Use DATABASE_SSL, not URL SSL parameters');
  }
  const ssl = env.DATABASE_SSL ?? 'true';
  if (!['true', 'false'].includes(ssl)) throw new Error('Invalid DATABASE_SSL');
  if (ssl === 'false' && (!['localhost', '127.0.0.1', '[::1]', 'db'].includes(url.hostname) || env.NODE_ENV === 'production')) {
    throw new Error('TLS required');
  }
  return { connectionString, ssl: ssl === 'true' ? { rejectUnauthorized: true, ...(env.DATABASE_CA_FILE ? { ca: readFileSync(env.DATABASE_CA_FILE, 'utf8') } : {}) } : false, connectionTimeoutMillis: 10000, statement_timeout: 30000 };
}
