// Real development integration test. Credentials come only from ignored local env.
// Logs contain step names/statuses only; never response bodies or tokens.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import pg from 'pg';
import { migrationConnection } from './database-config.mjs';
import { checkLearningApi } from './check-learning-api.mjs';
import { checkSyncApi } from './check-sync-api.mjs';
import { checkProgressApi } from './check-progress-api.mjs';

const report = (step, status) => console.log(JSON.stringify({ step, status }));
let stage = 'configuration';
let child;
let exited;
let db;
let origin;
let authOrigin;
let key;
const sessions = [];
let originalA;
let tokenA;
let changedA = false;

async function auth(path, body, token) {
  const response = await fetch(new URL(`/auth/v1/${path}`, authOrigin), {
    method: 'POST', headers: { apikey: key, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    // Whitelist known error identifiers; do not print arbitrary server messages.
    const safeCodes = ['invalid_credentials', 'email_not_confirmed', 'over_request_rate_limit', 'refresh_token_not_found', 'refresh_token_already_used'];
    const label = safeCodes.includes(data.error_code) ? data.error_code : safeCodes.includes(data.code) ? data.code : `HTTP_${response.status}`;
    throw new Error(label);
  }
  return data;
}

async function api(method, token, body) {
  const response = await fetch(`${origin}/api/v1/user/profile`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000),
  });
  return { status: response.status, body: await response.json() };
}

