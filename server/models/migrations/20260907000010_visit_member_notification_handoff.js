'use strict';

// A resumed grouped completion may retry its durable bell, but an admin push
// already handed to the provider must not be sent again after a process loss.
exports.up = async function up(knex) {
  if (!await knex.schema.hasTable('visit_completion_packet_items')) return;
  if (!await knex.schema.hasColumn('visit_completion_packet_items', 'notification_push_started_at')) {
    await knex.schema.alterTable('visit_completion_packet_items', (table) => {
      table.timestamp('notification_push_started_at', { useTz: true });
    });
  }
};

exports.down = async function down(knex) {
  if (!await knex.schema.hasTable('visit_completion_packet_items')) return;
  if (await knex.schema.hasColumn('visit_completion_packet_items', 'notification_push_started_at')) {
    await knex.schema.alterTable('visit_completion_packet_items', (table) => {
      table.dropColumn('notification_push_started_at');
    });
  }
};
