import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,mkdir,writeFile,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import pg from 'pg';
import {docker,waitFor} from './local-docker.mjs';
import {checkConsistency} from './check-consistency.mjs';
import {loadMigrations,runMigrations} from './migration-runner.mjs';

// Fixed local source only; does not load .env, take a URL or restore in place.
const connectionString='postgresql://cam_migrator:local_migration_only@127.0.0.1:54329/vocabulary';
const source=new pg.Client({connectionString,connectionTimeoutMillis:5000});
const nonce=randomUUID(),name='cam-restore-'+nonce;
const directory=resolve('backups'),archive=resolve(directory,nonce+'.dump');
const started=performance.now();let target,runtime,containerId,snapshotOpen=false,stage='source_guard',passed=false,report;
const emit=step=>console.log(JSON.stringify({step,status:'passed'}));
const quote=value=>'"'+value.replaceAll('"','""')+'"';
async function fingerprints(client){
  const tables=(await client.query(`SELECT table_schema,table_name FROM information_schema.tables
    WHERE table_schema IN ('auth','app','app_migrations') AND table_type='BASE TABLE' ORDER BY 1,2`)).rows;
  const result=[];
  for(const table of tables){
    const data=(await client.query(`SELECT count(*)::text AS rows,
      md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text)),'')) AS digest
      FROM ${quote(table.table_schema)}.${quote(table.table_name)} t`)).rows[0];
    result.push({schema:table.table_schema,table:table.table_name,...data});
  }
  return result;
}
try{
  await source.connect();
  assert.deepEqual((await source.query("SELECT column_name FROM information_schema.columns WHERE table_schema='auth' AND table_name='users' ORDER BY ordinal_position")).rows.map(r=>r.column_name),['id'],'Only local auth fixture may be backed up');
  const migrations=await loadMigrations(new URL('../database/migrations/',import.meta.url));
  const ledger=(await source.query('SELECT name,checksum FROM app_migrations.history ORDER BY name')).rows;
  assert.deepEqual(ledger,migrations.map(({name,checksum})=>({name,checksum})));
  await mkdir(directory,{recursive:true});
  await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');snapshotOpen=true;
  const snapshot=(await source.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
  const expected=await fingerprints(source);
  const owners=(await source.query('SELECT user_id FROM app.profiles WHERE deleted_at IS NULL ORDER BY user_id LIMIT 2')).rows.map(r=>r.user_id);
  stage='pg_dump';const dumpStart=performance.now();
  await docker(['compose','exec','-T','db','pg_dump','--username=cam_migrator','--dbname=vocabulary','--format=custom','--no-owner',
    '--schema=auth','--schema=app','--schema=app_migrations','--snapshot='+snapshot],{outputFile:archive});
  await source.query('COMMIT');snapshotOpen=false;
  const backupMs=performance.now()-dumpStart;
  const sha256=createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(resolve(directory,nonce+'.json'),JSON.stringify({created_at:new Date().toISOString(),scope:'local Compose only; auth fixture + app + migration ledger',sha256,tables:expected,migrations:ledger},null,2)+'\n',{flag:'wx',mode:0o600});
  emit('backup_exported_snapshot_archive_and_manifest');

  stage='isolated_restore_container';const restoreStart=performance.now();
  containerId=await docker(['run','--detach','--name',name,'--label','cam.backup.drill='+nonce,
    '--env','POSTGRES_USER=cam_migrator','--env','POSTGRES_PASSWORD=local_migration_only','--env','POSTGRES_DB=vocabulary',
    '--publish','127.0.0.1::5432','postgres:17-bookworm']);
  assert.match(containerId,/^[a-f0-9]{64}$/);
  await waitFor(async()=>{await docker(['exec',containerId,'pg_isready','-h','127.0.0.1','-U','cam_migrator','-d','vocabulary']);return true;});
  const address=await docker(['port',containerId,'5432/tcp']);assert.match(address,/^127\.0\.0\.1:\d+$/);
  const port=Number(address.split(':')[1]);
  target=new pg.Client({host:'127.0.0.1',port,user:'cam_migrator',password:'local_migration_only',database:'vocabulary',connectionTimeoutMillis:5000});
  await target.connect();
  await target.query("CREATE ROLE vocabulary_api NOLOGIN NOSUPERUSER NOBYPASSRLS; CREATE ROLE cam_backend LOGIN PASSWORD 'local_backend_only' NOSUPERUSER NOBYPASSRLS; GRANT vocabulary_api TO cam_backend");
  assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'),sha256);
  stage='pg_restore';
  await docker(['exec','-i',containerId,'pg_restore','--username=cam_migrator','--dbname=vocabulary','--no-owner','--exit-on-error','--single-transaction'],{inputFile:archive});
  assert.deepEqual(await fingerprints(target),expected,'Restored table contents must match the exported snapshot');
  assert.deepEqual(await runMigrations(target,migrations),[],'Restored migration ledger must rerun without changes');
  const consistency=await checkConsistency(target);emit('restore_contents_ledger_FK_indexes_FORCE_RLS');
  stage='restored_runtime_access';
  runtime=new pg.Client({host:'127.0.0.1',port,user:'cam_backend',password:'local_backend_only',database:'vocabulary',connectionTimeoutMillis:5000});
  await runtime.connect();
  const role=(await runtime.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];assert.equal(role.rolsuper,false);assert.equal(role.rolbypassrls,false);
  for(const owner of owners){
    await runtime.query('BEGIN');
    try{
      await runtime.query("SELECT set_config('app.user_id',$1,true)",[owner]);
      const rows=(await runtime.query('SELECT user_id FROM app.profiles')).rows;
      assert.equal(rows.length,1);assert.equal(rows[0].user_id,owner);
    }finally{await runtime.query('ROLLBACK');}
  }
  assert.ok(owners.length>=2,'Seeded A/B profiles required to verify restored runtime owner isolation');
  emit('restored_runtime_grants_and_A_B_owner_isolation');
  report={generated_at:new Date().toISOString(),scope:'Local Compose source, new disposable PostgreSQL 17 target; no Supabase access',
    archive_bytes:(await stat(archive)).size,archive_sha256:sha256,backup_ms:Number(backupMs.toFixed(2)),restore_and_verify_ms:Number((performance.now()-restoreStart).toFixed(2)),
    tables:expected.map(({schema,table,rows})=>({schema,table,rows,contents_match:true})),migrations:ledger.map(m=>m.name),
    consistency,runtime_owners_checked:owners.length,passed:true,resources_closed:false,
    limits:'Logical schema/data snapshot, not PITR or a backup of roles, Storage files, Auth service settings, secrets or real Supabase Auth. Archive is ignored local data, not uploaded.'};
  passed=true;
}catch{console.error(JSON.stringify({stage,status:'failed',message:'Local backup/restore drill failed; no credential or database row logged'}));process.exitCode=1;}
finally{
  await runtime?.end();await target?.end();
  if(snapshotOpen)await source.query('ROLLBACK').catch(()=>{});
  await source.end().catch(()=>{});
  try{
    // Inspect exact name/label before removing only the container created here.
    let info;try{info=JSON.parse(await docker(['inspect',name]))[0];}catch{if(containerId)throw Error('Owned restore container missing');}
    if(info){assert.equal(info.Name,'/'+name);assert.equal(info.Config.Labels['cam.backup.drill'],nonce);await docker(['rm','--force','--volumes',info.Id]);}
    if(passed){report.resources_closed=true;report.total_ms=Number((performance.now()-started).toFixed(2));await writeFile(new URL('../../../docs/cam/benchmarks/backup-restore-local.json',import.meta.url),JSON.stringify(report,null,2)+'\n');emit('restore_drill_cleanup_source_untouched');}
  }catch{console.error('Owned restore container cleanup failed');process.exitCode=1;}
}
