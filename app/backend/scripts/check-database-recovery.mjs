// Local PostgreSQL only. A private TCP proxy drops this test's connections;
// other backend processes, containers and Supabase connections stay untouched.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import {createServer,createConnection} from 'node:net';
import {once} from 'node:events';
import {Test} from '@nestjs/testing';
import {DatabaseService} from '../dist/src/database/database.service.js';
import {HealthController} from '../dist/src/health/health.controller.js';
import {HealthService} from '../dist/src/health/health.service.js';
import {configureHttp} from '../dist/src/common/http.js';

export async function checkDatabaseRecovery({report=()=>{}}={}){
  const sockets=new Set();let available=true;
  const proxy=createServer(incoming=>{
    incoming.on('error',()=>{});
    if(!available){incoming.destroy();return;}
    const outgoing=createConnection({host:'127.0.0.1',port:54329});
    sockets.add(incoming);sockets.add(outgoing);
    incoming.on('close',()=>{sockets.delete(incoming);outgoing.destroy();});
    outgoing.on('close',()=>{sockets.delete(outgoing);incoming.destroy();});
    outgoing.on('error',()=>incoming.destroy());
    incoming.pipe(outgoing);outgoing.pipe(incoming);
  });
  proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
  const database=new DatabaseService({port:0,database:{
    host:'127.0.0.1',port:proxy.address().port,database:'vocabulary',user:'cam_backend',password:'local_backend_only',
    ssl:false,max:1,connectionTimeoutMillis:500,query_timeout:2000,statement_timeout:15000,
    idleTimeoutMillis:10000,application_name:'cam-recovery-test',
  }});
  let app;
  const a='10000000-0000-4000-8000-000000000001',b='10000000-0000-4000-8000-000000000002';
  const breakNetwork=()=>{available=false;for(const socket of sockets)socket.destroy();};
  try{
    const module=await Test.createTestingModule({controllers:[HealthController],providers:[HealthService,{provide:DatabaseService,useValue:database}]}).compile();
    app=module.createNestApplication({logger:false});configureHttp(app);await app.listen(0,'127.0.0.1');
    const origin=await app.getUrl();
    const health=()=>fetch(origin+'/health',{signal:AbortSignal.timeout(3000)});
    const recover=async()=>{
      available=true;
      for(let attempt=0;attempt<20;attempt++){
        if((await health()).status===200)return;
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      assert.fail('The same pool must recover after connectivity returns');
    };
    assert.equal((await health()).status,200);
    breakNetwork();
    const down=await health();assert.equal(down.status,503);assert.equal((await down.json()).error.code,'SERVICE_UNAVAILABLE');
    assert.equal((await fetch(origin+'/health/live')).status,200,'liveness remains available during DB outage');
    await recover();report('database_idle_disconnect_readiness_200_503_200','passed');

    const before=await database.withUser(a,async client=>(await client.query('SELECT display_name,version::text FROM app.profiles WHERE user_id=$1',[a])).rows[0]);
    assert.ok(before,'local seed profile must exist');
    let signalStarted;const started=new Promise(resolve=>signalStarted=resolve);
    const pending=database.withUser(a,async client=>{
      await client.query('UPDATE app.profiles SET display_name=$2 WHERE user_id=$1',[a,'Uncommitted recovery fixture']);
      const sleeping=client.query('SELECT pg_sleep(10)');signalStarted();await sleeping;
    });
    // Attach a handler before dropping the socket, including failures before sleep.
    const rejected=assert.rejects(pending);
    await Promise.race([started,pending.then(()=>assert.fail('Transaction unexpectedly completed'))]);
    breakNetwork();await rejected;
    assert.equal((await health()).status,503);await recover();
    const after=await database.withUser(a,async client=>(await client.query('SELECT display_name,version::text FROM app.profiles WHERE user_id=$1',[a])).rows[0]);
    assert.deepEqual(after,before,'connection loss must roll back both content and version');
    report('database_active_transaction_disconnect_rolls_back_and_recovers','passed');

    for(const owner of [b,a]){
      await database.withUser(owner,async client=>{
        assert.equal((await client.query('SELECT app.current_user_id() AS id')).rows[0].id,owner);
        const rows=(await client.query('SELECT user_id FROM app.profiles')).rows;
        assert.ok(rows.length>0);assert.ok(rows.every(row=>row.user_id===owner));
      });
    }
    report('database_reconnected_pool_preserves_owner_isolation','passed');
  }finally{
    // Close the application first so the pool can finish before proxy teardown.
    if(app)await app.close();else await database.onApplicationShutdown();
    for(const socket of sockets)socket.destroy();
    await new Promise(resolve=>proxy.close(resolve));
  }
}
