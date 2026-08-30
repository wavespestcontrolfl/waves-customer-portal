/**
 * receipt_delivery_jobs.customer_initiated — payment provenance for the
 * receipt's quiet-hours decision (Codex P1 on PR #3598).
 *
 * The receipt queue serves BOTH customer-initiated payments (Pay page,
 * combined pay, deposits) and machine-initiated off-session charges
 * (autopay, completion balance sweeps, no-show fees). Owner ruling
 * 2026-08-29: only the customer-initiated ones send their receipt SMS
 * immediately at any hour; machine-charge receipts stay behind the
 * 8AM-8PM ET send window. Enqueue sites stamp the flag from what they
 * know (the Pay routes always customer; the succeeded webhook from the
 * PaymentIntent's machine markers). Default FALSE is the fail-closed
 * direction: legacy rows and any caller that doesn't stamp provenance
 * are treated as machine-initiated and hold overnight.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('receipt_delivery_jobs'))) return;
  if (await knex.schema.hasColumn('receipt_delivery_jobs', 'customer_initiated')) return;
  await knex.schema.alterTable('receipt_delivery_jobs', (t) => {
    t.boolean('customer_initiated').notNullable().defaultTo(false);
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('receipt_delivery_jobs'))) return;
  if (!(await knex.schema.hasColumn('receipt_delivery_jobs', 'customer_initiated'))) return;
  await knex.schema.alterTable('receipt_delivery_jobs', (t) => {
    t.dropColumn('customer_initiated');
  });
};
