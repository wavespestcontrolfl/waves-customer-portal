/**
 * invoices.scheduled_service_id — lets an invoice be minted BEFORE completion,
 * linked back to the scheduled_services row. Used by the "Charge now" flow so
 * the tech can run Tap-to-Pay before finishing the visit report. The completion
 * handler then detects the existing invoice and skips re-minting.
 *
 * Nullable so the vast majority of invoices (post-completion, linked via
 * service_record_id) remain valid. ON DELETE SET NULL — invoices outlive
 * scheduled rows.
 */

exports.up = async function (knex) {
  const has = await knex.schema.hasColumn('invoices', 'scheduled_service_id');
  if (has) return;

  await knex.schema.alterTable('invoices', (t) => {
    t.uuid('scheduled_service_id')
      .references('id')
      .inTable('scheduled_services')
      .onDelete('SET NULL');
    t.index('scheduled_service_id');
  });
};

exports.down = async function (knex) {
  const has = await knex.schema.hasColumn('invoices', 'scheduled_service_id');
  if (!has) return;

  await knex.schema.alterTable('invoices', (t) => {
    t.dropColumn('scheduled_service_id');
  });
};
