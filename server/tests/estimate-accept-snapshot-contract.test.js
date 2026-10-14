/**
 * Source contract for the accept's table snapshot
 * (services/estimate-accept-snapshot.js).
 *
 * The accept's effect list shows every row the accept changes only because the
 * snapshot reads every table the accept path writes. This test scans the
 * converter, the accept steps and the helpers they call for write targets and
 * fails when a table is written that is in neither SNAPSHOT_TABLES (read in
 * the transaction and diffed) nor NOT_SNAPSHOTTED (with the reason it is
 * safe). A future writer cannot be missed silently: it must be added to the
 * snapshot, or listed with a reason.
 */
const fs = require('fs');
const path = require('path');
const { SNAPSHOT_TABLES, NOT_SNAPSHOTTED, WRITER_FILES } = require('../services/estimate-accept-snapshot');

const SERVICES = path.join(__dirname, '..', 'services');
const MIGRATIONS = path.join(__dirname, '..', 'models', 'migrations');

// Every real table name (so a column or alias that looks like one is ignored).
function allTables() {
  const names = new Set();
  for (const file of fs.readdirSync(MIGRATIONS)) {
    const source = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
    for (const m of source.matchAll(/createTable(?:IfNotExists)?\(\s*['"]([a-z_0-9]+)['"]/g)) names.add(m[1]);
  }
  return names;
}

// Tables a source file writes: a `('table')` / `('table as t')` query whose
// chain (to the end of the statement) calls insert/update/del/increment, and
// raw INSERT INTO / UPDATE / DELETE FROM statements.
function writtenTables(source, tables) {
  const written = new Set();
  for (const m of source.matchAll(/\(\s*['"`]([a-z_0-9]+)(?: as [a-z_]+)?['"`]\s*\)/g)) {
    if (!tables.has(m[1])) continue;
    const rest = source.slice(m.index + m[0].length, m.index + m[0].length + 1200);
    const end = rest.search(/;\s*\n/);
    const chain = end > 0 ? rest.slice(0, end) : rest;
    if (/\.(insert|update|del|delete|increment|decrement)\(/.test(chain)) written.add(m[1]);
  }
  for (const m of source.matchAll(/(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?([a-z_0-9]+)"?/g)) {
    if (tables.has(m[1])) written.add(m[1]);
  }
  return written;
}

describe('the accept snapshot covers every table the accept path writes', () => {
  const tables = allTables();
  const covered = new Set([...SNAPSHOT_TABLES.map((t) => t.table), ...Object.keys(NOT_SNAPSHOTTED)]);

  test('the scan sees the tables it should (a broken scanner would pass everything)', () => {
    expect(tables.size).toBeGreaterThan(300);
    const converter = writtenTables(fs.readFileSync(path.join(SERVICES, 'estimate-converter.js'), 'utf8'), tables);
    for (const known of ['customers', 'estimates', 'activity_log', 'scheduled_services', 'customer_turf_profiles']) expect(converter.has(known)).toBe(true);
    expect(writtenTables(fs.readFileSync(path.join(SERVICES, 'consultation-outcomes.js'), 'utf8'), tables).has('consultation_outcomes')).toBe(true);
    expect(writtenTables(fs.readFileSync(path.join(SERVICES, 'plan-rate-ledger.js'), 'utf8'), tables).has('customer_plan_rates')).toBe(true);
  });

  test.each(WRITER_FILES)('%s: every table it writes is snapshotted or listed with a reason', (file) => {
    const source = fs.readFileSync(path.join(SERVICES, file), 'utf8');
    const missing = [...writtenTables(source, tables)].filter((t) => !covered.has(t)).sort();
    expect(missing).toEqual([]);
  });

  test('every snapshot table exists, and every excluded table says why', () => {
    for (const { table } of SNAPSHOT_TABLES) expect(tables.has(table)).toBe(true);
    for (const [table, reason] of Object.entries(NOT_SNAPSHOTTED)) {
      expect(tables.has(table)).toBe(true);
      expect(reason.length).toBeGreaterThan(20);
      // A table cannot be both read and excused.
      expect(SNAPSHOT_TABLES.some((t) => t.table === table)).toBe(false);
    }
  });

  test('every excused table is still written by some scanned file (a stale excuse is removed)', () => {
    const written = new Set();
    for (const file of WRITER_FILES) for (const t of writtenTables(fs.readFileSync(path.join(SERVICES, file), 'utf8'), tables)) written.add(t);
    expect(Object.keys(NOT_SNAPSHOTTED).filter((t) => !written.has(t))).toEqual([]);
  });

  test('the scanner catches a writer that is missing (self-test on a synthetic source)', () => {
    const synthetic = "await trx('customer_credit_ledger')\n  .where({ id })\n  .update({ delta: 1 });\nawait trx('invoices').where({ id }).first();";
    expect([...writtenTables(synthetic, tables)]).toEqual(['customer_credit_ledger']);
    expect(writtenTables("await trx('never_snapshotted_table_xyz').insert({});\n", new Set(['never_snapshotted_table_xyz'])).has('never_snapshotted_table_xyz')).toBe(true);
  });
});
