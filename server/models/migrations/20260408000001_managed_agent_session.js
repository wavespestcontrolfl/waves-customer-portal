/**
 * Add managed_session_id to ai_conversations for Managed Agents integration.
 * Links each conversation to its Anthropic-hosted agent session.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasColumn('ai_conversations', 'managed_session_id'))) {
    await knex.schema.alterTable('ai_conversations', (t) => {
      t.string('managed_session_id', 100);
      t.index('managed_session_id', 'idx_ai_conv_managed_session');
    });
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasColumn('ai_conversations', 'managed_session_id')) {
    await knex.schema.alterTable('ai_conversations', (t) => {
      t.dropColumn('managed_session_id');
    });
  }
};
