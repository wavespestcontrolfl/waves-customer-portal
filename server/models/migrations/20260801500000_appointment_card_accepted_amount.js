// accepted_amount for appointment_card_requests (Codex #3153 r1 P1): the
// completion auto-charge must cap at the price the customer actually SAW.
// Appointment editors rewrite scheduled_services.estimated_price, so the
// live value at completion time is not consent — the same lesson the hold
// rail already carries as estimate_card_holds.accepted_amount
// (20260717160000, Codex #2821 P1).
//
// Stamped at /secure page render (the last disclosure shown wins) and at
// auto-secure time from the visit's then-current price. No backfill: rows
// without a stamped amount cannot prove what was disclosed, so the
// completion-charge lane skips them (fail toward the pay-link flow).
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('appointment_card_requests'))) return;
  if (!(await knex.schema.hasColumn('appointment_card_requests', 'accepted_amount'))) {
    await knex.schema.alterTable('appointment_card_requests', (t) => {
      t.decimal('accepted_amount', 10, 2);
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('appointment_card_requests'))) return;
  if (await knex.schema.hasColumn('appointment_card_requests', 'accepted_amount')) {
    await knex.schema.alterTable('appointment_card_requests', (t) => {
      t.dropColumn('accepted_amount');
    });
  }
};
