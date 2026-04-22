/**
 * Operator-initiated "Send receipt" action on paid invoices. Adds two
 * columns — receipt_sent_at (timestamp of the send) and receipt_memo
 * (ephemeral per-send note, last value stored for audit). No status
 * change: 'paid' stays the terminal state; the UI derives a "Closed"
 * display from receipt_sent_at IS NOT NULL.
 */

exports.up = async function (knex) {
  const hasSent = await knex.schema.hasColumn('invoices', 'receipt_sent_at');
  const hasMemo = await knex.schema.hasColumn('invoices', 'receipt_memo');
  await knex.schema.alterTable('invoices', (t) => {
    if (!hasSent) t.timestamp('receipt_sent_at').nullable();
    if (!hasMemo) t.text('receipt_memo').nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('invoices', (t) => {
    t.dropColumn('receipt_sent_at');
    t.dropColumn('receipt_memo');
  });
};
