/**
 * invoice_followup_sequences.touch_claimed_at — in-flight touch claim.
 *
 * A dun touch renders invoice amounts/copy and sends externally without a
 * transaction, so a delivered-invoice edit (2026-07-17 lane) could commit
 * mid-send and the reminder would quote a total the pay page no longer
 * charges. fireStep stamps this before rendering and clears it after;
 * InvoiceService.update refuses edits while a fresh claim exists (pre-check
 * + atomic predicate). Crashed senders self-heal via the 10-minute
 * freshness window the readers apply.
 */
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('invoice_followup_sequences');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('invoice_followup_sequences', 'touch_claimed_at');
  if (hasColumn) return;
  await knex.schema.alterTable('invoice_followup_sequences', (t) => {
    t.timestamp('touch_claimed_at').nullable(); // fresh = touch mid-send; NULL = idle
  });
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('invoice_followup_sequences');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('invoice_followup_sequences', 'touch_claimed_at');
  if (!hasColumn) return;
  await knex.schema.alterTable('invoice_followup_sequences', (t) => {
    t.dropColumn('touch_claimed_at');
  });
};
