'use strict';

/**
 * pay_bank_selections: when the public pay page last switched an invoice's
 * PaymentIntent to Bank account (owner 2026-11-24, "build bell").
 *
 * The bank-step-left bell (services/bank-step-left-bell.js) rings the office
 * when a customer picked Bank account and has not paid 30 minutes later
 * (Stripe's bank sign-in failed or was closed; Stripe reports nothing). It reads
 * candidates from here instead of a Stripe search, which cannot bound reused
 * intents by their last touch.
 *
 * Its own table, not a column on invoices: the pay routes fence on
 * invoices.updated_at, so a pay-page write to the invoice row could trip that
 * fence. One row per invoice (the latest selection). /update-amount upserts it
 * on a switch to us_bank_account and deletes it on a switch to anything else;
 * the row goes with its invoice (ON DELETE CASCADE).
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('pay_bank_selections')) return;
  await knex.schema.createTable('pay_bank_selections', (t) => {
    t.uuid('invoice_id').primary().references('id').inTable('invoices').onDelete('CASCADE');
    t.string('payment_intent_id', 128).notNullable();
    t.timestamp('selected_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_pay_bank_selections_selected_at ON pay_bank_selections (selected_at)');
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('pay_bank_selections');
};
