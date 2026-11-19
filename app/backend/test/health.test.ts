import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Test } from '@nestjs/testing';
import { Controller, Get } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { configureHttp } from '../src/common/http';
import { APP_CONFIG, DatabaseService } from '../src/database/database.service';

test('real HTTP health responses: readiness, outage, recovery and sanitized errors', async () => {
  let available = true;
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG).useValue({ port: 3000, database: {} })
    .overrideProvider(DatabaseService).useValue({ ping: async () => {
      if (!available) throw new Error('postgres://private:password@secret-host/db');
    } }).compile();
  const app = module.createNestApplication({ logger: false });
  configureHttp(app);
  await app.listen(0, '127.0.0.1');
  try {
    const base = await app.getUrl();
    assert.equal((await fetch(base + '/health')).status, 200);
    available = false;
    const down = await fetch(base + '/health');
    assert.equal(down.status, 503);
    assert.ok(down.headers.get('x-request-id'));
    const body = await down.text();
    assert.match(body, /SERVICE_UNAVAILABLE/);
    assert.doesNotMatch(body, /password|secret-host|postgres/);
    assert.equal((await fetch(base + '/health/live')).status, 200);
    available = true;
    assert.equal((await fetch(base + '/health')).status, 200);
    const missing = await fetch(base + '/not-found?token=secret');
    assert.equal(missing.status, 404);
    assert.doesNotMatch(await missing.text(), /token|secret/);
  } finally { await app.close(); }
});

@Controller('test-failure')
class FailureController {
  @Get() fail(): never { throw new Error('SQL and password must not escape'); }
}

test('global filter sanitizes unexpected server errors', async () => {
  const module = await Test.createTestingModule({ controllers: [FailureController] }).compile();
  const app = module.createNestApplication({ logger: false });
  configureHttp(app);
  await app.listen(0, '127.0.0.1');
  try {
    const response = await fetch((await app.getUrl()) + '/test-failure');
    assert.equal(response.status, 500);
    const body = await response.text();
    assert.match(body, /INTERNAL_ERROR/);
    assert.doesNotMatch(body, /SQL|password/);
  } finally { await app.close(); }
});
