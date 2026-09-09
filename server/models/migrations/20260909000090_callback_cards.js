exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('call_commitments'))) return;
  for (const name of ['callback_due_at', 'snoozed_until']) {
    if (!(await knex.schema.hasColumn('call_commitments', name))) {
      await knex.schema.alterTable('call_commitments', (t) => t.timestamp(name, { useTz: true }));
    }
  }
  if (!(await knex.schema.hasColumn('call_commitments', 'assigned_to'))) {
    await knex.schema.alterTable('call_commitments', (t) => {
      t.uuid('assigned_to').references('id').inTable('technicians').onDelete('SET NULL');
    });
  }
};

// Retain recorded deadlines and ownership when disabling the feature.
// The runtime gate is the rollback; removing these columns loses staff work.
exports.down = async function down() {};
