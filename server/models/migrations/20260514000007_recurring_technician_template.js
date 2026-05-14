exports.up = async function (knex) {
  const cols = await knex('scheduled_services').columnInfo();
  if (!cols.recurring_technician_id || !cols.recurring_technician_override) {
    await knex.schema.alterTable('scheduled_services', (t) => {
      if (!cols.recurring_technician_id) {
        t.uuid('recurring_technician_id')
          .nullable()
          .references('id')
          .inTable('technicians')
          .onDelete('SET NULL');
        t.index(['recurring_technician_id']);
      }
      if (!cols.recurring_technician_override) {
        t.boolean('recurring_technician_override').notNullable().defaultTo(false);
      }
    });
  }
};

exports.down = async function (knex) {
  const cols = await knex('scheduled_services').columnInfo();
  if (cols.recurring_technician_id || cols.recurring_technician_override) {
    await knex.schema.alterTable('scheduled_services', (t) => {
      if (cols.recurring_technician_override) t.dropColumn('recurring_technician_override');
      if (cols.recurring_technician_id) t.dropColumn('recurring_technician_id');
    });
  }
};
