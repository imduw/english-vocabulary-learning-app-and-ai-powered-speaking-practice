import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { HttpException } from '@nestjs/common';
import { SupabaseAuthService } from '../src/auth/supabase-auth.service';
import { parseProfileUpdate } from '../src/profiles/profile-input';
import { readConfig } from '../src/config';

const userId = '10000000-0000-4000-8000-000000000001';
const hasStatus = (status: number) => (error: unknown) => error instanceof HttpException && error.getStatus() === status;

test('Supabase verifier checks JWKS signature, issuer, audience, expiry, role and identity', async () => {
  const pair = await generateKeyPair('ES256');
  const jwk = { ...await exportJWK(pair.publicKey), kid: 'test-key', alg: 'ES256', use: 'sig' };
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const issuer = `http://127.0.0.1:${address.port}/auth/v1`;
  const service = new SupabaseAuthService({ port: 3000, database: {}, auth: { issuer, jwksUrl: issuer + '/.well-known/jwks.json' } });
  const now = Math.floor(Date.now() / 1000);
  const claims = { sub: userId, iss: issuer, aud: 'authenticated', role: 'authenticated', iat: now, exp: now + 300 };
  const token = (overrides: Record<string, unknown> = {}, key = pair.privateKey) => new SignJWT({ ...claims, ...overrides }).setProtectedHeader({ alg: 'ES256', kid: 'test-key' }).sign(key);
  try {
    assert.equal(await service.verify(await token()), userId);
    for (const overrides of [
      { exp: now - 60 }, { iss: 'https://attacker.example/auth/v1' }, { aud: 'wrong' },
      { role: 'service_role' }, { role: 'anon' }, { sub: 'invalid' }, { is_anonymous: true },
      { iat: now + 600 }, { nbf: now + 600 }, { exp: undefined },
    ]) await assert.rejects(service.verify(await token(overrides)), hasStatus(401));
    const other = await generateKeyPair('ES256');
    await assert.rejects(service.verify(await token({}, other.privateKey)), hasStatus(401));
    await assert.rejects(service.verify('not.a.jwt'), hasStatus(401));
    const hmac = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).sign(new Uint8Array(32));
    await assert.rejects(service.verify(hmac), hasStatus(401));
    assert.equal(requests, 1, 'public keys are cached, not fetched per request');
    await assert.rejects(new SupabaseAuthService({ port: 3000, database: {} }).verify(await token()), hasStatus(503));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('profile input rejects owner injection, no-op updates, whitespace and bigint overflow', () => {
  assert.deepEqual(parseProfileUpdate({ base_version: '1', display_name: '  Cam  ' }), { base_version: '1', display_name: 'Cam' });
  assert.deepEqual(parseProfileUpdate({ base_version: '1', display_name: null }), { base_version: '1', display_name: null });
  for (const input of [null, [], {}, { base_version: '1' }, { base_version: '1', user_id: userId },
    { base_version: '1', display_name: ' ' }, { base_version: 1, timezone: 'UTC' },
    { base_version: '9223372036854775808', timezone: 'UTC' }, { base_version: '1', timezone: null }]) {
    assert.throws(() => parseProfileUpdate(input), hasStatus(422));
  }
});

test('unavailable or malformed JWKS returns 503 instead of exposing provider diagnostics',async()=>{
  const pair=await generateKeyPair('ES256');
  const server=createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({keys:'invalid'}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const issuer=`http://127.0.0.1:${address.port}/auth/v1`;
  const service=new SupabaseAuthService({port:3000,database:{},auth:{issuer,jwksUrl:issuer+'/.well-known/jwks.json'}});
  const token=await new SignJWT({role:'authenticated'}).setSubject(userId).setIssuer(issuer).setAudience('authenticated').setIssuedAt().setExpirationTime('5m').setProtectedHeader({alg:'ES256',kid:'test-key'}).sign(pair.privateKey);
  try{await assert.rejects(service.verify(token),hasStatus(503));}
  finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('Auth configuration derives trusted JWKS URL and rejects unsafe origins', () => {
  const base = { DATABASE_URL: 'postgresql://user:password@127.0.0.1/test', DATABASE_SSL: 'false', NODE_ENV: 'development' };
  assert.deepEqual(readConfig({ ...base, SUPABASE_URL: 'https://project.supabase.co' }).auth, {
    issuer: 'https://project.supabase.co/auth/v1', jwksUrl: 'https://project.supabase.co/auth/v1/.well-known/jwks.json',
  });
  for (const SUPABASE_URL of ['http://remote.example', 'https://user:password@example.com', 'https://example.com/path', 'https://example.com?x=1']) {
    assert.throws(() => readConfig({ ...base, SUPABASE_URL }), /SUPABASE_URL/);
  }
});
