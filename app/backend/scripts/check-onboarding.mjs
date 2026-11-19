import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {docker} from './local-docker.mjs';

const project='cam-onboard-'+randomUUID();
const compose=['compose','--project-name',project,'--file','compose.yaml','--file','compose.onboarding.yaml'];
const env={...process.env,COMPOSE_DISABLE_ENV_FILE:'1',SUPABASE_URL:'',SUPABASE_PUBLISHABLE_KEY:''};
const started=performance.now();let passed=false,report,stage='compose_build_and_start';
try{
  await docker([...compose,'up','--build','--detach','--wait','--wait-timeout','600','backend'],{env,timeoutMs:900000});
  const address=await docker([...compose,'port','backend','3000'],{env});assert.match(address,/^127\.0\.0\.1:\d+$/);
  const origin='http://'+address,checks=[];
  for(const path of ['/health','/health/live','/docs/','/openapi.json']){
    const r=await fetch(origin+path,{signal:AbortSignal.timeout(5000)});assert.equal(r.status,200);
    if(path==='/openapi.json'){
      const spec=await r.json();assert.equal(spec.info.version,'0.9.0-draft');
      assert.equal(Object.values(spec.paths).reduce((n,p)=>n+Object.keys(p).filter(m=>['get','post','put','patch','delete'].includes(m)).length,0),25);
    }
    checks.push({path,http:200});
  }
  const protectedResponse=await fetch(origin+'/api/v1/user/profile',{signal:AbortSignal.timeout(5000)});assert.equal(protectedResponse.status,401);checks.push({path:'/api/v1/user/profile',http:401});
  const auth=await fetch(origin+'/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'fixture@example.com',password:'example-only-password'}),signal:AbortSignal.timeout(5000)});
  assert.equal(auth.status,503);assert.equal(auth.headers.get('cache-control'),'no-store');checks.push({path:'/api/v1/auth/login',http:503});
  const containers=(await docker([...compose,'ps','--all','--format','json'],{env})).split('\n').filter(Boolean).flatMap(line=>{const x=JSON.parse(line);return Array.isArray(x)?x:[x];});
  assert.equal(containers.find(c=>c.Service==='migrate')?.ExitCode,0);
  const elapsed=performance.now()-started;
  report={generated_at:new Date().toISOString(),scope:'Automated documented Compose install with a new project/database/volume and random loopback API port',
    prerequisites:'Docker engine/Compose >=2.24.4 and Node already installed; repository already available',
    cache_condition:'Existing Docker images/layer cache retained; database/volume freshly initialized. Not a cold-download or first-time human onboarding measurement.',
    elapsed_ms:Number(elapsed.toFixed(2)),target_ms:900000,target_met:elapsed<900000,checks,migration_exit:0,resources_closed:false,passed:elapsed<900000};
  assert.ok(report.target_met,'Onboarding exceeds fifteen-minute target');passed=true;
  console.log(JSON.stringify({step:'fresh_project_build_migrate_health_docs_auth',status:'passed',elapsed_ms:report.elapsed_ms}));
}catch{console.error(JSON.stringify({stage,status:'failed',message:'Isolated onboarding failed; check Docker engine/build resources'}));process.exitCode=1;}
finally{
  try{
    // Random generated project, never the user's default or Supabase project.
    const ids=(await docker([...compose,'ps','--all','--quiet'],{env})).split('\n').filter(Boolean);
    for(const id of ids){assert.match(id,/^[a-f0-9]{12,64}$/);const info=JSON.parse(await docker(['inspect',id]))[0];assert.equal(info.Config.Labels['com.docker.compose.project'],project);}
    let volume;try{volume=JSON.parse(await docker(['volume','inspect',project+'_cam_pgdata']))[0];}catch{}
    if(volume)assert.equal(volume.Labels['com.docker.compose.project'],project);
    await docker([...compose,'down','--volumes'],{env});
    if(passed){report.resources_closed=true;await writeFile(new URL('../../../docs/cam/benchmarks/onboarding-local.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({step:'owned_onboarding_project_cleanup',status:'passed'}));}
  }catch{console.error('Owned onboarding project cleanup failed');process.exitCode=1;}
}
