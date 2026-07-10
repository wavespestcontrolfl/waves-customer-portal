// Codex P2 on #2556: blocked calls return TwiML before the call_log insert,
// so the STIR/AddOns evidence for the MOST audit-worthy calls (the blocked
// ones) was lost — blocked_call_attempts only stored block type + SID. A
// false-positive review of any future auto-block needs the evidence that
// drove it, so the signals ride the audit row itself.
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('blocked_call_attempts');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('blocked_call_attempts', 'signals');
  if (!hasColumn) {
    await knex.schema.alterTable('blocked_call_attempts', (table) => {
      table.jsonb('signals').nullable();
    });
  }
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('blocked_call_attempts');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('blocked_call_attempts', 'signals');
  if (hasColumn) {
    await knex.schema.alterTable('blocked_call_attempts', (table) => {
      table.dropColumn('signals');
    });
  }
};
