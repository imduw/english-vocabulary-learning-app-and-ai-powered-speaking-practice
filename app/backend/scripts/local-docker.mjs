import {spawn} from 'node:child_process';
import {createReadStream,createWriteStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';

// Arguments are passed directly to Docker; never evaluated by a shell. This
// helper is for local drills, not a general remote/production restore tool.
export async function docker(args,{inputFile,outputFile,timeoutMs=120000,env=process.env}={}){
  const child=spawn('docker',args,{windowsHide:true,shell:false,env,stdio:['pipe','pipe','pipe']});
  const chunks=[];let bytes=0,timeout=false;
  child.stderr.on('data',()=>{}); // CLI diagnostics can contain environment details.
  const timer=setTimeout(()=>{timeout=true;child.kill();},timeoutMs);
  const exited=new Promise((resolve,reject)=>{
    child.on('error',()=>reject(Error('Docker CLI unavailable')));
    child.on('close',code=>code===0?resolve():reject(Error(timeout?'Docker command timed out':'Docker command failed')));
  });
  const streams=[];
  if(inputFile)streams.push(pipeline(createReadStream(inputFile),child.stdin));else child.stdin.end();
  if(outputFile)streams.push(pipeline(child.stdout,createWriteStream(outputFile,{flags:'wx',mode:0o600})));
  else child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes<=2*1024*1024)chunks.push(chunk);else child.kill();});
  try{await Promise.all([exited,...streams]);return Buffer.concat(chunks).toString('utf8').trim();}
  catch(error){child.kill();await Promise.allSettled([exited,...streams]);throw error;}
  finally{clearTimeout(timer);}
}

export async function waitFor(check,timeoutMs=60000){
  const end=Date.now()+timeoutMs;
  while(Date.now()<end){try{if(await check())return;}catch{}await new Promise(resolve=>setTimeout(resolve,500));}
  throw Error('Local service readiness deadline exceeded');
}
