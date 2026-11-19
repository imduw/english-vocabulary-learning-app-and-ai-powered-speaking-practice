import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { Test } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { AppModule } from '../dist/src/app.module.js';
import { APP_CONFIG, DatabaseService } from '../dist/src/database/database.service.js';
import { SupabaseAuthService } from '../dist/src/auth/supabase-auth.service.js';
import { configureHttp } from '../dist/src/common/http.js';
import { OcrEngine } from '../dist/src/ocr/ocr-engine.js';
import { OcrBudget } from '../dist/src/ocr/ocr-budget.js';
import { OcrImageProcessor, MAX_IMAGE_BYTES } from '../dist/src/ocr/ocr-image.js';
import { ocrResult } from '../dist/src/ocr/ocr-result.js';
import { parseTsv } from '../dist/src/ocr/ocr-native.js';

const word=text=>({text,confidence:96,bbox:{x0:10,y0:10,x1:40,y1:30}});
const page={confidence:96,blocks:[{paragraphs:[{lines:[{words:['Learning','English'].map(word)},{words:['is','useful.','Practice','every','day!'].map(word)}]}]}]};

test('OCR budget bounds per-owner attempts, global capacity, cancelled leases and expiry',()=>{
  const budget=new OcrBudget();
  const first=budget.acquire('A',0);first.begin();
  assert.throws(()=>budget.acquire('B',0),error=>error.getStatus()===503);
  first.release();first.release();
  assert.throws(()=>first.begin(),error=>error.getStatus()===400);
  for(let i=1;i<10;i++)budget.acquire('A',i).release();
  assert.throws(()=>budget.acquire('A',11),error=>error.getStatus()===429&&error.details.retry_after_seconds===60);
  const other=budget.acquire('B',12);first.release();
  assert.throws(()=>budget.acquire('C',13),error=>error.getStatus()===503);
  other.release();budget.acquire('A',60000).release();
  const bounded=new OcrBudget();
  for(let i=0;i<10000;i++)bounded.acquire(String(i),0).release();
  assert.throws(()=>bounded.acquire('new',1),error=>error.getStatus()===503);
  bounded.acquire('new',60000).release();
});

test('OCR reconstructs whole sentences across lines, scales boxes, bounds scores and detects language',()=>{
  const result=ocrResult(page,{width:800,height:400,processed_width:400,processed_height:200});
  assert.equal(result.text,'Learning English is useful. Practice every day!');
  assert.equal(result.sentences.length,2);
  assert.equal(result.words[0].context,'Learning English is useful.');
  assert.equal(result.words[4].context,'Practice every day!');
  assert.deepEqual(result.words[0].bbox,{x:20,y:20,width:60,height:40});
  assert.deepEqual(result.sentences[0].word_indices,[0,1,2,3]);
  assert.equal(result.language.code,'en');assert.equal(result.confidence,.96);
  const vi=ocrResult({confidence:80,blocks:[{paragraphs:[{lines:[{words:'Tôi đang học tiếng Việt mỗi ngày để giao tiếp tốt hơn.'.split(' ').map(word)}]}]}]},result.image);
  assert.equal(vi.language.code,'vi');
  assert.equal(ocrResult({confidence:0,blocks:null},result.image).language.code,'und');
  const malformed={confidence:200,blocks:[{paragraphs:[{lines:[{words:[word('ok'),{...word('bad'),bbox:{x0:NaN,y0:0,x1:2,y1:2}}]}]}]}]};
  const bounded=ocrResult(malformed,result.image);assert.equal(bounded.words.length,1);assert.equal(bounded.confidence,1);
});

test('native TSV parsing preserves paragraph/line order and ignores non-word rows',()=>{
  const header='level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
  const parsed=parseTsv(header+'\n4\t1\t1\t1\t1\t0\t0\t0\t100\t20\t-1\t\n5\t1\t1\t1\t1\t1\t10\t20\t30\t15\t95.5\tHello\n5\t1\t1\t1\t2\t1\t12\t40\t45\t15\t90\tworld.\n');
  assert.equal(parsed.blocks[0].paragraphs[0].lines.length,2);
  assert.equal(parsed.confidence,92.75);
  assert.deepEqual(parsed.blocks[0].paragraphs[0].lines[0].words[0].bbox,{x0:10,y0:20,x1:40,y1:35});
  assert.throws(()=>parseTsv('not TSV'));
});

test('OCR image preprocessing validates real codecs, EXIF orientation and pixel limits',async()=>{
  const images=new OcrImageProcessor();
  const raw=sharp({create:{width:400,height:200,channels:3,background:'white'}});
  for(const [format,mime]of [['png','image/png'],['jpeg','image/jpeg'],['webp','image/webp']]) {
    const prepared=await images.prepare({buffer:await raw.clone()[format]().toBuffer(),mimetype:mime});
    assert.equal(prepared.width,400);assert.equal(prepared.height,200);
    assert.equal((await sharp(prepared.buffer).metadata()).format,'png');
  }
  const rotated=await raw.clone().jpeg().withMetadata({orientation:6}).toBuffer();
  const prepared=await images.prepare({buffer:rotated,mimetype:'image/jpeg'});
  assert.equal(prepared.width,200);assert.equal(prepared.height,400);assert.equal(prepared.processed_width,200);
  const oversizedPixels=await sharp({create:{width:4001,height:4001,channels:3,background:'white'}}).png().toBuffer();
  await assert.rejects(images.prepare({buffer:oversizedPixels,mimetype:'image/png'}),error=>error.getStatus()===400);
});

