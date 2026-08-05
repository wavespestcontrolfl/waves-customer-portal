/**
 * inspection_credit_offers.source_service_key — the service key the CLOSEOUT
 * resolved for the source inspection, frozen at offer creation.
 *
 * Why (Codex #3178 r35 P0): dark-mode redemption is restricted to
 * standing-promise offers (rodent's estimator-quoted credit), and the first
 * cut classified the source by joining scheduled_services.service_id →
 * services.service_key. That FK is NULL on graduated held-slot rows and
 * legacy free-text rows — exactly the rows whose closeout still resolves
 * `rodent_inspection` via the service_type fallback — so their offers were
 * recorded and their memo printed, but the restricted redemption could
 * never see them. Freezing the key the closeout actually resolved makes
 * the classification identical at both ends, with no FK dependence.
 *
 * No backfill: the lane has never been live (GATE_INSPECTION_CREDIT dark
 * since inception), so no offer rows exist in prod at migration time.
 */
exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('inspection_credit_offers', 'source_service_key');
  if (!has) {
    await knex.schema.alterTable('inspection_credit_offers', (t) => {
      t.string('source_service_key', 120);
    });
  }
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasColumn('inspection_credit_offers', 'source_service_key');
  if (has) {
    await knex.schema.alterTable('inspection_credit_offers', (t) => {
      t.dropColumn('source_service_key');
    });
  }
};
