import 'reflect-metadata';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {Test} from '@nestjs/testing';
import {AuthController} from '../dist/src/auth/auth.controller.js';
import {AuthSessionService} from '../dist/src/auth/auth-session.service.js';
import {AuthRateGuard} from '../dist/src/auth/auth-rate.guard.js';
import {SupabaseAuthService} from '../dist/src/auth/supabase-auth.service.js';
import {APP_CONFIG} from '../dist/src/database/database.service.js';
import {configureHttp} from '../dist/src/common/http.js';

const user='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002';
test('Auth routes delegate to a fixed upstream and real JWKS verification without storing credentials',async t=>{
  const pair=await generateKeyPair('ES256'),jwk={...await exportJWK(pair.publicKey),kid:'auth-fixture',alg:'ES256',use:'sig'};
  let reply,observed=[];
  const upstream=createServer(async(req,res)=>{
    if(req.url.endsWith('/.well-known/jwks.json')){res.setHeader('content-type','application/json');res.end(JSON.stringify({keys:[jwk]}));return;}
    let raw='';for await(const chunk of req)raw+=chunk;
    observed.push({url:req.url,body:JSON.parse(raw),key:req.headers.apikey});
    if(reply.hang)return;
    res.statusCode=reply.status??200;
    if(reply.redirect)res.setHeader('location',reply.redirect);
    res.end(reply.raw??JSON.stringify(reply.body));
  });
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const issuer='http://127.0.0.1:'+upstream.address().port+'/auth/v1';
  const access=await new SignJWT({role:'authenticated'}).setSubject(user).setIssuer(issuer).setAudience('authenticated').setIssuedAt().setExpirationTime('5m').setProtectedHeader({alg:'ES256',kid:jwk.kid}).sign(pair.privateKey);
  const valid={access_token:access,refresh_token:'fixture-refresh',token_type:'bearer',expires_in:300,user:{id:user,email:'cam@example.com',encrypted_password:'must-not-leak',app_metadata:{role:'private'},identities:[{secret:'hidden'}]}};
  const config={port:3000,database:{},auth:{issuer,jwksUrl:issuer+'/.well-known/jwks.json',publishableKey:'sb_publishable_fixture'}};
  const module=await Test.createTestingModule({controllers:[AuthController],providers:[AuthSessionService,AuthRateGuard,SupabaseAuthService,{provide:APP_CONFIG,useValue:config}]}).compile();
  const app=module.createNestApplication({logger:false});configureHttp(app);await app.listen(0,'127.0.0.1');const origin=await app.getUrl();
  const guard=app.get(AuthRateGuard),service=app.get(AuthSessionService);
  const credentials={email:'cam@example.com',password:'  fixture-password  '};
  const call=async(action,body,query='')=>{
    const r=await fetch(origin+'/api/v1/auth/'+action+query,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    return {status:r.status,body:await r.json(),headers:r.headers};
  };
  t.beforeEach(()=>{guard.windows.clear();observed=[];reply={body:valid};});
  try{
    await t.test('login/register/refresh work without Bearer, preserve password and expose only public user/session fields',async()=>{
      for(const action of ['login','register','refresh']){
        const body=action==='refresh'?{refresh_token:'fixture-old'}:{...credentials,captcha_token:'captcha-fixture'};
        const r=await call(action,body);assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('pragma'),'no-cache');
        assert.deepEqual(r.body.data.user,{id:user,email:'cam@example.com'});assert.equal(r.body.data.session.access_token,access);assert.equal(r.body.data.requires_email_confirmation,false);
        assert.equal(observed.at(-1).key,config.auth.publishableKey);
        assert.equal(observed.at(-1).url,action==='register'?'/auth/v1/signup':'/auth/v1/token?grant_type='+(action==='login'?'password':'refresh_token'));
        if(action!=='refresh'){assert.equal(observed.at(-1).body.password,credentials.password);assert.deepEqual(observed.at(-1).body.gotrue_meta_security,{captcha_token:'captcha-fixture'});}
      }
    });
    await t.test('confirmation-needed and duplicate registration responses hide identity and metadata',async()=>{
      for(const response of [{body:{id:user,email:'cam@example.com',identities:[]}},{body:{user:{id:user}}},{status:400,body:{code:'user_already_exists',msg:'private'}}]){
        reply=response;const r=await call('register',credentials);assert.equal(r.status,200);assert.deepEqual(r.body.data,{user:null,session:null,requires_email_confirmation:true});
      }
    });
    await t.test('rejects owner/provider/redirect injection, malformed credentials and oversized UTF-8 secrets before upstream',async()=>{
      for(const action of ['login','register','refresh'])for(const body of [null,[],{},...(action==='refresh'?[{refresh_token:''},{refresh_token:'a b'},{refresh_token:'x'.repeat(8193)},{refresh_token:1}]:[
        {email:1,password:'test-password'},{...credentials,email:'bad'},{...credentials,password:''},{...credentials,password:'é'.repeat(37)},
        {...credentials,role:'admin'},{...credentials,redirect_to:'https://attacker.example'},{...credentials,captcha_token:''},{...credentials,captcha_token:'a\n'},
      ])]){guard.windows.clear();assert.equal((await call(action,body)).status,body===null?400:422);}
      assert.equal((await call('register',{...credentials,password:'short'})).status,422);
      assert.equal((await call('login',credentials,'?user_id='+other)).status,422);
      assert.equal(observed.length,0);
    });
    await t.test('normalizes credential/refresh failures, CAPTCHA, rate limits and service errors without upstream messages',async()=>{
      for(const [action,response,status]of [
        ['login',{status:400,body:{code:'invalid_credentials',msg:'must-not-leak'}},401],
        ['refresh',{status:403,body:{code:'refresh_token_not_found',msg:'must-not-leak'}},401],
        ['register',{status:422,body:{code:'weak_password',msg:'must-not-leak'}},422],
        ['login',{status:403,body:{code:'captcha_failed',msg:'must-not-leak'}},403],
        ['login',{status:429,body:{msg:'must-not-leak'}},429],
        ['login',{status:502,body:{msg:'must-not-leak'}},503],
        ['register',{status:403,body:{code:'configuration_fault'}},503],
      ]){
        reply=response;const r=await call(action,action==='refresh'?{refresh_token:'old'}:credentials);assert.equal(r.status,status);assert.ok(!JSON.stringify(r.body).includes('must-not-leak'));
        if([429,503].includes(status))assert.equal(r.headers.get('retry-after'),'60');
      }
    });
    await t.test('rejects corrupt/unbounded responses, untrusted redirects and inconsistent or invalid sessions',async()=>{
      for(const response of [{raw:'not json'},{body:[]},{body:null},{body:{}},{raw:' '.repeat(262145)},{status:302,redirect:'http://127.0.0.1:1/never',body:{}}]){
        reply=response;assert.equal((await call('register',credentials)).status,503);
      }
      for(const patch of [{token_type:1},{token_type:'other'},{expires_in:0},{expires_in:86401},{refresh_token:''},{access_token:'not.a.valid.jwt'},{user:{id:other}},{user:{id:'invalid'}},{user:{id:user,email:42}}]){
        reply={body:{...valid,...patch}};assert.equal((await call('login',credentials)).status,503);
      }
      reply={body:{...valid,user:{id:user}}};assert.equal((await call('login',credentials)).status,200);
    });
    await t.test('times out upstream and returns 503 when proxy configuration is absent',async t=>{
      const timeout=AbortSignal.timeout.bind(AbortSignal);t.mock.method(AbortSignal,'timeout',()=>timeout(20));
      reply={hang:true};assert.equal((await call('login',credentials)).status,503);
      const noKey=new AuthSessionService({database:{},port:3000},app.get(SupabaseAuthService));
      await assert.rejects(noKey.exchange('login',credentials,{}),e=>e.getStatus()===503);
    });
    await t.test('limits thirty requests per socket IP, ignores forged forwarded IPs and permits requests after window expiry',async()=>{
      reply={body:{id:user}};
      for(let i=0;i<30;i++)assert.equal((await call('register',credentials)).status,200);
      const r=await fetch(origin+'/api/v1/auth/register',{method:'POST',headers:{'content-type':'application/json','x-forwarded-for':'198.51.100.123'},body:JSON.stringify(credentials)});
      assert.equal(r.status,429);assert.ok(Number(r.headers.get('retry-after'))>=1);
      const now=performance.now();for(const value of guard.windows.values())value.start=now-60001;
      assert.equal((await call('register',credentials)).status,200);
    });
    await t.test('bounded IP inventory returns 503 and treats missing socket identity consistently',()=>{
      const g=new AuthRateGuard(),headers={};
      const context=ip=>({switchToHttp:()=>({getRequest:()=>({socket:{remoteAddress:ip}}),getResponse:()=>({setHeader:(k,v)=>headers[k]=v})})});
      assert.equal(g.canActivate(context(undefined)),true);
      for(let i=0;i<9999;i++)g.windows.set('fixture-'+i,{start:performance.now(),count:1});
      assert.throws(()=>g.canActivate(context('new-ip')),e=>e.getStatus()===503);assert.equal(headers['Retry-After'],'60');
    });
  }finally{await app.close();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));}
});
