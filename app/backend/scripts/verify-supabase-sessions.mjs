import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import pg from 'pg';
import {migrationConnection} from './database-config.mjs';

// Only existing, explicitly configured development test accounts. No signup,
// global logout, settings update or application-data mutation is performed.
const report={checks:[],passed:false,sessions_closed:false};
const sessions=[];let project,key,db,stage='configuration';
const passed=step=>{report.checks.push(step);console.log(JSON.stringify({step,status:'passed'}));};
async function api(action,body){
 const r=await fetch('http://127.0.0.1:3001/api/v1/auth/'+action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
 return {http:r.status,headers:r.headers,body:await r.json()};
}
async function logout(session){
 const r=await fetch(new URL('/auth/v1/logout?scope=local',project),{method:'POST',headers:{apikey:key,authorization:'Bearer '+session.access_token},signal:AbortSignal.timeout(15000)});
 assert.ok(r.ok);session.closed=true;
}
function sessionFrom(result){assert.equal(result.http,200);assert.equal(result.headers.get('cache-control'),'no-store');assert.ok(result.body.data?.session?.access_token&&result.body.data.session.refresh_token);return {...result.body.data.session,user:result.body.data.user,closed:false};}
try{
 const url=new URL(process.env.SUPABASE_URL??'');key=process.env.SUPABASE_PUBLISHABLE_KEY;
 assert.equal(process.env.NODE_ENV,'development');assert.equal(url.protocol,'https:');assert.ok(url.hostname.endsWith('.supabase.co'));
 assert.equal(url.pathname,'/');assert.ok(!url.username&&!url.password&&!url.search&&!url.hash);assert.ok(key?.startsWith('sb_publishable_'));project=url.origin;
 const accounts=['A','B'].map(label=>({email:process.env['TEST_'+label+'_EMAIL'],password:process.env['TEST_'+label+'_PASSWORD']}));
 assert.ok(accounts.every(a=>a.email?.endsWith('@example.com')&&a.password));assert.notEqual(accounts[0].email,accounts[1].email);
 stage='proxy_login_A_B';
 for(const account of accounts)sessions.push(sessionFrom(await api('login',account)));
 assert.notEqual(sessions[0].user.id,sessions[1].user.id);passed(stage);
 stage='bcrypt_and_independent_salts';
 db=new pg.Client({...migrationConnection(),connectionTimeoutMillis:10000});await db.connect();await db.query('BEGIN READ ONLY');
 try{
   // Return booleans/counts only; no hash, salt, password or user row is fetched.
   const checked=(await db.query(`SELECT count(*)::int AS checked,
     bool_and(encrypted_password ~ '^\\$2[aby]\\$[0-9]{2}\\$[./A-Za-z0-9]{53}$') AS bcrypt,
     count(DISTINCT substr(encrypted_password,8,22))::int AS salts
     FROM auth.users WHERE id=ANY($1::uuid[])`,[sessions.map(s=>s.user.id)])).rows[0];
   assert.equal(checked.checked,2);assert.equal(checked.bcrypt,true);assert.equal(checked.salts,2);
 }finally{await db.query('ROLLBACK');}
 await db.end();db=undefined;passed(stage);
 stage='refresh_rotates_pair_same_owner';
 const root=sessions[0].refresh_token,first=sessionFrom(await api('refresh',{refresh_token:root}));
 assert.equal(first.user.id,sessions[0].user.id);assert.notEqual(first.refresh_token,root);sessions[0]=first;passed(stage);
 stage='refresh_parent_retry_exception';
 const retry=sessionFrom(await api('refresh',{refresh_token:root}));sessions[0]=retry;
 assert.equal(retry.refresh_token,first.refresh_token);assert.equal(retry.user.id,first.user.id);passed(stage);
 const latest=sessionFrom(await api('refresh',{refresh_token:retry.refresh_token}));sessions[0]=latest;
 assert.notEqual(latest.refresh_token,retry.refresh_token);
 stage='new_access_token_reads_profile';
 const profile=await fetch('http://127.0.0.1:3001/api/v1/user/profile',{headers:{authorization:'Bearer '+latest.access_token},signal:AbortSignal.timeout(15000)});
 assert.equal(profile.status,200);assert.equal((await profile.json()).data.user_id,latest.user.id);passed(stage);
 stage='local_logout_rejects_root_and_latest_refresh';await logout(latest);
 for(const refresh_token of [root,latest.refresh_token]){
   const revoked=await api('refresh',{refresh_token});
   if(revoked.http===200)sessions[0]=sessionFrom(revoked); // Cleanup any unexpected renewed session before failing.
   assert.equal(revoked.http,401);
 }
 passed(stage);
 stage='other_account_refresh_remains_valid';
 const b=sessionFrom(await api('refresh',{refresh_token:sessions[1].refresh_token}));
 assert.equal(b.user.id,sessions[1].user.id);sessions[1]=b;passed(stage);
 stage='offline_access_token_remains_valid_until_expiry';
 const oldAccess=await fetch('http://127.0.0.1:3001/api/v1/user/profile',{headers:{authorization:'Bearer '+latest.access_token},signal:AbortSignal.timeout(15000)});
 assert.equal(oldAccess.status,200);passed(stage);
 report.semantics={provider:'Supabase Auth',refresh_tokens:'opaque, provider rotation with parent/reuse exceptions',strict_immediate_old_token_rejection:false,offline_JWT_revocation:'access token remains valid until expiry; logout revokes refresh session'};
 report.passed=true;
}catch{console.log(JSON.stringify({step:stage,status:'failed_check_configuration_network_or_assertion'}));process.exitCode=1;}
finally{
 await db?.end().catch(()=>{});
 let closed=true;
 for(const session of sessions)if(!session.closed){try{await logout(session);}catch{closed=false;process.exitCode=1;}}
 report.sessions_closed=closed&&sessions.length===2&&sessions.every(s=>s.closed);
 if(report.sessions_closed)passed('close_only_created_test_sessions');
}
report.generated_at=new Date().toISOString();report.scope='Proxy login/refresh + existing development users; read-only hash-format/salt-count checks; no registration/email/settings mutation. GET profile may provision missing profile.';
await writeFile(new URL('../../../docs/cam/benchmarks/auth-supabase-sessions.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
