// Local-only diagnostic: all fixture writes roll back; no .env or remote URLs.
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { substringMatch } from '../dist/src/learning/substring-match.js';
const c = new pg.Client({ connectionString: 'postgresql://cam_migrator:local_migration_only@127.0.0.1:54329/vocabulary', connectionTimeoutMillis: 5000 });
const owner = randomUUID(), deck = randomUUID();
await c.connect();
try {
  assert.deepEqual((await c.query("SELECT column_name FROM information_schema.columns WHERE table_schema='auth' AND table_name='users'")).rows, [{ column_name: 'id' }]);
  const examples = ['Hello World','I i K S','Học TIẾNG Việt','Café École','ĐƯỜNG phố','100%_\\','.*+?^${}()|[]\\','***=hello','a\nb','İıſKßẞΣσς'];
  const needles = ['WORLD','tiếng','ÉCOLE','đường','%','_','\\','.*','[','***=','\n','İ','i','ſ','S','K','k','ß','ẞ','Σ','σ','ς','absent'];
  for (const value of examples) for (const needle of needles) {
    const pattern = '%' + needle.replace(/[\\%_]/g, '\\$&') + '%';
    const row = (await c.query(`SELECT r.word ILIKE $2 AS old, ${substringMatch('r.word',2)} AS fast FROM (SELECT $1::text AS word) r`, [value, pattern])).rows[0];
    assert.equal(row.fast, row.old, JSON.stringify({ value, needle }));
  }
  console.log('ASCII fast-path and ILIKE equivalence examples passed');
  await c.query('BEGIN');
  await c.query('INSERT INTO auth.users VALUES($1)', [owner]);
  await c.query('INSERT INTO app.profiles(user_id) VALUES($1)', [owner]);
  await c.query('INSERT INTO app.decks(id,user_id,name) VALUES($1,$2,$3)', [deck, owner, 'search probe']);
  await c.query(`INSERT INTO app.cards(id,user_id,deck_id,word,meaning)
    SELECT md5($1||g)::uuid,$1::uuid,$2::uuid,'vocabulary-'||lpad(g::text,6,'0'),repeat(md5(g::text),58)
    FROM generate_series(1,5000) g`, [owner, deck]);
  await c.query('ANALYZE app.cards');
  await c.query('SET LOCAL ROLE vocabulary_api');
  await c.query("SELECT set_config('app.user_id',$1,true)", [owner]);
  for (const needle of ['vocabulary-00001','no-match-in-this-fixture','a','tiếng']) {
    const outputs = [];
    for (const [label, condition, search] of [
      ['ILIKE', 'r.word ILIKE $2 OR r.meaning ILIKE $2', '%' + needle + '%'],
      ['ascii_fastpath', `${substringMatch('r.word',2)} OR ${substringMatch('r.meaning',2)}`, '%' + needle + '%'],
    ]) {
      const sql = `SELECT r.id FROM app.cards r WHERE r.user_id=$1 AND r.deleted_at IS NULL AND (${condition}) ORDER BY r.updated_at DESC,r.id ASC LIMIT 101`;
      const durations = [];
      let ids;
      for (let i = 0; i < 23; i++) {
        const start = performance.now();
        ids = (await c.query(sql, [owner, search])).rows;
        if (i >= 3) durations.push(performance.now() - start);
      }
      outputs.push(ids);
      durations.sort((a, b) => a - b);
      console.log(JSON.stringify({ needle, label, p95_ms: durations[18], rows: ids.length }));
    }
    assert.deepEqual(outputs[0], outputs[1]);
  }
} finally {
  try {
    await c.query('ROLLBACK');
    assert.equal((await c.query('SELECT id FROM auth.users WHERE id=$1', [owner])).rowCount, 0);
    await c.query('ANALYZE app.cards');
  } finally { await c.end(); }
}
