/**
 * route_decisions.recording_sid — the recording a decision was derived from.
 *
 * The audit is append-only and keyed UNIQUE (call_log_id, decision_version,
 * mode), which made "reprocess the same call" a no-op by design. A REPLACED
 * recording (operator adoption, a later Twilio callback superseding the dial
 * leg) is a different transcript on the same call: its pass could not insert
 * its own decision (ON CONFLICT DO NOTHING) and then wrote its outcome into
 * the discarded recording's row — a calibration row mixing the old audio's
 * recommendation and flags with the new audio's action (Codex #3736 r7 P1).
 * The recording joins the key so every recording's decision is its own
 * immutable row; readers already take the newest enforce row per call.
 *
 * EXPAND step only (Codex #3736 r9): the old three-column constraint is
 * KEPT here because Railway runs migrations before the new instances take
 * traffic while the previous release is still live, and that release's
 * inserts name the three-column key as their ON CONFLICT target — dropping
 * it would make every route-decision insert on an old instance throw for
 * the length of the overlap. The new code inserts ON CONFLICT DO NOTHING
 * without a target, so it needs neither constraint by name. The CONTRACT
 * step — dropping the three-column constraint, which is what lets a
 * replaced recording's decision actually insert — is a follow-up migration
 * once this release has drained.
 *
 * Existing rows keep the '' legacy sentinel — "recording not recorded" —
 * deliberately NOT backfilled from the call's current recording: the
 * pre-migration webhook could replace a call's recording after its decision
 * was derived, and labelling that decision with the replacement would make
 * the replacement's own pass collide with it (the bug this fixes). A pass
 * after the migration inserts one recording-keyed row per call, then
 * no-ops on that key as before.
 */

exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('route_decisions', 'recording_sid');
  if (!has) {
    await knex.schema.alterTable('route_decisions', (t) => {
      t.string('recording_sid', 64).notNullable().defaultTo('');
    });
  }
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS route_decisions_call_version_mode_recording_uniq
      ON route_decisions (call_log_id, decision_version, mode, recording_sid)
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS route_decisions_call_version_mode_recording_uniq');
  const has = await knex.schema.hasColumn('route_decisions', 'recording_sid');
  if (has) {
    await knex.schema.alterTable('route_decisions', (t) => {
      t.dropColumn('recording_sid');
    });
  }
};
