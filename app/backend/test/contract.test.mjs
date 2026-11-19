import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const path = new URL('../api/openapi.json', import.meta.url);
const load = async () => JSON.parse(await readFile(path, 'utf8'));

test('OpenAPI 3 contract is valid, planned routes are explicit and operation IDs unique', async () => {
  const spec = await SwaggerParser.validate(await load());
  const ids = new Set();
  let count = 0;
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (method === 'parameters') continue;
      assert.ok(!ids.has(operation.operationId));
      ids.add(operation.operationId);
      count++;
      if (path.startsWith('/api/')) {
        assert.equal(operation['x-implementation-status'], 'implemented');
        if(path.startsWith('/api/v1/auth/')){assert.deepEqual(operation.security,[]);for(const code of ['400','422','429','503'])assert.ok(operation.responses[code]);continue;}
        assert.ok(operation.responses['401']);
        if(path!=='/api/v1/ocr/process')assert.ok(operation.responses['409']);
        else for(const code of ['400','413','429','503'])assert.ok(operation.responses[code]);
      } else {
        assert.equal(operation['x-implementation-status'], 'implemented');
        assert.deepEqual(operation.security, []);
      }
    }
  }
  assert.equal(count, 25);
  assert.equal(spec.components.securitySchemes.SupabaseBearer.scheme, 'bearer');
});

test('all request/response examples match their schemas', async () => {
  const spec = await SwaggerParser.dereference(await load());
  const ajv = new Ajv({ strict: false, validateFormats: true });
  addFormats(ajv);
  let checked = 0;
  for (const item of Object.values(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (method === 'parameters') continue;
      const entries = [op.requestBody, ...Object.values(op.responses)].filter(Boolean);
      for (const entry of entries) {
        const media = entry.content?.['application/json'];
        if (!media || media.example === undefined) continue;
        const valid = ajv.compile(media.schema);
        assert.ok(valid(media.example), `${op.operationId}: ${JSON.stringify(valid.errors)}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 50);
});

test('input schemas reject owner injection, missing fields and malformed versions', async () => {
  const { components: { schemas } } = await SwaggerParser.dereference(await load());
  const ajv = new Ajv({ strict: false });
  addFormats(ajv);
  const create = ajv.compile(schemas.CardCreate);
  const sample = { id: '30000000-0000-4000-8000-000000000001', deck_id: '20000000-0000-4000-8000-000000000001', word: 'bank', meaning: 'ngân hàng' };
  assert.ok(create(sample));
  assert.ok(create({...sample,tags:['Travel','Café']}));
  for(const tags of [null,[''],['x'.repeat(51)],['Travel','Travel'],Array.from({length:21},(_,i)=>String(i))])assert.equal(create({...sample,tags}),false);
  assert.equal(create({ ...sample, user_id: '10000000-0000-4000-8000-000000000001' }), false);
  assert.equal(create({ ...sample, word: '' }), false);
  assert.equal(create({ ...sample, id: 'invalid' }), false);
  const update = ajv.compile(schemas.CardUpdate);
  assert.ok(update({ base_version: '1', phonetic: null }));
  assert.ok(update({base_version:'1',tags:[]}));
  assert.equal(update({ base_version: '1' }), false);
  assert.equal(update({ base_version: 1, is_favorite: true }), false);
  assert.equal(update({ base_version: '0', is_favorite: true }), false);
  const batch = ajv.compile(schemas.CardBatch);
  assert.equal(batch({ items: [] }), false);
  assert.equal(batch({ items: Array(101).fill(sample) }), false);
  const profile = ajv.compile(schemas.ProfileUpdate);
  assert.ok(profile({ base_version: '1', display_name: null }));
  assert.equal(profile({ base_version: '1', display_name: '' }), false);
});

test('Postman collection covers the contract without embedding a token', async () => {
  const spec = await SwaggerParser.dereference(await load());
  const collection = JSON.parse(await readFile(new URL('../api/postman.collection.json', import.meta.url), 'utf8'));
  assert.equal(collection.variable.find(v => v.key === 'access_token').value, '');
  const count = Object.values(spec.paths).reduce((sum, item) => sum + Object.keys(item).filter(k => k !== 'parameters').length, 0);
  assert.equal(collection.item.length, count);
  const operations=new Map(Object.values(spec.paths).flatMap(path=>Object.values(path).filter(op=>op.operationId).map(op=>[op.operationId,op])));
  const ajv=new Ajv({strict:false});addFormats(ajv);
  for (const item of collection.item) {
    assert.ok(item.request.url.startsWith('{{base_url}}'));
    if (item.request.url.includes('/health')) assert.equal(item.request.auth.type, 'noauth');
    if(item.request.body?.mode==='raw'){
      const operation=operations.get(item.name.split(' ').at(-1));assert.ok(operation,'Unknown Postman operation');
      const schema=operation.requestBody?.content?.['application/json']?.schema;assert.ok(schema);
      const validate=ajv.compile(schema);
      assert.ok(validate(JSON.parse(item.request.body.raw)),item.name+': '+JSON.stringify(validate.errors));
    }
  }
  for(const name of ['local','supabase-dev']){
    const environment=JSON.parse(await readFile(new URL('../api/postman.'+name+'.environment.json',import.meta.url),'utf8'));
    const values=new Map(environment.values.map(v=>[v.key,v]));
    assert.equal(values.get('access_token').value,'');assert.equal(values.get('access_token').type,'secret');
    assert.equal(values.get('base_url').value,'http://localhost:'+(name==='local'?3000:3001));
    for(const variable of collection.variable)assert.ok(values.has(variable.key));
  }
});
