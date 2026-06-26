/**
 * invoices.email_message — an optional, operator-written (AI-assisted) personal
 * thank-you message rendered in the invoice EMAIL body, beneath the service
 * summary (invoice.notes) and above the line-item table.
 *
 * Deliberately separate from `notes`: `notes` is the service summary that also
 * prints on the invoice PDF, whereas `email_message` is a relationship /
 * thank-you note that lives only in the email — it is never placed on the PDF.
 *
 * Nullable; existing rows stay null and the email renders exactly as before
 * (the send path no-ops the paragraph when the column is empty).
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('invoices', (t) => {
    t.text('email_message').nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('invoices', (t) => {
    t.dropColumn('email_message');
  });
};
