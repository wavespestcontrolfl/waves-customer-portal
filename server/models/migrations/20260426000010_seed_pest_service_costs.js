/**
 * Companion to the 20260414000017 fix on PR for issue #294.
 *
 * 20260414000017_pest_service_costs_and_modifiers.js now skips
 * silently on a fresh DB where pricing_config doesn't yet have the
 * JSONB `data` column (the column is added later by ...026). That
 * defensive skip is correct — but the pest_service_costs row that
 * ...017 was supposed to insert is NOT in ...026's seed list, so a
 * fresh DB ends up missing the row entirely.
 *
 * This migration runs after ...026 (filename order: ...026 → 026 in
 * batch with seeded data, then this file at ...010 in the next-day
 * sequence). It idempotently inserts pest_service_costs if the row
 * isn't already present. Existing prod (where ...017 ran in some
 * historical state) already has the row — onConflict('config_key').ignore()
 * makes this a no-op there. On a fresh DB the row appears here.
 *
 * The seeded values are copied verbatim from ...017's insert so
 * fresh DBs and prod-historic DBs converge on the same data.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;

  // Defensive: only run if pricing_config has the JSONB `data` column.
  // On a fresh DB, ...026 will have run before this migration in
  // alphabetical order (20260414000026 < 20260426000010), so the
  // column exists. This guard is belt-and-suspenders for partially-
  // applied legacy DBs.
  const cols = await knex.raw(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'pricing_config' AND column_name = 'data'
  `);
  if (cols.rows.length === 0) return;

  await knex('pricing_config')
    .insert({
      config_key: 'pest_service_costs',
      name: 'Pest Service Cost Breakdown',
      category: 'pest',
      sort_order: 5,
      data: JSON.stringify({
        chemicals: {
          taurus_sc: { bottle_price: 95.00, bottle_oz: 78, oz_per_service: 4, cost_per_service: 4.87 },
          talak: { bottle_price: 41.57, bottle_oz: 128, oz_per_service: 4, cost_per_service: 1.30 },
        },
        labor: {
          spray_minutes: 10,
          sweep_minutes: 10,
          total_minutes: 20,
          rate_per_hour: 35,
          cost_per_service: 11.67,
        },
        total_cost_per_service: 17.84,
      }),
      description: 'Per-service chemical cost + labor time breakdown',
    })
    .onConflict('config_key')
    .ignore();
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;
  // Don't delete — the original ...017's down handles this row, and
  // we want to leave it in place if a downstream migration came to
  // depend on it. Idempotent up + no-op down is safe here.
};
