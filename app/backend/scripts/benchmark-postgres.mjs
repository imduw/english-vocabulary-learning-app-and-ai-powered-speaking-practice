// Only this repository's local Compose fixture. Never load .env or accept a URL.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { loadMigrations } from './migration-runner.mjs';

const require = createRequire(import.meta.url);
const { LearningRepository } = require('../dist/src/learning/learning.repository.js');
const { ProgressService } = require('../dist/src/progress/progress.service.js');
const { SyncService } = require('../dist/src/sync/sync.service.js');
const client = new pg.Client({ connectionString: 'postgresql://cam_migrator:local_migration_only@127.0.0.1:54329/vocabulary', connectionTimeoutMillis: 5000 });
const owners = [randomUUID(), randomUUID()];
const tables = ['profiles', 'decks', 'cards', 'tags', 'card_tags', 'review_states', 'review_events', 'sync_heads', 'sync_changes', 'review_heads'];
const repetitions = 40;
const mixedText = process.argv.includes('--mixed-text');
const withTags = process.argv.includes('--with-tags');
assert.ok(process.argv.slice(2).every(arg => ['--mixed-text','--with-tags'].includes(arg)), 'only --mixed-text/--with-tags are supported');
let inTransaction = false;
let analyzed = false;
let report;
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const stats = values => ({ samples: values.length, min_ms: Math.min(...values), p50_ms: percentile(values, .5), p95_ms: percentile(values, .95), max_ms: Math.max(...values) });

