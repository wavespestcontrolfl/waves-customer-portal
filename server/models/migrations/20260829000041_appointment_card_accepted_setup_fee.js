// accepted_setup_fee for appointment_card_requests (codex #3591 r15 P1):
// a direct (non-estimate) rodent bait series on the /secure plan choice
// discloses the non-member bait-station setup from the LIVE
// pricing_config.rodent_setup_fee. The selection POST must consume the
// figure the customer SAW, not a value an operator raised between render
// and selection — same lesson accepted_amount carries for the
// per-application cap (20260801500000). Stamped at render (monotonic-down);
// NULL = no setup disclosed. No backfill.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('appointment_card_requests'))) return;
  if (!(await knex.schema.hasColumn('appointment_card_requests', 'accepted_setup_fee'))) {
    await knex.schema.alterTable('appointment_card_requests', (t) => {
      t.decimal('accepted_setup_fee', 10, 2);
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('appointment_card_requests'))) return;
  if (await knex.schema.hasColumn('appointment_card_requests', 'accepted_setup_fee')) {
    await knex.schema.alterTable('appointment_card_requests', (t) => {
      t.dropColumn('accepted_setup_fee');
    });
  }
};
