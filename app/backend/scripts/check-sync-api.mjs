import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function checkSyncApi({origin,accountId,tokenA,tokenB,admin,report=()=>{}}) {
  const call=async(method,path,body,token=tokenA)=>{
    const r=await fetch(`${origin}/api/v1/${path}`,{method,headers:{'content-type':'application/json',authorization:`Bearer ${token}`},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
    return {...await r.json(),status:r.status};
  };
  const deck=randomUUID(),card=randomUUID();
  const mutation=(kind,id,action,payload,base_version=null)=>({operation_id:randomUUID(),entity_type:kind,entity_id:id,action,payload,base_version});
  const pullAll=async(cursor)=>{
    const changes=[];
    for(let page=0;page<1000;page++) {
      const r=await call('GET','sync/changes'+(cursor?'?cursor='+encodeURIComponent(cursor):''));assert.equal(r.status,200);
      changes.push(...r.data.changes);cursor=r.data.next_cursor;if(!r.data.has_more)return {changes,cursor};
    }
    throw new Error('Unexpected sync history size');
  };
  const baseline=await pullAll();
  try {
    const label='sync-'+card,nextLabel='u-'+card;
    const items=[mutation('deck',deck,'create',{name:'Sync protocol fixture'}),mutation('card',card,'create',{deck_id:deck,word:'bank',meaning:'fixture',tags:[label]})];
    const created=await call('POST','sync/batch',{items});assert.equal(created.status,200);
    const replay=await call('POST','sync/batch',{items});assert.equal(replay.status,200);assert.deepEqual(replay.data,created.data);
    const initial=await call('GET','sync/changes?limit=1&cursor='+encodeURIComponent(baseline.cursor));assert.equal(initial.status,200);assert.equal(initial.data.has_more,true);
    assert.deepEqual(created.data.results[1].record.tags,[label]);
    const changed=await call('PUT','vocabulary/'+card,{base_version:'1',meaning:'ordinary CRUD logged',tags:[nextLabel]});assert.equal(changed.status,200);
    const second=await call('GET','sync/changes?limit=1&cursor='+encodeURIComponent(initial.data.next_cursor));assert.equal(second.data.has_more,false);assert.equal(second.data.changes[0].record.version,'1');
    assert.deepEqual(second.data.changes[0].record.tags,[label]);
    const later=await pullAll(second.data.next_cursor);assert.equal(later.changes.filter(c=>c.entity_id===card&&c.record.version==='2').length,1);
    assert.deepEqual(later.changes.find(c=>c.entity_id===card&&c.record.version==='2').record.tags,[nextLabel]);
    assert.deepEqual((await call('POST','sync/batch',{items:[items[1]]})).data.results[0].record.tags,[label]);
    assert.equal((await call('GET','sync/changes?cursor='+encodeURIComponent(later.cursor),undefined,tokenB)).status,422);
    report('sync_replay_cursor_upper_bound_and_tenant_binding','passed');

    const rolledBack=randomUUID();
    const conflict=await call('POST','sync/batch',{items:[mutation('deck',rolledBack,'create',{name:'rollback'}),mutation('card',card,'update',{word:'stale'},'1')]});
    assert.equal(conflict.status,409);assert.equal(conflict.error.details.server.version,'2');assert.equal((await call('GET','decks/'+rolledBack)).status,404);
    assert.ok(!(await pullAll(later.cursor)).changes.some(c=>c.entity_id===rolledBack));
    report('sync_batch_rollback_including_change_log','passed');

    if(admin) {
      // Assign a sequence in an uncommitted writer. A reader must not advance
      // beyond it until commit (plain timestamp/global-sequence cursors can fail).
      const pending=randomUUID();let transaction=false;
      try {
        await admin.query('BEGIN');transaction=true;
        await admin.query('INSERT INTO app.decks(id,user_id,name) VALUES($1,$2,$3)',[pending,accountId,'Commit-order fixture']);
        const beforeCommit=await pullAll(later.cursor);
        assert.ok(!beforeCommit.changes.some(c=>c.entity_id===pending));
        await admin.query('COMMIT');transaction=false;
        const afterCommit=await pullAll(beforeCommit.cursor);
        assert.ok(afterCommit.changes.some(c=>c.entity_id===pending));
        const row=await call('GET','decks/'+pending);assert.equal((await call('DELETE',`decks/${pending}?base_version=${row.data.version}`)).status,200);
        report('sync_cursor_never_skips_uncommitted_writer','passed');
      }finally{if(transaction)await admin.query('ROLLBACK');}
    }
  }finally{
    const current=await call('GET','decks/'+deck);
    if(current.status===200)assert.equal((await call('DELETE',`decks/${deck}?base_version=${current.data.version}`)).status,200);
    else assert.equal(current.status,404);
    report('sync_protocol_fixture_cleanup','passed_soft_deleted');
  }
}