try {
  const project = new URL(process.env.SUPABASE_URL ?? '');
  key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (process.env.NODE_ENV !== 'development' || project.protocol !== 'https:' || !project.hostname.endsWith('.supabase.co')
    || project.pathname !== '/' || project.username || project.password || project.search || project.hash
    || !key?.startsWith('sb_publishable_') || !process.env.DATABASE_URL || process.env.DATABASE_SSL !== 'true') {
    throw new Error('MISSING_DEVELOPMENT_CONFIGURATION');
  }
  authOrigin = project.origin;
  const accounts = ['A', 'B'].map(label => ({ email: process.env[`TEST_${label}_EMAIL`], password: process.env[`TEST_${label}_PASSWORD`] }));
  if (accounts.some(account => !account.email?.endsWith('@example.com') || !account.password) || accounts[0].email === accounts[1].email) {
    throw new Error('MISSING_DISTINCT_TEST_ACCOUNTS');
  }

  stage = 'login_A_B';
  for (const account of accounts) {
    const session = await auth('token?grant_type=password', account);
    assert.ok(session.access_token && session.refresh_token && session.user?.id);
    sessions.push(session);
  }
  assert.notEqual(sessions[0].user.id, sessions[1].user.id);
  tokenA = sessions[0].access_token;
  report(stage, 'passed');

  stage = 'start_backend';
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const childEnv = { ...process.env, PORT: String(port) };
  for (const name of ['MIGRATION_DATABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'TEST_A_PASSWORD', 'TEST_B_PASSWORD']) delete childEnv[name];
  child = spawn(process.execPath, ['dist/src/main.js'], { cwd: new URL('../', import.meta.url), env: childEnv, windowsHide: true, stdio: 'ignore' });
  exited = once(child, 'exit');
  origin = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 150; i++) {
    try { ready = (await fetch(`${origin}/health/live`, { signal: AbortSignal.timeout(1000) })).ok; if (ready) break; } catch {}
    if (child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready);

  stage = 'protected_profile';
  assert.equal((await api('GET')).status, 401);
  const profileA = await api('GET', tokenA);
  assert.equal(profileA.status, 200);
  assert.equal(profileA.body.data.user_id, sessions[0].user.id);
  originalA = profileA.body.data;
  const profileB = await api('GET', sessions[1].access_token);
  assert.equal(profileB.status, 200);
  assert.equal(profileB.body.data.user_id, sessions[1].user.id);
  assert.deepEqual((await api('GET', tokenA)).body.data, originalA);
  report(stage, 'passed');

  stage = 'owner_injection_and_jwt_tampering';
  assert.equal((await api('PATCH', tokenA, { base_version: originalA.version, user_id: sessions[1].user.id, display_name: 'Denied' })).status, 422);
  const parts = tokenA.split('.');
  const forgedPayload = { ...JSON.parse(Buffer.from(parts[1], 'base64url').toString()), sub: sessions[1].user.id };
  parts[1] = Buffer.from(JSON.stringify(forgedPayload)).toString('base64url');
  assert.equal((await api('GET', parts.join('.'))).status, 401);
  assert.deepEqual((await api('GET', sessions[1].access_token)).body.data, profileB.body.data);
  report(stage, 'passed');

  stage = 'profile_update_and_version_conflict';
  const changed = await api('PATCH', tokenA, { base_version: originalA.version, display_name: 'CAM integration check', timezone: 'Asia/Ho_Chi_Minh' });
  assert.equal(changed.status, 200);
  changedA = true;
  assert.equal(changed.body.data.version, String(BigInt(originalA.version) + 1n));
  assert.equal((await api('PATCH', tokenA, { base_version: originalA.version, display_name: 'Stale update' })).status, 409);
  assert.equal((await api('PATCH', tokenA, { base_version: changed.body.data.version, timezone: 'Invalid/Zone' })).status, 422);
  assert.deepEqual((await api('GET', sessions[1].access_token)).body.data, profileB.body.data);
  report(stage, 'passed');

  stage = 'database_RLS';
  db = new pg.Client({ ...migrationConnection(), connectionString: process.env.DATABASE_URL });
  await db.connect();
  assert.equal((await db.query('SELECT user_id FROM app.profiles')).rowCount, 0);
  await db.query('BEGIN');
  try {
    await db.query("SELECT set_config('app.user_id',$1,true)", [originalA.user_id]);
    const visible = await db.query('SELECT user_id FROM app.profiles');
    assert.deepEqual(visible.rows.map(row => row.user_id), [originalA.user_id]);
    assert.equal((await db.query('UPDATE app.profiles SET display_name=$1 WHERE user_id=$2 RETURNING user_id', ['Denied', profileB.body.data.user_id])).rowCount, 0);
  } finally { await db.query('ROLLBACK'); }
  assert.equal((await db.query('SELECT user_id FROM app.profiles')).rowCount, 0);
  report(stage, 'passed');

  stage = 'refresh_session';
  const refreshed = await auth('token?grant_type=refresh_token', { refresh_token: sessions[0].refresh_token });
  sessions[0] = refreshed;
  tokenA = refreshed.access_token;
  assert.equal((await api('GET', tokenA)).status, 200);
  report(stage, 'passed');
  stage = 'learning_API';
  await checkLearningApi({origin,tokenA,tokenB:sessions[1].access_token,report});
  stage='progress_API';
  await checkProgressApi({origin,tokenA,tokenB:sessions[1].access_token,report});
  stage='sync_protocol';
  await checkSyncApi({origin,accountId:sessions[0].user.id,tokenA,tokenB:sessions[1].access_token,report});
} catch (error) {
  const safe = ['MISSING_DEVELOPMENT_CONFIGURATION', 'MISSING_DISTINCT_TEST_ACCOUNTS', 'invalid_credentials', 'email_not_confirmed', 'over_request_rate_limit'];
  report(stage, safe.includes(error?.message) ? error.message : error?.code === 'ERR_ASSERTION' ? 'assertion_failed' : 'failed_check_configuration_or_network');
  process.exitCode = 1;
} finally {
  if (db) await db.end();
  if (changedA && originalA && origin && tokenA) {
    try {
      const current = await api('GET', tokenA);
      const restored = await api('PATCH', tokenA, { base_version: current.body.data.version, display_name: originalA.display_name, timezone: originalA.timezone });
      assert.equal(restored.status, 200);
      report('restore_A_profile', 'passed_content_restored_version_increased');
    } catch { report('restore_A_profile', 'failed_check_test_profile_manually'); process.exitCode = 1; }
  }
  for (const session of sessions) {
    try { await auth('logout?scope=local', undefined, session.access_token); report('close_test_session', 'passed'); }
    catch { report('close_test_session', 'failed'); process.exitCode = 1; }
  }
  if (child) { child.kill(); await exited; }
}
if (!process.exitCode) report('real_supabase_auth_integration', 'passed');
