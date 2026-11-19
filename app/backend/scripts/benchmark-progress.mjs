// Local-only CAM-06 acceptance check. Four real backend processes share one
// PostgreSQL database; no .env/Supabase credentials or production data are used.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {readFile,writeFile} from 'node:fs/promises';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import pg from 'pg';
import {startTemporaryBackend} from './temporary-backend.mjs';
import {loadMigrations,runMigrations} from './migration-runner.mjs';

const db=new pg.Client({connectionString:'postgresql://cam_migrator:local_migration_only@127.0.0.1:54329/vocabulary',connectionTimeoutMillis:5000});
const backends=[],owners=[],timings=[],statusCounts={};let jwks,stage='configuration';
const report={passed:false,checks:[],backend_processes:4,accounts:8,concurrency:48,fixture_cleanup:false};
const passed=name=>{report.checks.push(name);console.log(JSON.stringify({step:name,status:'passed'}));};
const day=86400000,base=Date.now()-10*day;
async function call(owner,processIndex,method,path,body,measure=false){
 const start=performance.now();
 const r=await fetch(backends[processIndex%backends.length].origin+'/api/v1/'+path,{method,headers:{authorization:'Bearer '+owner.token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(120000)});
 const json=await r.json();if(measure){timings.push(performance.now()-start);statusCounts[r.status]=(statusCounts[r.status]??0)+1;}
 return {...json,status:r.status};
}
async function parallel(jobs,concurrency=48){
 let next=0;const errors=[];
 await Promise.all(Array.from({length:Math.min(concurrency,jobs.length)},async()=>{
  while(next<jobs.length){const i=next++;try{await jobs[i]();}catch(error){errors.push(error);}}
 }));
 assert.equal(errors.length,0,'Every submitted operation must finish with its expected result');
}
try{
 await db.connect();
 assert.deepEqual((await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='auth' AND table_name='users' ORDER BY ordinal_position")).rows.map(r=>r.column_name),['id']);
 await runMigrations(db,await loadMigrations(new URL('../database/migrations/',import.meta.url)));
 const keys=await generateKeyPair('ES256'),key={...await exportJWK(keys.publicKey),kid:'progress-local-only',alg:'ES256',use:'sig'};
 jwks=createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({keys:[key]}));});jwks.listen(0,'127.0.0.1');await once(jwks,'listening');
 const authOrigin=`http://127.0.0.1:${jwks.address().port}`;
 for(let i=0;i<4;i++)backends.push(await startTemporaryBackend({DATABASE_URL:'postgresql://cam_backend:local_backend_only@127.0.0.1:54329/vocabulary',DATABASE_SSL:'false',DATABASE_TIMEOUT_MS:'30000',DATABASE_POOL_MAX:'5',SUPABASE_URL:authOrigin}));
 const fixtures=JSON.parse(await readFile(new URL('../../../contracts/sm2-v1-fixtures.json',import.meta.url),'utf8'));
 const patterns=[fixtures.cases[6],fixtures.cases[9],fixtures.cases[10],fixtures.cases[8]];
 const zones=['UTC','Asia/Ho_Chi_Minh','America/Los_Angeles','Pacific/Kiritimati'];
 stage='fresh_owner_and_card_setup';
 for(let i=0;i<8;i++){
  const owner={id:randomUUID(),deck:randomUUID(),cards:[],events:[],zone:zones[i%zones.length]};owners.push(owner);
  await db.query('INSERT INTO auth.users(id) VALUES($1)',[owner.id]);
  owner.token=await new SignJWT({role:'authenticated'}).setSubject(owner.id).setIssuer(authOrigin+'/auth/v1').setAudience('authenticated').setIssuedAt().setExpirationTime('10m').setProtectedHeader({alg:'ES256',kid:key.kid}).sign(keys.privateKey);
  const profile=await call(owner,0,'GET','user/profile');assert.equal(profile.status,200);
  assert.equal((await call(owner,0,'PATCH','user/profile',{base_version:profile.data.version,timezone:owner.zone})).status,200);
  assert.equal((await call(owner,0,'POST','decks',{id:owner.deck,name:'CAM-06 multiprocess fixture'})).status,201);
  for(let c=0;c<5;c++){
   const id=randomUUID();owner.cards.push(id);
   assert.equal((await call(owner,0,'POST','vocabulary',{id,deck_id:owner.deck,word:'fixture '+c,meaning:'isolated progress acceptance'})).status,201);
   if(c<4)owner.events.push(...patterns[c].qualities.map((quality,n)=>({id:randomUUID(),card_id:id,quality,score:quality*20,reviewed_at:new Date(base+n*day).toISOString(),timezone_at_review:owner.zone,algorithm_version:'sm2-v1'})));
  }
 }
 passed(stage);
 stage='concurrent_distinct_and_duplicate_reviews_across_processes';
 const receipts=new Map(),jobs=[];
 // Reverse chronological arrival, and send each ID twice through different
 // processes, so neither in-process queues nor request order can ensure safety.
 for(const [index,owner] of owners.entries())for(const [n,event] of owner.events.toReversed().entries())for(let copy=0;copy<2;copy++)jobs.push(async()=>{
  const r=await call(owner,index+n+copy,'POST','progress/review',event,true);assert.equal(r.status,200);
  if(receipts.has(event.id))assert.deepEqual(r.data,receipts.get(event.id));else receipts.set(event.id,r.data);
 });
 const started=performance.now();await parallel(jobs);
 report.concurrent_review_requests=jobs.length;report.concurrent_elapsed_ms=Number((performance.now()-started).toFixed(2));
 assert.equal(receipts.size,128);passed(stage);
 stage='persisted_schedules_match_versioned_SM2_fixtures';
 for(const owner of owners)for(let c=0;c<4;c++){
  const state=(await db.query('SELECT * FROM app.review_states WHERE user_id=$1 AND card_id=$2',[owner.id,owner.cards[c]])).rows[0],expected=patterns[c];
  assert.ok(state);assert.equal(state.total_reviews,expected.qualities.length);
  assert.equal(state.repetitions,expected.repetitions);assert.equal(state.interval_days,expected.interval_days);assert.equal(Number(state.ease_factor),expected.ease_factor);
  const last=base+(expected.qualities.length-1)*day;assert.equal(new Date(state.last_reviewed_at).getTime(),last);assert.equal(new Date(state.due_at).getTime(),last+expected.interval_days*day);
 }
 assert.equal((await db.query('SELECT count(*)::int AS n FROM app.review_events WHERE user_id=ANY($1::uuid[])',[owners.map(o=>o.id)])).rows[0].n,128);passed(stage);
 stage='late_reviews_replay_without_lost_updates';
 for(const owner of owners){
  const event={...owner.events[0],id:randomUUID(),quality:5,reviewed_at:new Date(base-day).toISOString()};
  const r=await call(owner,3,'POST','progress/review',event,true);assert.equal(r.status,200);
  assert.equal(r.data.state.repetitions,4);assert.equal(r.data.state.interval_days,42);assert.equal(r.data.state.ease_factor,2.6);assert.equal(r.data.state.total_reviews,4);
 }
 passed(stage);
 stage='mastery_due_and_history_are_owner_scoped';
 for(const [index,owner] of owners.entries()){
  const r=await call(owner,index,'GET','progress/summary',undefined,true);assert.equal(r.status,200);
  for(const [key,expected] of Object.entries({total_cards:5,new_count:1,learning_count:1,relearning_count:1,mastered_count:2,total_reviews:17,current_streak:0,due_today_count:1}))assert.equal(r.data[key],expected,key);
  assert.equal(r.data.timezone,owner.zone);
  const history=await call(owner,index+1,'GET','progress/history?limit=100');assert.equal(history.data.length,17);
  assert.ok(history.data.every(event=>owner.cards.includes(event.card_id)));
  const other=owners[(index+1)%owners.length];assert.equal((await call(other,index,'GET','progress/history?card_id='+owner.cards[0])).data.length,0);
  assert.equal((await call(other,index,'POST','progress/review',{...owner.events[0],id:randomUUID()})).status,404);
 }
 passed(stage);
 stage='bounded_queue_backpressure_preserves_retry_identity';
 const owner=owners[0],event={...owner.events[0],id:randomUUID(),card_id:owner.cards[4],quality:4,reviewed_at:new Date(base).toISOString()};
 const burst=await Promise.all(Array.from({length:96},()=>call(owner,0,'POST','progress/review',event,true)));
 report.burst={requests:96,ok:burst.filter(r=>r.status===200).length,busy:burst.filter(r=>r.status===503).length};
 assert.ok(burst.every(r=>[200,503].includes(r.status)));assert.ok(report.burst.ok>0);
 const retry=await call(owner,1,'POST','progress/review',event,true);assert.equal(retry.status,200);assert.equal(retry.data.state.total_reviews,1);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM app.review_events WHERE user_id=$1 AND id=$2',[owner.id,event.id])).rows[0].n,1);passed(stage);
 stage='final_event_and_feed_integrity';
 const final=(await db.query(`SELECT count(*)::int AS events,count(DISTINCT (user_id,id))::int AS identities,
  count(DISTINCT (user_id,sequence))::int AS sequences FROM app.review_events WHERE user_id=ANY($1::uuid[])`,[owners.map(o=>o.id)])).rows[0];
 assert.deepEqual(final,{events:137,identities:137,sequences:137});report.final_events=final.events;
 for(const owner of owners){
  const counts=(await db.query(`SELECT h.last_sequence::int AS head,count(e.id)::int AS n FROM app.review_heads h
   JOIN app.review_events e ON e.user_id=h.user_id WHERE h.user_id=$1 GROUP BY h.last_sequence`,[owner.id])).rows[0];assert.equal(counts.head,counts.n);
 }
 passed(stage);report.passed=true;
}catch{report.failed_stage=stage;console.log(JSON.stringify({step:stage,status:'failed_no_credentials_logged'}));process.exitCode=1;}
finally{
 let cleanup=true;
 for(const owner of owners)if(owner.token&&backends.length){try{const r=await call(owner,0,'GET','decks/'+owner.deck);if(r.status===200)assert.equal((await call(owner,0,'DELETE','decks/'+owner.deck+'?base_version='+r.data.version)).status,200);}catch{cleanup=false;}}
 report.fixture_cleanup=cleanup;report.fixture_retention='Fresh local accounts/profiles and immutable review audit retained; fixture decks/cards soft-deleted. No Supabase access.';
 for(const backend of backends)await backend.close();
 if(jwks){jwks.closeAllConnections();await new Promise(resolve=>jwks.close(resolve));}
 await db.end().catch(()=>{});report.resources_closed=true;
 if(!cleanup){report.passed=false;process.exitCode=1;}
 timings.sort((a,b)=>a-b);const percentile=p=>timings.length?Number(timings[Math.max(0,Math.ceil(timings.length*p)-1)].toFixed(2)):null;
 report.http={measured_requests:timings.length,status_counts:statusCounts,p50_ms:percentile(.5),p95_ms:percentile(.95),max_ms:timings.length?Number(timings.at(-1).toFixed(2)):null};
 report.generated_at=new Date().toISOString();report.scope='Local Windows/Linux Node + PostgreSQL TCP, 4 isolated backend processes, 8 owners/4 timezones/40 cards. Correctness and measured latency on this host; no production throughput or mobile SLA claim.';
 await writeFile(new URL('../../../docs/cam/benchmarks/progress-multiprocess.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({step:'progress_multiprocess_report',passed:report.passed,requests:timings.length}));
}
