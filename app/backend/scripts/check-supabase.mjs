// Read-only connection checks. Never outputs URLs, keys, passwords or driver errors.
import pg from 'pg';
import { migrationConnection } from './database-config.mjs';

function report(check, status, message) {
  console.log(JSON.stringify({ check, status, message }));
}

let project;
try {
  project = new URL(process.env.SUPABASE_URL ?? '');
  if (project.protocol !== 'https:' || !project.hostname.endsWith('.supabase.co')
    || project.username || project.password || project.search || project.hash || project.pathname !== '/'
    || project.hostname.includes('YOUR_')) throw new Error();
} catch {
  report('project', 'missing', 'Set your actual HTTPS SUPABASE_URL in .env.supabase.local');
  process.exitCode = 1;
}

if (project && !process.exitCode) {
  try {
    const response = await fetch(new URL('/auth/v1/.well-known/jwks.json', project), { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error();
    const jwks = await response.json();
    const keys = jwks.keys?.filter(key => ['ES256', 'RS256'].includes(key.alg));
    if (!Array.isArray(keys) || keys.length === 0) {
      report('jwks', 'incomplete', 'No supported public signing key found. Check Auth signing keys (ES256/RS256).');
      process.exitCode = 1;
    } else report('jwks', 'ok', 'Project public signing keys reachable; no user login has been tested yet.');
  } catch {
    report('jwks', 'failed', 'Could not fetch project signing keys. Check project status, URL and network.');
    process.exitCode = 1;
  }

  let client;
  try {
    if (!process.env.MIGRATION_DATABASE_URL || /YOUR_/i.test(process.env.MIGRATION_DATABASE_URL)) {
      report('database', 'missing', 'Enter session/direct PostgreSQL connection URI locally, not in chat.');
      process.exitCode = 1;
    } else {
      const config = migrationConnection();
      if (process.env.DATABASE_SSL !== 'true') throw new Error('TLS_REQUIRED');
      client = new pg.Client(config);
      await client.connect();
      report('authentication', 'ok', 'Database accepted credentials over verified TLS.');
      await client.query('BEGIN READ ONLY');
      const { rows } = await client.query("SELECT to_regclass('auth.users') IS NOT NULL AS has_auth, to_regnamespace('app') IS NOT NULL AS has_app");
      await client.query('ROLLBACK');
      // pg_stat_ssl describes pooler-to-Postgres, not THIS client's TLS to the pooler.
      if (!rows[0].has_auth || !client.connection.stream.encrypted || !client.connection.stream.authorized) throw new Error('WRONG_DATABASE');
      report('database', 'ok', 'TLS database connection and auth.users verified. No database changes made.');
      report('schema', rows[0].has_app ? 'present' : 'not_applied', rows[0].has_app ? 'Application schema exists; migration history still needs inspection.' : 'Application schema not present; migrations have not been run here.');
    }
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : '';
    const message = typeof error?.message === 'string' ? error.message : '';
    const hints = {
      '28P01': 'Database credentials rejected. Check the database password and pooler username.',
      ENOTFOUND: 'Database hostname could not be resolved. Check the session pooler host.',
      ENETUNREACH: 'Database network unreachable. Try the IPv4 session pooler.',
      ECONNREFUSED: 'Connection refused. Check project status, host and port.',
      SELF_SIGNED_CERT_IN_CHAIN: 'Install the trusted Supabase CA using NODE_EXTRA_CA_CERTS; keep TLS verification enabled.',
      UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'Install the trusted Supabase CA using NODE_EXTRA_CA_CERTS; keep TLS verification enabled.',
    };
    const fallback = /SASL|SCRAM|signature/i.test(message) ? 'Database authentication failed during SCRAM exchange. Recheck the pooler username and database password.'
      : /timeout|timed out/i.test(message) ? 'Database connection timed out; check host, port and project readiness.'
      : `Connection check failed (code: ${/^[A-Z0-9_]{1,60}$/.test(code) ? code : 'UNCLASSIFIED'}). Check URI, TLS certificate, project availability and network; credentials were not logged.`;
    report('database', 'failed', hints[code] ?? fallback);
    process.exitCode = 1;
  } finally { if (client) await client.end(); }
}
