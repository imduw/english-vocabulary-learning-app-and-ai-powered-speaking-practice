import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { substringMatch } from '../dist/src/learning/substring-match.js';

test('optimized substring predicate agrees with locale ILIKE for Unicode and literal patterns', async () => {
  const db = new PGlite();
  const values = ['', 'Hello World', 'I i K S', 'Học TIẾNG Việt', 'Café École', 'ĐƯỜNG phố',
    '100%_\\', '.*+?^${}()|[]\\', '***=hello', 'a\nb', 'İıſKßẞΣσς', '😀 school', '漢字'];
  const needles = ['WORLD', 'tiếng', 'ÉCOLE', 'đường', '%', '_', '\\', '.*', '[', '***=', '\n',
    'İ', 'i', 'ſ', 'S', 'K', 'k', 'ß', 'ẞ', 'Σ', 'σ', 'ς', '😀', '漢', 'absent', "' OR 1=1--"];
  try {
    for (const value of values) for (const needle of needles) {
      const pattern = '%' + needle.replace(/[\\%_]/g, '\\$&') + '%';
      const { rows } = await db.query(`SELECT r.word ILIKE $2 AS original,
        ${substringMatch('r.word', 2)} AS optimized FROM (SELECT $1::text AS word) r`, [value, pattern]);
      assert.equal(rows[0].optimized, rows[0].original, JSON.stringify({ value, needle }));
    }
  } finally { await db.close(); }
});
