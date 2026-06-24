// Adds an in-flight send marker so recap delivery is crash-recoverable: the claim
// stamps send_attempt_at (not sent_at), and sent_at is only set once the provider
// confirms. A crash between claim and confirmation leaves sent_at NULL, so a retry
// re-claims after the stale window instead of the recap being stuck "sent".
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('service_recaps');
  if (!hasTable) return;
  const hasCol = await knex.schema.hasColumn('service_recaps', 'send_attempt_at');
  if (!hasCol) {
    await knex.schema.alterTable('service_recaps', (t) => {
      t.timestamp('send_attempt_at', { useTz: true }).nullable();
    });
  }
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('service_recaps');
  if (!hasTable) return;
  const hasCol = await knex.schema.hasColumn('service_recaps', 'send_attempt_at');
  if (hasCol) {
    await knex.schema.alterTable('service_recaps', (t) => {
      t.dropColumn('send_attempt_at');
    });
  }
};
