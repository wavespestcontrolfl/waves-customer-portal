// The backfill migration scrubs the internal inspection_fee out of legacy
// project.recommendations narratives (audit 2026-07-16 / codex #2807) — once,
// in place, with no delivery path touched. Driven through a fake knex so the
// row-selection + per-project fee gathering + update behavior is pinned.
const migration = require('../models/migrations/20260716150000_scrub_inspection_fee_from_project_narratives');

function fakeKnex(rows) {
  const updates = [];
  const builder = {
    _rows: rows,
    whereNotNull() { return this; },
    andWhereRaw() { return this; },
    select() { return Promise.resolve(this._rows); },
    where(criteria) { this._pending = criteria; return this; },
    update(patch) {
      // compare-and-set: only "writes" if the current row still matches the
      // predicate's recommendations (simulates the concurrent-edit guard)
      const current = rows.find((r) => r.id === this._pending.id);
      if (!current || current.recommendations !== this._pending.recommendations) return Promise.resolve(0);
      updates.push({ id: this._pending.id, patch });
      return Promise.resolve(1);
    },
  };
  const knex = (table) => {
    if (table !== 'projects') throw new Error(`unexpected table ${table}`);
    return builder;
  };
  knex.schema = {
    hasTable: () => Promise.resolve(true),
    hasColumn: () => Promise.resolve(true),
  };
  knex._updates = updates;
  return knex;
}

test('scrubs the fee from a legacy narrative, leaves the rest, and updates only affected rows', async () => {
  const knex = fakeKnex([
    {
      id: 'p-legacy',
      findings: JSON.stringify({ wdo_finding: 'None observed', inspection_fee: '$250' }),
      wdo_sent_filings: null,
      recommendations: 'Inspection fee $250. Keep mulch pulled back from the foundation.',
    },
    {
      id: 'p-clean',
      findings: JSON.stringify({ wdo_finding: 'None observed', inspection_fee: '$250' }),
      wdo_sent_filings: null,
      recommendations: 'Keep mulch pulled back and stay on the annual schedule.',
    },
    {
      id: 'p-no-fee',
      findings: JSON.stringify({ wdo_finding: 'None observed' }),
      wdo_sent_filings: null,
      recommendations: 'Anything at all with a $250 number.',
    },
    {
      id: 'p-archived-fee',
      findings: JSON.stringify({ wdo_finding: 'None observed' }),
      wdo_sent_filings: JSON.stringify([{ findings: { inspection_fee: '$300' } }]),
      recommendations: 'Prior charge $300 noted. Re-inspect within 175 days.',
    },
    {
      // fee CHANGED $250 -> $300 after the narrative was written; the stale
      // $250 is named by no snapshot but must still be scrubbed (value-
      // independent cued pass), gated because the project HAS a fee
      id: 'p-stale-draft',
      findings: JSON.stringify({ wdo_finding: 'None observed', inspection_fee: '$300' }),
      wdo_sent_filings: null,
      recommendations: 'Inspection fee $250 quoted earlier. Keep mulch back.',
    },
    {
      // fee-less project with a legitimate cued estimate — must NOT be touched
      id: 'p-legit-estimate',
      findings: JSON.stringify({ wdo_finding: 'Repairs recommended' }),
      wdo_sent_filings: null,
      recommendations: 'Repair cost estimate: $1,250 for the sill plate.',
    },
  ]);

  await migration.up(knex);

  // only the two fee-bearing narratives are updated
  const byId = Object.fromEntries(knex._updates.map((u) => [u.id, u.patch.recommendations]));
  expect(Object.keys(byId).sort()).toEqual(['p-archived-fee', 'p-legacy', 'p-stale-draft']);
  expect(byId['p-legacy']).toBe('Inspection fee [fee removed]. Keep mulch pulled back from the foundation.');
  // archived fee is gathered too; the unrelated "175 days" survives
  expect(byId['p-archived-fee']).toContain('[fee removed]');
  expect(byId['p-archived-fee']).toContain('175 days');
  // a stale draft fee ($250) not named by any snapshot is still scrubbed
  expect(byId['p-stale-draft']).toBe('Inspection fee [fee removed] quoted earlier. Keep mulch back.');
  // p-clean (no fee in text), p-no-fee (no fee field), and p-legit-estimate
  // (fee-less project with a real cued estimate) are untouched
  expect(byId['p-clean']).toBeUndefined();
  expect(byId['p-no-fee']).toBeUndefined();
  expect(byId['p-legit-estimate']).toBeUndefined();
});

test('compare-and-set skips a row edited concurrently between SELECT and UPDATE', async () => {
  const rows = [{
    id: 'p-raced',
    findings: JSON.stringify({ wdo_finding: 'None observed', inspection_fee: '$250' }),
    wdo_sent_filings: null,
    recommendations: 'Inspection fee $250. Keep mulch back.',
  }];
  const knex = fakeKnex(rows);
  // simulate a concurrent admin edit AFTER the bulk SELECT: the live row text
  // changes, so the CAS predicate no longer matches and nothing is clobbered
  rows[0].recommendations = 'Admin just rewrote this entirely.';
  await migration.up(knex);
  expect(knex._updates).toHaveLength(0);
  expect(rows[0].recommendations).toBe('Admin just rewrote this entirely.');
});

test('down is a no-op (a removed internal fee is not restored)', async () => {
  await expect(migration.down()).resolves.toBeUndefined();
});
