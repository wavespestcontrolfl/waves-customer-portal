/**
 * Phase 3: dedupe ledger for the "model won — ready to promote" bell alert.
 *
 * triggerNotification() writes a bell entry on every call (no built-in dedupe),
 * so we fire the "won" alert only on the FIRST time a (feature, candidate) clears
 * the readiness bar — recorded here. The row is cleared when the feature is
 * promoted or loses eligibility, so a later re-qualification re-notifies. Mirrors
 * the bill-payment-error-alerts first-occurrence-only pattern.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('model_promotion_alerts')) return;
  await knex.schema.createTable('model_promotion_alerts', (t) => {
    t.string('feature_key', 60).primary();
    t.string('candidate_provider', 30).notNullable();
    t.timestamp('notified_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('model_promotion_alerts');
};
