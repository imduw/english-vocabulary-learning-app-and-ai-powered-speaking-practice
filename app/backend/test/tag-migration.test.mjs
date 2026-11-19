import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { loadMigrations, runMigrations } from '../scripts/migration-runner.mjs';

test('tag migration upgrades old cards and immutable sync receipts without changing versions or sequence',async()=>{
  const db=new PGlite();
  const connection={query:(sql,params)=>params?db.query(sql,params):db.exec(sql).then(result=>result.at(-1))};
  try {
    await db.exec('CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY)');
    const migrations=await loadMigrations(new URL('../database/migrations/',import.meta.url));
    await runMigrations(connection,migrations.slice(0,migrations.findIndex(m=>m.name.startsWith('007_'))));
    const owner=randomUUID(),deck=randomUUID(),card=randomUUID(),operation=randomUUID();
    await db.query('INSERT INTO auth.users VALUES($1)',[owner]);
    await db.query('INSERT INTO app.profiles(user_id) VALUES($1)',[owner]);
    await db.query("INSERT INTO app.decks(id,user_id,name) VALUES($1,$2,'upgrade')",[deck,owner]);
    await db.query("INSERT INTO app.cards(id,user_id,deck_id,word,meaning) VALUES($1,$2,$3,'old','context')",[card,owner,deck]);
    const before=(await db.query('SELECT * FROM app.cards WHERE id=$1',[card])).rows[0];
    const snapshot=(await db.query("SELECT snapshot FROM app.sync_changes WHERE entity_type='card'")).rows[0].snapshot;
    const result={operation_id:operation,entity_type:'card',entity_id:card,record:snapshot};
    await db.query("INSERT INTO app.sync_receipts(user_id,operation_id,request_hash,result) VALUES($1,$2,'retained',$3::jsonb)",[owner,operation,JSON.stringify(result)]);
    const head=(await db.query('SELECT last_sequence FROM app.sync_heads WHERE user_id=$1',[owner])).rows[0].last_sequence;
    await runMigrations(connection,migrations);
    assert.deepEqual(await runMigrations(connection,migrations),[]);
    const after=(await db.query('SELECT * FROM app.cards WHERE id=$1',[card])).rows[0];
    assert.deepEqual(after,{...before,tags:[]});
    const receipt=(await db.query('SELECT request_hash,result FROM app.sync_receipts')).rows[0];
    assert.equal(receipt.request_hash,'retained');assert.deepEqual(receipt.result,{...result,record:{...snapshot,tags:[]}});
    assert.deepEqual((await db.query("SELECT snapshot FROM app.sync_changes WHERE entity_type='card'")).rows[0].snapshot,{...snapshot,tags:[]});
    assert.equal((await db.query('SELECT last_sequence FROM app.sync_heads WHERE user_id=$1',[owner])).rows[0].last_sequence,head);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM app.tags')).rows[0].n,0);
  } finally {await db.close();}
});
