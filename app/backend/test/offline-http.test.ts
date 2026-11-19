import 'reflect-metadata';
import {Body,Controller,Post} from '@nestjs/common';
import {Test} from '@nestjs/testing';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {configureHttp} from '../src/common/http';
import {readConfig} from '../src/config';

@Controller('fixture')
class FixtureController {
  @Post() post(@Body()body:{text:string}){return {length:body.text.length};}
}
test('offline JSON batches accept >100KiB, reject >1MiB and expose only configured CORS origins',async()=>{
  const module=await Test.createTestingModule({controllers:[FixtureController]}).compile();
  const app=module.createNestApplication({logger:false});configureHttp(app,{corsOrigins:['http://localhost:8080']});await app.listen(0,'127.0.0.1');
  const origin=await app.getUrl();
  try{
    const send=(text:string)=>fetch(origin+'/fixture',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text})});
    const valid=await send('x'.repeat(200000));assert.equal(valid.status,201);assert.equal((await valid.json()).length,200000);
    const large=await send('private-content'.repeat(100000));assert.equal(large.status,413);assert.ok(!JSON.stringify(await large.json()).includes('private-content'));
    for(const [site,allowed]of [['http://localhost:8080',true],['https://attacker.example',false]] as const){
      const response=await fetch(origin+'/fixture',{method:'OPTIONS',headers:{origin:site,'access-control-request-method':'POST','access-control-request-headers':'authorization,content-type'}});
      assert.equal(response.status,204);assert.equal(response.headers.get('access-control-allow-origin'),allowed?site:null);
    }
  }finally{await app.close();}
});
test('Web origins require exact HTTPS origins or explicit local development origins',()=>{
  const base={DATABASE_URL:'postgresql://demo:local@127.0.0.1/vocabulary',DATABASE_SSL:'false',NODE_ENV:'development'};
  assert.deepEqual(readConfig({...base,CORS_ORIGINS:'http://localhost:8080,https://app.example.com'}).corsOrigins,['http://localhost:8080','https://app.example.com']);
  for(const value of ['*','http://remote.example','https://user:pass@app.example.com','https://app.example.com/path'])assert.throws(()=>readConfig({...base,CORS_ORIGINS:value}),/CORS_ORIGINS/);
});
