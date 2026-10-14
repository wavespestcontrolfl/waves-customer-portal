/**
 * The area add-ons are excluded from percentage discounts in the rule table too (Codex round 9 on #6135).
 *
 * The scheduler, the completion pricing and the IB reprice tools judge a visit line by its catalog service key against
 * WAVEGUARD.excludedFromPercentDiscount (pricing-engine/constants.js), which now lists the six `area_addon_*` keys. The
 * Pricing Logic panel's Discount Rules and services/discount-engine.js applyTierDiscount read service_discount_rules, so the
 * same exclusion goes there: one row per add-on key with exclude_from_pct_discount true and nothing else set.
 *
 * Insert-if-missing: an existing row is never touched. down() deletes only the rows this migration wrote and that still carry
 * its note (an edited row keeps its edit, because an edit of the note is what marks it as touched).
 */
const SERVICE_KEYS = [
  'area_addon_bed_pre_emergent',
  'area_addon_lawn_insect_spot',
  'area_addon_fire_ant_yard',
  'area_addon_lawn_insect_preventive',
  'area_addon_hardscape_weed',
  'area_addon_web_sweep',
];
const NOTE = 'Area add-on treatment: a priced one-time job, never cut by a percentage (migration 20261010100000).';

exports.SERVICE_KEYS = SERVICE_KEYS;
exports.NOTE = NOTE;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('service_discount_rules'))) return;
  for (const serviceKey of SERVICE_KEYS) {
    if (await knex('service_discount_rules').where({ service_key: serviceKey }).first('service_key')) continue;
    await knex('service_discount_rules').insert({
      service_key: serviceKey,
      tier_qualifier: false,
      max_discount_pct: null,
      flat_credit: null,
      flat_credit_min_tier: null,
      exclude_from_pct_discount: true,
      notes: NOTE,
      updated_at: knex.fn.now(),
    }).onConflict('service_key').ignore();
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('service_discount_rules'))) return;
  await knex('service_discount_rules').whereIn('service_key', SERVICE_KEYS).where({ notes: NOTE, exclude_from_pct_discount: true }).del();
};
