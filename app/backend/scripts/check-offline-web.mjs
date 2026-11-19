import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdtemp,rm,realpath,lstat,access} from 'node:fs/promises';
import {join,resolve,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import assert from 'node:assert/strict';

const root=resolve('../frontend/flutter_app/.dart_tool/offline_web_check'),profile=await mkdtemp(join(tmpdir(),'cam-offline-web-'));
let child,childExit,socket,server,result,peer={passed:false},readyResolve,resultResolve;
const ready=new Promise(resolve=>{readyResolve=resolve;}),completed=new Promise(resolve=>{resultResolve=resolve;});
const pending=new Map();let nextId=1;
async function send(method,params={}){const id=nextId++;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});}
try{
 await writeFile(join(root,'index.html'),'<!doctype html><meta charset="utf-8"><script defer src="main.dart.js"></script>');
 const candidates=process.env.CHROME_EXECUTABLE?[process.env.CHROME_EXECUTABLE]:process.platform==='win32'?['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']:['/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser'];
 let executable;for(const candidate of candidates){try{await access(candidate);executable=candidate;break;}catch{}}
 assert.ok(executable,'Headless Chrome/Edge unavailable; set CHROME_EXECUTABLE');
 server=createServer(async(req,res)=>{
  try{
   const path=new URL(req.url,'http://localhost').pathname;
   if(req.method==='POST'){
    let body='';for await(const bytes of req){body+=bytes;if(body.length>65536)throw Error('Oversized result');}const data=JSON.parse(body);
    if(path==='/result')resultResolve(data);if(path==='/peer-result')peer=data;
    if(path==='/ready-peer'){await ready;await send('Target.createTarget',{url:`http://127.0.0.1:${server.address().port}/?peer=1`});}res.end('{}');return;
   }
   if(path==='/peer-result'){res.setHeader('content-type','application/json');res.end(JSON.stringify(peer));return;}
   const name=path==='/'?'index.html':path.slice(1);
   if(!['index.html','main.dart.js','main.dart.js.map','sqlite3.wasm','sqflite_sw.js'].includes(name)){res.statusCode=404;res.end();return;}
   res.setHeader('content-type',name.endsWith('.wasm')?'application/wasm':name.endsWith('.js')?'application/javascript':name.endsWith('.map')?'application/json':'text/html');res.end(await readFile(join(root,name)));
  }catch{res.statusCode=500;res.end('Test asset unavailable');}
 });server.listen(0,'127.0.0.1');await once(server,'listening');
 child=spawn(executable,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-extensions','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--user-data-dir='+profile,`http://127.0.0.1:${server.address().port}/`],{windowsHide:true,stdio:'ignore'});
 childExit=once(child,'exit');let debugging;
 for(let i=0;i<100;i++){try{debugging=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).trim().split('\n');break;}catch{await new Promise(r=>setTimeout(r,100));}}assert.ok(debugging,'Chrome debugging endpoint unavailable');
 socket=new WebSocket(`ws://127.0.0.1:${debugging[0]}${debugging[1]}`);await once(socket,'open');
 socket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.id){const task=pending.get(message.id);pending.delete(message.id);if(message.error)task?.reject(Error('Browser protocol error'));else task?.resolve(message.result);}});readyResolve();
 let timer;try{result=await Promise.race([completed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Web offline test deadline')),60000);})]);}finally{clearTimeout(timer);}
 assert.equal(result.passed,true,'Web offline stage failed: '+result.stage+' '+(result.diagnostic??''));const browser=await send('Browser.getVersion');
 result={generated_at:new Date().toISOString(),environment:browser.product,scope:'Real headless browser, SQLite WASM/IndexedDB SharedWorker with two tabs and a private disposable profile',...result};console.log(JSON.stringify({step:'offline_web_SQLite_two_tabs',status:'passed',checks:result.checks.length}));
}catch(error){console.error(error.code==='ERR_ASSERTION'?error.message:'Web offline check failed; verify generated assets and headless browser');process.exitCode=1;}
finally{
 if(socket?.readyState===WebSocket.OPEN){send('Browser.close').catch(()=>{});socket.close();}
 if(child){await Promise.race([childExit,new Promise(resolve=>setTimeout(resolve,5000))]);if(child.exitCode===null){child.kill();await childExit;}}
 if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 assert.equal(dirname(await realpath(profile)),await realpath(tmpdir()));assert.ok(basename(profile).startsWith('cam-offline-web-'));assert.equal((await lstat(profile)).isSymbolicLink(),false);
 await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:200});
 if(result?.passed){result.resources_closed=true;await writeFile(new URL('../../../docs/cam/benchmarks/offline-web.json',import.meta.url),JSON.stringify(result,null,2)+'\n');}
}
