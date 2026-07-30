/**
 * Sealed exam runs learn which owner-approved VOICE PROFILE version drafted
 * them (Codex r2, PR #3072). The weekly distiller can swap the approved
 * profile WITHOUT a prompt-version bump, and the profile changes generation —
 * so a run must be pinned to one profile version at creation (frozen across
 * resume) and the exam gate must only accept runs recorded under the
 * CURRENTLY effective profile. NULL = drafted with no profile (none approved,
 * or SHADOW_VOICE_PROFILE=false).
 */

exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('sms_sealed_eval_runs', 'voice_profile_version');
  if (!has) {
    await knex.schema.alterTable('sms_sealed_eval_runs', (t) => {
      t.integer('voice_profile_version');
    });
  }
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasColumn('sms_sealed_eval_runs', 'voice_profile_version');
  if (has) {
    await knex.schema.alterTable('sms_sealed_eval_runs', (t) => {
      t.dropColumn('voice_profile_version');
    });
  }
};
