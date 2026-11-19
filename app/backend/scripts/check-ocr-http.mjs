// Real OCR + production controller/guards/preprocessing through HTTP.
// A local JWKS and ephemeral signing keys replace external Auth only. No DB,
// user accounts, cloud OCR calls or real user images are used by this script.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile,mkdir,writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash,randomUUID } from 'node:crypto';
import { cpus } from 'node:os';
import { execFileSync } from 'node:child_process';
import { generateKeyPair,exportJWK,SignJWT } from 'jose';
import sharp from 'sharp';
import { APP_CONFIG } from '../dist/src/database/database.service.js';
import { AuthGuard } from '../dist/src/auth/auth.guard.js';
import { SupabaseAuthService } from '../dist/src/auth/supabase-auth.service.js';
import { configureHttp } from '../dist/src/common/http.js';
import { OcrController,OcrUploadErrors } from '../dist/src/ocr/ocr.controller.js';
import { OcrBudget,OcrRequestGuard } from '../dist/src/ocr/ocr-budget.js';
import { OcrEngine } from '../dist/src/ocr/ocr-engine.js';
import { OcrImageProcessor,MAX_IMAGE_BYTES } from '../dist/src/ocr/ocr-image.js';
import { OcrService } from '../dist/src/ocr/ocr.service.js';

const args=process.argv.slice(2),benchmark=args.includes('--benchmark'),outputAt=args.indexOf('--output');
const engine=process.env.OCR_ENGINE??'wasm';assert.ok(['native','wasm'].includes(engine));
const output=outputAt>=0?args[outputAt+1]:fileURLToPath(new URL(`../../../docs/cam/benchmarks/ocr-${engine}.json`,import.meta.url));
assert.ok(output,'--output requires a path');
const fixtures=JSON.parse(await readFile(new URL('../fixtures/ocr/manifest.json',import.meta.url),'utf8'));
const inputs=new Map();
for(const item of fixtures.cases){const bytes=await readFile(new URL('../fixtures/ocr/'+item.file,import.meta.url));assert.equal(createHash('sha256').update(bytes).digest('hex'),item.sha256);inputs.set(item.id,{...item,bytes});}
const tokens=text=>text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu)??[];
function accuracy(expected,actual){
 const a=tokens(expected),b=tokens(actual);let previous=Array.from({length:b.length+1},(_,i)=>i);
 for(let i=1;i<=a.length;i++){const next=[i];for(let j=1;j<=b.length;j++)next.push(Math.min(previous[j]+1,next[j-1]+1,previous[j-1]+(a[i-1]===b[j-1]?0:1)));previous=next;}
 return Math.max(0,1-previous[b.length]/Math.max(1,a.length));
}
let app,jwks,origin,stage='setup';
const report={generated_at:new Date().toISOString(),engine,environment:{node:process.version,platform:process.platform,arch:process.arch,cpu:cpus()[0]?.model},
 model_manifest:JSON.parse(await readFile(new URL('../models/manifest.json',import.meta.url),'utf8')),checks:[],samples:[],target_mean_ms:2500,
 method:{http:'loopback HTTP multipart + real ES256 JWT/JWKS + real OCR',concurrency:1,samples:benchmark?6:0,warmup_full_pages:benchmark?1:0,
 fixtures:fixtures.cases.map(({bytes,...item})=>item),timing:'upload, JWT validation, decode/preprocess, recognition, result parsing and JSON response; app/model startup separate',
 scope:'synthetic A4 single-column English references; not a guarantee for all photos, fonts or machines',quality_gate:'token Levenshtein accuracy >=0.95 for full pages; confidence is not calibrated probability'}};
