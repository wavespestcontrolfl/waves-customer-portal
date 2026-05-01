// Persists the user's "Send review request (2hr delay)" intent on invoices
// scheduled via /admin/invoices/:id/send. The cron tick (sendInvoiceNow)
// reads + clears this flag after a successful channel send so the review
// follow-up is gated on actual delivery, matching the immediate-send path.
exports.up = async (knex) => {
  await knex.schema.alterTable('invoices', (t) => {
    t.boolean('request_review_after_send').notNullable().defaultTo(false);
  });
};

exports.down = async (knex) => {
  await knex.schema.alterTable('invoices', (t) => {
    t.dropColumn('request_review_after_send');
  });
};
