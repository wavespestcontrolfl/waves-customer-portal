/**
 * The one-letter prompt_version tag of a prompt patch (GATE_SMS_PROMPT_AUTOPROMOTE).
 *
 * The first migration (20261024220000) derived the tag from patch_no mod 26, so patch 1 and
 * patch 27 would have stamped the same prompt_version and shared graduation and exam evidence
 * (Codex round 1). The tag is now a stored column, handed out once per base prompt identity:
 * UNIQUE (base_version, version_tag) means no two patches on one base ever share a version
 * string. Only rows that can become live (candidate, active, retired, or a rejected candidate
 * that was examined) carry a tag; a rule the guards refused at creation never gets one.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('sms_prompt_patches', 'version_tag'))) {
    await knex.raw('ALTER TABLE sms_prompt_patches ADD COLUMN version_tag char(1)');
    // Rows from the mod-26 scheme (only ever test or preview rows): keep their old tag.
    await knex.raw(`
      UPDATE sms_prompt_patches
         SET version_tag = chr(65 + ((patch_no - 1) % 26))
       WHERE version_tag IS NULL AND status IN ('candidate', 'active', 'retired')
    `);
    await knex.raw(`
      ALTER TABLE sms_prompt_patches
        ADD CONSTRAINT sms_prompt_patches_version_tag_check
        CHECK (
          (version_tag IS NULL OR version_tag ~ '^[A-Z]$')
          AND (version_tag IS NOT NULL OR status = 'rejected')
        )
    `);
    await knex.raw('CREATE UNIQUE INDEX sms_prompt_patches_base_tag ON sms_prompt_patches (base_version, version_tag)');
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('sms_prompt_patches', 'version_tag')) {
    await knex.raw('DROP INDEX IF EXISTS sms_prompt_patches_base_tag');
    await knex.raw('ALTER TABLE sms_prompt_patches DROP CONSTRAINT IF EXISTS sms_prompt_patches_version_tag_check');
    await knex.raw('ALTER TABLE sms_prompt_patches DROP COLUMN version_tag');
  }
};
