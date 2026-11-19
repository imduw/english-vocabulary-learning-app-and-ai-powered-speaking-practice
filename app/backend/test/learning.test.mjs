import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { Test } from '@nestjs/testing';
import { AppModule } from '../dist/src/app.module.js';
import { APP_CONFIG, DatabaseService } from '../dist/src/database/database.service.js';
import { SupabaseAuthService } from '../dist/src/auth/supabase-auth.service.js';
import { configureHttp } from '../dist/src/common/http.js';
import { loadMigrations, runMigrations } from '../scripts/migration-runner.mjs';

const A='10000000-0000-4000-8000-000000000001',B='10000000-0000-4000-8000-000000000002';
test('learning API over HTTP with PostgreSQL constraints, RLS and transactions', async t=>{
  const db=new PGlite();
  await db.exec('CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY)');
  await runMigrations({query:(sql,params)=>params?db.query(sql,params):db.exec(sql).then(r=>r.at(-1))},await loadMigrations(new URL('../database/migrations/',import.meta.url)));
  await db.query('INSERT INTO auth.users(id) VALUES ($1),($2)',[A,B]);
  const database={withUser:(id,work)=>db.transaction(async tx=>{
    await tx.exec('SET LOCAL ROLE vocabulary_api');
    await tx.query("SELECT set_config('app.user_id',$1,true)",[id]);
    return work({query:async(sql,params)=>{
      const result=await tx.query(sql,params);
      // Match node-postgres: bigint versions are strings, SELECT has rowCount.
      return {...result,rowCount:result.rows.length||result.affectedRows||0,rows:result.rows.map(row=>Object.hasOwn(row,'version')?{...row,version:String(row.version)}:row)};
    }});
  }),ping:async()=>{}};
  const module=await Test.createTestingModule({imports:[AppModule]})
    .overrideProvider(APP_CONFIG).useValue({port:3000,database:{}})
    .overrideProvider(DatabaseService).useValue(database)
    // JWT cryptography is tested separately. Here A/B select test identities only.
    .overrideProvider(SupabaseAuthService).useValue({verify:async token=>token==='A'?A:B}).compile();
  const app=module.createNestApplication({logger:false});configureHttp(app);await app.listen(0,'127.0.0.1');
  const origin=await app.getUrl();
  const api=async(method,path,body,user='A')=>{
    const response=await fetch(origin+'/api/v1/'+path,{method,headers:{'content-type':'application/json',...(user?{authorization:'Bearer '+user}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    return {...await response.json(),status:response.status};
  };
  const da=randomUUID(),dbId=randomUUID(),c1=randomUUID(),c2=randomUUID();
  try {
    await t.test('requires auth; validates payload/query/IDs and provisions profile',async()=>{
      assert.equal((await api('GET','decks',undefined,null)).status,401);
      for(const body of [{name:'Missing ID'},{id:randomUUID(),name:' '},{id:randomUUID(),name:'bad',user_id:B}])assert.equal((await api('POST','decks',body)).status,422);
      for(const path of ['decks?limit=0','decks?limit=101','decks?offset=-1','decks?limit=1&limit=2','decks?unknown=x','vocabulary?is_favorite=yes','vocabulary?deck_id=bad','vocabulary?q=%20','decks/not-a-uuid'])assert.equal((await api('GET',path)).status,422,path);
      assert.equal((await api('POST','decks',{id:da,name:'  Daily life  '})).status,201);
      assert.equal((await api('POST','decks',{id:dbId,name:'B private'},'B')).status,201);
      assert.equal((await api('GET','decks/'+da)).data.name,'Daily life');
    });
    await t.test('isolates owners and preserves current data on stale/no-op updates',async()=>{
      assert.equal((await api('GET','decks/'+da,undefined,'B')).status,404);
      assert.equal((await api('PATCH','decks/'+da,{base_version:'1',name:'attack'},'B')).status,404);
      assert.equal((await api('DELETE','decks/'+da+'?base_version=1',undefined,'B')).status,404);
      assert.equal((await api('PATCH','decks/'+da,{base_version:'1'})).status,422);
      const changed=await api('PATCH','decks/'+da,{base_version:'1',description:'source contexts'});assert.equal(changed.status,200);assert.equal(changed.data.version,'2');
      assert.equal((await api('PATCH','decks/'+da,{base_version:'1',name:'stale'})).status,409);
      assert.equal((await api('POST','decks',{id:da,name:'duplicate'})).status,409);
    });
    await t.test('database RLS independently blocks a forged owner and cross-owner writes',async()=>{
      await database.withUser(A,async client=>{
        assert.equal((await client.query('SELECT * FROM app.decks WHERE id=$1',[dbId])).rowCount,0);
        assert.equal((await client.query('UPDATE app.decks SET name=$1 WHERE id=$2 RETURNING id',['forbidden',dbId])).rowCount,0);
      });
      await assert.rejects(database.withUser(A,client=>client.query('INSERT INTO app.decks(id,user_id,name) VALUES ($1,$2,$3)',[randomUUID(),B,'forbidden'])),{code:'42501'});
      await assert.rejects(database.withUser(A,client=>client.query('INSERT INTO app.cards(id,user_id,deck_id,word,meaning) VALUES ($1,$2,$3,$4,$5)',[randomUUID(),A,dbId,'forbidden','forbidden'])),{code:'23503'});
      await assert.rejects(database.withUser(A,client=>client.query('DELETE FROM app.decks WHERE id=$1',[da])),{code:'42501'});
    });
    await t.test('allows contextual duplicate words, all card fields, literal search and pagination',async()=>{
      const first=await api('POST','vocabulary',{id:c1,deck_id:da,word:'Bank',meaning:'ngân hàng',phonetic:'/bæŋk/',source_sentence:'I went to the bank.',ai_example:'She works at a bank.'});
      assert.equal(first.status,201);assert.equal(first.data.is_favorite,false);
      const second=await api('POST','vocabulary',{id:c2,deck_id:da,word:'Bank',meaning:'bờ sông',source_sentence:'We sat on the river bank.',is_favorite:true});assert.equal(second.status,201);
      const page=await api('GET','vocabulary?limit=1');assert.equal(page.data.length,1);assert.equal(page.metadata.pagination.has_more,true);
      const next=await api('GET','vocabulary?limit=1&offset=1');assert.equal(next.data.length,1);assert.notEqual(next.data[0].id,page.data[0].id);assert.equal(next.metadata.pagination.has_more,false);
      assert.equal((await api('GET','vocabulary?q=bAnK')).data.length,2);
      assert.equal((await api('GET','vocabulary?q='+encodeURIComponent('bờ sông'))).data.length,1);
      assert.equal((await api('GET','vocabulary?is_favorite=true')).data[0].id,c2);
      assert.equal((await api('GET','vocabulary?is_favorite=false')).data[0].id,c1);
      assert.equal((await api('GET','vocabulary?deck_id='+dbId)).data.length,0);
      const lit=randomUUID();await api('POST','vocabulary',{id:lit,deck_id:da,word:'100%_\\',meaning:'literal'});
      assert.equal((await api('GET','vocabulary?q=%25')).data[0].id,lit);
      assert.equal((await api('GET','vocabulary?q=%5C')).data[0].id,lit);
      assert.equal((await api('GET','vocabulary?q=%27%20OR%201%3D1--')).data.length,0);
    });
    await t.test('validates parents and blocks cross-owner card reads/moves/updates/deletes',async()=>{
      assert.equal((await api('POST','vocabulary',{id:randomUUID(),deck_id:dbId,word:'bad',meaning:'bad'})).status,404);
      assert.equal((await api('GET','vocabulary/'+c1,undefined,'B')).status,404);
      assert.equal((await api('PUT','vocabulary/'+c1,{base_version:'1',meaning:'attack'},'B')).status,404);
      assert.equal((await api('DELETE','vocabulary/'+c1+'?base_version=1',undefined,'B')).status,404);
      assert.equal((await api('PUT','vocabulary/'+c1,{base_version:'1',deck_id:dbId})).status,404);
      assert.equal((await api('POST','vocabulary',{id:randomUUID(),deck_id:da,source_document_id:randomUUID(),word:'bad',meaning:'bad'})).status,404);
      const updated=await api('PUT','vocabulary/'+c1,{base_version:'1',phonetic:null,is_favorite:true});assert.equal(updated.status,200);assert.equal(updated.data.version,'2');assert.equal(updated.data.phonetic,null);assert.equal(updated.data.source_sentence,'I went to the bank.');
      assert.equal((await api('PUT','vocabulary/'+c1,{base_version:'1',meaning:'stale'})).status,409);
      assert.equal((await api('PUT','vocabulary/'+c1,{base_version:'2',user_id:B})).status,422);
      assert.equal((await api('PUT','vocabulary/'+c1,{base_version:'9223372036854775808',word:'overflow'})).status,422);
    });
    await t.test('batch commits in order or rolls back fully on parent/UUID conflicts',async()=>{
      const good=randomUUID(),bad=randomUUID();
      const item=id=>({id,deck_id:da,word:'batch',meaning:'test'});
      assert.equal((await api('POST','vocabulary/batch',{items:[item(good),{...item(bad),deck_id:dbId}]})).status,404);
      assert.equal((await api('GET','vocabulary/'+good)).status,404);
      assert.equal((await api('POST','vocabulary/batch',{items:[item(good),item(c1)]})).status,409);
      assert.equal((await api('GET','vocabulary/'+good)).status,404);
      assert.equal((await api('POST','vocabulary/batch',{items:[item(good),item(good)]})).status,409);
      assert.equal((await api('POST','vocabulary/batch',{items:[]})).status,422);
      assert.equal((await api('POST','vocabulary/batch',{items:Array.from({length:101},()=>item(randomUUID()))})).status,422);
      const done=await api('POST','vocabulary/batch',{items:[item(good),item(bad)]});assert.equal(done.status,201);assert.deepEqual(done.data.map(r=>r.id),[good,bad]);assert.deepEqual(done.metadata,{});
    });
    await t.test('source document links require an active source with the same owner',async()=>{
      const sourceA=randomUUID(),sourceB=randomUUID();
      for(const [owner,source] of [[A,sourceA],[B,sourceB]]) {
        const media=randomUUID();
        await db.query("INSERT INTO app.media_assets(id,user_id,kind,mime_type,size_bytes,width,height) VALUES ($1,$2,'image','image/png',100,100,100)",[media,owner]);
        await db.query("INSERT INTO app.source_documents(id,user_id,media_id,ocr_original_text,ocr_engine) VALUES ($1,$2,$3,'bank','fixture')",[source,owner,media]);
      }
      const card=randomUUID();
      const input={id:card,deck_id:da,word:'source card',meaning:'fixture',source_document_id:sourceA};
      assert.equal((await api('POST','vocabulary',input)).status,201);
      assert.equal((await api('POST','vocabulary',{...input,id:randomUUID(),source_document_id:sourceB})).status,404);
      assert.equal((await api('PUT','vocabulary/'+card,{base_version:'1',source_document_id:sourceB})).status,404);
      await db.query('UPDATE app.source_documents SET deleted_at=now() WHERE id=$1',[sourceA]);
      assert.equal((await api('POST','vocabulary',{...input,id:randomUUID()})).status,404);
      assert.equal((await api('PUT','vocabulary/'+card,{base_version:'1',source_document_id:null})).status,200);
    });
    await t.test('soft-deletes cards and decks with atomic child tombstones',async()=>{
      assert.equal((await api('DELETE','vocabulary/'+c1+'?base_version=1')).status,409);
      const removed=await api('DELETE','vocabulary/'+c1+'?base_version=2');assert.equal(removed.status,200);assert.equal(removed.data.version,'3');assert.ok(removed.data.deleted_at);
      assert.equal((await api('GET','vocabulary/'+c1)).status,404);
      assert.equal((await api('DELETE','vocabulary/'+c1+'?base_version=3')).status,404);
      assert.equal((await api('DELETE','decks/'+da+'?base_version=1')).status,409);
      const deck=await api('DELETE','decks/'+da+'?base_version=2');assert.equal(deck.status,200);
      assert.equal((await api('GET','decks/'+da)).status,404);assert.equal((await api('GET','vocabulary/'+c2)).status,404);
      assert.equal((await api('GET','vocabulary')).data.length,0);
      assert.equal((await api('POST','vocabulary',{id:randomUUID(),deck_id:da,word:'late',meaning:'late'})).status,404);
      const tombstones=(await db.query('SELECT deleted_at,version FROM app.cards WHERE user_id=$1',[A])).rows;
      assert.ok(tombstones.length>0 && tombstones.every(r=>r.deleted_at));
      assert.equal((await api('GET','decks',undefined,'B')).data.length,1);
    });
    await t.test('substring search preserves case, Unicode and literal wildcard semantics',async()=>{
      const deck=randomUUID(),card=randomUUID();
      assert.equal((await api('POST','decks',{id:deck,name:'Search regression'})).status,201);
      assert.equal((await api('POST','vocabulary',{id:card,deck_id:deck,word:'Hello 100%_\\',meaning:'Học TIẾNG Việt; Café École; ĐƯỜNG phố'})).status,201);
      for(const query of ['HELLO','tiếng','ÉCOLE','đường','%','_','\\']) {
        const response=await api('GET','vocabulary?deck_id='+deck+'&q='+encodeURIComponent(query));
        assert.equal(response.status,200);
        assert.deepEqual(response.data.map(row=>row.id),[card],query);
        assert.equal((await api('GET','vocabulary?q='+encodeURIComponent(query),undefined,'B')).data.length,0);
      }
      assert.equal((await api('GET','vocabulary?deck_id='+deck+'&q=absent')).data.length,0);
    });
    const taggedDeck=randomUUID(),taggedOne=randomUUID(),taggedTwo=randomUUID();
    await t.test('creates canonical owner-scoped tags, searches labels and composes pagination/filters',async()=>{
      assert.equal((await api('POST','decks',{id:taggedDeck,name:'Tagged cards'})).status,201);
      const first=await api('POST','vocabulary',{id:taggedOne,deck_id:taggedDeck,word:'alpha',meaning:'fixture',is_favorite:true,tags:[' Travel ','Cafe\u0301','TOEIC']});
      assert.equal(first.status,201);assert.equal(first.data.version,'1');
      assert.deepEqual([...first.data.tags].sort(),['Café','TOEIC','Travel'].sort());
      const second=await api('POST','vocabulary',{id:taggedTwo,deck_id:taggedDeck,word:'beta',meaning:'fixture',tags:['travel']});
      assert.deepEqual(second.data.tags,['Travel']);
      const foreign=await api('POST','vocabulary',{id:randomUUID(),deck_id:dbId,word:'private',meaning:'B label',tags:['travel']},'B');
      assert.deepEqual(foreign.data.tags,['travel']);
      const query='vocabulary?deck_id='+taggedDeck;
      assert.deepEqual(new Set((await api('GET',query+'&tag=TRAVEL')).data.map(row=>row.id)),new Set([taggedOne,taggedTwo]));
      assert.deepEqual((await api('GET',query+'&tag='+encodeURIComponent('Cafe\u0301'))).data.map(row=>row.id),[taggedOne]);
      const page=await api('GET',query+'&q=rav&limit=1');assert.equal(page.data.length,1);assert.equal(page.metadata.pagination.has_more,true);
      const next=await api('GET',query+'&q=rav&limit=1&offset=1');assert.equal(next.data.length,1);assert.notEqual(page.data[0].id,next.data[0].id);
      assert.equal(next.metadata.pagination.has_more,false);
      assert.deepEqual((await api('GET',query+'&tag=travel&is_favorite=true')).data.map(row=>row.id),[taggedOne]);
      assert.deepEqual((await api('GET',query+'&tag=travel',undefined,'B')).data,[]);
      assert.deepEqual((await api('GET',query+'&tag=absent')).data,[]);
      assert.deepEqual((await api('GET',query+'&tag=travel&sort=word&order=asc')).data.map(row=>row.id),[taggedOne,taggedTwo]);
      assert.deepEqual((await api('GET',query+'&tag=travel&sort=word&order=desc')).data.map(row=>row.id),[taggedTwo,taggedOne]);
    });
    await t.test('rejects invalid tags and rolls back labels/membership/change log in failed card batches',async()=>{
      for(const tags of [null,'Travel',[''],[' '],[null],[3],[['nested']],['x'.repeat(51)],Array.from({length:21},(_,i)=>String(i)),[' Travel','travel'],['Café','Cafe\u0301']]) {
        assert.equal((await api('POST','vocabulary',{id:randomUUID(),deck_id:taggedDeck,word:'invalid',meaning:'fixture',tags})).status,422,JSON.stringify(tags));
      }
      for(const query of ['tag=','tag='+encodeURIComponent('x'.repeat(51)),'tag=a&tag=b'])assert.equal((await api('GET','vocabulary?'+query)).status,422);
      for(const query of ['sort=meaning','sort=word&sort=created_at','order=sideways','sort='+encodeURIComponent('word; DROP TABLE app.cards')])assert.equal((await api('GET','vocabulary?'+query)).status,422);
      const failed=randomUUID();
      assert.equal((await api('POST','vocabulary/batch',{items:[
        {id:failed,deck_id:taggedDeck,word:'rollback',meaning:'fixture',tags:['Rollback label']},
        {id:taggedOne,deck_id:taggedDeck,word:'duplicate',meaning:'fixture'},
      ]})).status,409);
      assert.equal((await api('GET','vocabulary/'+failed)).status,404);
      assert.equal((await db.query("SELECT * FROM app.tags WHERE user_id=$1 AND name='Rollback label'",[A])).rows.length,0);
      assert.equal((await db.query('SELECT * FROM app.sync_changes WHERE user_id=$1 AND entity_id=$2',[A,failed])).rows.length,0);
    });
    await t.test('tag membership shares card version/tombstone and database forbids cross-owner or direct runtime link edits',async()=>{
      const foreign=(await db.query("SELECT id FROM app.tags WHERE user_id=$1 AND normalized_name='travel'",[B])).rows[0].id;
      await assert.rejects(db.query('INSERT INTO app.card_tags(user_id,card_id,tag_id) VALUES($1,$2,$3)',[A,taggedOne,foreign]),{code:'23503'});
      await database.withUser(B,async client=>assert.equal((await client.query('SELECT * FROM app.card_tags WHERE user_id=$1',[A])).rowCount,0));
      await assert.rejects(database.withUser(A,client=>client.query('DELETE FROM app.card_tags WHERE card_id=$1',[taggedOne])),{code:'42501'});
      await assert.rejects(database.withUser(A,client=>client.query("INSERT INTO app.tags(user_id,name) VALUES($1,'forbidden')",[A])),{code:'42501'});
      const updated=await api('PUT','vocabulary/'+taggedOne,{base_version:'1',tags:['Only']});assert.equal(updated.status,200);assert.equal(updated.data.version,'2');assert.deepEqual(updated.data.tags,['Only']);
      const kept=await api('PUT','vocabulary/'+taggedOne,{base_version:'2',meaning:'keeps tags'});assert.equal(kept.data.version,'3');assert.deepEqual(kept.data.tags,['Only']);
      assert.equal((await api('PUT','vocabulary/'+taggedOne,{base_version:'1',tags:['Stale label']})).status,409);
      assert.equal((await db.query("SELECT * FROM app.tags WHERE user_id=$1 AND name='Stale label'",[A])).rows.length,0);
      const cleared=await api('PUT','vocabulary/'+taggedOne,{base_version:'3',tags:[]});assert.equal(cleared.data.version,'4');assert.deepEqual(cleared.data.tags,[]);
      assert.equal((await db.query('SELECT * FROM app.card_tags WHERE user_id=$1 AND card_id=$2',[A,taggedOne])).rows.length,0);
      assert.equal((await api('DELETE','vocabulary/'+taggedTwo+'?base_version=1')).status,200);
      assert.deepEqual((await api('GET','vocabulary?tag=travel&deck_id='+taggedDeck)).data,[]);
      assert.equal((await db.query('SELECT * FROM app.card_tags WHERE user_id=$1 AND card_id=$2',[A,taggedTwo])).rows.length,1);
      const delta=(await db.query('SELECT snapshot FROM app.sync_changes WHERE user_id=$1 AND entity_id=$2 ORDER BY sequence DESC LIMIT 1',[A,taggedTwo])).rows[0].snapshot;
      assert.deepEqual(delta.tags,['Travel']);assert.ok(delta.deleted_at);
    });
  } finally {await app.close();await db.close();}
});
