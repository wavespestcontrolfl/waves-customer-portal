/**
 * Data fix — Sarasota County and North Port cap phosphorus but do not require a soil test before it
 * (owner 2026-11-01, soil-test cleanups). The seed (20260430000011) set phosphorus_requires_soil_test on
 * both rows; "no phosphorus without a soil test" is Manatee County's rule, so the Manatee row keeps it.
 *   - Sarasota County Code Sec. 54-1026(a): at most 0.25 lb P2O5 per 1,000 sq ft per application and
 *     0.50 lb per year, no soil test (re-read 2026-10-31).
 *   - City of North Port Code Sec. 22-58(1): the same cap, no soil test (Ord. 2007-45; Ord. 2023-14 moved the
 *     restricted season to April 1 and left the cap; read 2026-11-01).
 * The flag drives only the plan engine's phosphorus_soil_test warning, which never fires while lawn v13 has
 * no phosphorus product. Update-only: a row whose flag is already off is left as it is.
 */

const ROWS = [
  {
    jurisdiction_type: 'county',
    jurisdiction_name: 'Sarasota County',
    source_checked_at: '2026-10-31',
    note: 'Phosphorus: at most 0.25 lb P2O5 per 1,000 sq ft per application and 0.50 lb per year, no soil test required (Sec. 54-1026(a)).',
  },
  {
    jurisdiction_type: 'city',
    jurisdiction_name: 'North Port',
    source_checked_at: '2026-11-01',
    note: 'Phosphorus: at most 0.25 lb P2O5 per 1,000 sq ft per application and 0.50 lb per year, no soil test required (Sec. 22-58(1)).',
  },
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('municipality_ordinances'))) return;
  for (const row of ROWS) {
    const current = await knex('municipality_ordinances')
      .where({ jurisdiction_type: row.jurisdiction_type, jurisdiction_name: row.jurisdiction_name, active: true })
      .first('id', 'phosphorus_requires_soil_test', 'notes');
    if (!current || current.phosphorus_requires_soil_test !== true) continue;
    await knex('municipality_ordinances').where({ id: current.id }).update({
      phosphorus_requires_soil_test: false,
      source_checked_at: row.source_checked_at,
      notes: [current.notes, row.note].filter(Boolean).join(' '),
      updated_at: knex.fn.now(),
    });
  }
};

exports.down = async function down() {
  // Data correction — intentionally NOT reverted (a down would restore false info), as in 20260528000031.
};
