/**
 * Durable portal-chat request identity and turn serialization.
 *
 * The request row is the retry receipt. A partial unique index permits only
 * one claimed turn per authenticated portal conversation scope, while the
 * attempt id fences a worker whose lease expired before it could publish.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('portal_chat_requests'))) {
    await knex.schema.createTable('portal_chat_requests', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('request_id').notNullable();
      t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
      t.uuid('property_id');
      t.string('channel_identifier', 120).notNullable();
      t.string('scope_key', 64).notNullable();
      t.string('message_hash', 64).notNullable();
      t.string('state', 20).notNullable().defaultTo('pending');
      t.uuid('attempt_id');
      t.timestamp('lease_expires_at', { useTz: true });
      t.uuid('conversation_id').references('id').inTable('agent_sessions').onDelete('SET NULL');
      t.jsonb('response');
      t.timestamps(true, true);

      t.unique(['customer_id', 'request_id']);
      t.index(['scope_key', 'created_at']);
    });
    await knex.raw(`
      CREATE UNIQUE INDEX portal_chat_requests_processing_scope_unique
        ON portal_chat_requests (scope_key)
        WHERE state = 'processing'
    `);
  }

  if (await knex.schema.hasTable('agent_messages')
    && !(await knex.schema.hasColumn('agent_messages', 'portal_chat_request_id'))) {
    await knex.schema.alterTable('agent_messages', (t) => {
      t.uuid('portal_chat_request_id').references('id').inTable('portal_chat_requests').onDelete('SET NULL');
    });
    await knex.raw(`
      CREATE UNIQUE INDEX agent_messages_portal_turn_role_unique
        ON agent_messages (portal_chat_request_id, role)
        WHERE portal_chat_request_id IS NOT NULL AND role IN ('user', 'assistant')
    `);
  }

  if (await knex.schema.hasTable('ai_escalations')
    && !(await knex.schema.hasColumn('ai_escalations', 'portal_chat_request_id'))) {
    await knex.schema.alterTable('ai_escalations', (t) => {
      t.uuid('portal_chat_request_id').references('id').inTable('portal_chat_requests').onDelete('SET NULL');
    });
    await knex.raw(`
      CREATE UNIQUE INDEX ai_escalations_portal_turn_unique
        ON ai_escalations (portal_chat_request_id)
        WHERE portal_chat_request_id IS NOT NULL
    `);
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('ai_escalations')
    && await knex.schema.hasColumn('ai_escalations', 'portal_chat_request_id')) {
    await knex.raw('DROP INDEX IF EXISTS ai_escalations_portal_turn_unique');
    await knex.schema.alterTable('ai_escalations', (t) => t.dropColumn('portal_chat_request_id'));
  }
  if (await knex.schema.hasTable('agent_messages')
    && await knex.schema.hasColumn('agent_messages', 'portal_chat_request_id')) {
    await knex.raw('DROP INDEX IF EXISTS agent_messages_portal_turn_role_unique');
    await knex.schema.alterTable('agent_messages', (t) => t.dropColumn('portal_chat_request_id'));
  }
  await knex.schema.dropTableIfExists('portal_chat_requests');
};
