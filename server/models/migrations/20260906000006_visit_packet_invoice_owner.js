'use strict';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('invoices'))) return;
  if (!(await knex.schema.hasColumn('invoices', 'visit_completion_packet_id'))) {
    await knex.schema.alterTable('invoices', (t) => {
      // A packet keeps its one invoice even if that invoice is later voided.
      // Financial exceptions must not turn a retry into a replacement bill.
      t.uuid('visit_completion_packet_id').nullable()
        .references('id').inTable('visit_completion_packets').onDelete('RESTRICT')
        .unique({ indexName: 'invoices_visit_packet_owner_unique' });
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('invoices'))) return;
  if (await knex.schema.hasColumn('invoices', 'visit_completion_packet_id')) {
    await knex.schema.alterTable('invoices', (t) => t.dropColumn('visit_completion_packet_id'));
  }
};
