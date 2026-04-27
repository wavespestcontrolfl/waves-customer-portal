exports.up = async function(knex) {
  const hasTable = await knex.schema.hasTable('pricing_config');
  if (!hasTable) return; // ensureTable will seed on next API call

  // Defensive: if the table doesn't yet have the JSONB `data` column
  // (added by 20260414000026), skip silently. Same defensive pattern
  // 20260414000013_payment_model_restructure already uses — file
  // ordering puts ...017 BEFORE ...026 even though ...017 depends on
  // the column ...026 creates. On a fresh DB, ...026 drops/recreates
  // with the right schema and seeds pest_features with shrubs_light /
  // trees_light / indoor (lines 80 of ...026), so the work below is
  // redundant when the column is missing. The pest_service_costs row
  // this migration adds is NOT in ...026's seed — covered by the
  // companion migration 20260426000010_seed_pest_service_costs which
  // runs after ...026 and idempotently inserts.
  //
  // Background: PR #294 (Phase 1.5, migrate moves to release command)
  // surfaced this as a hard deploy-blocker — the per-boot retry loop
  // had been silently masking the failure. Codex P1 on PR #294 review
  // flagged the related preDeployCommand syntax; prod's knex_migrations
  // verification confirmed ...017 was never recorded as applied, so
  // any fail-fast deploy would reject. This fix makes the migration
  // safe under both the new release-command flow and the legacy
  // per-boot path.
  const cols = await knex.raw(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'pricing_config' AND column_name = 'data'
  `);
  if (cols.rows.length === 0) return;

  // Update pest_features to include shrubs_light, trees_light, indoor
  const existing = await knex('pricing_config').where({ config_key: 'pest_features' }).first();
  if (existing) {
    const data = typeof existing.data === 'string' ? JSON.parse(existing.data) : existing.data;
    if (!('shrubs_light' in data)) data.shrubs_light = -5;
    if (!('trees_light' in data)) data.trees_light = -5;
    if (!('indoor' in data)) data.indoor = 10;
    await knex('pricing_config').where({ config_key: 'pest_features' }).update({
      data: JSON.stringify(data),
      updated_at: new Date(),
    });
  }

  // Add pest service costs config (chemical + labor breakdown)
  const costExists = await knex('pricing_config').where({ config_key: 'pest_service_costs' }).first();
  if (!costExists) {
    await knex('pricing_config').insert({
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
    });
  }
};

exports.down = async function(knex) {
  const hasTable = await knex.schema.hasTable('pricing_config');
  if (!hasTable) return;

  // Same defensive guard as up — if the table is on the pre-...026
  // schema (no `data` column), there's nothing for this rollback to
  // touch. The companion migration's down handles its own row.
  const cols = await knex.raw(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'pricing_config' AND column_name = 'data'
  `);
  if (cols.rows.length === 0) return;

  // Remove the new modifiers from pest_features
  const existing = await knex('pricing_config').where({ config_key: 'pest_features' }).first();
  if (existing) {
    const data = typeof existing.data === 'string' ? JSON.parse(existing.data) : existing.data;
    delete data.shrubs_light;
    delete data.trees_light;
    delete data.indoor;
    await knex('pricing_config').where({ config_key: 'pest_features' }).update({
      data: JSON.stringify(data),
      updated_at: new Date(),
    });
  }

  await knex('pricing_config').where({ config_key: 'pest_service_costs' }).del();
};