try {
  await client.connect();
  const fixture = await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema='auth' AND table_name='users'");
  assert.deepEqual(fixture.rows.map(row => row.column_name), ['id'], 'local auth fixture only');
  const environment = (await client.query('SELECT version(), current_database() AS database, current_user AS session_role')).rows[0];
  assert.equal(environment.database, 'vocabulary');
  assert.equal(environment.session_role, 'cam_migrator');
  const migrations = await loadMigrations(new URL('../database/migrations/', import.meta.url));
  const history = (await client.query('SELECT name,checksum FROM app_migrations.history ORDER BY name')).rows;
  assert.deepEqual(history, migrations.map(({ name, checksum }) => ({ name, checksum })), 'apply the current migration set before benchmarking');
  // Verify deployed locale and literal-search examples on actual PostgreSQL.
  const searchCases = [
    ['Hello World', '%WORLD%'], ['Học TIẾNG Việt', '%tiếng%'],
    ['Café École', '%ÉCOLE%'], ['ĐƯỜNG phố', '%đường%'],
    ['a%_\\b', '%\\%\\_\\\\%'], ['not a match', '%absent%'],
  ];
  for (const [value, pattern] of searchCases) {
    const { rows } = await client.query('SELECT $1::text ILIKE $2 AS matches', [value, pattern]);
    assert.equal(rows[0].matches, value !== 'not a match', 'case/literal search examples must work in the deployed locale');
  }
  await client.query('BEGIN'); inTransaction = true;
  await client.query("SET LOCAL statement_timeout='120s'");
  console.log('Creating transactional fixtures: 2 owners, 10,000 cards, 100,000 reviews...');
  for (const owner of owners) {
    await client.query('INSERT INTO auth.users(id) VALUES($1)', [owner]);
    await client.query("INSERT INTO app.profiles(user_id,timezone) VALUES($1,'Asia/Ho_Chi_Minh')", [owner]);
    await client.query(`INSERT INTO app.decks(id,user_id,name)
      SELECT md5($1||':deck:'||g)::uuid,$1::uuid,'Benchmark deck '||g FROM generate_series(1,100) g`, [owner]);
    await client.query(`INSERT INTO app.cards(id,user_id,deck_id,word,meaning,source_sentence,is_favorite,deleted_at,tags)
      SELECT md5($1||':card:'||g)::uuid,$1::uuid,md5($1||':deck:'||((g-1)%100+1))::uuid,
      'vocabulary-'||lpad(g::text,6,'0'),
      CASE WHEN $2::boolean AND g%5=0 THEN E'Học TIẾNG Việt; ĐƯỜNG phố; Café École; İıſKßẞΣσς; 100%_\\\\; ' ELSE '' END || repeat(md5(g::text),58),
      repeat(md5((g+1)::text),4),g%5=0,
      CASE WHEN g%20=0 THEN now() ELSE NULL END,
      CASE WHEN $3::boolean THEN ARRAY['topic-'||(g%100),'level-'||(g%5)] ELSE '{}'::text[] END
      FROM generate_series(1,5000) g`, [owner, mixedText, withTags]);
    // Ten events per card; direct SQL fixtures measure reads, not SM-2 replay/write performance.
    await client.query(`INSERT INTO app.review_events(user_id,id,card_id,quality,score,reviewed_at,timezone_at_review,algorithm_version,request_hash,result)
      SELECT $1::uuid,md5($1||':event:'||g)::uuid,md5($1||':card:'||((g-1)%5000+1))::uuid,
      (g%6)::smallint,(g%101)::smallint,now()-(g%365)*interval '1 day',
      'Asia/Ho_Chi_Minh','sm2-v1',md5(g::text),jsonb_build_object('benchmark',true)
      FROM generate_series(1,50000) g`, [owner]);
    await client.query(`INSERT INTO app.review_states(user_id,card_id,algorithm_version,repetitions,interval_days,ease_factor,total_reviews,last_reviewed_at,due_at)
      SELECT $1::uuid,md5($1||':card:'||g)::uuid,'sm2-v1',g%5,6,2.5,10,now()-interval '6 days',now()+(g%30-15)*interval '1 day'
      FROM generate_series(1,5000) g`, [owner]);
  }
  analyzed = true;
  for (const table of tables) await client.query(`ANALYZE app.${table}`);
  await client.query('SET LOCAL ROLE vocabulary_api');
  await client.query("SELECT set_config('app.user_id',$1,true)", [owners[0]]);
  const role = (await client.query('SELECT current_user AS name,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
  assert.equal(role.name, 'vocabulary_api'); assert.equal(role.rolsuper, false); assert.equal(role.rolbypassrls, false);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM app.cards WHERE user_id=$1', [owners[1]])).rows[0].n, 0);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM app.cards')).rows[0].n, 5000);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM app.tags')).rows[0].n, withTags ? 105 : 0);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM app.card_tags')).rows[0].n, withTags ? 10000 : 0);
  const owner = owners[0];
  const ids = (await client.query('SELECT id,deck_id FROM app.cards WHERE deleted_at IS NULL ORDER BY id LIMIT 1')).rows[0];
  const traces = [];
  const measuredClient = { query: async (sql, values) => {
    const started = performance.now();
    const result = await client.query(sql, values);
    if (/FROM\s+app\./i.test(sql)) traces.push({ sql, values, ms: performance.now() - started, rows: result.rowCount });
    return result;
  } };
  // A single fixture transaction keeps all generated data invisible to other connections.
  // Exercise production repository/service SQL; exclude pool/BEGIN/auth/profile provisioning.
  const database = { withUser: async (user, work) => { assert.equal(user, owner); return work(measuredClient); } };
  const profiles = { getOrCreate: async user => { assert.equal(user, owner); } };
  const learning = new LearningRepository(database);
  const progress = new ProgressService(database, profiles, () => new Date());
  const sync = new SyncService(database, learning, profiles);
  const list = extra => learning.list(owner, 'card', { limit: 100, offset: 0, ...extra });
  const cases = [
    ['decks_list', () => learning.list(owner, 'deck', { limit: 100, offset: 0 })],
    ['card_by_id', () => learning.get(owner, 'card', ids.id)],
    ['cards_list', () => list({})],
    ['cards_by_deck', () => list({ deck_id: ids.deck_id })],
    ['cards_favorites', () => list({ is_favorite: true })],
    ['cards_search_hit', () => list({ q: 'vocabulary-00001' })],
    ['cards_search_miss', () => list({ q: 'no-match-in-this-fixture' })],
    ['cards_deep_page', () => list({ offset: 4500 })],
    ['review_history', () => progress.history(owner, { limit: '100', offset: '0' })],
    ['review_card_history', () => progress.history(owner, { limit: '100', card_id: ids.id })],
    ['progress_summary', () => progress.summary(owner, {})],
    ['sync_changes', () => sync.changes(owner, { limit: '100' })],
    ['review_changes', () => progress.changes(owner, { limit: '100' })],
    ['cards_search_unicode', () => list({ q: 'tiếng' })],
    ['cards_search_unicode_miss', () => list({ q: 'không-có-kết-quả' })],
    ['cards_search_literal', () => list({ q: '%_\\' })],
    ...(withTags ? [
      ['cards_tag_exact', () => list({ tag: 'TOPIC-1' })],
      ['cards_tag_missing', () => list({ tag: 'absent-label' })],
      ['cards_search_tag_name', () => list({ q: 'topic-1' })],
      ['cards_tag_search_combined', () => list({ tag: 'topic-1', q: 'vocabulary-0' })],
      ['cards_tag_deep_page', () => list({ tag: 'level-0', offset: 650 })],
      ['cards_sort_word', () => list({ sort: 'word', order: 'asc' })],
      ['cards_sort_word_desc_deep_page', () => list({ sort: 'word', order: 'desc', offset: 4500 })],
      ['cards_sort_created', () => list({ sort: 'created_at', order: 'asc' })],
    ] : []),
  ];
  const results = [];
  for (const [name, run] of cases) {
    for (let i = 0; i < 3; i++) await run();
    traces.length = 0;
    const operations = [];
    for (let i = 0; i < repetitions; i++) { const start = performance.now(); await run(); operations.push(performance.now() - start); }
    const groups = Map.groupBy(traces, row => row.sql);
    const queries = [];
    for (const [sql, samples] of groups) {
      const plan = (await client.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + sql, samples[0].values)).rows[0]['QUERY PLAN'][0];
      queries.push({ sql, ...stats(samples.map(row => row.ms)), returned_rows: samples[0].rows, explain: plan });
    }
    assert.ok(queries.length, `${name} must execute actual application SQL`);
    const result = { name, operation: stats(operations), queries };
    results.push(result);
    console.log(`${name}: operation p95=${result.operation.p95_ms.toFixed(2)}ms; slowest query p95=${Math.max(...queries.map(q => q.p95_ms)).toFixed(2)}ms`);
  }
  report = { generated_at: new Date().toISOString(), migrations: migrations.map(m => m.name), environment: { ...environment, node: process.version, platform: process.platform, runtime_role: role.name },
    dataset: { owners: 2, per_owner: { decks: 100, cards: 5000, active_cards: 4750, review_events: 50000, review_states: 5000, tags: withTags ? 105 : 0, card_tags: withTags ? 10000 : 0 }, card_text_bytes_approx: 2000, unicode_meanings_percent: mixedText ? 20 : 0 },
    method: { repetitions, warmup: 3, concurrency: 1, statistics: 'ANALYZE after fixture inserts', latency: 'Node pg round-trip per SQL; separate repository/service operation duration; excludes pool, transaction setup, auth and HTTP', transaction: 'ROLLBACK all fixtures; restore ANALYZE statistics afterwards', scope: 'local Compose PostgreSQL only; warmed cache; no production/Supabase or concurrent load claim' },
    threshold_ms: 50, all_query_p95_below_threshold: results.every(r => r.queries.every(q => q.p95_ms < 50)), results };
} finally {
  try {
    if (inTransaction) {
      await client.query('ROLLBACK');
      const remaining = await client.query('SELECT id FROM auth.users WHERE id=ANY($1::uuid[])', [owners]);
      assert.equal(remaining.rowCount, 0, 'benchmark users and dependent rows must be rolled back');
    }
    // ANALYZE metadata is not transactional: restore estimates for the real local rows.
    if (analyzed) for (const table of tables) await client.query(`ANALYZE app.${table}`);
  } finally {
    await client.end();
  }
}
assert.ok(report);
report.fixture_cleanup_verified = true;
const folder = new URL('../../../docs/cam/benchmarks/', import.meta.url);
await mkdir(folder, { recursive: true });
const filename = withTags ? 'postgres-local-tags.json' : mixedText ? 'postgres-local-mixed.json' : 'postgres-local.json';
await writeFile(new URL(filename, folder), JSON.stringify(report, null, 2) + '\n');
console.log(`Fixture rollback verified; query p95 <50ms: ${report.all_query_p95_below_threshold}. Report: docs/cam/benchmarks/${filename}`);
if (!report.all_query_p95_below_threshold) process.exitCode = 1;
