'use strict';

/**
 * /secure plan-choice lane (owner workflow 2026-07-24): the appointment
 * card-request link gains a plan step — pay per application vs. annual
 * prepay — so office-created bookings can skip the estimator.
 *
 * 1. appointment_card_requests — record WHICH plan the customer picked and,
 *    for prepay, the minted invoice + term (idempotency anchors: a second
 *    submit returns the same pay link instead of minting twice).
 * 2. scheduled_services.pending_setup_fee — the $99 WaveGuard setup fee a
 *    per-application selection on a solo pest/mosquito series owes (owner
 *    decision 2026-07-24: added to the FIRST completion invoice
 *    automatically). Amount snapshotted at selection so the billed fee
 *    always equals the disclosed fee; stamped on the series parent only,
 *    cleared by the completion mint's atomic claim.
 *
 * Everything here is inert until GATE_SECURE_PLAN_CHOICE is on — columns
 * stay NULL on every existing path.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('appointment_card_requests')) {
    if (!(await knex.schema.hasColumn('appointment_card_requests', 'selected_plan'))) {
      await knex.schema.alterTable('appointment_card_requests', (t) => {
        // 'per_application' | 'prepay_annual' — NULL until the customer picks.
        t.string('selected_plan', 24);
        t.timestamp('plan_selected_at', { useTz: true });
      });
    }
    if (!(await knex.schema.hasColumn('appointment_card_requests', 'prepay_invoice_id'))) {
      await knex.schema.alterTable('appointment_card_requests', (t) => {
        t.uuid('prepay_invoice_id').references('id').inTable('invoices').onDelete('SET NULL');
        t.uuid('annual_prepay_term_id').references('id').inTable('annual_prepay_terms').onDelete('SET NULL');
      });
    }
  }

  if (await knex.schema.hasTable('scheduled_services')) {
    if (!(await knex.schema.hasColumn('scheduled_services', 'pending_setup_fee'))) {
      await knex.schema.alterTable('scheduled_services', (t) => {
        t.decimal('pending_setup_fee', 10, 2);
      });
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('appointment_card_requests')) {
    for (const col of ['annual_prepay_term_id', 'prepay_invoice_id', 'plan_selected_at', 'selected_plan']) {
      if (await knex.schema.hasColumn('appointment_card_requests', col)) {
        await knex.schema.alterTable('appointment_card_requests', (t) => { t.dropColumn(col); });
      }
    }
  }
  if (await knex.schema.hasTable('scheduled_services')) {
    if (await knex.schema.hasColumn('scheduled_services', 'pending_setup_fee')) {
      await knex.schema.alterTable('scheduled_services', (t) => { t.dropColumn('pending_setup_fee'); });
    }
  }
};
