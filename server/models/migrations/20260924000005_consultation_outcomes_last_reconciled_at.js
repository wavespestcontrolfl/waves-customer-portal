// reconcileOpenConsultationOutcomes (the hourly sweep) ordered its LIMIT-200
// slice by recorded_at ASC alone. recorded_at never changes for a still-open
// row, so a backlog of 200+ rows still waiting on booking evidence sorts to
// the exact same front every tick and starves every row behind it forever —
// the same starvation class as codex #4293 P1 (see
// 20260911000020_outbox_messages_last_scanned_at.js), one sweep table over.
//
// last_reconciled_at decouples "examined this tick" from "won this tick":
// every pass stamps it on every row it looks at, win or not, and ordering by
// (last_reconciled_at NULLS FIRST, recorded_at ASC) moves an examined row to
// the back of the line even when it stayed open — restoring forward
// progress through the backlog instead of re-checking the same 200 rows.
exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('consultation_outcomes', 'last_reconciled_at');
  if (!has) {
    await knex.schema.alterTable('consultation_outcomes', (t) => {
      t.timestamp('last_reconciled_at', { useTz: true }).nullable();
    });
  }
  await knex.raw('CREATE INDEX IF NOT EXISTS consultation_outcomes_last_reconciled_at_index ON consultation_outcomes (last_reconciled_at)');
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS consultation_outcomes_last_reconciled_at_index');
  const has = await knex.schema.hasColumn('consultation_outcomes', 'last_reconciled_at');
  if (has) await knex.schema.alterTable('consultation_outcomes', (t) => { t.dropColumn('last_reconciled_at'); });
};
