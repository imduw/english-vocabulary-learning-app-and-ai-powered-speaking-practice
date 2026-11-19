// Explicit integration check for THIS repository's disposable Compose database.
// No .env loading: never use a user's remote/Supabase credentials for this script.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { once } from 'node:events';
import pg from 'pg';
import { loadMigrations, runMigrations } from './migration-runner.mjs';
import { checkLearningApi } from './check-learning-api.mjs';
import { checkSyncApi } from './check-sync-api.mjs';
import { checkProgressApi } from './check-progress-api.mjs';
import { checkDatabaseRecovery } from './check-database-recovery.mjs';
import { checkConcurrentLoad } from './check-concurrent-load.mjs';
import { checkOfflineClient } from './check-offline-client.mjs';

const admin = new pg.Client({ connectionString: 'postgresql://cam_migrator:local_migration_only@127.0.0.1:54329/vocabulary', connectionTimeoutMillis: 5000 });
let child;
let exited;
let jwksServer;
try {
  await admin.connect();
  // Ensure the local-only auth fixture, not a real Supabase auth schema.
  const columns = await admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema='auth' AND table_name='users'");
  assert.deepEqual(columns.rows.map(row => row.column_name), ['id']);
  const migrations = await loadMigrations(new URL('../database/migrations/', import.meta.url));
  await runMigrations(admin, migrations);
  assert.deepEqual(await runMigrations(admin, migrations), []);
  await admin.query(await readFile(new URL('../database/local/seed.sql', import.meta.url), 'utf8'));
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM app_migrations.history')).rows[0].n, migrations.length);
  await admin.query('BEGIN');
  try {
    await assert.rejects(admin.query("UPDATE app.cards SET deck_id='20000000-0000-4000-8000-000000000002' WHERE id='30000000-0000-4000-8000-000000000001'"), { code: '23503' });
  } finally { await admin.query('ROLLBACK'); }

  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const keys = await generateKeyPair('ES256');
  const jwk = { ...await exportJWK(keys.publicKey), kid: 'local-test-only', alg: 'ES256', use: 'sig' };
  jwksServer = createHttpServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); });
  jwksServer.listen(0, '127.0.0.1');
  await once(jwksServer, 'listening');
  const authUrl = `http://127.0.0.1:${jwksServer.address().port}`;
  child = spawn(process.execPath, ['dist/src/main.js'], {
    cwd: new URL('../', import.meta.url), windowsHide: true,
    env: { ...process.env, NODE_ENV: 'development', PORT: String(port), DATABASE_URL: 'postgresql://cam_backend:local_backend_only@127.0.0.1:54329/vocabulary', DATABASE_SSL: 'false', SUPABASE_URL: authUrl },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  exited = once(child, 'exit');
  const url = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { ready = (await fetch(url + '/health')).status === 200; if (ready) break; } catch {}
    if (child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'readiness must succeed with the actual Compose PostgreSQL');
  assert.equal((await (await fetch(url + '/health')).json()).data.database, 'up');
  assert.equal((await fetch(url + '/docs/')).status, 200);
  const contract = await (await fetch(url + '/openapi.json')).json();
  assert.equal(contract.openapi, '3.0.3');
  assert.equal((await fetch(url + '/api/v1/vocabulary')).status, 401);
  const endpoint = url + '/api/v1/user/profile';
  const a = '10000000-0000-4000-8000-000000000001';
  const b = '10000000-0000-4000-8000-000000000002';
  const c = '10000000-0000-4000-8000-000000000003';
  await admin.query('INSERT INTO auth.users(id) VALUES ($1) ON CONFLICT DO NOTHING', [c]);
  const sign = (id, expiration = '5m') => new SignJWT({ role: 'authenticated' }).setSubject(id).setIssuer(authUrl + '/auth/v1').setAudience('authenticated').setIssuedAt().setExpirationTime(expiration).setProtectedHeader({ alg: 'ES256', kid: 'local-test-only' }).sign(keys.privateKey);
  const tokenA = await sign(a);
  const tokenB = await sign(b);
  const tokenC = await sign(c);
  const headers = token => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
  assert.equal((await fetch(endpoint)).status, 401);
  assert.equal((await fetch(endpoint, { headers: headers(await sign(a, '-1m')) })).status, 401);
  const getProfile = async token => {
    const response = await fetch(endpoint, { headers: headers(token) });
    assert.equal(response.status, 200, 'verified user must read their profile');
    return (await response.json()).data;
  };
  assert.equal((await getProfile(tokenA)).user_id, a);
  const beforeB = await getProfile(tokenB);
  const beforeC = await getProfile(tokenC);
  assert.equal((await getProfile(tokenC)).version, beforeC.version, 'GET provisioning is idempotent');
  const patch = (token, body) => fetch(endpoint, { method: 'PATCH', headers: headers(token), body: JSON.stringify(body) });
  assert.equal((await patch(tokenA, { base_version: '1', user_id: b, display_name: 'attack' })).status, 422);
  assert.deepEqual(await getProfile(tokenB), beforeB);
  assert.equal((await patch(tokenC, { base_version: beforeC.version, timezone: 'Invalid/Zone' })).status, 422);
  const changed = await patch(tokenC, { base_version: beforeC.version, display_name: 'CAM Auth fixture', timezone: 'Asia/Ho_Chi_Minh' });
  assert.equal(changed.status, 200);
  const updated = (await changed.json()).data;
  assert.equal(updated.version, String(BigInt(beforeC.version) + 1n));
  assert.equal((await patch(tokenC, { base_version: beforeC.version, display_name: 'stale' })).status, 409);
  assert.equal((await getProfile(tokenC)).display_name, 'CAM Auth fixture');
  assert.deepEqual(await getProfile(tokenB), beforeB, 'pool must not leak user identity after rollback or switching users');
  await checkLearningApi({origin:url,tokenA,tokenB,report:(step,status)=>console.log(JSON.stringify({step,status}))});
  await checkProgressApi({origin:url,tokenA,tokenB,report:(step,status)=>console.log(JSON.stringify({step,status}))});
  await checkSyncApi({origin:url,accountId:a,tokenA,tokenB,admin,report:(step,status)=>console.log(JSON.stringify({step,status}))});
  if(process.argv.includes('--offline-client'))await checkOfflineClient({origin:url,ownerA:a,ownerB:b,tokenA,tokenB});
  await checkConcurrentLoad({origin:url,accountA:a,accountB:b,tokenA,tokenB,admin,report:(step,status)=>console.log(JSON.stringify({step,status}))});
  await checkDatabaseRecovery({report:(step,status)=>console.log(JSON.stringify({step,status}))});
  console.log('PASS: PostgreSQL TCP, migrations, seed, owner FK, readiness/Swagger and signed-JWT profile API (401/200/422/409), isolation and idempotent provisioning. Test keys discarded; temporary backend stopped; database left running.');
} catch (error) {
  console.error('Local integration check failed:', error instanceof assert.AssertionError ? error.message : 'Check Docker database and build output; no connection details logged.');
  process.exitCode = 1;
} finally {
  if (child) { child.kill(); await exited; }
  if (jwksServer) { jwksServer.closeAllConnections(); await new Promise(resolve => jwksServer.close(resolve)); }
  await admin.end();
}
