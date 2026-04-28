/**
 * Pest landscape complexity — three-tier ladder.
 *
 * Replaces the single complex-only adder ($8) with a symmetric
 * simple/moderate/complex ladder: -$5 / $0 / +$5 per visit. Mirrors
 * the constants.js + service-pricing.js + db-bridge.js + client
 * estimateEngine.js change in the same commit.
 *
 * Merges into the existing pest_features jsonb so any environment
 * (admin-pricing-config seed at 8, or 20260414000026 seed at 5)
 * converges on the new values.
 */

const NEW_VALUES = {
  landscape_simple: -5,
  landscape_moderate: 0,
  landscape_complex: 5,
};

const OLD_VALUES = {
  landscape_complex: 8,
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) {
    return;
  }
  const result = await knex('pricing_config')
    .where({ config_key: 'pest_features' })
    .update({
      data: knex.raw('data || ?::jsonb', [JSON.stringify(NEW_VALUES)]),
      updated_at: knex.fn.now(),
    });
  // eslint-disable-next-line no-console
  console.log(`[pest_landscape_complexity_tiers] updated ${result} row(s)`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) {
    return;
  }
  await knex('pricing_config')
    .where({ config_key: 'pest_features' })
    .update({
      data: knex.raw("(data - 'landscape_simple' - 'landscape_moderate') || ?::jsonb", [JSON.stringify(OLD_VALUES)]),
      updated_at: knex.fn.now(),
    });
};
