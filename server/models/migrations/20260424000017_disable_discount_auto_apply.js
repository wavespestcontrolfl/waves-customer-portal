/**
 * Disable auto-apply on all discounts — manual only for now.
 *
 * Flips `is_auto_apply` to false on every row in `discounts` so the
 * discount engine never auto-attaches a discount to an estimate / invoice.
 * Admins still pick discounts manually from the appointment + estimate
 * pickers.
 *
 * `down` restores the seed-level auto-apply flags (WaveGuard tiers,
 * Military, Senior, Multi-Home, Free Termite Inspection, WaveGuard Member
 * WDO, retired ACH payment discount) in case the behavior is re-enabled.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('discounts'))) return;
  if (!(await knex.schema.hasColumn('discounts', 'is_auto_apply'))) return;
  await knex('discounts').update({ is_auto_apply: false, updated_at: new Date() });
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('discounts'))) return;
  if (!(await knex.schema.hasColumn('discounts', 'is_auto_apply'))) return;
  const originallyAutoApply = [
    'waveguard_bronze',
    'waveguard_silver',
    'waveguard_gold',
    'waveguard_platinum',
    'military',
    'senior',
    'multi_home',
    'free_termite_inspection',
    'waveguard_member_wdo',
    'ach_payment_discount',
  ];
  await knex('discounts')
    .whereIn('discount_key', originallyAutoApply)
    .update({ is_auto_apply: true, updated_at: new Date() });
};
