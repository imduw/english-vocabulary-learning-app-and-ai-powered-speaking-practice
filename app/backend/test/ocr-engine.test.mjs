import 'reflect-metadata';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {readFile} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {NativeOcr} from '../dist/src/ocr/ocr-native.js';
import {OcrEngine} from '../dist/src/ocr/ocr-engine.js';
import {ApiError} from '../dist/src/common/api-error.js';

const tsv='level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t10\t20\t40\t30\t95\tLearning\n';
const raw=Buffer.from('public test model'),model={code:'eng',bytes:gzipSync(raw),sourceHash:createHash('sha256').update(raw).digest('hex')};
function nativeTransport(t,plans) {
  const calls=[];
  t.mock.method(childProcess,'spawn',(command,args,options)=>{
    assert.equal(command,'tesseract');assert.equal(options.shell,false);
    assert.equal(options.env.OMP_THREAD_LIMIT,'1');
    assert.equal(options.env.DATABASE_URL,undefined);assert.equal(options.env.MIGRATION_DATABASE_URL,undefined);
    const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
    let closed=false;
    const close=code=>{if(!closed){closed=true;child.emit('close',code);}};
    child.kill=()=>{queueMicrotask(()=>close(null));return true;};
    const plan=plans.shift()??{};calls.push({args,input:[]});const call=calls.at(-1);
    child.stdin.on('data',bytes=>call.input.push(bytes));
    child.stdin.on('finish',()=>queueMicrotask(()=>{
      if(plan.hang)return;
      if(plan.error)child.emit('error',Error('internal path'));
      child.stdout.write(plan.output??(args[0]==='--version'?'tesseract test':tsv));
      child.stderr.write('internal diagnostics must not be returned');
      close(plan.code??(plan.error?1:0));
    }));
    return child;
  });
  return calls;
}
test('native adapter verifies models, streams image bytes and parses TSV without shell or credential forwarding',async t=>{
  const calls=nativeTransport(t,[{},{}]),engine=new NativeOcr();t.after(()=>engine.close());
  await engine.initialize([model]);await engine.initialize([model]);
  const image=Buffer.from('already decoded PNG'),page=await engine.recognize(image);
  assert.equal(page.blocks[0].paragraphs[0].lines[0].words[0].text,'Learning');
  assert.equal(calls.length,2);assert.equal(calls[1].args[0],'stdin');assert.deepEqual(Buffer.concat(calls[1].input),image);
  await engine.close();await assert.rejects(engine.recognize(image));await assert.rejects(engine.initialize([model]));
});
test('native adapter cleans failed initialization and handles unavailable CLI, oversized output and failed processes',async t=>{
  const corrupt=new NativeOcr();await assert.rejects(corrupt.initialize([{...model,sourceHash:'wrong'}]),/integrity/);await corrupt.close();
  nativeTransport(t,[{error:true},{},{output:'x'.repeat(4*1024*1024+1)},{code:1}]);
  const engine=new NativeOcr();t.after(()=>engine.close());
  await assert.rejects(engine.initialize([model]),/unavailable/);
  await engine.initialize([model]);
  await assert.rejects(engine.recognize(Buffer.alloc(1)),e=>e.getStatus()===422);
  await assert.rejects(engine.recognize(Buffer.alloc(1)),/failed/);
});
test('native adapter kills timed-out and shutdown-owned processes before cleanup',async t=>{
  nativeTransport(t,[{},{hang:true},{hang:true}]);
  const engine=new NativeOcr();t.after(()=>engine.close());await engine.initialize([model]);
  t.mock.timers.enable({apis:['setTimeout']});
  const timed=assert.rejects(engine.recognize(Buffer.alloc(1)),/timed out/);
  t.mock.timers.tick(15000);await timed;
  const closed=assert.rejects(engine.recognize(Buffer.alloc(1)));await engine.close();await closed;
});
test('OCR facade warms native models and sanitizes engine errors while preserving bounded-output errors',async t=>{
  nativeTransport(t,[{},{},{code:1}]);
  const engine=new OcrEngine({ocr:{engine:'native',warmup:true}});t.after(()=>engine.onModuleDestroy());
  await Promise.all([engine.onModuleInit(),engine.onModuleInit()]);
  assert.equal((await engine.recognize(Buffer.alloc(1))).confidence,95);
  await assert.rejects(engine.recognize(Buffer.alloc(1)),e=>e.getStatus()===503&&!e.message.includes('internal'));
  t.mock.method(engine.native,'recognize',async()=>{throw new ApiError(422,'IMAGE_TOO_COMPLEX','bounded');});
  await assert.rejects(engine.recognize(Buffer.alloc(1)),e=>e.getStatus()===422);
});
test('WASM facade recognizes bundled public image, resets a failed worker and shuts down cleanly',async t=>{
  const engine=new OcrEngine({ocr:{engine:'wasm',warmup:true}});t.after(()=>engine.onModuleDestroy());
  await Promise.all([engine.onModuleInit(),engine.onModuleInit()]);
  const image=await readFile(new URL('../fixtures/ocr/english-small.png',import.meta.url));
  assert.match((await engine.recognize(image)).text,/Learning English/);
  t.mock.method(engine.worker,'recognize',async()=>{throw Error('sensitive OCR details');});
  await assert.rejects(engine.recognize(image),e=>e.getStatus()===503&&!e.message.includes('sensitive'));
  assert.match((await engine.recognize(image)).text,/Learning English/);
  await engine.onModuleDestroy();await assert.rejects(engine.recognize(image),e=>e.getStatus()===503);
});
