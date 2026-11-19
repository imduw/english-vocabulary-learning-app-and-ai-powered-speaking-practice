import { randomBytes } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import pg from 'pg';
import { migrationConnection } from './database-config.mjs';

// Backend-only database login; never issue Auth users or application tokens here.
const role = 'vocabulary_backend';
const configFile = new URL('../.env.supabase.local', import.meta.url);
let admin;
let runtime;
try {
  const project = new URL(process.env.SUPABASE_URL ?? '');
  const reference = project.hostname.split('.')[0];
  const settings = migrationConnection();
  const migrationUrl = new URL(settings.connectionString);
  if (!/^[a-z]{20}$/.test(reference) || project.protocol !== 'https:' || !project.hostname.endsWith('.supabase.co')
    || migrationUrl.username !== `postgres.${reference}` || migrationUrl.port !== '5432'
    || !migrationUrl.hostname.endsWith('.pooler.supabase.com') || process.env.DATABASE_SSL !== 'true') {
    throw new Error('CONFIG_MISMATCH');
  }
  admin = new pg.Client(settings);
  await admin.connect();
  const prior = await admin.query('SELECT rolname FROM pg_roles WHERE rolname=$1', [role]);
  if (prior.rowCount) {
    // Repeated runs may validate the current private configuration, never rotate silently.
    if (!process.env.DATABASE_URL) throw new Error('EXISTING_ROLE_WITHOUT_LOCAL_CREDENTIAL');
  } else {
    if (process.env.DATABASE_URL) throw new Error('EXISTING_LOCAL_CONFIGURATION');
    const password = randomBytes(32).toString('hex');
    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = `${role}.${reference}`;
    runtimeUrl.password = password;
    let text = await readFile(configFile, 'utf8');
    if (!/^DATABASE_URL=.*$/m.test(text)) throw new Error('MISSING_CONFIG_FIELD');
    await admin.query('BEGIN');
    try {
      // Role name is a constant; password is generated hex (not user-supplied SQL).
      await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT`);
      await admin.query(`GRANT vocabulary_api TO ${role}`);
      await admin.query(`GRANT CONNECT ON DATABASE postgres TO ${role}`);
      await admin.query('COMMIT');
    } catch (error) { await admin.query('ROLLBACK'); throw error; }
    text = text.replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=${runtimeUrl.toString()}`);
    const temp = new URL('../.env.supabase.local.tmp', import.meta.url);
    await writeFile(temp, text, { encoding: 'utf8', mode: 0o600 });
    await rename(temp, configFile);
    process.env.DATABASE_URL = runtimeUrl.toString();
    console.log('Created restricted runtime role; generated credential saved only in ignored local environment file.');
  }
  const runtimeUrl = new URL(process.env.DATABASE_URL);
  if (runtimeUrl.hostname !== migrationUrl.hostname || runtimeUrl.pathname !== migrationUrl.pathname
    || runtimeUrl.username !== `${role}.${reference}`) throw new Error('RUNTIME_TARGET_MISMATCH');
  runtime = new pg.Client({ ...settings, connectionString: runtimeUrl.toString() });
  await runtime.connect();
  const flags = (await runtime.query('SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname=current_user')).rows[0];
  if (!flags || Object.values(flags).some(Boolean)) throw new Error('UNSAFE_ROLE');
  const isolated = await runtime.query('SELECT user_id FROM app.profiles');
  if (isolated.rowCount !== 0) throw new Error('RLS_IDENTITY_REQUIRED');
  console.log('PASS: restricted Supabase runtime login works over verified TLS; profile rows hidden without verified transaction identity.');
} catch {
  console.error('Runtime setup/verification failed; no credentials logged. Check migration state and local configuration. Existing credentials were not rotated.');
  process.exitCode = 1;
} finally {
  if (runtime) await runtime.end();
  if (admin) await admin.end();
}
