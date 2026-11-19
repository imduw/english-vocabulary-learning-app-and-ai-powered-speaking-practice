// SQL fragments only: the column is an internal whitelist; the search pattern
// remains a bound parameter with LIKE wildcards escaped by the caller.
export function substringMatch(column: 'r.word' | 'r.meaning', parameterIndex: number): string {
  const pattern = `$${parameterIndex}::text`;
  // In UTF-8, byte length equals character length exactly for ASCII text.
  // C collation avoids locale work on each ASCII character. Lower the pattern
  // using the original default locale first (e.g. Unicode dotted I -> i).
  // Other encodings, non-ASCII values and locales with different ASCII folding
  // (e.g. Turkish I) retain the original ILIKE expression.
  return `(CASE WHEN getdatabaseencoding()='UTF8'
    AND lower('ABCDEFGHIJKLMNOPQRSTUVWXYZ')='abcdefghijklmnopqrstuvwxyz'
    AND octet_length(${column})=length(${column})
    THEN ${column} COLLATE "C" ILIKE lower(${pattern} COLLATE "default") COLLATE "C"
    ELSE ${column} ILIKE ${pattern} END)`;
}
