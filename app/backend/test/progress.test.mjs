import 'reflect-metadata';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {Test} from '@nestjs/testing';
import {AppModule} from '../dist/src/app.module.js';
import {APP_CONFIG,DatabaseService} from '../dist/src/database/database.service.js';
import {SupabaseAuthService} from '../dist/src/auth/supabase-auth.service.js';
import {PROGRESS_CLOCK} from '../dist/src/progress/progress.service.js';
import {replayReviews,localDay,streak} from '../dist/src/progress/sm2.js';
import {configureHttp} from '../dist/src/common/http.js';
import {loadMigrations,runMigrations} from '../scripts/migration-runner.mjs';

test('SM-2 fixtures: intervals, integer EF, failure reset, deterministic late-event replay and cap',()=>{
  const event=(quality,day,id=randomUUID())=>({id,quality,reviewed_at:`2026-11-${String(day).padStart(2,'0')}T12:00:00.000Z`});
  let events=[event(4,1),event(4,2),event(4,8)];
  let state=replayReviews(events);
  assert.equal(state.interval_days,15);assert.equal(state.ease_factor,2.5);assert.equal(state.repetitions,3);
  events.push(event(0,9));state=replayReviews(events);
  assert.equal(state.interval_days,1);assert.equal(state.repetitions,0);assert.equal(state.ease_factor,1.7);
  events.push(event(0,10),event(5,11));state=replayReviews(events);
  assert.equal(state.ease_factor,1.4);assert.equal(state.repetitions,1);
  assert.deepEqual(replayReviews(events.toReversed()),state);
  const tied=[event(0,12,'10000000-0000-4000-8000-000000000001'),event(4,12,'10000000-0000-4000-8000-000000000002')];
  assert.equal(replayReviews(tied.toReversed()).repetitions,1);
  const perfect=Array.from({length:30},(_,i)=>event(5,1,String(i).padStart(36,'0')));
  assert.equal(replayReviews(perfect).interval_days,36500);
  assert.throws(()=>replayReviews([event(6,1)]));
  for(const [quality,ease] of [[0,1.7],[1,1.96],[2,2.18],[3,2.36],[4,2.5],[5,2.6]]){
    assert.equal(replayReviews([event(quality,1)]).ease_factor,ease);
  }
});
test('calendar streak respects local midnight, leap day and DST without adding 24h',()=>{
  const time=new Date('2026-11-16T00:30:00.000Z');
  assert.equal(localDay(time,'America/Los_Angeles'),'2026-11-15');
  assert.equal(localDay(time,'Asia/Ho_Chi_Minh'),'2026-11-16');
  assert.equal(streak(['2024-02-28','2024-02-29'],'2024-03-01'),2);
  assert.equal(streak(['2026-03-07','2026-03-08'],'2026-03-09'),2);
  assert.equal(streak(['2026-11-14'],'2026-11-16'),0);
});
test('SM-2 fixtures match the versioned scheduling contract',async()=>{
  const fixtures=JSON.parse(await readFile(new URL('../../../contracts/sm2-v1-fixtures.json',import.meta.url),'utf8'));
  for(const fixture of fixtures.cases){
    const events=fixture.qualities.map((quality,i)=>({id:String(i).padStart(36,'0'),quality,reviewed_at:new Date(Date.parse(fixtures.start)+i*86400000).toISOString()}));
    const state=replayReviews(events);
    for(const key of ['repetitions','interval_days','ease_factor'])assert.equal(state[key],fixture[key]);
    assert.equal(state.algorithm_version,fixtures.algorithm_version);
  }
});
test('review feed migration backfills existing immutable receipts without data loss',async()=>{
  const db=new PGlite();
  const connection={query:(sql,params)=>params?db.query(sql,params):db.exec(sql).then(r=>r.at(-1))};
  try{
    await db.exec('CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY)');
    const migrations=await loadMigrations(new URL('../database/migrations/',import.meta.url));
    await runMigrations(connection,migrations.slice(0,migrations.findIndex(m=>m.name.startsWith('006_'))));
    const owner=randomUUID(),deck=randomUUID(),card=randomUUID(),id=randomUUID();
    await db.query('INSERT INTO auth.users VALUES($1)',[owner]);
    await db.query('INSERT INTO app.profiles(user_id) VALUES($1)',[owner]);
    await db.query("INSERT INTO app.decks(id,user_id,name) VALUES($1,$2,'migration')",[deck,owner]);
    await db.query("INSERT INTO app.cards(id,user_id,deck_id,word,meaning) VALUES($1,$2,$3,'word','context')",[card,owner,deck]);
    await db.query("INSERT INTO app.review_events(user_id,id,card_id,quality,reviewed_at,timezone_at_review,algorithm_version,request_hash,result) VALUES($1,$2,$3,4,now(),'UTC','sm2-v1','unchanged',$4::jsonb)",[owner,id,card,JSON.stringify({receipt:'retained'})]);
    await runMigrations(connection,migrations);
    const stored=(await db.query('SELECT sequence::text,result,request_hash FROM app.review_events')).rows[0];
    assert.deepEqual(stored,{sequence:'1',result:{receipt:'retained'},request_hash:'unchanged'});
    assert.equal(String((await db.query('SELECT last_sequence FROM app.review_heads')).rows[0].last_sequence),'1');
    await db.exec('BEGIN');
    await db.query("INSERT INTO app.review_events(user_id,id,card_id,quality,reviewed_at,timezone_at_review,algorithm_version,request_hash,result) VALUES($1,$2,$3,4,now(),'UTC','sm2-v1','new','{}')",[owner,randomUUID(),card]);
    await db.exec('ROLLBACK');
    assert.equal(String((await db.query('SELECT last_sequence FROM app.review_heads')).rows[0].last_sequence),'1');
  }finally{await db.close();}
});

