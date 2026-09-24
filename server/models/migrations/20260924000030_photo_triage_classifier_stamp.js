/**
 * Photo-text auto-triage (services/photo-text-triage.js, GATE_PHOTO_TRIAGE):
 * messages.photo_triage_classified_at — the per-message claim for the PAID
 * intent classifier (captions the regex fast path cannot place). Stamped by
 * a conditional UPDATE ... WHERE photo_triage_classified_at IS NULL under an
 * advisory lock right before the model call, so the classifier runs at most
 * once per message, and counted per ET day against
 * PHOTO_TRIAGE_CLASSIFIER_DAILY_CAP. A separate column from
 * photo_triage_at (the vision claim, 20260924000020) so a classifier "no"
 * never spends a vision slot.
 *
 * Nullable, no default: a metadata-only ALTER on Postgres 11+, no rewrite,
 * no index (the cap count is range-scoped by messages (channel, created_at)).
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('messages', 'photo_triage_classified_at'))) {
    await knex.schema.alterTable('messages', (t) => {
      t.timestamp('photo_triage_classified_at', { useTz: true }).nullable();
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('messages', 'photo_triage_classified_at')) {
    await knex.schema.alterTable('messages', (t) => {
      t.dropColumn('photo_triage_classified_at');
    });
  }
};
