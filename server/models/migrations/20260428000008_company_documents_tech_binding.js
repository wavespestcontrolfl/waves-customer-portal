/**
 * Bind company_documents to a specific technician (optional) and
 * track an expiration date. Lets ops see "Jose's pesticide license
 * expires 2026-08-15" alongside the file, and filter the docs
 * library to one tech.
 *
 * technician_id is nullable — null = company-wide doc (SOPs, policies)
 * which is the existing default. expiration_date is nullable since
 * most documents don't expire.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasColumn('company_documents', 'technician_id'))) {
    await knex.schema.alterTable('company_documents', t => {
      t.uuid('technician_id');
      t.index('technician_id');
    });
  }
  if (!(await knex.schema.hasColumn('company_documents', 'expiration_date'))) {
    await knex.schema.alterTable('company_documents', t => {
      t.date('expiration_date');
      t.index('expiration_date');
    });
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasColumn('company_documents', 'expiration_date')) {
    await knex.schema.alterTable('company_documents', t => t.dropColumn('expiration_date'));
  }
  if (await knex.schema.hasColumn('company_documents', 'technician_id')) {
    await knex.schema.alterTable('company_documents', t => t.dropColumn('technician_id'));
  }
};
