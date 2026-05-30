/**
 * projects.invoice_id — persistent link from a project to the invoice raised
 * for it. The WDO "send report + invoice" flow auto-creates a draft invoice;
 * without a stored linkage, the dry-run preview, the actual send, and any later
 * resend each fall through to a fresh InvoiceService.create (projects can be
 * ad-hoc, i.e. have neither service_record_id nor scheduled_service_id), so the
 * same inspection accumulates duplicate drafts. Recording the invoice id on the
 * project lets every subsequent call reuse the existing invoice.
 *
 * Nullable; ON DELETE SET NULL — invoices and projects have independent
 * lifecycles.
 */

exports.up = async function (knex) {
  const has = await knex.schema.hasColumn('projects', 'invoice_id');
  if (has) return;

  await knex.schema.alterTable('projects', (t) => {
    t.uuid('invoice_id')
      .references('id')
      .inTable('invoices')
      .onDelete('SET NULL');
    t.index('invoice_id');
  });
};

exports.down = async function (knex) {
  const has = await knex.schema.hasColumn('projects', 'invoice_id');
  if (!has) return;

  await knex.schema.alterTable('projects', (t) => {
    t.dropColumn('invoice_id');
  });
};
