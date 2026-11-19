import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config';

const local = { DATABASE_URL: 'postgresql://demo:secret@127.0.0.1:5432/vocabulary', DATABASE_SSL: 'false' };

test('configuration rejects missing URL and invalid numeric values without leaking secrets', () => {
  assert.throws(() => readConfig({}), /DATABASE_URL/);
  for (const key of ['PORT', 'DATABASE_POOL_MAX', 'DATABASE_TIMEOUT_MS']) {
    for (const invalid of ['0', '-1', 'abc', '1.5', '999999']) {
      assert.throws(() => readConfig({ ...local, [key]: invalid }), new RegExp(key));
    }
  }
  assert.throws(() => readConfig({ ...local, DATABASE_URL: 'password=secret' }), { message: 'Invalid DATABASE_URL' });
});

test('TLS cannot be disabled remotely or overridden through URL parameters', () => {
  assert.equal(readConfig(local).database.ssl, false);
  assert.throws(() => readConfig({ ...local, NODE_ENV: 'production' }), /TLS/);
  assert.throws(() => readConfig({ ...local, DATABASE_URL: 'postgresql://user:secret@remote.example/app' }), /TLS/);
  assert.throws(() => readConfig({ ...local, DATABASE_URL: local.DATABASE_URL + '?sslmode=no-verify' }), /DATABASE_SSL/);
  assert.deepEqual(readConfig({ DATABASE_URL: 'postgresql://user:secret@remote.example/app' }).database.ssl, { rejectUnauthorized: true });
});

test('OCR engine/warmup are explicit and invalid options fail at startup',()=>{
  assert.equal(readConfig({...local,NODE_ENV:'test'}).ocr?.warmup,false);
  assert.equal(readConfig(local).ocr?.engine,'wasm');
  assert.deepEqual(readConfig({...local,OCR_ENGINE:'native',OCR_WARMUP:'true'}).ocr,{engine:'native',warmup:true});
  assert.throws(()=>readConfig({...local,OCR_ENGINE:'external'}),/OCR_ENGINE/);
  assert.throws(()=>readConfig({...local,OCR_WARMUP:'yes'}),/OCR_WARMUP/);
});

test('Auth proxy accepts only a publishable key tied to a configured project',()=>{
  const configured={...local,SUPABASE_URL:'https://project.supabase.co'};
  assert.equal(readConfig({...configured,SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture'}).auth?.publishableKey,'sb_publishable_fixture');
  for(const key of ['sb_secret_private','service_role','sb_publishable_bad\nkey'])assert.throws(()=>readConfig({...configured,SUPABASE_PUBLISHABLE_KEY:key}),/SUPABASE_PUBLISHABLE_KEY/);
  assert.throws(()=>readConfig({...local,SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture'}),/SUPABASE_PUBLISHABLE_KEY/);
});
