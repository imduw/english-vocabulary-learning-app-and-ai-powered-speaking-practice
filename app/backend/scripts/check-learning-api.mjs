import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Shared integration scenarios for local PostgreSQL and real Supabase Auth.
// Creates only its own UUID resources, then soft-deletes them. Tombstones remain.
export async function checkLearningApi({origin,tokenA,tokenB,report=()=>{}}) {
  const createdDecks=[];
  const call=async(method,path,body,token=tokenA)=>{
    const response=await fetch(`${origin}/api/v1/${path}`,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
    return {...await response.json(),status:response.status};
  };
  const createDeck=async token=>{
    const id=randomUUID();
    const result=await call('POST','decks',{id,name:'CAM-05 integration fixture'},token);
    assert.equal(result.status,201);createdDecks.push({id,token});return id;
  };
  try {
    assert.equal((await call('GET','vocabulary',undefined,null)).status,401);
    const deckA=await createDeck(tokenA),deckB=await createDeck(tokenB);
    const c1=randomUUID(),c2=randomUUID();
    const label='camtag-'+deckA;
    const input=(id,deck_id=deckA)=>({id,deck_id,word:'CAM05 bank',meaning:'fixture ngân hàng',source_sentence:'A contextual sentence.',tags:[label]});
    assert.equal((await call('POST','vocabulary',input(c1))).status,201);
    assert.equal((await call('POST','vocabulary',{...input(c2),meaning:'fixture bờ sông',is_favorite:true})).status,201);
    assert.equal((await call('GET',`vocabulary?deck_id=${deckA}&q=CAM05&limit=1`)).metadata.pagination.has_more,true);
    assert.equal((await call('GET',`vocabulary?deck_id=${deckA}&is_favorite=true`)).data[0].id,c2);
    assert.equal((await call('GET',`vocabulary?deck_id=${deckA}&q=${encodeURIComponent('bờ sông')}`)).data[0].id,c2);
    assert.equal((await call('POST','vocabulary',{...input(randomUUID()),user_id:randomUUID()})).status,422);
    assert.equal((await call('POST','vocabulary',input(randomUUID(),deckB))).status,404);
    assert.equal((await call('GET',`vocabulary/${c1}`,undefined,tokenB)).status,404);
    assert.equal((await call('PUT',`vocabulary/${c1}`,{base_version:'1',meaning:'attack'},tokenB)).status,404);
    assert.equal((await call('DELETE',`decks/${deckA}?base_version=1`,undefined,tokenB)).status,404);
    report('learning_crud_and_owner_isolation','passed');

    const byTag=await call('GET',`vocabulary?tag=${label.toUpperCase()}&sort=word&order=asc`);
    assert.equal(byTag.status,200);assert.deepEqual(new Set(byTag.data.map(card=>card.id)),new Set([c1,c2]));
    assert.deepEqual(new Set((await call('GET','vocabulary?q='+label)).data.map(card=>card.id)),new Set([c1,c2]));
    assert.deepEqual((await call('GET','vocabulary?tag='+label,undefined,tokenB)).data,[]);
    const renamed=await call('PUT','vocabulary/'+c2,{base_version:'1',tags:['updated-'+deckA]});
    assert.equal(renamed.status,200);assert.deepEqual(renamed.data.tags,['updated-'+deckA]);
    const cleared=await call('PUT','vocabulary/'+c2,{base_version:'2',tags:[]});
    assert.equal(cleared.status,200);assert.deepEqual(cleared.data.tags,[]);
    assert.deepEqual((await call('GET','vocabulary?tag='+label)).data.map(card=>card.id),[c1]);
    assert.equal((await call('POST','vocabulary',{...input(randomUUID()),tags:[' a ','A']})).status,422);
    report('learning_tags_filter_search_sort_replace_clear_and_owner','passed');

    const searchCard=randomUUID();
    assert.equal((await call('POST','vocabulary',{id:searchCard,deck_id:deckA,
      word:'HELLO 100%_\\.*+?^${}()|[] ***=',meaning:'Học TIẾNG Việt; Café École; ĐƯỜNG phố'})).status,201);
    for(const needle of ['hello','tiếng','ÉCOLE','đường','%','_','\\','.*','[','***=']) {
      const path=`vocabulary?deck_id=${deckA}&q=${encodeURIComponent(needle)}`;
      assert.deepEqual((await call('GET',path)).data.map(card=>card.id),[searchCard],needle);
      assert.deepEqual((await call('GET',path,undefined,tokenB)).data,[],needle);
    }
    report('learning_search_unicode_literal_and_owner_isolation','passed');

    const rolledBack=randomUUID();
    assert.equal((await call('POST','vocabulary/batch',{items:[input(rolledBack),input(randomUUID(),deckB)]})).status,404);
    assert.equal((await call('GET',`vocabulary/${rolledBack}`)).status,404);
    assert.equal((await call('POST','vocabulary/batch',{items:[input(rolledBack),input(c1)]})).status,409);
    assert.equal((await call('GET',`vocabulary/${rolledBack}`)).status,404);
    const batchIds=[randomUUID(),randomUUID()];
    const batch=await call('POST','vocabulary/batch',{items:batchIds.map(id=>input(id))});
    assert.equal(batch.status,201);assert.deepEqual(batch.data.map(item=>item.id),batchIds);
    report('learning_batch_atomicity','passed');

    const races=await Promise.all([
      call('PUT',`vocabulary/${c1}`,{base_version:'1',is_favorite:true}),
      call('PUT',`vocabulary/${c1}`,{base_version:'1',phonetic:'/bank/'}),
    ]);
    assert.deepEqual(races.map(result=>result.status).sort(),[200,409]);
    const current=await call('GET',`vocabulary/${c1}`);
    assert.equal(current.data.version,'2');
    assert.equal((await call('DELETE',`vocabulary/${c1}?base_version=1`)).status,409);
    assert.equal((await call('DELETE',`vocabulary/${c1}?base_version=2`)).status,200);
    assert.equal((await call('GET',`vocabulary/${c1}`)).status,404);
    report('learning_concurrent_version_control','passed');

    const lateId=randomUUID();
    const deletionRace=await Promise.all([
      call('POST','vocabulary',input(lateId)),
      call('DELETE',`decks/${deckA}?base_version=1`),
    ]);
    assert.ok([201,404].includes(deletionRace[0].status));assert.equal(deletionRace[1].status,200);
    assert.equal((await call('GET',`vocabulary/${lateId}`)).status,404);
    assert.equal((await call('GET',`vocabulary/${c2}`)).status,404);
    assert.equal((await call('GET',`vocabulary?deck_id=${deckA}`)).data.length,0);
    assert.equal((await call('POST','vocabulary',input(randomUUID()))).status,404);
    assert.equal((await call('GET',`decks/${deckB}`,undefined,tokenB)).status,200);
    report('learning_parent_delete_race','passed');
  } finally {
    let failed=false;
    for(const {id,token} of createdDecks) {
      try {
        const current=await call('GET',`decks/${id}`,undefined,token);
        if(current.status===404)continue;
        assert.equal(current.status,200);
        assert.equal((await call('DELETE',`decks/${id}?base_version=${current.data.version}`,undefined,token)).status,200);
      } catch {failed=true;}
    }
    report('learning_fixture_cleanup',failed?'failed':'passed_soft_deleted');
    if(failed)throw new Error('Fixture cleanup failed');
  }
}
