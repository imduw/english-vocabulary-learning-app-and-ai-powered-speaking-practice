import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

// Own only this child. Never read .env here or log child environment/output.
export async function startTemporaryBackend(configuration){
 const listener=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');
 const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
 const env={...process.env};
 for(const key of Object.keys(env))if(/^(MIGRATION_|TEST_|REGISTRATION_|SUPABASE_)/.test(key))delete env[key];
 const child=spawn(process.execPath,['dist/src/main.js'],{cwd:new URL('../',import.meta.url),windowsHide:true,
  env:{...env,...configuration,NODE_ENV:'development',OCR_WARMUP:'false',PORT:String(port)},stdio:'ignore'});
 let spawnFailed=false;child.on('error',()=>{spawnFailed=true;});
 const exited=new Promise(resolve=>child.once('close',resolve));
 const close=async()=>{if(child.exitCode===null&&!spawnFailed)child.kill();await exited;};
 const origin=`http://127.0.0.1:${port}`;
 try{
  for(let attempt=0;attempt<100;attempt++){
   if(spawnFailed||child.exitCode!==null)throw Error('Temporary backend unavailable');
   try{if((await fetch(origin+'/health',{signal:AbortSignal.timeout(1500)})).status===200)return {origin,close};}catch{}
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw Error('Temporary backend readiness deadline');
 }catch(error){await close();throw error;}
}
