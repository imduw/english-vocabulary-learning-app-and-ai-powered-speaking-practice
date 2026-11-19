import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import pg from 'pg';
import {migrationConnection} from './database-config.mjs';
import {startTemporaryBackend} from './temporary-backend.mjs';

// Explicit two-step check: begin sends one signup request to the supplied owned
// mailbox; complete verifies real confirmation/login, never admin-confirms it.
const statePath=new URL('../.registration-test.local.json',import.meta.url);
const reportPath=new URL('../../../docs/cam/benchmarks/auth-supabase-registration.json',import.meta.url);
let db,backend,session,project,key,state,stage='configuration';
let report={passed:false,checks:[],email_delivery:'not_yet_confirmed',sessions_closed:true};
const passed=name=>{report.checks.push(name);console.log(JSON.stringify({step:name,status:'passed'}));};
async function saved(){await writeFile(reportPath,JSON.stringify({...report,generated_at:new Date().toISOString()},null,2)+'\n');}
async function api(action,body){
 const r=await fetch(backend.origin+'/api/v1/auth/'+action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
 return {status:r.status,headers:r.headers,body:await r.json()};
}
async function account(){
 const {rows}=await db.query(`SELECT id,email_confirmed_at IS NOT NULL AS confirmed,
  confirmation_sent_at IS NOT NULL AS confirmation_requested,
  encrypted_password ~ '^\\$2[aby]\\$[0-9]{2}\\$[./A-Za-z0-9]{53}$' AS bcrypt
  FROM auth.users WHERE lower(email)=lower($1)`,[state.email]);
 assert.ok(rows.length<=1);return rows[0];
}
async function logout(){
 if(!session)return;
 const r=await fetch(new URL('/auth/v1/logout?scope=local',project),{method:'POST',headers:{apikey:key,authorization:'Bearer '+session.access_token},signal:AbortSignal.timeout(15000)});
 assert.ok(r.ok);session=undefined;report.sessions_closed=true;
}
try{
 assert.equal(process.env.NODE_ENV,'development');
 const url=new URL(process.env.SUPABASE_URL??'');assert.equal(url.protocol,'https:');assert.ok(url.hostname.endsWith('.supabase.co'));
 assert.equal(url.origin+'/',url.href);project=url.origin;key=process.env.SUPABASE_PUBLISHABLE_KEY;assert.ok(key?.startsWith('sb_publishable_'));
 const begin=process.argv.includes('--begin'),complete=process.argv.includes('--complete');assert.notEqual(begin,complete);
 if(begin){
  try{await readFile(statePath);throw Error('Existing registration state: use --complete');}catch(error){if(error.code!=='ENOENT')throw error;}
  const email=process.env.REGISTRATION_TEST_EMAIL??process.argv.find(value=>value.startsWith('--email='))?.slice(8);assert.ok(typeof email==='string'&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)&&!email.endsWith('@example.com'));
  state={project,email,password:randomBytes(24).toString('base64url')+'aA9!',created_at:new Date().toISOString(),submitted:false};
 }else{
  state=JSON.parse(await readFile(statePath,'utf8'));assert.equal(state.project,project);assert.equal(typeof state.submitted,'boolean');
  report=JSON.parse(await readFile(reportPath,'utf8'));
 }
 db=new pg.Client(migrationConnection());await db.connect();await db.query('BEGIN READ ONLY');
 const before=await account();await db.query('ROLLBACK');
 if(begin){assert.equal(before,undefined);passed('mailbox_not_preexisting_in_project');}
 else assert.ok(before?.id);
 backend=await startTemporaryBackend(Object.fromEntries(['DATABASE_URL','DATABASE_SSL','DATABASE_CA_FILE','SUPABASE_URL','SUPABASE_PUBLISHABLE_KEY'].filter(k=>process.env[k]).map(k=>[k,process.env[k]])));
 if(begin){
  // Save before the one external write: a lost response must never cause an
  // automatic repeated signup/email. State contains no access/refresh tokens.
  await writeFile(statePath,JSON.stringify(state)+'\n',{flag:'wx',mode:0o600});
  stage='register_via_backend';const response=await api('register',{email:state.email,password:state.password});
  report.registration_http=response.status;
  if(response.status!==200){report.failure_code=response.body.error?.code??'http_error';throw Error('Registration rejected');}
  assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('pragma'),'no-cache');
  const data=response.body.data;
  if(data?.session){session=data.session;report.sessions_closed=false;report.confirmation_policy='immediate_session';}
  else {assert.deepEqual(data,{user:null,session:null,requires_email_confirmation:true});report.confirmation_policy='email_confirmation_required';}
  state.submitted=true;await writeFile(statePath,JSON.stringify(state)+'\n',{mode:0o600});passed(stage);
  stage='stored_hash_and_confirmation_state';const stored=await account();assert.ok(stored?.bcrypt);passed(stage);
  report.provider_confirmation_requested=stored.confirmation_requested;
  if(!stored.confirmed){
   assert.equal((await api('login',{email:state.email,password:state.password})).status,401);passed('login_rejected_before_confirmation');
   report.status='awaiting_mailbox_confirmation';
  }else report.status='confirmation_disabled_email_delivery_not_proven';
 }else{
  stage='provider_email_confirmed';assert.equal(before.confirmed,true);passed(stage);
  if(process.argv.includes('--email-received'))report.email_delivery='confirmed_by_mailbox_owner';
  stage='login_and_profile_after_confirmation';
  const login=await api('login',{email:state.email,password:state.password});assert.equal(login.status,200);
  session=login.body.data.session;report.sessions_closed=false;assert.ok(session?.access_token&&session.refresh_token);
  assert.equal(login.body.data.user.id,before.id);assert.equal(login.headers.get('cache-control'),'no-store');
  assert.equal((await fetch(backend.origin+'/api/v1/user/profile')).status,401);
  const profile=await fetch(backend.origin+'/api/v1/user/profile',{headers:{authorization:'Bearer '+session.access_token},signal:AbortSignal.timeout(15000)});
  assert.equal(profile.status,200);assert.equal((await profile.json()).data.user_id,before.id);passed(stage);
  stage='new_account_refresh_rotation';const old=session.refresh_token;
  const refreshed=await api('refresh',{refresh_token:old});assert.equal(refreshed.status,200);
  session=refreshed.body.data.session;assert.ok(session?.access_token&&session.refresh_token);assert.notEqual(session.refresh_token,old);assert.equal(refreshed.body.data.user.id,before.id);passed(stage);
  stage='logout_only_new_test_session';await logout();passed(stage);
  report.passed=report.email_delivery==='confirmed_by_mailbox_owner';report.status=report.passed?'passed':'email_receipt_attestation_missing';
  if(report.passed)await unlink(statePath);
 }
}catch{
 report.failed_stage=stage;report.status='needs_configuration_or_check';process.exitCode=1;
 console.log(JSON.stringify({step:stage,status:'failed_no_credentials_logged',...(report.failure_code?{code:report.failure_code}:{})}));
}finally{
 try{await logout();}catch{report.sessions_closed=false;report.passed=false;process.exitCode=1;}
 await backend?.close();await db?.end().catch(()=>{});
 report.scope='One explicitly owned fresh mailbox; signup through temporary backend, read-only auth checks, manual real email confirmation, login/profile/refresh, local logout. No settings change, admin confirmation or account deletion. Account/profile retained.';
 await saved();
 console.log(JSON.stringify({step:'registration_report',status:report.status,passed:report.passed}));
}
