import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Test } from '@nestjs/testing';
import { AppModule } from '../dist/src/app.module.js';
import { APP_CONFIG, DatabaseService } from '../dist/src/database/database.service.js';
import { SupabaseAuthService } from '../dist/src/auth/supabase-auth.service.js';
import { configureHttp } from '../dist/src/common/http.js';
import { loadMigrations,runMigrations } from '../scripts/migration-runner.mjs';

const A='10000000-0000-4000-8000-000000000001',B='10000000-0000-4000-8000-000000000002';
test('sync protocol with transactional receipts and tenant-scoped change log',async t=>{
  const db=new PGlite();
  await db.exec('CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY)');
  await runMigrations({query:(sql,params)=>params?db.query(sql,params):db.exec(sql).then(r=>r.at(-1))},await loadMigrations(new URL('../database/migrations/',import.meta.url)));
  await db.query('INSERT INTO auth.users VALUES($1),($2)',[A,B]);
  const database={withUser:(id,work)=>db.transaction(async tx=>{
    await tx.exec('SET LOCAL ROLE vocabulary_api');await tx.query("SELECT set_config('app.user_id',$1,true)",[id]);
    return work({query:async(sql,params)=>{const r=await tx.query(sql,params);return {...r,rowCount:r.rows.length||r.affectedRows||0,rows:r.rows.map(row=>Object.hasOwn(row,'version')?{...row,version:String(row.version)}:row)};}});
  }),ping:async()=>{}};
  const module=await Test.createTestingModule({imports:[AppModule]}).overrideProvider(APP_CONFIG).useValue({port:3000,database:{}})
    .overrideProvider(DatabaseService).useValue(database).overrideProvider(SupabaseAuthService).useValue({verify:async token=>token==='A'?A:B}).compile();
  const app=module.createNestApplication({logger:false});configureHttp(app);await app.listen(0,'127.0.0.1');const origin=await app.getUrl();
  const api=async(method,path,body,user='A')=>{const r=await fetch(origin+'/api/v1/'+path,{method,headers:{'content-type':'application/json',...(user?{authorization:'Bearer '+user}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {...await r.json(),status:r.status};};
  const deck=randomUUID(),card=randomUUID();
  const mutation=(entity_type,entity_id,action,payload,base_version=null)=>({operation_id:randomUUID(),entity_type,entity_id,action,payload,base_version});
  const createDeck=mutation('deck',deck,'create',{name:'Sync deck'});
  const createCard=mutation('card',card,'create',{deck_id:deck,word:'bank',meaning:'context'});
  try {
    await t.test('validates auth/schema and commits parent-child batch atomically',async()=>{
      assert.equal((await api('POST','sync/batch',{items:[createDeck]},null)).status,401);
      assert.equal((await api('POST','sync/batch',{items:[]})).status,422);
      assert.equal((await api('POST','sync/batch',{items:[{...createDeck,user_id:B}]})).status,422);
      assert.equal((await api('POST','sync/batch',{items:[{...createDeck,payload:{name:'deck',id:deck}}]})).status,422);
      const result=await api('POST','sync/batch',{items:[createDeck,createCard]});assert.equal(result.status,200);assert.equal(result.data.results[1].record.version,'1');
      const repeated=await api('POST','sync/batch',{items:[createDeck,createCard]});assert.deepEqual(repeated.data,result.data);
      const changes=await api('GET','sync/changes');assert.equal(changes.data.changes.length,2);assert.equal(changes.data.changes[0].entity_type,'deck');
    });
    await t.test('reusing operation ID with changed payload is a conflict',async()=>{
      const conflict=await api('POST','sync/batch',{items:[{...createDeck,payload:{name:'changed'}}]});assert.equal(conflict.status,409);assert.equal(conflict.error.details.reason,'operation_reused');
      assert.equal((await api('GET','decks/'+deck)).data.name,'Sync deck');
    });
    await t.test('stale operation rolls back other NEW writes and receipts in batch',async()=>{
      const id=randomUUID();const create=mutation('deck',id,'create',{name:'rollback'});
      const stale=mutation('card',card,'update',{meaning:'stale'},'9');
      const conflict=await api('POST','sync/batch',{items:[create,stale]});assert.equal(conflict.status,409);assert.equal(conflict.error.details.server.version,'1');
      assert.equal((await api('GET','decks/'+id)).status,404);
      assert.equal((await db.query('SELECT * FROM app.sync_receipts WHERE operation_id=$1',[create.operation_id])).rows.length,0);
      assert.equal((await api('GET','sync/changes')).data.changes.length,2);
    });
    await t.test('pagination keeps a stable upper bound while ordinary CRUD writes log new events',async()=>{
      const first=await api('GET','sync/changes?limit=1');assert.equal(first.data.has_more,true);
      assert.equal((await api('PUT','vocabulary/'+card,{base_version:'1',meaning:'online edit'})).status,200);
      const second=await api('GET','sync/changes?limit=1&cursor='+first.data.next_cursor);assert.equal(second.data.has_more,false);assert.equal(second.data.changes.length,1);assert.equal(second.data.changes[0].record.version,'1');
      const next=await api('GET','sync/changes?cursor='+second.data.next_cursor);assert.equal(next.data.changes.length,1);assert.equal(next.data.changes[0].record.version,'2');
      assert.equal((await api('GET','sync/changes?cursor='+next.data.next_cursor)).data.changes.length,0);
      assert.equal((await api('GET','sync/changes?cursor='+first.data.next_cursor,undefined,'B')).status,422);
      assert.equal((await api('GET','sync/changes?cursor=bad')).status,422);
      assert.equal((await api('GET','sync/changes?limit=101')).status,422);
    });
    await t.test('lost response replay does not advance record version or change log twice',async()=>{
      const item=mutation('card',card,'update',{meaning:'once'},'2');
      const sent=await api('POST','sync/batch',{items:[item]});assert.equal(sent.status,200);assert.equal(sent.data.results[0].record.version,'3');
      const replay=await api('POST','sync/batch',{items:[item]});assert.deepEqual(replay.data,sent.data);
      assert.equal((await api('GET','vocabulary/'+card)).data.version,'3');
      assert.equal((await api('GET','sync/changes')).data.changes.length,4);
    });
    await t.test('isolates receipt/snapshot histories and carries deleted records as tombstones',async()=>{
      const unrelated=mutation('card',card,'update',{meaning:'attack'},'3');
      const denied=await api('POST','sync/batch',{items:[unrelated]},'B');assert.equal(denied.status,409);assert.equal(denied.error.details.server,null);
      assert.equal((await api('GET','sync/changes',undefined,'B')).data.changes.length,0);
      const remove=mutation('deck',deck,'delete',{},'1');assert.equal((await api('POST','sync/batch',{items:[remove]})).status,200);
      const tombstones=(await api('GET','sync/changes')).data.changes.filter(c=>c.record.deleted_at);assert.equal(tombstones.length,2);
      const stale=await api('POST','sync/batch',{items:[mutation('card',card,'update',{word:'resurrect'},'3')]});assert.equal(stale.status,409);assert.equal(stale.error.details.reason,'deleted');
      assert.equal((await api('GET','vocabulary/'+card)).status,404);
      await database.withUser(B,async client=>{assert.equal((await client.query('SELECT * FROM app.sync_receipts')).rows.length,0);assert.equal((await client.query('SELECT * FROM app.sync_changes')).rows.length,0);});
    });
    await t.test('sequence paging stays numeric after 9 and never skips parents/events',async()=>{
      for(let i=0;i<12;i++) {
        const id=randomUUID();
        assert.equal((await api('POST','sync/batch',{items:[mutation('deck',id,'create',{name:'ordering fixture'})]})).status,200);
      }
      const all=(await api('GET','sync/changes')).data.changes;
      const positions=all.map(c=>Number(c.sequence));
      assert.deepEqual(positions,[...positions].sort((a,b)=>a-b));
      let cursor,done=false;const paged=[];
      while(!done){const r=await api('GET','sync/changes?limit=3'+(cursor?'&cursor='+cursor:''));paged.push(...r.data.changes);cursor=r.data.next_cursor;done=!r.data.has_more;}
      assert.deepEqual(paged.map(c=>c.sequence),all.map(c=>c.sequence));
    });
    await t.test('tag changes keep per-version snapshots and replay receipts atomic',async()=>{
      const d=randomUUID(),c=randomUUID();
      const parent=mutation('deck',d,'create',{name:'Tag sync'});
      const first=mutation('card',c,'create',{deck_id:d,word:'tagged',meaning:'sync fixture',tags:['Travel']});
      const second=mutation('card',c,'update',{tags:['TOEIC']},'1');
      const sent=await api('POST','sync/batch',{items:[parent,first,second]});assert.equal(sent.status,200);
      assert.deepEqual(sent.data.results[1].record.tags,['Travel']);assert.equal(sent.data.results[1].record.version,'1');
      assert.deepEqual(sent.data.results[2].record.tags,['TOEIC']);assert.equal(sent.data.results[2].record.version,'2');
      const logged=(await db.query("SELECT snapshot FROM app.sync_changes WHERE user_id=$1 AND entity_id=$2 ORDER BY sequence",[A,c])).rows;
      assert.deepEqual(logged.map(row=>row.snapshot.tags),[['Travel'],['TOEIC']]);
      const replay=await api('POST','sync/batch',{items:[first]});assert.deepEqual(replay.data.results[0],sent.data.results[1]);
      assert.equal((await api('POST','sync/batch',{items:[{...first,payload:{...first.payload,tags:['Different']}}]})).status,409);
      const rolled=mutation('card',c,'update',{tags:['Rolled back tag']},'2');
      const stale=mutation('card',c,'update',{meaning:'stale'},'1');
      assert.equal((await api('POST','sync/batch',{items:[rolled,stale]})).status,409);
      assert.deepEqual((await api('GET','vocabulary/'+c)).data.tags,['TOEIC']);
      assert.equal((await db.query("SELECT * FROM app.tags WHERE user_id=$1 AND name='Rolled back tag'",[A])).rows.length,0);
      assert.equal((await db.query('SELECT * FROM app.sync_receipts WHERE user_id=$1 AND operation_id=$2',[A,rolled.operation_id])).rows.length,0);
    });
  }finally{await app.close();await db.close();}
});
