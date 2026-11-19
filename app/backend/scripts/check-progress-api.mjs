import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function checkProgressApi({origin,tokenA,tokenB,report=()=>{}}){
  const call=async(method,path,body,token=tokenA)=>{
    const r=await fetch(origin+'/api/v1/'+path,{method,headers:{'content-type':'application/json',authorization:'Bearer '+token},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(120000)});
    return {...await r.json(),status:r.status};
  };
  const deck=randomUUID(),card=randomUUID();
  try{
    assert.equal((await call('POST','decks',{id:deck,name:'Progress API fixture'})).status,201);
    assert.equal((await call('POST','vocabulary',{id:card,deck_id:deck,word:'practice',meaning:'review fixture'})).status,201);
    const input={id:randomUUID(),card_id:card,quality:4,score:80,reviewed_at:new Date(Date.now()-86400000).toISOString(),timezone_at_review:'Asia/Ho_Chi_Minh',algorithm_version:'sm2-v1'};
    const first=await call('POST','progress/review',input);assert.equal(first.status,200);
    assert.equal(first.data.state.interval_days,1);
    const duplicates=await Promise.all(Array.from({length:8},()=>call('POST','progress/review',input)));
    for(const r of duplicates){assert.equal(r.status,200);assert.deepEqual(r.data,first.data);}
    assert.equal((await call('GET','progress/history?card_id='+card)).data.length,1);
    assert.equal((await call('POST','progress/review',{...input,quality:5})).status,409);
    report('progress_parallel_duplicate_receipts','passed');
    // Distinct reviews arrive together and out of chronological order.
    const events=Array.from({length:16},(_,i)=>({...input,id:randomUUID(),quality:i===7?0:4,
      reviewed_at:new Date(Date.now()-3600000-i*60000).toISOString()}));
    const results=await Promise.all(events.map(e=>call('POST','progress/review',e)));
    if(results.some(r=>r.status!==200)){
      const counts={};for(const r of results)counts[r.status]=(counts[r.status]??0)+1;
      for(const [status,count] of Object.entries(counts))report('progress_parallel_http_'+status,String(count));
    }
    for(const r of results)assert.equal(r.status,200);
    const history=await call('GET','progress/history?limit=100&card_id='+card);
    assert.equal(history.data.length,17);assert.equal(new Set(history.data.map(e=>e.id)).size,17);
    const last=await call('POST','progress/review',{...input,id:randomUUID(),reviewed_at:new Date(Date.now()-1800000).toISOString()});
    assert.equal(last.status,200);assert.equal(last.data.state.total_reviews,18);
    assert.equal(last.data.state.repetitions,8);
    assert.equal(last.data.state.ease_factor,1.7);
    assert.equal(last.data.state.interval_days,165);
    report('progress_parallel_distinct_events_replay_without_lost_updates','passed');
    assert.equal((await call('POST','progress/review',{...input,id:randomUUID()},tokenB)).status,404);
    assert.equal((await call('GET','progress/history?card_id='+card,undefined,tokenB)).data.length,0);
    const summary=await call('GET','progress/summary');assert.equal(summary.status,200);
    assert.ok(summary.data.current_streak>=1);assert.ok(summary.data.total_reviews>=18);
    assert.equal(summary.data.total_cards,summary.data.new_count+summary.data.learning_count+summary.data.relearning_count+summary.data.mastered_count);
    report('progress_summary_history_owner_isolation','passed');
    const firstPage=await call('GET','progress/changes?limit=1');assert.equal(firstPage.status,200);
    const late={...input,id:randomUUID(),reviewed_at:new Date(Date.now()-2*86400000).toISOString()};
    assert.equal((await call('POST','progress/review',late)).status,200);
    let cursor=firstPage.data.next_cursor,more=firstPage.data.has_more;
    const initial=[...firstPage.data.events];
    while(more){const page=await call('GET','progress/changes?cursor='+encodeURIComponent(cursor));assert.equal(page.status,200);initial.push(...page.data.events);cursor=page.data.next_cursor;more=page.data.has_more;}
    assert.ok(!initial.some(e=>e.id===late.id));
    const next=await call('GET','progress/changes?cursor='+encodeURIComponent(cursor));assert.equal(next.status,200);
    assert.equal(next.data.events.filter(e=>e.id===late.id).length,1);
    assert.equal((await call('GET','progress/changes?cursor='+encodeURIComponent(cursor),undefined,tokenB)).status,422);
    report('progress_commit_ordered_feed_late_event_and_owner_cursor','passed');
  }finally{
    const current=await call('GET','decks/'+deck);
    if(current.status===200)assert.equal((await call('DELETE',`decks/${deck}?base_version=${current.data.version}`)).status,200);
    report('progress_fixture_cleanup','passed_soft_deleted_review_audit_retained');
  }
}
