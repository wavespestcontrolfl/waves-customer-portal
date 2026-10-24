/**
 * shadow_draft_judgments: judge_version + could_send (GATE_SMS_JUDGE_V2, owner 2026-10-24).
 *
 * judge_version: 'j2' when the stricter judge graded the row; NULL = the old judge (no backfill, so the
 * two rulers never mix: the autonomy safety backstop counts only 'j2' rows while the gate is on).
 * could_send: the owner's question, "could the person who replied have sent the AI draft instead?":
 * yes | yes_with_edit | no. NULL for the old judge and for unscored rows.
 * Both columns are nullable with no default, so the add is metadata-only and every existing reader
 * (all select named columns) is unaffected. Measurement only: nothing here sends or holds a message.
 */
const TABLE = 'shadow_draft_judgments';
const CHECK = 'shadow_draft_judgments_could_send_check';

exports.up = async function up(knex) {
  await knex.schema.alterTable(TABLE, (t) => {
    t.string('judge_version', 8);
    t.string('could_send', 16);
  });
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${CHECK} CHECK (could_send IN ('yes', 'yes_with_edit', 'no') OR could_send IS NULL)`);
};

exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${CHECK}`);
  await knex.schema.alterTable(TABLE, (t) => {
    t.dropColumn('could_send');
    t.dropColumn('judge_version');
  });
};
