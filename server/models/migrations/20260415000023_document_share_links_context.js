/**
 * Extends document_share_links with customer_id + service_record_id so the
 * unauthenticated /shared/:token endpoint can resolve both stored docs and
 * auto-generated service reports (which have document_id = null).
 */
exports.up = async function (knex) {
  const hasCustomer = await knex.schema.hasColumn('document_share_links', 'customer_id');
  const hasService = await knex.schema.hasColumn('document_share_links', 'service_record_id');
  await knex.schema.alterTable('document_share_links', (t) => {
    if (!hasCustomer) t.uuid('customer_id');
    if (!hasService) t.uuid('service_record_id');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('document_share_links', (t) => {
    t.dropColumn('customer_id');
    t.dropColumn('service_record_id');
  });
};
