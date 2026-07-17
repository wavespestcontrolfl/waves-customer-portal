// The backfill migration scrubs the internal inspection_fee out of legacy
// project.recommendations narratives (audit 2026-07-16 / codex #2807) — once,
// in place, with no delivery path touched. Driven through a fake knex so the
// row-selection + per-project fee gathering + update behavior is pinned.
const migration = require('../models/migrations/20260716150000_scrub_inspection_fee_from_project_narratives');

function fakeKnex(rows, opts = {}) {
  // rows is the LIVE store (mutated by CAS writes and by any onSelect hook so
  // a concurrent edit can be simulated). Each query starts a fresh builder.
  const updates = [];
  const knex = (table) => {
    if (table !== 'projects') throw new Error(`unexpected table ${table}`);
    let idFilter = null;
    let pending = null;
    const builder = {
      whereNotNull() { return this; },
      andWhereRaw() { return this; },
      whereIn(col, ids) { if (col === 'id') idFilter = new Set(ids); return this; },
      where(criteria) { pending = criteria; return this; },
      select() {
        // fire the concurrent-edit hook exactly once, then snapshot the store
        if (opts.onSelect) { opts.onSelect(); opts.onSelect = null; }
        const scoped = idFilter ? rows.filter((r) => idFilter.has(r.id)) : rows;
        // return copies so the migration's in-memory rows can't alias the store
        return Promise.resolve(scoped.map((r) => ({ ...r })));
      },
      update(patch) {
        const current = rows.find((r) => r.id === pending.id);
        if (!current || current.recommendations !== pending.recommendations) return Promise.resolve(0);
        current.recommendations = patch.recommendations; // apply to the store
        updates.push({ id: pending.id, patch });
        return Promise.resolve(1);
      },
    };
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
      recommendations: 'Inspection fee $300 on file. Re-inspect within 175 days.',
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

test('a concurrent edit that removes the fee is never clobbered', async () => {
  const rows = [{
    id: 'p-raced',
    findings: JSON.stringify({ wdo_finding: 'None observed', inspection_fee: '$250' }),
    wdo_sent_filings: null,
    recommendations: 'Inspection fee $250. Keep mulch back.',
  }];
  // onSelect fires once, right after the initial read: an admin rewrites the
  // row (removing the fee) before the first UPDATE lands.
  const knex = fakeKnex(rows, { onSelect: () => { rows[0].recommendations = 'Admin rewrote this — no fee here.'; } });
  await migration.up(knex);
  // CAS misses on the stale copy; the retry re-reads the clean text, which
  // needs no scrub — nothing is written, the admin's edit stands.
  expect(knex._updates).toHaveLength(0);
  expect(rows[0].recommendations).toBe('Admin rewrote this — no fee here.');
});

test('a concurrent edit that STILL bears the fee is re-scrubbed on retry (not left leaking)', async () => {
  const rows = [{
    id: 'p-raced-fee',
    findings: JSON.stringify({ wdo_finding: 'None observed', inspection_fee: '$250' }),
    wdo_sent_filings: null,
    recommendations: 'Inspection fee $250. Keep mulch back.',
  }];
  // the concurrent edit changes the text but a fee is still present
  const knex = fakeKnex(rows, { onSelect: () => { rows[0].recommendations = 'Reworded: inspection fee $250 still noted.'; } });
  await migration.up(knex);
  // first CAS misses; retry re-reads the new text and scrubs the fee from it
  expect(rows[0].recommendations).toBe('Reworded: inspection fee [fee removed] still noted.');
});

test('down is a no-op (a removed internal fee is not restored)', async () => {
  await expect(migration.down()).resolves.toBeUndefined();
});
