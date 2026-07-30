// Dedupe marker for the GATE_VOICEMAIL_CALLBACK_ALERT bell: alert delivery
// (bell rows, pushes) is preference-gated and best-effort, so the one-alert-
// per-call guarantee needs its own persisted claim on the call row — an
// atomic `UPDATE ... WHERE voicemail_callback_alerted_at IS NULL` — instead
// of depending on a notifications row existing.
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('call_log');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('call_log', 'voicemail_callback_alerted_at');
  if (!hasColumn) {
    await knex.schema.alterTable('call_log', (table) => {
      table.timestamp('voicemail_callback_alerted_at').nullable();
    });
  }
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('call_log');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('call_log', 'voicemail_callback_alerted_at');
  if (hasColumn) {
    await knex.schema.alterTable('call_log', (table) => {
      table.dropColumn('voicemail_callback_alerted_at');
    });
  }
};