test('OCR HTTP multipart/Auth/limits and leases with real image preprocessing and an isolated fake recognizer',async t=>{
  let recognize=async()=>page, calls=0;
  const module=await Test.createTestingModule({imports:[AppModule]})
    .overrideProvider(APP_CONFIG).useValue({port:0,database:{},ocr:{warmup:false}})
    .overrideProvider(DatabaseService).useValue({ping:async()=>{}})
    .overrideProvider(SupabaseAuthService).useValue({verify:async token=>{if(!/^[0-9a-f-]{36}$/.test(token))throw new UnauthorizedException();return token;}})
    .overrideProvider(OcrEngine).useValue({recognize:async buffer=>{calls++;return recognize(buffer);}}).compile();
  const app=module.createNestApplication({logger:false});configureHttp(app);await app.listen(0,'127.0.0.1');
  const url=(await app.getUrl())+'/api/v1/ocr/process';
  const png=await sharp({create:{width:400,height:200,channels:3,background:'white'}}).png().toBuffer();
  const upload=async({bytes=png,type='image/png',owner=randomUUID(),field='image',extra=false,query='',signal}={})=>{
    const body=new FormData();body.append(field,new Blob([bytes],{type}),'../../upload.png');
    if(extra)body.append('user_id',randomUUID());
    const response=await fetch(url+query,{method:'POST',headers:owner?{authorization:'Bearer '+owner}:{},body,signal});
    return {status:response.status,body:await response.json(),retry:response.headers.get('retry-after')};
  };
  try {
    await t.test('requires JWT before upload parsing and accepts multipart PNG/JPEG/WebP',async()=>{
      assert.equal((await upload({owner:null})).status,401);
      assert.equal((await upload({owner:'invalid'})).status,401);
      for(const [format,type]of [['png','image/png'],['jpeg','image/jpeg'],['webp','image/webp']]) {
        const result=await upload({bytes:await sharp(png)[format]().toBuffer(),type});
        assert.equal(result.status,200,JSON.stringify(result.body));
        assert.equal(result.body.data.words.length,7);assert.equal(result.body.data.image.coordinate_space,'upright_original_pixels');
      }
    });
    await t.test('rejects fake MIME, corrupt/empty files, extra fields, wrong field, missing file and query ownership',async()=>{
      const before=calls;
      for(const options of [
        {bytes:Buffer.from('<svg/>'),type:'image/png'},
        {bytes:Buffer.concat([png.subarray(0,8),Buffer.from('corrupt')])},
        {bytes:Buffer.alloc(0)}, {type:'image/jpeg'}, {type:'application/pdf'},
        {field:'file'}, {extra:true}, {query:'?user_id='+randomUUID()},
      ])assert.equal((await upload(options)).status,400,JSON.stringify(options));
      const missing=await fetch(url,{method:'POST',headers:{authorization:'Bearer '+randomUUID()}});assert.equal(missing.status,400);
      assert.equal(calls,before);
      assert.equal((await upload()).status,200,'bad uploads must not retain capacity');
    });
    await t.test('rejects an upload over 10MiB before OCR and releases its slot',async()=>{
      const before=calls,owner=randomUUID();
      const result=await upload({bytes:Buffer.alloc(MAX_IMAGE_BYTES+1),owner});
      assert.equal(result.status,413);assert.equal(result.body.error.code,'IMAGE_TOO_LARGE');assert.equal(calls,before);
      assert.equal((await upload({owner})).status,200);
    });
    await t.test('enforces a separate rate window per verified owner and gives retry headers',async()=>{
      const owner=randomUUID();
      for(let i=0;i<10;i++)assert.equal((await upload({owner,type:'application/pdf'})).status,400);
      const limited=await upload({owner});assert.equal(limited.status,429);assert.equal(limited.body.error.code,'OCR_RATE_LIMITED');assert.ok(Number(limited.retry)>0);
      assert.equal((await upload({owner:randomUUID()})).status,200);
    });
    await t.test('rejects concurrent uploads early and retains capacity after a client aborts running OCR',async()=>{
      let release,entered;
      const started=new Promise(resolve=>{entered=resolve;});
      recognize=()=>new Promise(resolve=>{release=resolve;entered();});
      const controller=new AbortController();
      const pending=upload({signal:controller.signal});
      const rejected=assert.rejects(pending,error=>error.name==='AbortError');
      await started;controller.abort();await rejected;
      const busy=await upload();assert.equal(busy.status,503);assert.equal(busy.retry,'1');
      release(page);recognize=async()=>page;
      let next;
      for(let i=0;i<20;i++){next=await upload();if(next.status===200)break;await new Promise(resolve=>setTimeout(resolve,10));}
      assert.equal(next.status,200);
    });
    await t.test('sanitizes recognizer failure and recovers the upload slot',async()=>{
      recognize=async()=>{throw new Error('private engine data must not escape');};
      const failed=await upload();assert.equal(failed.status,500);assert.doesNotMatch(JSON.stringify(failed.body),/private engine/);
      recognize=async()=>page;assert.equal((await upload()).status,200);
    });
  } finally {await app.close();}
});
