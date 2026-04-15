/**
 * True-up Pest Service Cost Breakdown to reflect real labor + full chemical rotation.
 *
 * Replaces the earlier 2-chemical / 20-min config with the accurate picture:
 *   - Labor: 33 min on-site + 20 min drive = 53 min @ $35/hr → $30.92
 *   - Chemicals: full rotation (Taurus SC, Talak, Tekko Pro IGR, Temprid, Demand CS) → $10.88
 *   - Total cost per service: $41.80
 *
 * Context: prior config showed fake 87% margins at $135/qtr because drive time
 * and most of the product rotation weren't counted. True margin is 69% at
 * $135, 53% at the $89 floor — still above the 35% floor, confirms $89 is
 * priced correctly.
 *
 * Bracket pricing engine is unaffected — customers see the same prices.
 * This only corrects what the margin dashboards, profitability reports,
 * and cost-per-customer analytics read.
 *
 * Idempotent: re-running replaces the data blob.
 */

const NEW_DATA = {
  chemicals: {
    taurus_sc: { bottle_price: 95.00, bottle_oz: 78,  oz_per_service: 4, cost_per_service: 4.87 },
    talak:     { bottle_price: 41.57, bottle_oz: 128, oz_per_service: 4, cost_per_service: 1.30 },
    tekko_pro: { bottle_price: 72.60, bottle_oz: 16,  oz_per_service: 1, cost_per_service: 4.54 },
    temprid:   { bottle_price: 89.00, bottle_oz: 400, oz_per_service: 0.5, cost_per_service: 0.11 },
    demand_cs: { bottle_price: 65.00, bottle_oz: 8,   oz_per_service: 0.8 / 20, cost_per_service: 0.06 },
  },
  labor: {
    on_site_minutes: 33,
    drive_minutes: 20,
    total_minutes: 53,
    rate_per_hour: 35,
    cost_per_service: 30.92,
  },
  chemical_cost_per_service: 10.88,
  total_cost_per_service: 41.80,
  notes: [
    'Labor now includes 20 min drive time (route avg) plus 33 min on-site.',
    'Chemical cost reflects full rotation. Tekko Pro IGR is the single biggest per-visit chemical at $4.54 — if amortized across every-other quarterly instead of every visit, avg chemical drops to ~$7–8 and total cost to ~$38–39.',
    'At $135/qtr typical: margin = 69%. At $89 floor: margin = 53% (above 35% floor).',
  ],
};

exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable('pricing_config');
  if (!hasTable) return;

  const existing = await knex('pricing_config').where({ config_key: 'pest_service_costs' }).first();
  if (existing) {
    await knex('pricing_config').where({ config_key: 'pest_service_costs' }).update({
      name: 'Pest Service Cost Breakdown',
      category: 'pest',
      sort_order: 5,
      description: 'Per-service chemical cost + labor time breakdown (drive + on-site, full product rotation)',
      data: JSON.stringify(NEW_DATA),
      updated_at: new Date(),
    });
  } else {
    await knex('pricing_config').insert({
      config_key: 'pest_service_costs',
      name: 'Pest Service Cost Breakdown',
      category: 'pest',
      sort_order: 5,
      description: 'Per-service chemical cost + labor time breakdown (drive + on-site, full product rotation)',
      data: JSON.stringify(NEW_DATA),
    });
  }
};

exports.down = async function (knex) {
  const hasTable = await knex.schema.hasTable('pricing_config');
  if (!hasTable) return;

  const previous = {
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
  };
  await knex('pricing_config').where({ config_key: 'pest_service_costs' }).update({
    data: JSON.stringify(previous),
    updated_at: new Date(),
  });
};