const passed=step=>{report.checks.push(step);console.log(JSON.stringify({step,status:'passed'}));};
const keys=await generateKeyPair('ES256');
const jwk={...await exportJWK(keys.publicKey),kid:'ocr-local-fixture',alg:'ES256',use:'sig'};
try {
 jwks=createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({keys:[jwk]}));});
 jwks.listen(0,'127.0.0.1');await once(jwks,'listening');
 const auth=`http://127.0.0.1:${jwks.address().port}`;
 const sign=()=>new SignJWT({role:'authenticated'}).setSubject(randomUUID()).setIssuer(auth+'/auth/v1').setAudience('authenticated').setIssuedAt().setExpirationTime('10m').setProtectedHeader({alg:'ES256',kid:jwk.kid}).sign(keys.privateKey);
 const [a,b,c,d,e,f]=await Promise.all(Array.from({length:6},sign));
 class OcrCheckModule {}
 Module({controllers:[OcrController],providers:[
  {provide:APP_CONFIG,useValue:{port:0,database:{},auth:{issuer:auth+'/auth/v1',jwksUrl:auth+'/auth/v1/.well-known/jwks.json'},ocr:{warmup:true,engine}}},
  SupabaseAuthService,AuthGuard,OcrBudget,OcrRequestGuard,OcrUploadErrors,OcrEngine,OcrImageProcessor,OcrService,
 ]})(OcrCheckModule);
 const startup=performance.now();app=await NestFactory.create(OcrCheckModule,{logger:false});configureHttp(app);await app.listen(0,'127.0.0.1');
 report.startup_ms=performance.now()-startup;origin=await app.getUrl();
 const upload=async(bytes,type='image/png',token=a,field='image')=>{
  const body=new FormData();body.append(field,new Blob([bytes],{type}),'page.png');
  const start=performance.now();const response=await fetch(origin+'/api/v1/ocr/process',{method:'POST',headers:token?{authorization:'Bearer '+token}:{},body,signal:AbortSignal.timeout(25000)});
  const json=await response.json();return {status:response.status,body:json,ms:performance.now()-start,retry:response.headers.get('retry-after')};
 };
 const validate=(result,fixture,minAccuracy=.9)=>{
  assert.equal(result.status,200);assert.ok(result.body.data.words.length>0);
  const data=result.body.data;assert.equal(data.image.coordinate_space,'upright_original_pixels');
  assert.equal(data.image.width,fixture.width);assert.equal(data.image.height,fixture.height);
  for(const word of data.words){assert.ok(word.bbox.width>0&&word.bbox.height>0&&word.bbox.x>=0&&word.bbox.y>=0&&word.bbox.x+word.bbox.width<=fixture.width&&word.bbox.y+word.bbox.height<=fixture.height);assert.ok(word.confidence>=0&&word.confidence<=1);assert.equal(word.context,data.sentences[word.sentence_index].text);assert.ok(word.context.includes(word.text));}
  assert.ok(accuracy(fixture.text,data.text)>=minAccuracy,'recognition quality must pass alongside latency');
 };
 stage='JWT';const small=inputs.get('english-small');
 assert.equal((await upload(small.bytes,'image/png',null)).status,401);
 const parts=a.split('.');const payload=JSON.parse(Buffer.from(parts[1],'base64url'));payload.sub=randomUUID();parts[1]=Buffer.from(JSON.stringify(payload)).toString('base64url');
 assert.equal((await upload(small.bytes,'image/png',parts.join('.'))).status,401);passed('ocr_real_JWT_missing_and_tampered_rejected');
 stage='formats';
 for(const [format,mime]of [['png','image/png'],['jpeg','image/jpeg'],['webp','image/webp']])validate(await upload(await sharp(small.bytes)[format]().toBuffer(),mime),small);
 passed('ocr_real_PNG_JPEG_WebP_text_boxes_sentences');
 stage='Vietnamese';const vi=inputs.get('vietnamese-small'),v=await upload(vi.bytes,'image/png',b);validate(v,vi,.8);assert.equal(v.body.data.language.code,'vi');passed('ocr_real_Vietnamese_language');
 stage='EXIF';const exif=await sharp(small.bytes).rotate(-90).jpeg().withMetadata({orientation:6}).toBuffer();validate(await upload(exif,'image/jpeg',b),small);passed('ocr_real_EXIF_upright_coordinates');
 stage='blank';const blank=await sharp({create:{width:400,height:200,channels:3,background:'white'}}).png().toBuffer();const empty=await upload(blank,'image/png',b);assert.equal(empty.status,200);assert.deepEqual(empty.body.data.words,[]);assert.equal(empty.body.data.language.code,'und');passed('ocr_real_blank_image');
 stage='validation';
 assert.equal((await upload(Buffer.from('<svg/>'),'image/png',c)).status,400);
 assert.equal((await upload(small.bytes,'image/jpeg',c)).status,400);
 assert.equal((await upload(Buffer.concat([small.bytes.subarray(0,8),Buffer.from('corrupt')]),'image/png',c)).status,400);
 assert.equal((await upload(small.bytes,'image/png',c,'wrong_field')).status,400);
 assert.equal((await upload(Buffer.alloc(MAX_IMAGE_BYTES+1),'image/png',c)).status,413);passed('ocr_real_upload_validation');
 stage='rate';for(let i=0;i<10;i++)assert.equal((await upload(small.bytes,'application/pdf',d)).status,400);
 const limited=await upload(small.bytes,'image/png',d);assert.equal(limited.status,429);assert.ok(Number(limited.retry)>0);passed('ocr_real_owner_rate_limit');
 stage='capacity';const simultaneous=await Promise.all([upload(inputs.get('standard-page').bytes,'image/png',e),upload(inputs.get('standard-page').bytes,'image/png',f)]);
 assert.deepEqual(simultaneous.map(r=>r.status).sort(),[200,503]);assert.equal(simultaneous.find(r=>r.status===503).retry,'1');passed('ocr_real_global_capacity');
 if(benchmark){
  stage='benchmark';const refs=['standard-page','varied-page'].map(id=>inputs.get(id));
  const warm=await upload(refs[0].bytes);validate(warm,refs[0],.95);report.first_full_page_ms=warm.ms;
  for(let i=0;i<6;i++){
   const fixture=refs[i%refs.length],result=await upload(fixture.bytes);
   const sample={fixture:fixture.id,expected_words:fixture.word_count,recognized_words:result.body.data?.words.length,accuracy:accuracy(fixture.text,result.body.data?.text??''),http_ms:result.ms,processing_ms:result.body.metadata?.processing_ms};
   report.samples.push(sample);console.log(JSON.stringify({step:'ocr_benchmark_sample',...sample}));validate(result,fixture,.95);
  }
  const ms=report.samples.map(s=>s.http_ms).sort((x,y)=>x-y);
  report.mean_ms=ms.reduce((x,y)=>x+y,0)/ms.length;report.p95_ms=ms[Math.ceil(ms.length*.95)-1];report.max_ms=ms.at(-1);
  report.target_met=report.mean_ms<report.target_mean_ms;
  if(!report.target_met)process.exitCode=1;
 }
 report.functional_pass=true;
 if(engine==='native')report.native_version=execFileSync('tesseract',['--version'],{encoding:'utf8',windowsHide:true}).split(/\r?\n/)[0];
 else report.wasm_package=JSON.parse(await readFile(new URL('../node_modules/tesseract.js/package.json',import.meta.url),'utf8')).version;
} catch(error){report.functional_pass=false;report.failed_stage=stage;console.log(JSON.stringify({step:stage,status:'failed',kind:error.code??error.name}));process.exitCode=1;}
finally {await app?.close();if(jwks)await new Promise(resolve=>jwks.close(resolve));}
report.resources_closed=true;
await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({functional_pass:report.functional_pass,engine,mean_ms:report.mean_ms,target_met:report.target_met,resources_closed:true,output}));
