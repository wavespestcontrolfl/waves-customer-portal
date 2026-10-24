/**
 * Paper FDACS-13692 consumer notices (GATE_WARRANTY_13692_CHECK, owner 2026-10-24).
 *
 * Rule 5E-14.105(1), F.A.C.: the owner or authorized agent signs the Consumer Notice Form FDACS-13692 before a
 * wood-destroying-organism contract. A customer who signed the paper form has no e-signed contract row, so the office
 * uploads a scan and the date it was signed. The New Construction Termite Warranty counts one of these like an e-signed
 * consumer_notice.fdacs_13692 contract.
 *
 *   customer_id           the customer the notice was signed for (rows follow a customer merge through the generic repoint)
 *   signed_on             the date the owner or agent signed the paper form
 *   s3_key                the private scan, under consumer-notices/<customer id>/ (never returned by a route; a signed link only)
 *   recorded_by_admin_id  the admin who uploaded it (technicians.id; NULL if that user is removed)
 *
 * down() drops the table. It holds only scans an admin uploaded through the consumer-notices route, and nothing else
 * reads it.
 */
const TABLE = 'consumer_notice_paper_records';

exports.up = async function up(knex) {
  if (await knex.schema.hasTable(TABLE)) return;
  await knex.schema.createTable(TABLE, (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.date('signed_on').notNullable();
    t.string('s3_key', 300).notNullable();
    t.string('file_name', 255).notNullable();
    t.string('mime_type', 100).notNullable();
    t.integer('file_size_bytes').notNullable();
    t.uuid('recorded_by_admin_id').nullable().references('id').inTable('technicians').onDelete('SET NULL');
    t.string('notes', 500).nullable();
    t.timestamps(true, true);
    t.index('customer_id');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists(TABLE);
};
