exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('service_discount_rules'))) return;

  const rows = [
    {
      service_key: 'pest_initial_roach',
      tier_qualifier: false,
      max_discount_pct: null,
      flat_credit: null,
      flat_credit_min_tier: null,
      exclude_from_pct_discount: true,
      notes: 'Initial roach knockdown is a non-waivable first-visit cost-recovery charge.',
      updated_at: knex.fn.now(),
    },
    {
      service_key: 'german_roach',
      tier_qualifier: false,
      max_discount_pct: null,
      flat_credit: null,
      flat_credit_min_tier: null,
      exclude_from_pct_discount: true,
      notes: 'German Roach Cleanout is a 3-visit specialty program excluded from percentage discounts.',
      updated_at: knex.fn.now(),
    },
    {
      service_key: 'german_roach_initial',
      tier_qualifier: false,
      max_discount_pct: null,
      flat_credit: null,
      flat_credit_min_tier: null,
      exclude_from_pct_discount: true,
      notes: 'Legacy German roach initial line remains excluded for backward compatibility.',
      updated_at: knex.fn.now(),
    },
  ];

  await knex('service_discount_rules')
    .insert(rows)
    .onConflict('service_key')
    .merge([
      'tier_qualifier',
      'max_discount_pct',
      'flat_credit',
      'flat_credit_min_tier',
      'exclude_from_pct_discount',
      'notes',
      'updated_at',
    ]);
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('service_discount_rules'))) return;

  await knex('service_discount_rules')
    .whereIn('service_key', ['pest_initial_roach', 'german_roach', 'german_roach_initial'])
    .del();
};
