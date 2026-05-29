exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('admin_alerts'))) {
    await knex.schema.createTable('admin_alerts', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('dedupe_key', 240).notNullable().unique();
      t.string('type', 80).notNullable();
      t.string('status', 24).notNullable().defaultTo('open');
      t.string('severity', 24).notNullable().defaultTo('medium');
      t.uuid('owner_user_id').references('id').inTable('technicians').onDelete('SET NULL');
      t.string('source_record_type', 60).notNullable();
      t.string('source_record_id', 120).notNullable();
      t.string('title', 180).notNullable();
      t.text('description');
      t.text('href');
      t.uuid('customer_id').references('id').inTable('customers').onDelete('SET NULL');
      t.uuid('employee_user_id').references('id').inTable('technicians').onDelete('SET NULL');
      t.timestamp('detected_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('last_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('resolved_at', { useTz: true });
      t.timestamp('snoozed_until', { useTz: true });
      t.timestamp('dismissed_at', { useTz: true });
      t.string('created_by_rule', 120).notNullable();
      t.jsonb('metadata').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    });

    await knex.raw(`
      ALTER TABLE admin_alerts
        ADD CONSTRAINT admin_alerts_status_check
        CHECK (status IN ('open', 'snoozed', 'resolved', 'dismissed'))
    `);
    await knex.raw(`
      ALTER TABLE admin_alerts
        ADD CONSTRAINT admin_alerts_severity_check
        CHECK (severity IN ('low', 'medium', 'high', 'critical'))
    `);
    await knex.raw(`
      CREATE INDEX idx_admin_alerts_open
        ON admin_alerts (last_seen_at DESC)
        WHERE status = 'open'
    `);
    await knex.raw(`
      CREATE INDEX idx_admin_alerts_snoozed_until
        ON admin_alerts (snoozed_until)
        WHERE status = 'snoozed'
    `);
    await knex.raw(`
      CREATE INDEX idx_admin_alerts_source
        ON admin_alerts (source_record_type, source_record_id, type)
    `);
    await knex.raw(`
      CREATE INDEX idx_admin_alerts_owner
        ON admin_alerts (owner_user_id, status, last_seen_at DESC)
        WHERE owner_user_id IS NOT NULL
    `);
  }

  if (!(await knex.schema.hasTable('admin_alert_events'))) {
    await knex.schema.createTable('admin_alert_events', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('alert_id').notNullable().references('id').inTable('admin_alerts').onDelete('CASCADE');
      t.string('event_type', 40).notNullable();
      t.uuid('actor_user_id').references('id').inTable('technicians').onDelete('SET NULL');
      t.timestamp('event_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.jsonb('previous_value');
      t.jsonb('new_value');
      t.text('note');
    });
    await knex.raw(`
      CREATE INDEX idx_admin_alert_events_alert_time
        ON admin_alert_events (alert_id, event_at DESC)
    `);
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('admin_alert_events');
  await knex.schema.dropTableIfExists('admin_alerts');
};
