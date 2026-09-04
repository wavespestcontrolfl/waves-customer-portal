// Portal card-removal hold notice (PR #3828, Codex r1 P1): GET /api/billing/
// cards reads estimate_card_holds by (customer_id, status) — the table only
// had (estimate_id, status) and scheduled_service_id, so every Billing-tab
// open would scan the growing hold history. appointment_card_requests
// already indexes customer_id.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('estimate_card_holds'))) return;
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_estimate_card_holds_customer_status ON estimate_card_holds (customer_id, status)');
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_estimate_card_holds_customer_status');
};
