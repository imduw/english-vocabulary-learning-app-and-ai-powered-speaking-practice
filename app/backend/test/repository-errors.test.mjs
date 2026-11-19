import 'reflect-metadata';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ProfilesRepository} from '../dist/src/profiles/profiles.repository.js';
import {SyncService} from '../dist/src/sync/sync.service.js';

test('sync conflict audit logs only operation metadata, never snapshots or driver details',t=>{
  const service=new SyncService({}, {}, {}),entries=[];
  t.mock.method(service.logger,'warn',entry=>entries.push(entry));
  const operation_id=randomUUID(),entity_id=randomUUID();
  assert.throws(()=>service.conflict({operation_id,entity_id,entity_type:'card'},'version_mismatch',{word:'private content',user_id:'private owner'}),e=>e.getStatus()===409);
  assert.deepEqual(entries,[{event:'sync_conflict',operation_id,entity_type:'card',reason:'version_mismatch'}]);
});

test('profile repository distinguishes removed accounts, soft-deleted profiles and transport failures',async()=>{
  const repository=query=>new ProfilesRepository({withUser:(_user,work)=>work({query})});
  await assert.rejects(repository(async()=>({rows:[]})).getOrCreate('owner'),e=>e.getStatus()===403);
  await assert.rejects(repository(async()=>{throw {code:'23503'};}).getOrCreate('owner'),e=>e.getStatus()===401);
  const error=Error('database fault');
  await assert.rejects(repository(async()=>{throw error;}).getOrCreate('owner'),e=>e===error);
  for(const [exists,status] of [[false,404],[true,409]]){
    const repo=repository(async sql=>({rows:[],rowCount:sql.startsWith('SELECT 1 FROM app.profiles')&&exists?1:0}));
    await assert.rejects(repo.update('owner',{base_version:'1',display_name:'Cam'}),e=>e.getStatus()===status);
  }
});

test('sync classifies aborted constraint errors without querying the failed transaction again',async()=>{
  for(const code of ['23505','23503','23514','XX000']){
    let aborted=false,receiptWrites=0;
    const fault={code},database={withUser:(_user,work)=>work({query:async sql=>{
      assert.equal(aborted,false,'must not query an aborted transaction');
      if(sql.startsWith('INSERT INTO app.sync_receipts'))receiptWrites++;
      return {rows:[]};
    }})};
    const service=new SyncService(database,{insert:async()=>{aborted=true;throw fault;}},{getOrCreate:async()=>{}});
    const input={items:[{operation_id:randomUUID(),entity_type:'deck',entity_id:randomUUID(),action:'create',base_version:null,payload:{name:'test'}}]};
    await assert.rejects(service.batch(randomUUID(),input),e=>code==='XX000'?e===fault:e.getStatus()===409&&e.details.reason==='constraint');
    assert.equal(receiptWrites,0);
  }
});
