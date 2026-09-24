// Codex #4710 r3 P1: a win produced by a booking stayed `won` forever even
// when that booking was later cancelled/skipped/no-showed, so the same
// booking counted as a win or not depending on whether the direct hook or the
// hourly sweep saw it first. The win now remembers WHICH booking produced it
// and what the row was before, so the sweep can reopen a win whose evidence
// died.
//
// won_evidence_booking_id: the scheduled_services row behind a booking win
//   (NULL for estimate-accept wins and legacy rows). Deliberately NO foreign
//   key — a FK KEY SHARE lock here is the lock-order class 20260924000004
//   removed from lead_id.
// pre_win_outcome: 'warm' | 'cold' as the row stood when it was won, restored
//   on reopen.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('consultation_outcomes', 'won_evidence_booking_id'))) {
    await knex.schema.alterTable('consultation_outcomes', (t) => {
      t.uuid('won_evidence_booking_id').nullable();
    });
  }
  if (!(await knex.schema.hasColumn('consultation_outcomes', 'pre_win_outcome'))) {
    await knex.schema.alterTable('consultation_outcomes', (t) => {
      t.string('pre_win_outcome', 10).nullable();
    });
  }
  await knex.raw('CREATE INDEX IF NOT EXISTS consultation_outcomes_won_evidence_booking_id_index ON consultation_outcomes (won_evidence_booking_id) WHERE won_evidence_booking_id IS NOT NULL');
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS consultation_outcomes_won_evidence_booking_id_index');
  if (await knex.schema.hasColumn('consultation_outcomes', 'pre_win_outcome')) {
    await knex.schema.alterTable('consultation_outcomes', (t) => { t.dropColumn('pre_win_outcome'); });
  }
  if (await knex.schema.hasColumn('consultation_outcomes', 'won_evidence_booking_id')) {
    await knex.schema.alterTable('consultation_outcomes', (t) => { t.dropColumn('won_evidence_booking_id'); });
  }
};
