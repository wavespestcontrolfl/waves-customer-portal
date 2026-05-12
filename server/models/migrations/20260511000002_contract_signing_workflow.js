exports.up = async function up(knex) {
  const hasContracts = await knex.schema.hasTable('customer_contracts');
  if (!hasContracts) {
    await knex.schema.createTable('customer_contracts', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
      t.uuid('payment_method_id').nullable().references('id').inTable('payment_methods').onDelete('SET NULL');
      t.uuid('created_by').nullable().references('id').inTable('technicians').onDelete('SET NULL');
      t.string('contract_type', 60).notNullable().defaultTo('autopay_authorization');
      t.string('title', 180).notNullable();
      t.string('status', 30).notNullable().defaultTo('draft');
      t.string('recipient_name', 180);
      t.string('recipient_email', 255);
      t.string('recipient_phone', 40);
      t.string('service_name', 180);
      t.date('renewal_date');
      t.date('cancellation_deadline');
      t.boolean('auto_renewal_notice_required').notNullable().defaultTo(false);
      t.timestamp('auto_renewal_notice_sent_at', { useTz: true });
      t.string('consent_text_version', 40);
      t.text('consent_text_snapshot');
      t.text('contract_text_snapshot');
      t.text('esign_disclosure_snapshot');
      t.string('share_token_hash', 128).unique();
      t.timestamp('share_token_expires_at', { useTz: true });
      t.timestamp('shared_at', { useTz: true });
      t.timestamp('viewed_at', { useTz: true });
      t.timestamp('signed_at', { useTz: true });
      t.string('signed_name', 180);
      t.string('recipient_initials', 20);
      t.string('signer_ip', 45);
      t.text('signer_user_agent');
      t.timestamp('cancelled_at', { useTz: true });
      t.text('cancelled_reason');
      t.timestamps(true, true);

      t.index(['customer_id', 'created_at'], 'idx_customer_contracts_customer_created');
      t.index(['status', 'share_token_expires_at'], 'idx_customer_contracts_status_expiry');
    });
  }

  const hasEvents = await knex.schema.hasTable('customer_contract_events');
  if (!hasEvents) {
    await knex.schema.createTable('customer_contract_events', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('contract_id').notNullable().references('id').inTable('customer_contracts').onDelete('CASCADE');
      t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
      t.string('event_type', 60).notNullable();
      t.string('actor_type', 30).notNullable().defaultTo('system');
      t.uuid('actor_id').nullable();
      t.string('ip', 45);
      t.text('user_agent');
      t.jsonb('metadata');
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

      t.index(['contract_id', 'created_at'], 'idx_contract_events_contract_created');
      t.index(['customer_id', 'created_at'], 'idx_contract_events_customer_created');
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('customer_contract_events');
  await knex.schema.dropTableIfExists('customer_contracts');
};
