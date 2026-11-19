import assert from 'node:assert/strict';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {relative,resolve,join} from 'node:path';
import {createHash} from 'node:crypto';

const summary=JSON.parse(await readFile('coverage/coverage-summary.json','utf8'));
const normalized=new Map(Object.entries(summary).filter(([key])=>key!=='total').map(([key,value])=>[relative(process.cwd(),key).replaceAll('\\','/'),value]));
async function walk(directory){const entries=await readdir(directory,{withFileTypes:true});return (await Promise.all(entries.map(e=>e.isDirectory()?walk(join(directory,e.name)):[join(directory,e.name).replaceAll('\\','/')]))).flat();}
const sources=(await walk('src')).filter(p=>p.endsWith('.ts'));
// Engine adapters and scheduling/preprocessing helpers are explicitly included
// alongside class names, so moving business logic out of *.service cannot hide it.
const layer=p=>p.endsWith('.repository.ts')?'Repository':p.endsWith('.service.ts')||/src\/ocr\/ocr-(engine|native|image|result|budget)\.ts$/.test(p)||p==='src/progress/sm2.ts'?'Service':null;
const files=[];let passed=true;
for(const path of sources){
  const group=layer(path);if(!group)continue;
  const metrics=normalized.get(path);assert.ok(metrics,'Missing TypeScript coverage: '+path);
  const sha256=createHash('sha256').update(await readFile(path)).digest('hex');
  const filePass=['lines','statements','functions','branches'].every(metric=>metrics[metric].pct>85);
  passed&&=filePass;
  files.push({path,layer:group,sha256,metrics,passed:filePass});
}
assert.ok(files.length>=9,'Service/Repository inventory unexpectedly empty');
const layers={};
for(const name of ['Service','Repository']){
  const group=files.filter(f=>f.layer===name);layers[name]={};
  for(const metric of ['lines','statements','functions','branches']){
    const total=group.reduce((n,f)=>n+f.metrics[metric].total,0),covered=group.reduce((n,f)=>n+f.metrics[metric].covered,0);
    layers[name][metric]={total,covered,pct:total?Number((100*covered/total).toFixed(2)):100};
  }
}
const report={generated_at:new Date().toISOString(),node:process.version,tool:'c8 9.1.0 / V8, TypeScript source maps',
  rule:'Every Service/Repository file: lines, statements, functions and branches strictly >85%',
  scope:'All src files reported; gate includes service/repository classes, OCR adapters/helpers and SM-2. Native transport fault tests use subprocess doubles; real OCR accuracy has separate evidence.',
  overall:summary.total,layers,files,passed};
await writeFile(resolve('../../docs/cam/benchmarks/backend-coverage.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({coverage_gate:passed?'passed':'failed',layers,files:files.length}));
if(!passed){console.error('Coverage below required threshold: '+files.filter(f=>!f.passed).map(f=>f.path).join(', '));process.exitCode=1;}
