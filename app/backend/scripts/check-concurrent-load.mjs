import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {writeFile} from 'node:fs/promises';
import {checkConsistency} from './check-consistency.mjs';

export async function checkConcurrentLoad({origin,tokenA,tokenB,accountA,accountB,admin,report=()=>{}}){
  // Only called by verify-local with its fixed disposable Compose DB. Never
  // imports .env, Supabase credentials or real Auth identities.
  const owners=[{token:tokenA,id:accountA},{token:tokenB,id:accountB}];
  const runs=[];let requests=0,active=0,maxActive=0;
  async function call(owner,method,path,body){
    requests++;active++;maxActive=Math.max(maxActive,active);
    try{
      const r=await fetch(origin+'/api/v1/'+path,{method,headers:{authorization:'Bearer '+owner.token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
      return {http:r.status,...await r.json()};
    }finally{active--;}
  }
  async function parallel(name,jobs){
    let index=0;const results=new Array(jobs.length),start=performance.now();
    // Settle every worker before cleanup, even on failed network requests.
    const workers=await Promise.allSettled(Array.from({length:Math.min(32,jobs.length)},async()=>{
      while(index<jobs.length){const i=index++;results[i]=await jobs[i]();}
    }));
    for(const worker of workers)if(worker.status==='rejected')throw worker.reason;
    runs.push({name,requests:jobs.length,elapsed_ms:Number((performance.now()-start).toFixed(2))});return results;
  }
  const deadlocks=async()=>Number((await admin.query('SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()')).rows[0].deadlocks);
  const before=await deadlocks();let cleanup=false;
  try{
    for(const owner of owners){
      owner.deck=randomUUID();owner.cards=Array.from({length:32},()=>randomUUID());owner.syncCard=randomUUID();
      assert.equal((await call(owner,'POST','decks',{id:owner.deck,name:'CAM-11 concurrent fixture'})).http,201);
      assert.equal((await call(owner,'POST','vocabulary/batch',{items:owner.cards.map(id=>({id,deck_id:owner.deck,word:'concurrent',meaning:'fixture'}))})).http,201);
    }
    const conflicts=await parallel('64_same_version_writes',Array.from({length:64},(_,i)=>()=>call(owners[0],'PUT','vocabulary/'+owners[0].cards[0],{base_version:'1',meaning:'winner '+i})));
    assert.equal(conflicts.filter(r=>r.http===200).length,1);assert.equal(conflicts.filter(r=>r.http===409).length,63);
    assert.equal((await call(owners[0],'GET','vocabulary/'+owners[0].cards[0])).data.version,'2');
    report('load_64_stale_writes_one_winner','passed');

    const jobs=[];
    for(const owner of owners)for(const id of owner.cards.slice(owner===owners[0]?1:0))jobs.push(async()=>{assert.equal((await call(owner,'PUT','vocabulary/'+id,{base_version:'1',meaning:'committed'})).http,200);});
    for(let i=0;i<128;i++)jobs.push(async()=>{const owner=owners[i%2];const r=await call(owner,'GET','vocabulary?deck_id='+owner.deck+'&limit=100');assert.equal(r.http,200);assert.equal(r.data.length,32);assert.ok(r.data.every(c=>c.user_id===owner.id));});
    await parallel('63_writes_with_128_reads',jobs);
    for(const owner of owners){const r=await call(owner,'GET','vocabulary?deck_id='+owner.deck+'&limit=100');assert.ok(r.data.every(c=>c.version==='2'));}
    report('load_mixed_reads_writes_no_lost_updates_or_owner_leak','passed');

    const reviewed_at=new Date(Date.now()-120000).toISOString();
    const events=owners.flatMap(owner=>owner.cards.map(card_id=>({owner,input:{id:randomUUID(),card_id,quality:4,score:80,reviewed_at,timezone_at_review:'UTC',algorithm_version:'sm2-v1'}})));
    const reviewResults=await parallel('64_reviews_each_replayed_once',events.flatMap(({owner,input})=>[()=>call(owner,'POST','progress/review',input),()=>call(owner,'POST','progress/review',input)]));
    assert.ok(reviewResults.every(r=>r.http===200));
    const stored=(await admin.query('SELECT count(*)::int AS n FROM app.review_events WHERE card_id=ANY($1::uuid[])',[owners.flatMap(o=>o.cards)])).rows[0].n;
    assert.equal(stored,64);
    const states=(await admin.query('SELECT total_reviews FROM app.review_states WHERE card_id=ANY($1::uuid[])',[owners.flatMap(o=>o.cards)])).rows;
    assert.equal(states.length,64);assert.ok(states.every(s=>s.total_reviews===1));
    report('load_128_review_requests_exactly_64_events','passed');

    for(const owner of owners)owner.batch={items:[{operation_id:randomUUID(),entity_type:'card',entity_id:owner.syncCard,action:'create',base_version:null,payload:{deck_id:owner.deck,word:'sync once',meaning:'receipt'}}]};
    const synced=await parallel('64_sync_receipt_replays',Array.from({length:64},(_,i)=>()=>call(owners[i%2],'POST','sync/batch',owners[i%2].batch)));
    assert.ok(synced.every(r=>r.http===200));
    for(const owner of owners){
      const receipts=(await admin.query('SELECT count(*)::int AS n FROM app.sync_receipts WHERE user_id=$1 AND operation_id=$2',[owner.id,owner.batch.items[0].operation_id])).rows[0].n;assert.equal(receipts,1);
      assert.equal((await call(owner,'GET','vocabulary/'+owner.syncCard)).data.version,'1');
    }
    report('load_sync_replays_one_receipt_and_card_per_owner','passed');
  }finally{
    const results=await Promise.allSettled(owners.filter(o=>o.deck).map(async owner=>{
      const current=await call(owner,'GET','decks/'+owner.deck);
      if(current.http===200)assert.equal((await call(owner,'DELETE','decks/'+owner.deck+'?base_version='+current.data.version)).http,200);
      else assert.equal(current.http,404);
    }));
    cleanup=results.every(r=>r.status==='fulfilled');assert.ok(cleanup,'Load fixture cleanup failed');
  }
  await admin.query('SELECT pg_stat_clear_snapshot()');const delta=(await deadlocks())-before;assert.equal(delta,0);
  const consistency=await checkConsistency(admin);
  const result={generated_at:new Date().toISOString(),environment:'local Compose PostgreSQL, loopback Nest HTTP, ES256 JWT fixture, two owners, one API process',
    concurrency_limit:32,max_in_flight:maxActive,requests,runs,deadlocks_delta:delta,consistency,
    fixture_cleanup:cleanup?'soft_deleted_audit_retained':'failed',passed:true,
    limits:'Representative bounded burst, not production capacity or proof deadlocks are impossible. No Supabase data used.'};
  await writeFile(new URL('../../../docs/cam/benchmarks/backend-load.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
  report('load_consistency_FK_RLS_indexes_and_deadlocks','passed');return result;
}
