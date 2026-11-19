// Build the published worker directly with the project's locked package config.
// Avoids webdev's Windows SDK-path issue; never patches the Pub cache or SDK.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

const frontend=resolve('../frontend/flutter_app'),test=process.argv.includes('--test');
const output=join(frontend,test?'.dart_tool/offline_web_check':'web');
const configPath=join(frontend,'.dart_tool/package_config.json');
const config=JSON.parse(await readFile(configPath,'utf8'));
const root=name=>fileURLToPath(new URL(config.packages.find(p=>p.name===name).rootUri,pathToFileURL(configPath)));
const executable=process.env.DART_EXECUTABLE??(process.platform==='win32'?join(dirname(execFileSync('where.exe',['flutter'],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/)[0]),'cache','dart-sdk','bin','dart.exe'):'dart');
async function compile(source,target){
 const child=spawn(executable,['compile','js','-O2','--packages='+configPath,source,'-o',target],{cwd:frontend,windowsHide:true,stdio:['ignore','pipe','pipe']});
 let diagnostics='';child.stdout.on('data',bytes=>{diagnostics+=bytes;});child.stderr.on('data',bytes=>{diagnostics+=bytes;});
 const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
 if(code!==0){console.error(diagnostics);throw Error('Web compilation failed');}
}
await mkdir(output,{recursive:true});
await compile(join(root('sqflite_common_ffi_web'),'web/sqflite_sw.dart'),join(output,'sqflite_sw.js'));
const pinned=await readFile(join(root('sqflite_common_ffi_web'),'lib/src/setup/sqlite3_wasm_version.dart'),'utf8');
const release=pinned.match(/sqlite3WasmRelease\s*=\s*['"]([^'"]+)['"]/m)?.[1];
if(!release||!/^sqlite3-[\d.]+\/sqlite3\.wasm$/.test(release))throw Error('Unexpected published SQLite release reference');
const source='https://github.com/simolus3/sqlite3.dart/releases/download/'+release;
const response=await fetch(source,{signal:AbortSignal.timeout(60000)});if(!response.ok)throw Error('SQLite WASM download failed');
const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length<10000||bytes.length>16*1024*1024||bytes.subarray(0,4).toString('hex')!=='0061736d')throw Error('Invalid SQLite WASM asset');
await writeFile(join(output,'sqlite3.wasm'),bytes);
await writeFile(join(output,'sqlite3.LICENSE'),await readFile(join(root('sqlite3'),'LICENSE')));
await writeFile(join(output,'sqflite.LICENSE'),await readFile(join(root('sqflite_common_ffi_web'),'LICENSE')));
const manifest={source,sqlite3_wasm_sha256:createHash('sha256').update(bytes).digest('hex'),worker_sha256:createHash('sha256').update(await readFile(join(output,'sqflite_sw.js'))).digest('hex'),package_config:'pubspec.lock resolved versions'};
await writeFile(join(output,'sqlite-assets.json'),JSON.stringify(manifest,null,2)+'\n');
if(test)await compile(join(frontend,'tool/offline_web_check.dart'),join(output,'main.dart.js'));
console.log(JSON.stringify({step:'offline_web_assets',status:'built',test,...manifest}));
