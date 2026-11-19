import 'reflect-metadata';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {DatabaseService} from '../dist/src/database/database.service.js';

// Faults at the pg transport boundary; SQL/RLS correctness is tested separately
// against PostgreSQL. No production injection hooks are added for these tests.
function harness(t,{connectError,unsafe=false,rollbackError=false,commitError=false}={}) {
  const db=new DatabaseService({database:{}}),calls=[],released=[];
  const client=new EventEmitter();
  client.release=broken=>released.push(broken);
  client.query=async(sql,values)=>{
    calls.push({sql,values});
    if(sql.startsWith('SELECT rolsuper'))return {rows:[{rolsuper:unsafe,rolbypassrls:false}]};
    if(sql==='ROLLBACK'&&rollbackError)throw Error('socket closed');
    if(sql==='COMMIT'&&commitError)throw Error('commit failed');
    return {rows:[]};
  };
  t.mock.method(db.pool,'connect',async()=>{if(connectError)throw connectError;return client;});
  const logged=[];t.mock.method(db.logger,'error',message=>logged.push(message));
  db.pool.emit('connect',client);
  t.after(()=>db.onApplicationShutdown());
  return {db,client,calls,released,logged};
}
test('database commits verified owner context and releases a healthy connection',async t=>{
  const h=harness(t);
  assert.equal(await h.db.withUser('owner-a',async client=>{assert.equal(client,h.client);return 42;}),42);
  assert.deepEqual(h.calls.map(c=>c.sql),['SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user','BEGIN',"SELECT set_config('app.user_id', $1, true)",'COMMIT']);
  assert.deepEqual(h.calls[2].values,['owner-a']);assert.deepEqual(h.released,[false]);
  t.mock.method(h.db.pool,'query',async sql=>{assert.equal(sql,'SELECT 1');});await h.db.ping();
});
test('database connect/unsafe-role failures never invoke application work',async t=>{
  for(const options of [{connectError:Error('sensitive connection string')},{unsafe:true}]){
    const h=harness(t,options);let called=false;
    await assert.rejects(h.db.withUser('owner',async()=>{called=true;}),error=>error.getStatus()===503&&!error.message.includes('sensitive'));
    assert.equal(called,false);assert.deepEqual(h.released,options.connectError?[]:[false]);
  }
});
test('database rolls back business/commit failures and preserves errors after successful rollback',async t=>{
  const failure=Error('business failure'),h=harness(t);
  await assert.rejects(h.db.withUser('owner',async()=>{throw failure;}),error=>error===failure);
  assert.equal(h.calls.at(-1).sql,'ROLLBACK');assert.deepEqual(h.released,[false]);
  const commit=harness(t,{commitError:true});
  await assert.rejects(commit.db.withUser('owner',async()=>1),/commit failed/);
  assert.deepEqual(commit.calls.slice(-2).map(c=>c.sql),['COMMIT','ROLLBACK']);assert.deepEqual(commit.released,[false]);
});
test('database destroys disconnected/rollback-failed clients and logs only fixed labels',async t=>{
  for(const rollbackError of [false,true]){
    const h=harness(t,{rollbackError});
    await assert.rejects(h.db.withUser('owner',async()=>{
      if(!rollbackError)h.client.emit('error',Error('sensitive socket details'));
      throw Error('sensitive SQL details');
    }),error=>error.getStatus()===503&&!error.message.includes('sensitive'));
    assert.deepEqual(h.released,[true]);
    assert.deepEqual(h.logged,rollbackError?[]:['database_connection_error']);
    h.db.pool.emit('error',Error('sensitive idle details'));
    assert.equal(h.logged.at(-1),'database_idle_connection_error');
  }
});
