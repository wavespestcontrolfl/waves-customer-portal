/**
 * Seed the small-commercial pest pilot pricing config.
 *
 * Commercial pest pricing is DB-authoritative: db-bridge.syncConstantsFromDB
 * loads `pricing_config.commercial_pest_pilot` over the in-code
 * constants.COMMERCIAL_PEST_PILOT, so the constants.js defaults are inert in any
 * env carrying this row. This inserts the pilot row (quarterly GPC priced off
 * building sqft brackets) so the small-commercial pilot pricer can quote
 * commercial pest when a service opts in via
 * `commercialPricingMode: 'small_commercial_pilot'`.
 *
 * PILOT DEFAULTS — owner to confirm/tune via the admin Pricing Logic panel.
 * Every pilot price is returned with autoQuoteRequiresAdminApproval, so no quote
 * reaches a customer without operator review.
 */
const CONFIG_KEY = 'commercial_pest_pilot';
const MIGRATION_TAG = 'migration:20260626000020';
const UP_REASON = 'Seed small-commercial pest pilot pricing (quarterly GPC by building sqft)';

const PILOT_DATA = {
  enabled: true,
  floor: 95,
  ceilingSqFt: 15000,
  quarterlyBrackets: [
    { sqft: 2000, price: 95 },
    { sqft: 5000, price: 165 },
    { sqft: 10000, price: 245 },
    { sqft: 15000, price: 325 },
  ],
  frequencyMultipliers: { quarterly: 1.0, bimonthly: 0.92, monthly: 0.85 },
  frequencies: { quarterly: 4, bimonthly: 6, monthly: 12 },
  stories: { perStoryUplift: 0.12, maxStories: 6 },
  perUnitQuarterly: 5,
  unitManualReviewThreshold: 60,
  taxCategory: 'nonresidential_pest_control',
  description: 'Small-commercial pest pilot — quarterly per-visit price interpolated by building sqft, × stories uplift + per-unit callback reserve, summed across buildings. Above ceilingSqFt falls back to manual quote.',
};

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;

  const existing = await knex('pricing_config').where({ config_key: CONFIG_KEY }).first();
  if (existing) return; // idempotent — preserve any admin edits already present

  await knex('pricing_config').insert({
    config_key: CONFIG_KEY,
    name: 'Small-Commercial Pest Pilot',
    category: 'pest',
    sort_order: 90,
    data: JSON.stringify(PILOT_DATA),
    description: 'Quarterly commercial GPC priced off building square footage (pilot).',
  });

  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').insert({
      config_key: CONFIG_KEY,
      old_value: null,
      new_value: JSON.stringify(PILOT_DATA),
      changed_by: MIGRATION_TAG,
      reason: UP_REASON,
    });
  }
};

// Stable stringify so a key-order difference between the seeded JSON and the
// round-tripped DB JSON doesn't read as an admin edit.
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

exports.down = async function (knex) {
  // Only remove the row if this migration's up() created it (keyed off the audit
  // row) AND the current config still matches what we seeded. If an operator
  // tuned the values in the admin Pricing Logic panel, the row no longer matches
  // the seed, so rollback leaves the edited production config in place.
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;
  const ownUp = await knex('pricing_config_audit')
    .where({ config_key: CONFIG_KEY, changed_by: MIGRATION_TAG, reason: UP_REASON })
    .first('id');
  if (!ownUp) return;

  if (await knex.schema.hasTable('pricing_config')) {
    const row = await knex('pricing_config').where({ config_key: CONFIG_KEY }).first();
    if (row) {
      const current = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
      if (stableStringify(current) !== stableStringify(PILOT_DATA)) return; // admin-edited — keep it
      await knex('pricing_config').where({ config_key: CONFIG_KEY }).del();
    }
  }
  await knex('pricing_config_audit')
    .where({ config_key: CONFIG_KEY, changed_by: MIGRATION_TAG, reason: UP_REASON })
    .del();
};
