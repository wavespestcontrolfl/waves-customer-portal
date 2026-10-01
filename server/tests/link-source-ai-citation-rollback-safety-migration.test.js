/**
 * 20260928060000 — rollback-safety follow-up to the FROZEN
 * 20260928050000_link_source_ai_citation.js (Codex P1, 2026-09-28: that
 * migration's own down() would abort on real ai_citation data; it can no
 * longer be edited, so this later migration's down() relabels the data
 * BEFORE the earlier one's down() runs, relying on knex's normal
 * last-applied-first rollback ordering within a batch).
 */
const migration = require('../models/migrations/20260928060000_link_source_ai_citation_rollback_safety');
const earlier = require('../models/migrations/20260928050000_link_source_ai_citation');

function fakeKnex() {
  const updates = [];
  const builder = (table) => {
    let whereArg = null;
    const q = {
      where(a) { whereArg = a; return q; },
      update: jest.fn(async (patch) => { updates.push({ table, where: whereArg, patch }); return 0; }),
    };
    return q;
  };
  const raws = [];
  const knex = Object.assign(jest.fn(builder), {
    raw: jest.fn(async (sql) => { raws.push(String(sql)); return {}; }),
  });
  knex._updates = updates;
  knex._raws = raws;
  return knex;
}

test('up() is a documented no-op — no writes, no schema changes', async () => {
  const knex = fakeKnex();
  await migration.up(knex);
  expect(knex._updates).toEqual([]);
  expect(knex._raws).toEqual([]);
  expect(knex).not.toHaveBeenCalled();
});

test('down() relabels ai_citation → legacy_unknown in both provenance tables, source_detail untouched', async () => {
  const knex = fakeKnex();
  await migration.down(knex);
  expect(knex._updates).toEqual([
    { table: 'seo_link_domains', where: { source: 'ai_citation' }, patch: { source: 'legacy_unknown' } },
    { table: 'seo_link_domain_sources', where: { source: 'ai_citation' }, patch: { source: 'legacy_unknown' } },
  ]);
  for (const u of knex._updates) expect(u.patch).not.toHaveProperty('source_detail');
});

// The actual correctness proof: run THIS migration's down() first (as a real
// rollback would, within one batch — last-applied-first), then the EARLIER,
// frozen migration's down(), against the SAME simulated table state — by
// the time the earlier one's CHECK-narrowing runs, no row carries
// 'ai_citation' any more, which is exactly the precondition its (unfixed,
// unfixable) down() needs to succeed against real Postgres.
test('running this down() before the frozen migration\'s down() clears every ai_citation row first', async () => {
  const rows = {
    seo_link_domains: [{ id: 'd1', domain: 'bbb.org', source: 'ai_citation' }],
    seo_link_domain_sources: [{ id: 's1', domain_id: 'd1', source: 'ai_citation', touch_key: 'ai_citation:-' }],
  };
  const builder = (table) => {
    let whereArg = null;
    const q = {
      where(a) { whereArg = a; return q; },
      update: jest.fn(async (patch) => {
        let n = 0;
        for (const r of rows[table]) {
          if (Object.entries(whereArg).every(([k, v]) => r[k] === v)) { Object.assign(r, patch); n += 1; }
        }
        return n;
      }),
    };
    return q;
  };
  const knex = Object.assign(jest.fn(builder), { raw: jest.fn(async () => ({})) });

  await migration.down(knex); // this migration's down() FIRST (last-applied-first ordering)
  expect(rows.seo_link_domains[0].source).toBe('legacy_unknown');
  expect(rows.seo_link_domain_sources[0].source).toBe('legacy_unknown');

  // Now the EARLIER, frozen migration's down() — it only issues raw CHECK
  // SQL (it never touches row data), so it completing at all here proves
  // nothing on its own; the real proof is that no row carries 'ai_citation'
  // by this point, which is the exact condition a real Postgres CHECK needs.
  await expect(earlier.down(knex)).resolves.toBeUndefined();
  expect(rows.seo_link_domains.every((r) => r.source !== 'ai_citation')).toBe(true);
  expect(rows.seo_link_domain_sources.every((r) => r.source !== 'ai_citation')).toBe(true);
});
