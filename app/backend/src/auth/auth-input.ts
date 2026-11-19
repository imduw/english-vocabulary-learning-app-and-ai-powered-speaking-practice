import {ApiError} from '../common/api-error';
const invalid=()=>new ApiError(422,'VALIDATION_ERROR','Invalid authentication request');
export type AuthAction='register'|'login'|'refresh';
export function authInput(action:AuthAction,body:unknown,query:unknown){
  if(!query||typeof query!=='object'||Object.keys(query).length||!body||typeof body!=='object'||Array.isArray(body))throw invalid();
  const input=body as Record<string,unknown>,refresh=action==='refresh';
  const allowed=refresh?['refresh_token']:['email','password','captcha_token'];
  if(Object.keys(input).some(key=>!allowed.includes(key)))throw invalid();
  if(refresh){
    if(typeof input.refresh_token!=='string'||input.refresh_token.length>8192||!(/^[\x21-\x7e]+$/).test(input.refresh_token))throw invalid();
    return {refresh_token:input.refresh_token};
  }
  if(typeof input.email!=='string'||input.email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim()))throw invalid();
  if(typeof input.password!=='string'||input.password.length<(action==='register'?8:1)||Buffer.byteLength(input.password,'utf8')>72)throw invalid();
  const result:Record<string,unknown>={email:input.email.trim(),password:input.password};
  if(Object.hasOwn(input,'captcha_token')){
    if(typeof input.captcha_token!=='string'||!input.captcha_token.length||input.captcha_token.length>4096||/\p{Cc}/u.test(input.captcha_token))throw invalid();
    result.gotrue_meta_security={captcha_token:input.captcha_token};
  }
  return result;
}
