// messaging_suppression is keyed by phone (20260429000015) and has no id
// column. Mocked-table suites hand back whatever columns a query names, so a
// reader that selects id passes them and fails on every real query; three
// readers did, each behind a fail-open catch (2026-10-24). This scans the
// server source for a knex chain on that table that selects id. The behavior
// is proven against a migrated database in
// messaging-suppression-phone-key-postgres.test.js.
const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'tests', 'migrations']);
const TABLE_CALL = /\(\s*['"]messaging_suppression['"]\s*\)/g;
const SELECTS_ID = /\.(?:first|select|pluck|returning|column|columns)\(\s*\[?\s*['"](?:messaging_suppression\.)?id['"]/;

function* sourceFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* sourceFiles(full);
    } else if (entry.name.endsWith('.js')) {
      yield full;
    }
  }
}

test('no knex chain on messaging_suppression selects an id column', () => {
  const offenders = [];
  for (const file of sourceFiles(SERVER)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const match of src.matchAll(TABLE_CALL)) {
      const end = src.indexOf(';', match.index);
      const statement = src.slice(match.index, end === -1 ? undefined : end + 1);
      if (SELECTS_ID.test(statement)) {
        offenders.push(`${path.relative(SERVER, file)}:${src.slice(0, match.index).split('\n').length}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});
