import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Test } from '@nestjs/testing';
import { configureApiDocs } from '../src/api-docs';

test('Swagger assets and the current JSON specification are served', async () => {
  const module = await Test.createTestingModule({}).compile();
  const app = module.createNestApplication({ logger: false });
  configureApiDocs(app);
  await app.listen(0, '127.0.0.1');
  try {
    const base = await app.getUrl();
    const response = await fetch(base + '/openapi.json');
    assert.equal(response.status, 200);
    const spec = await response.json() as { openapi: string; paths: Record<string, { get: Record<string, string> }> };
    assert.equal(spec.openapi, '3.0.3');
    assert.equal(spec.paths['/api/v1/vocabulary'].get['x-implementation-status'], 'implemented');
    const docs = await fetch(base + '/docs/');
    assert.equal(docs.status, 200);
    assert.match(await docs.text(), /swagger-ui/);
    assert.equal((await fetch(base + '/docs/swagger-ui.css')).status, 200);
    assert.equal((await fetch(base + '/api/v1/vocabulary')).status, 404);
  } finally { await app.close(); }
});
