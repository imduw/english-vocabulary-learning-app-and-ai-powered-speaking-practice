import assert from 'node:assert/strict';
import pg from 'pg';

const ident=value=>'"'+value.replaceAll('"','""')+'"';
export async function checkConsistency(admin) {
  const foreignKeys=(await admin.query(`SELECT c.conname,c.convalidated,n.nspname AS schema,t.relname AS child,
    pn.nspname AS parent_schema,pt.relname AS parent,
    ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY k.ord) AS child_columns,
    ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num ORDER BY k.ord) AS parent_columns,
    EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.conrelid AND i.indisvalid AND i.indisready AND i.indpred IS NULL
      AND (i.indkey::smallint[])[0:cardinality(c.conkey)-1] @> c.conkey) AS has_leading_index
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    JOIN pg_class pt ON pt.oid=c.confrelid JOIN pg_namespace pn ON pn.oid=pt.relnamespace
    WHERE c.contype='f' AND n.nspname='app' ORDER BY t.relname,c.conname`)).rows;
  assert.equal(new Set(foreignKeys.map(fk=>fk.child)).size,13,'Every application table must appear in FK inventory');
  const checks=[];
  for(const fk of foreignKeys){
    assert.equal(fk.convalidated,true,'Unvalidated FK: '+fk.conname);
    const condition=fk.child_columns.map((name,i)=>`p.${ident(fk.parent_columns[i])}=c.${ident(name)}`).join(' AND ');
    const notNull=fk.child_columns.map(name=>`c.${ident(name)} IS NOT NULL`).join(' AND ');
    const sql=`SELECT count(*)::int AS n FROM ${ident(fk.schema)}.${ident(fk.child)} c WHERE ${notNull} AND NOT EXISTS(SELECT 1 FROM ${ident(fk.parent_schema)}.${ident(fk.parent)} p WHERE ${condition})`;
    const orphans=(await admin.query(sql)).rows[0].n;
    assert.equal(orphans,0,'Orphan rows: '+fk.conname);
    checks.push({table:fk.child,constraint:fk.conname,orphans,has_leading_index:fk.has_leading_index});
  }
  const invalid=(await admin.query(`SELECT indexrelid::regclass::text AS name FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='app' AND (NOT i.indisvalid OR NOT i.indisready)`)).rows;
  assert.deepEqual(invalid,[],'Invalid/unready indexes');
  const rls=(await admin.query(`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='app' AND relkind='r'`)).rows;
  assert.equal(rls.length,13);assert.ok(rls.every(t=>t.relrowsecurity&&t.relforcerowsecurity));
  return {foreign_keys:checks,orphan_rows:0,invalid_indexes:invalid,force_rls_tables:rls.length,
    index_review:checks.filter(c=>!c.has_leading_index).map(c=>({table:c.table,constraint:c.constraint})),
    note:'FK index findings require workload review; not every child FK needs a dedicated index. Query plans/latency have separate evidence.'};
}

if(process.argv.includes('--local')){
  const admin=new pg.Client({connectionString:'postgresql://cam_migrator:local_migration_only@127.0.0.1:54329/vocabulary',connectionTimeoutMillis:5000});
  try{
    await admin.connect();
    const columns=(await admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema='auth' AND table_name='users'")).rows;
    assert.deepEqual(columns.map(c=>c.column_name),['id'],'Only disposable Compose auth fixture is allowed');
    console.log(JSON.stringify(await checkConsistency(admin),null,2));
  }catch(error){console.error('Consistency check failed:',error instanceof TypeError?error.message:error.code??'assertion');process.exitCode=1;}
  finally{await admin.end();}
}
