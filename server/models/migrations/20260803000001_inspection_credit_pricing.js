/**
 * Inspection credit amount + window, seeded into pricing_config (owner
 * ruling 2026-08-03: flat $75 toward any service booked within 30 days).
 *
 * Pricing is DB-authoritative — db-bridge.syncConstantsFromDB overlays this
 * row onto constants.INSPECTION_CREDIT — so the constants.js default in
 * this PR is inert in prod without the row. Admin-editable through the
 * Pricing Logic panel, bounded by validatePricingConfigData.
 *
 * FLAT by ruling: the credit is worth this amount whatever the inspection
 * was actually billed at (a comped inspection still earns the full credit).
 * The value is FROZEN onto each offer at closeout, so editing it here only
 * affects promises made from that point on — never one already given.
 */
const CONFIG_KEY = 'inspection_credit';
const AMOUNT = 75;
const WINDOW_DAYS = 30;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;
  const existing = await knex('pricing_config').where({ config_key: CONFIG_KEY }).first('id');
  if (existing) return; // admin already tuned it — never clobber

  await knex('pricing_config').insert({
    config_key: CONFIG_KEY,
    name: 'Inspection Credit',
    category: 'global',
    data: JSON.stringify({ amount: AMOUNT, creditableWithinDays: WINDOW_DAYS }),
    description: 'Flat credit an inspection earns toward any service booked within the window. Applied as account credit at REBOOK, never at the inspection. Frozen per offer at closeout — editing this only affects future promises. Per-service windows (e.g. rodent_inspection.creditable_within_days) still win where they exist.',
    sort_order: 97,
  });

  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').insert({
      config_key: CONFIG_KEY,
      old_value: null,
      new_value: JSON.stringify({ amount: AMOUNT, creditableWithinDays: WINDOW_DAYS }),
      changed_by: 'migration:20260803000001',
      reason: 'Seed inspection credit (owner ruling 2026-08-03: flat $75 / 30 days)',
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;
  // Only remove the row this migration created, and only while it still
  // matches what was seeded — an admin edit since must survive rollback.
  const row = await knex('pricing_config').where({ config_key: CONFIG_KEY }).first('data');
  if (!row) return;
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {});
  if (Number(data.amount) !== AMOUNT || Number(data.creditableWithinDays) !== WINDOW_DAYS) return;
  await knex('pricing_config').where({ config_key: CONFIG_KEY }).del();
};
