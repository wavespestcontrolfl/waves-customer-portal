exports.up = async function (knex) {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS pgcrypto');

  if (!(await knex.schema.hasTable('lawn_protocol_audit_log'))) {
    await knex.schema.createTable('lawn_protocol_audit_log', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('lawn_protocol_id').nullable().references('id').inTable('lawn_protocols').onDelete('SET NULL');
      t.uuid('actor_technician_id').nullable().references('id').inTable('technicians').onDelete('SET NULL');
      t.string('actor_name', 160);
      t.string('actor_email', 180);
      t.string('entity_type', 40).notNullable();
      t.uuid('entity_id').notNullable();
      t.string('action', 40).notNullable();
      t.jsonb('changed_fields').notNullable().defaultTo('[]');
      t.jsonb('before_snapshot').notNullable().defaultTo('{}');
      t.jsonb('after_snapshot').notNullable().defaultTo('{}');
      t.jsonb('metadata').notNullable().defaultTo('{}');
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

      t.index(['lawn_protocol_id', 'created_at'], 'idx_lawn_protocol_audit_protocol_created');
      t.index(['entity_type', 'entity_id'], 'idx_lawn_protocol_audit_entity');
      t.index('actor_technician_id', 'idx_lawn_protocol_audit_actor');
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('lawn_protocol_audit_log');
};
