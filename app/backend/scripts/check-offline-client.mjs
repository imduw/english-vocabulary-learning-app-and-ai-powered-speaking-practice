import {spawn,execFileSync} from 'node:child_process';
import {dirname,join} from 'node:path';
import {writeFile} from 'node:fs/promises';
export async function checkOfflineClient({origin,ownerA,ownerB,tokenA,tokenB}){
 const executable=process.env.DART_EXECUTABLE??(process.platform==='win32'?join(dirname(execFileSync('where.exe',['flutter'],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/)[0]),'cache','dart-sdk','bin','dart.exe'):'dart');
 const child=spawn(executable,['run','tool/offline_http_check.dart'],{cwd:new URL('../../frontend/flutter_app/',import.meta.url),windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
 let output='',errors='';child.stdout.on('data',bytes=>{output+=bytes;if(output.length>1000000)child.kill();});child.stderr.on('data',bytes=>{errors+=bytes;if(errors.length>1000000)child.kill();});
 child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({origin,ownerA,ownerB,tokenA,tokenB}));
 const timer=setTimeout(()=>child.kill(),180000);
 try{
   const code=await new Promise((resolve,reject)=>{child.on('error',()=>reject(Error('Dart executable unavailable; set DART_EXECUTABLE')));child.on('close',resolve);});
   if(code!==0){const failure=(output+'\n'+errors).split(/\r?\n/).filter(line=>line.startsWith('{')).map(line=>{try{return JSON.parse(line);}catch{return {};}}).find(r=>r.step==='offline_http');console.error(JSON.stringify({step:'dart_offline',status:'failed',type:failure?.type,check:failure?.failed_check}));throw Error('Dart offline integration failed; run the Flutter unit tests and check SDK/native assets');}
   const result=output.split(/\r?\n/).filter(line=>line.startsWith('{')).map(line=>JSON.parse(line)).find(r=>Object.hasOwn(r,'offline_client_pass'));
   if(!result?.offline_client_pass||!result.resources_closed)throw Error('Offline client result missing');
   await writeFile(new URL('../../../docs/cam/benchmarks/offline-client-http.json',import.meta.url),JSON.stringify({generated_at:new Date().toISOString(),environment:'Dart SQLite file stores + Nest HTTP + local PostgreSQL + ES256/JWKS fixture',...result},null,2)+'\n');
   console.log(JSON.stringify({step:'dart_offline_client_HTTP_SQLite_PostgreSQL',status:'passed',checks:result.checks.length}));
 }finally{clearTimeout(timer);}
}
