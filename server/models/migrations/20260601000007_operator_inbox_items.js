exports.up = async function up(knex) {
  if (await knex.schema.hasTable('operator_inbox_items')) return;

  await knex.schema.createTable('operator_inbox_items', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('source', 20).notNullable(); // call | email | sms
    t.string('source_id', 80).notNullable();
    t.uuid('customer_id').references('id').inTable('customers').onDelete('SET NULL');
    t.string('channel', 20);

    t.string('status', 20).notNullable().defaultTo('open'); // open | snoozed | resolved | dismissed
    t.string('priority', 10).notNullable().defaultTo('low');
    t.boolean('at_risk').notNullable().defaultTo(false);
    t.boolean('needs_reply').notNullable().defaultTo(false);
    t.timestamp('occurred_at', { useTz: true });
    t.text('title');
    t.text('summary');
    t.jsonb('risk_reasons').notNullable().defaultTo('[]');

    t.text('assigned_to');
    t.timestamp('snoozed_until', { useTz: true });
    t.timestamp('resolved_at', { useTz: true });
    t.timestamp('dismissed_at', { useTz: true });
    t.uuid('acted_by').references('id').inTable('technicians').onDelete('SET NULL');
    t.timestamp('last_action_at', { useTz: true });

    t.jsonb('metadata').notNullable().defaultTo('{}');
    t.timestamps(true, true);

    t.unique(['source', 'source_id']);
    t.index(['status', 'occurred_at']);
    t.index(['priority', 'occurred_at']);
    t.index('assigned_to');
    t.index('snoozed_until');
    t.index('customer_id');
  });

  await knex.raw(`
    ALTER TABLE operator_inbox_items
      ADD CONSTRAINT operator_inbox_items_source_check
      CHECK (source IN ('call', 'email', 'sms'))
  `);
  await knex.raw(`
    ALTER TABLE operator_inbox_items
      ADD CONSTRAINT operator_inbox_items_status_check
      CHECK (status IN ('open', 'snoozed', 'resolved', 'dismissed'))
  `);
  await knex.raw(`
    ALTER TABLE operator_inbox_items
      ADD CONSTRAINT operator_inbox_items_priority_check
      CHECK (priority IN ('high', 'medium', 'low'))
  `);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('operator_inbox_items');
};
