// Real Supabase test account -> the native development API at fixed localhost:3001.
// Only bundled public fixtures. GET profile may provision an absent profile;
// existing profile content is not modified. No uploaded images are persisted.
import assert from 'node:assert/strict';
import { readFile,mkdir,writeFile } from 'node:fs/promises';
import sharp from 'sharp';
const report={checks:[],functional_pass:false,session_closed:false};
let session,origin,key,stage='configuration';
const passed=step=>{report.checks.push(step);console.log(JSON.stringify({step,status:'passed'}));};
async function auth(path,body,token){
 const r=await fetch(new URL('/auth/v1/'+path,origin),{method:'POST',headers:{apikey:key,'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
 assert.ok(r.ok,'Auth request must succeed');return r.status===204?{}:r.json();
}
try {
 const project=new URL(process.env.SUPABASE_URL??'');key=process.env.SUPABASE_PUBLISHABLE_KEY;
 assert.equal(process.env.NODE_ENV,'development');assert.equal(project.protocol,'https:');assert.ok(project.hostname.endsWith('.supabase.co'));
 assert.ok(key?.startsWith('sb_publishable_'));assert.ok(process.env.TEST_A_EMAIL?.endsWith('@example.com'));assert.ok(process.env.TEST_A_PASSWORD);
 origin=project.origin;
 stage='supabase_OCR_login';session=await auth('token?grant_type=password',{email:process.env.TEST_A_EMAIL,password:process.env.TEST_A_PASSWORD});passed(stage);
 stage='supabase_runtime_profile_RLS';
 const profile=await fetch('http://127.0.0.1:3001/api/v1/user/profile',{headers:{authorization:'Bearer '+session.access_token},signal:AbortSignal.timeout(15000)});
 assert.equal(profile.status,200);assert.equal((await profile.json()).data.user_id,session.user.id);passed(stage);
 const manifest=JSON.parse(await readFile(new URL('../fixtures/ocr/manifest.json',import.meta.url),'utf8'));
 const small=await readFile(new URL('../fixtures/ocr/english-small.png',import.meta.url));
 stage='supabase_OCR_formats';
 for(const [format,mime]of [['png','image/png'],['jpeg','image/jpeg'],['webp','image/webp']]){
  const form=new FormData();form.append('image',new Blob([await sharp(small)[format]().toBuffer()],{type:mime}),'page.'+format);
  const r=await fetch('http://127.0.0.1:3001/api/v1/ocr/process',{method:'POST',headers:{authorization:'Bearer '+session.access_token},body:form,signal:AbortSignal.timeout(25000)});
  assert.equal(r.status,200);const body=await r.json();assert.ok(body.data.text.includes('English'));assert.equal(body.data.language.code,'en');
 }
 passed(stage);
 stage='supabase_OCR_original_boxes';const full=manifest.cases.find(item=>item.id==='standard-page');
 const form=new FormData();form.append('image',new Blob([await readFile(new URL('../fixtures/ocr/standard-page.png',import.meta.url))],{type:'image/png'}),'page.png');
 const r=await fetch('http://127.0.0.1:3001/api/v1/ocr/process',{method:'POST',headers:{authorization:'Bearer '+session.access_token},body:form,signal:AbortSignal.timeout(25000)});
 assert.equal(r.status,200);const body=await r.json();assert.equal(body.data.words.length,full.word_count);
 assert.equal(body.data.image.width,full.width);assert.equal(body.data.image.height,full.height);
 const first=body.data.words[0];assert.equal(first.text,'Learning');assert.ok(first.bbox.x>=145&&first.bbox.x<=230&&first.bbox.y>=130&&first.bbox.y<=230);
 assert.equal(first.context,'Learning English every day builds confidence and opens new opportunities.');passed(stage);
 report.functional_pass=true;
} catch {console.log(JSON.stringify({step:stage,status:'failed_check_configuration_network_or_assertion'}));process.exitCode=1;}
finally {if(session){try{await auth('logout?scope=local',undefined,session.access_token);report.session_closed=true;passed('supabase_OCR_close_session');}catch{process.exitCode=1;}}}
report.generated_at=new Date().toISOString();
const folder=new URL('../../../docs/cam/benchmarks/',import.meta.url);await mkdir(folder,{recursive:true});await writeFile(new URL('ocr-supabase.json',folder),JSON.stringify(report,null,2)+'\n');
