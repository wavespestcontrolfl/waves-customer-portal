/**
 * invoice_followup_sequences.anchor_at — per-sequence cadence anchor.
 *
 * The follow-up cadence is anchored to when the invoice went out
 * (sent_at → sms_sent_at → created_at). The 2026-07-17 delivered-invoice
 * edit lane needs to SHIFT a sequence's whole remaining timeline when an
 * admin moves the due date (e.g. +30 days), and progression must stay on
 * that same shifted anchor — recomputing later steps from sent_at would
 * fire the deferred touches on consecutive cron runs. NULL = legacy
 * behavior (send-anchored); rescheduleForInvoiceEdit stamps it.
 */
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('invoice_followup_sequences');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('invoice_followup_sequences', 'anchor_at');
  if (hasColumn) return;
  await knex.schema.alterTable('invoice_followup_sequences', (t) => {
    t.timestamp('anchor_at').nullable(); // cadence anchor override; NULL = send-anchored
  });
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('invoice_followup_sequences');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('invoice_followup_sequences', 'anchor_at');
  if (!hasColumn) return;
  await knex.schema.alterTable('invoice_followup_sequences', (t) => {
    t.dropColumn('anchor_at');
  });
};
