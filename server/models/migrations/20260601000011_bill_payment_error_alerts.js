exports.up = async function (knex) {
  const hasAlerts = await knex.schema.hasTable('bill_payment_error_alerts');
  if (!hasAlerts) {
    await knex.schema.createTable('bill_payment_error_alerts', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('dedupe_key', 64).notNullable().unique();
      t.uuid('invoice_id').nullable().references('id').inTable('invoices').onDelete('SET NULL');
      t.uuid('customer_id').nullable().references('id').inTable('customers').onDelete('SET NULL');
      t.string('payment_intent_id', 128).nullable();
      t.string('phase', 60).notNullable();
      t.string('method_category', 60).nullable();
      t.string('source', 60).notNullable().defaultTo('server');
      t.string('error_code', 100).nullable();
      t.text('error_message').nullable();
      t.integer('occurrence_count').notNullable().defaultTo(1);
      t.timestamp('first_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('last_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('notified_at', { useTz: true }).nullable();
      t.jsonb('metadata').nullable();
      t.index(['invoice_id']);
      t.index(['customer_id']);
      t.index(['payment_intent_id']);
      t.index(['last_seen_at']);
    });
  }

  const hasPrefs = await knex.schema.hasTable('notification_preferences');
  const hasTechs = await knex.schema.hasTable('technicians');
  if (hasPrefs && hasTechs) {
    const users = await knex('technicians').where({ active: true }).select('id');
    if (users.length > 0) {
      const rows = users.map((u) => ({
        admin_user_id: u.id,
        trigger_key: 'bill_payment_error',
        push_enabled: true,
        bell_enabled: true,
        sound_enabled: true,
      }));
      await knex('notification_preferences')
        .insert(rows)
        .onConflict(['admin_user_id', 'trigger_key'])
        .ignore();
    }
  }
};

exports.down = async function (knex) {
  const hasPrefs = await knex.schema.hasTable('notification_preferences');
  if (hasPrefs) {
    await knex('notification_preferences')
      .where({ trigger_key: 'bill_payment_error' })
      .del();
  }
  await knex.schema.dropTableIfExists('bill_payment_error_alerts');
};
