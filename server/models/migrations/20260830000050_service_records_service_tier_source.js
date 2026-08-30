/**
 * service_records.service_tier_source — freeze the WaveGuard tier's
 * PROVENANCE on the record at completion, beside the tier itself.
 *
 * Why: `service_tier` alone cannot say whether the tier was a real paid
 * membership or an auto-derived label (waveguard_tier_source='auto') at the
 * time of the visit — and the customer's CURRENT row changes later (a
 * label-era customer becomes a paying member), so any current-row check can
 * rewrite what a permanent report claims about a past visit (codex #3617
 * r3 P1). The re-service "$0 — included with WaveGuard" money claim reads
 * this frozen value and fails closed: NULL (predates this migration, or no
 * tier) and 'auto' both refuse the claim.
 *
 * Values mirror customers.waveguard_tier_source at completion time
 * ('manual' when the customer row carries none but has a tier).
 */
exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('service_records', 'service_tier_source');
  if (has) return;
  await knex.schema.alterTable('service_records', (t) => {
    t.string('service_tier_source', 20);
  });
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasColumn('service_records', 'service_tier_source');
  if (!has) return;
  await knex.schema.alterTable('service_records', (t) => {
    t.dropColumn('service_tier_source');
  });
};
