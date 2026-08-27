/**
 * 20260826000002: rodent inspection fee $125 → $75. Each config row is
 * judged independently — a primary row already at $75 must not leave the
 * legacy onetime_exclusion mirror at $125 (uncapped audit P1 on #3521).
 */
const migration = require('../models/migrations/20260826000002_rodent_inspection_fee_75');

function fakeKnex(db) {
  const knex = (table) => {
    const filters = [];
    const rowsNow = () => db[table] || [];
    const match = (r) => filters.every((cond) => {
      if (cond.__op) { const [col, op, val] = cond.__op; return op === '>' ? Number(r[col]) > Number(val) : r[col] === val; }
      if (cond.__like) { const [col, pat] = cond.__like; return String(r[col] || '').startsWith(String(pat).replace(/%$/, '')); }
      return Object.entries(cond).every(([k, v]) => r[k] === v);
    });
    const q = {
      where(a, b, c) {
        if (typeof a === 'string' && c !== undefined) { filters.push({ __op: [a, b, c] }); return q; }
        filters.push(typeof a === 'string' ? { [a]: b } : a); return q;
      },
      whereLike(col, pattern) { filters.push({ __like: [col, pattern] }); return q; },
      orderBy() { return q; },
      first: async () => { const rows = rowsNow().filter(match); const hit = rows[rows.length - 1]; return hit ? { ...hit } : undefined; },
      update: async (patch) => { const hits = rowsNow().filter(match); hits.forEach((r) => Object.assign(r, patch)); return hits.length; },
      del: async () => { const hits = rowsNow().filter(match); db[table] = rowsNow().filter((r) => !hits.includes(r)); return hits.length; },
      insert: async (row) => { (db[table] = rowsNow()).push({ id: rowsNow().length + 1, ...row }); return [1]; },
    };
    return q;
  };
  knex.schema = { hasTable: async (t) => t in db };
  knex.fn = { now: () => 'NOW' };
  return knex;
}

const seedDb = ({ fee = 125, exclusionInspection = 125 } = {}) => ({
  pricing_config: [
    { id: 'pc-insp', config_key: 'rodent_inspection', data: { fee, creditable_within_days: 14, waive_if_approved_total_over: 995 } },
    { id: 'pc-ex', config_key: 'onetime_exclusion', data: { inspection: exclusionInspection, simple: 45 } },
  ],
  pricing_config_audit: [],
  pricing_changelog: [],
});
const dataOf = (db, key) => { const r = db.pricing_config.find((x) => x.config_key === key); return typeof r.data === 'string' ? JSON.parse(r.data) : r.data; };

describe('20260826000002 rodent inspection fee $75', () => {
  test('up() lowers the fee, mirrors it onto the legacy exclusion row, and logs; down() restores both', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    expect(dataOf(db, 'rodent_inspection').fee).toBe(75);
    expect(dataOf(db, 'onetime_exclusion').inspection).toBe(75);
    expect(db.pricing_changelog).toHaveLength(1);
    await migration.down(fakeKnex(db));
    expect(dataOf(db, 'rodent_inspection').fee).toBe(125);
    expect(dataOf(db, 'onetime_exclusion').inspection).toBe(125);
    expect(db.pricing_changelog).toHaveLength(0);
  });

  test('a primary row already at $75 still brings the stale legacy mirror in line', async () => {
    const db = seedDb({ fee: 75, exclusionInspection: 125 });
    await migration.up(fakeKnex(db));
    expect(dataOf(db, 'rodent_inspection').fee).toBe(75);
    expect(dataOf(db, 'onetime_exclusion').inspection).toBe(75);
    // No primary audit row (nothing changed there); the mirror has its own.
    expect(db.pricing_config_audit.map((a) => a.config_key)).toEqual(['onetime_exclusion']);
    // Rollback of a mirror-only up() restores the mirror and drops the changelog.
    await migration.down(fakeKnex(db));
    expect(dataOf(db, 'rodent_inspection').fee).toBe(75);
    expect(dataOf(db, 'onetime_exclusion').inspection).toBe(125);
    expect(db.pricing_changelog).toHaveLength(0);
  });

  test('fully current rows are a no-op apart from the changelog identity', async () => {
    const db = seedDb({ fee: 75, exclusionInspection: 75 });
    await migration.up(fakeKnex(db));
    expect(db.pricing_config_audit).toHaveLength(0);
  });

  test('a no-op reapplication after a rollback never consumes the earlier cycle\'s audit row', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));     // 125 → 75 (cycle 1)
    await migration.down(fakeKnex(db));   // back to 125, Rollback rows written
    expect(dataOf(db, 'rodent_inspection').fee).toBe(125);
    // Admin now sets both rows to $75 by hand, then the migration re-runs as a no-op.
    db.pricing_config[0].data = { fee: 75, creditable_within_days: 14, waive_if_approved_total_over: 995 };
    db.pricing_config[1].data = { inspection: 75, simple: 45 };
    await migration.up(fakeKnex(db));
    expect(db.pricing_changelog).toHaveLength(0);
    // Rolling THAT back must not resurrect cycle 1's $125.
    await migration.down(fakeKnex(db));
    expect(dataOf(db, 'rodent_inspection').fee).toBe(75);
    expect(dataOf(db, 'onetime_exclusion').inspection).toBe(75);
  });
});