test('progress API: event receipts, late replay, mastery, timezone boundaries and RLS',async t=>{
  const A='10000000-0000-4000-8000-000000000001',B='10000000-0000-4000-8000-000000000002';
  const db=new PGlite();await db.exec('CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY)');
  await runMigrations({query:(sql,params)=>params?db.query(sql,params):db.exec(sql).then(r=>r.at(-1))},await loadMigrations(new URL('../database/migrations/',import.meta.url)));
  await db.query('INSERT INTO auth.users VALUES($1),($2)',[A,B]);
  const database={withUser:(id,work)=>db.transaction(async tx=>{
    await tx.exec('SET LOCAL ROLE vocabulary_api');await tx.query("SELECT set_config('app.user_id',$1,true)",[id]);
    return work({query:async(sql,params)=>{const r=await tx.query(sql,params);return {...r,rowCount:r.rows.length||r.affectedRows||0,rows:r.rows.map(row=>Object.hasOwn(row,'version')?{...row,version:String(row.version)}:row)};}});
  }),ping:async()=>{}};
  let now=new Date('2026-11-16T00:30:00.000Z');
  const module=await Test.createTestingModule({imports:[AppModule]}).overrideProvider(APP_CONFIG).useValue({port:3000,database:{}})
    .overrideProvider(DatabaseService).useValue(database).overrideProvider(PROGRESS_CLOCK).useValue(()=>now)
    .overrideProvider(SupabaseAuthService).useValue({verify:async token=>token==='A'?A:B}).compile();
  const app=module.createNestApplication({logger:false});configureHttp(app);await app.listen(0,'127.0.0.1');const origin=await app.getUrl();
  const api=async(method,path,body,user='A')=>{const r=await fetch(origin+'/api/v1/'+path,{method,headers:{'content-type':'application/json',...(user?{authorization:'Bearer '+user}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {...await r.json(),status:r.status};};
  const deck=randomUUID(),card=randomUUID(),fresh=randomUUID();
  const event=(time,quality=4)=>({id:randomUUID(),card_id:card,quality,score:80,reviewed_at:time,timezone_at_review:'Asia/Ho_Chi_Minh',algorithm_version:'sm2-v1'});
  try{
    await api('POST','decks',{id:deck,name:'Progress'});
    for(const id of [card,fresh])assert.equal((await api('POST','vocabulary',{id,deck_id:deck,word:'test',meaning:'context'})).status,201);
    await t.test('auth, owner/server injection, invalid dates, quality, algorithm and query are rejected',async()=>{
      const good=event('2026-11-14T12:00:00.000Z');
      assert.equal((await api('POST','progress/review',good,null)).status,401);
      for(const patch of [{user_id:B},{quality:6},{quality:1.5},{score:101},{algorithm_version:'unknown'},{reviewed_at:'2026-02-30T00:00:00.000Z'},{reviewed_at:'2026-11-17T00:00:00.000Z'},{timezone_at_review:'Invalid/Zone'}]){
        assert.equal((await api('POST','progress/review',{...good,...patch})).status,422);
      }
      assert.equal((await api('POST','progress/review',good,'B')).status,404);
      assert.equal((await api('GET','progress/summary?user_id='+B)).status,422);
      assert.equal((await api('GET','progress/history?limit=101')).status,422);
      assert.equal((await api('GET','progress/history?card_id=bad')).status,422);
    });
    await t.test('replay receipt returns same result; changing the same event ID is 409',async()=>{
      const input=event('2026-11-15T12:00:00.000Z');
      const first=await api('POST','progress/review',input);assert.equal(first.status,200);assert.equal(first.data.state.due_at,'2026-11-16T12:00:00.000Z');
      assert.deepEqual((await api('POST','progress/review',input)).data,first.data);
      assert.equal((await api('POST','progress/review',{...input,quality:5})).status,409);
      assert.equal((await api('GET','progress/history')).data.length,1);
    });
    await t.test('late arrivals replay chronological events and update state without dropping either review',async()=>{
      assert.equal((await api('POST','progress/review',event('2026-11-13T12:00:00.000Z'))).data.state.interval_days,6);
      const result=await api('POST','progress/review',event('2026-11-14T12:00:00.000Z'));
      assert.equal(result.data.state.repetitions,3);assert.equal(result.data.state.total_reviews,3);
      assert.equal(result.data.state.last_reviewed_at,'2026-11-15T12:00:00.000Z');
      assert.equal(result.data.state.due_at,'2026-11-30T12:00:00.000Z');
      const page=await api('GET','progress/history?limit=2');assert.equal(page.data.length,2);assert.equal(page.metadata.pagination.has_more,true);
      assert.equal((await api('GET','progress/history?offset=2')).data.length,1);
      const summary=(await api('GET','progress/summary')).data;
      assert.equal(summary.mastered_count,1);assert.equal(summary.new_count,1);assert.equal(summary.current_streak,3);assert.equal(summary.total_reviews,3);
      assert.equal((await api('GET','progress/history',undefined,'B')).data.length,0);
    });
    await t.test('failed state write rolls back event and receipt, allowing a safe retry',async()=>{
      const input={...event('2026-11-15T07:00:00.000Z'),card_id:fresh};
      await db.exec(`CREATE FUNCTION app.test_reject_review_state() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test fault'; END $$;
        CREATE TRIGGER test_reject_review_state BEFORE INSERT OR UPDATE ON app.review_states FOR EACH ROW EXECUTE FUNCTION app.test_reject_review_state()`);
      try{
        assert.equal((await api('POST','progress/review',input)).status,500);
        assert.equal((await api('GET','progress/history?card_id='+fresh)).data.length,0);
      }finally{
        await db.exec('DROP TRIGGER test_reject_review_state ON app.review_states; DROP FUNCTION app.test_reject_review_state()');
      }
      // The failed request consumed no event ID or state; retry the exact request.
      assert.equal((await api('POST','progress/review',input)).status,200);
    });
    await t.test('summary uses profile timezone, excludes tomorrow due and counts overdue; deleted cards keep audit history',async()=>{
      const profile=(await api('GET','user/profile')).data;
      await api('PATCH','user/profile',{base_version:profile.version,timezone:'America/Los_Angeles'});
      const input={...event('2026-11-15T08:00:00.000Z',0),card_id:fresh};
      assert.equal((await api('POST','progress/review',input)).status,200);
      let summary=(await api('GET','progress/summary')).data;
      assert.equal(summary.today,'2026-11-15');assert.equal(summary.due_today_count,0);assert.equal(summary.current_streak,3);
      const next=(await api('GET','user/profile')).data;
      await api('PATCH','user/profile',{base_version:next.version,timezone:'Asia/Ho_Chi_Minh'});
      summary=(await api('GET','progress/summary')).data;
      assert.equal(summary.today,'2026-11-16');assert.equal(summary.due_today_count,1);assert.equal(summary.relearning_count,1);
      now=new Date('2026-11-20T00:30:00.000Z');
      summary=(await api('GET','progress/summary')).data;assert.equal(summary.current_streak,0);assert.equal(summary.due_today_count,1);
      assert.equal((await api('DELETE','decks/'+deck+'?base_version=1')).status,200);
      summary=(await api('GET','progress/summary')).data;assert.equal(summary.total_cards,0);assert.equal(summary.total_reviews,5);
      assert.equal((await api('POST','progress/review',event('2026-11-20T00:00:00.000Z'))).status,404);
      assert.equal((await api('POST','progress/review',input)).status,200,'committed receipt remains replayable after deletion');
      assert.equal((await api('GET','progress/history?card_id='+card)).data.length,3);
    });
    await t.test('due today uses real 23/25-hour local days across DST',async()=>{
      const otherDeck=randomUUID(),spring=randomUUID(),fall=randomUUID();
      await api('POST','decks',{id:otherDeck,name:'DST'},'B');
      for(const id of [spring,fall])await api('POST','vocabulary',{id,deck_id:otherDeck,word:'DST',meaning:'boundary'},'B');
      const p=(await api('GET','user/profile',undefined,'B')).data;
      await api('PATCH','user/profile',{base_version:p.version,timezone:'America/Los_Angeles'},'B');
      now=new Date('2026-03-08T12:00:00.000Z');
      assert.equal((await api('POST','progress/review',{...event('2026-03-08T07:30:00.000Z',0),card_id:spring},'B')).status,200);
      assert.equal((await api('GET','progress/summary',undefined,'B')).data.due_today_count,0,'24h due is after a 23h local day');
      now=new Date('2026-11-01T12:00:00.000Z');
      assert.equal((await api('POST','progress/review',{...event('2026-11-01T07:30:00.000Z',0),card_id:fall},'B')).status,200);
      assert.equal((await api('GET','progress/summary',undefined,'B')).data.due_today_count,2,'overdue spring + fall due within the 25h day');
    });
    await t.test('database enforces tenant ownership and runtime cannot mutate/delete events',async()=>{
      await database.withUser(B,async client=>{
        assert.equal((await client.query('SELECT * FROM app.review_events WHERE user_id=$1',[A])).rows.length,0);
        assert.equal((await client.query('SELECT * FROM app.review_states WHERE user_id=$1',[A])).rows.length,0);
      });
      await assert.rejects(database.withUser(A,client=>client.query('DELETE FROM app.review_events')),{code:'42501'});
      await assert.rejects(database.withUser(A,client=>client.query('UPDATE app.review_events SET quality=5')),{code:'42501'});
      await assert.rejects(database.withUser(B,client=>client.query(`INSERT INTO app.review_states VALUES($1,$2,'sm2-v1',0,1,2.5,1,now(),now())`,[A,card])),{code:'42501'});
      await assert.rejects(database.withUser(B,client=>client.query(`INSERT INTO app.review_states VALUES($1,$2,'sm2-v1',0,1,2.5,1,now(),now())`,[B,card])),{code:'23503'});
    });
    await t.test('review cursor isolates feeds/owners and keeps numeric stable pages despite new reviews',async()=>{
      now=new Date('2026-11-16T12:00:00.000Z');
      const d=randomUUID(),c=randomUUID();
      await api('POST','decks',{id:d,name:'Feed'});await api('POST','vocabulary',{id:c,deck_id:d,word:'feed',meaning:'history'});
      for(let i=1;i<=12;i++)assert.equal((await api('POST','progress/review',{...event(`2026-11-${String(i).padStart(2,'0')}T00:00:00.000Z`),card_id:c})).status,200);
      const all=(await api('GET','progress/changes')).data.events;
      assert.ok(all.length>9);assert.deepEqual(all.map(e=>Number(e.sequence)),all.map(e=>Number(e.sequence)).toSorted((a,b)=>a-b));
      assert.ok(all.every(e=>!Object.hasOwn(e,'request_hash')&&!Object.hasOwn(e,'result')));
      const first=(await api('GET','progress/changes?limit=1')).data;
      assert.equal(first.has_more,true);
      assert.equal((await api('POST','progress/review',{...event('2026-11-16T00:00:00.000Z'),card_id:c})).status,200);
      const collected=[...first.events];let cursor=first.next_cursor,more=true;
      while(more){const page=(await api('GET','progress/changes?limit=2&cursor='+cursor)).data;collected.push(...page.events);cursor=page.next_cursor;more=page.has_more;}
      assert.deepEqual(collected.map(e=>e.id),all.map(e=>e.id));
      assert.equal((await api('GET','progress/changes?cursor='+cursor)).data.events.length,1);
      assert.equal((await api('GET','progress/changes?cursor='+cursor,undefined,'B')).status,422);
      const wrong=(await api('GET','sync/changes')).data.next_cursor;
      assert.equal((await api('GET','progress/changes?cursor='+wrong)).status,422);
      assert.equal((await api('GET','sync/changes?cursor='+cursor)).status,422);
      assert.equal((await api('GET','progress/changes?cursor=bad')).status,422);
      assert.equal((await api('GET','progress/changes?limit=101')).status,422);
    });
  }finally{await app.close();await db.close();}
});
