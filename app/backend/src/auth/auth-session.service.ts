import {Inject,Injectable} from '@nestjs/common';
import {APP_CONFIG} from '../database/database.service';
import {AppConfig} from '../config';
import {ApiError} from '../common/api-error';
import {authInput,AuthAction} from './auth-input';
import {SupabaseAuthService} from './supabase-auth.service';

const unavailable=()=>new ApiError(503,'SERVICE_UNAVAILABLE','Authentication service unavailable');
const pending=()=>({user:null,session:null,requires_email_confirmation:true});
async function jsonLimited(response:globalThis.Response):Promise<Record<string,any>>{
  const reader=response.body?.getReader();if(!reader)throw unavailable();
  const chunks:Uint8Array[]=[];let size=0;
  try{
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>262144)throw unavailable();chunks.push(value);}
    const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(!data||typeof data!=='object'||Array.isArray(data))throw unavailable();return data;
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
@Injectable()
export class AuthSessionService {
  constructor(@Inject(APP_CONFIG) private readonly config:AppConfig,private readonly verifier:SupabaseAuthService){}
  async exchange(action:AuthAction,body:unknown,query:unknown){
    const input=authInput(action,body,query),auth=this.config.auth;
    if(!auth?.publishableKey)throw unavailable();
    const endpoint=action==='register'?'signup':'token?grant_type='+(action==='login'?'password':'refresh_token');
    let response:globalThis.Response,data:Record<string,any>;
    try{
      response=await fetch(new URL('/auth/v1/'+endpoint,new URL(auth.issuer).origin),{
        method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{apikey:auth.publishableKey,'content-type':'application/json',accept:'application/json'},body:JSON.stringify(input),
      });
      data=await jsonLimited(response);
    }catch{throw unavailable();}
    if(!response.ok){
      const code=data.code??data.error_code;
      if(response.status===429)throw new ApiError(429,'RATE_LIMITED','Authentication rate limit reached');
      if(['captcha_failed','captcha_required'].includes(code))throw new ApiError(403,'AUTH_CHALLENGE_REQUIRED','Authentication challenge required');
      if(action==='register'&&code==='user_already_exists')return this.ok(pending());
      if(action==='register'&&[400,422].includes(response.status))throw new ApiError(422,'VALIDATION_ERROR','Registration request rejected');
      if(action!=='register'&&[400,401,403].includes(response.status))throw new ApiError(401,'UNAUTHORIZED','Authentication failed');
      throw unavailable();
    }
    if(action==='register'&&!data.access_token){if(typeof (data.user?.id??data.id)!=='string')throw unavailable();return this.ok(pending());}
    const session=data,user=data.user;
    if(typeof session.access_token!=='string'||session.access_token.length>16377||typeof session.refresh_token!=='string'||!(/^[\x21-\x7e]{1,8192}$/).test(session.refresh_token)
      ||!Number.isInteger(session.expires_in)||session.expires_in<1||session.expires_in>86400||typeof session.token_type!=='string'||session.token_type.toLowerCase()!=='bearer'
      ||typeof user?.id!=='string'||!(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).test(user.id)
      ||(user.email!==undefined&&(typeof user.email!=='string'||user.email.length>254)))throw unavailable();
    try{if(await this.verifier.verify(session.access_token)!==user.id.toLowerCase())throw unavailable();}catch{throw unavailable();}
    return this.ok({user:{id:user.id.toLowerCase(),...(user.email===undefined?{}:{email:user.email})},
      session:{access_token:session.access_token,refresh_token:session.refresh_token,token_type:'bearer',expires_in:session.expires_in},requires_email_confirmation:false});
  }
  private ok(data:unknown){return {status:'ok',data,error:null,metadata:{}};}
}
