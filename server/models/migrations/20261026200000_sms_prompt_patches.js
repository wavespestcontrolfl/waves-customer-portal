/**
 * Prompt patches for the SMS house-voice drafter (GATE_SMS_PROMPT_AUTOPROMOTE).
 *
 * Owner rulings 2026-09-27 ("the texting AI should improve with NO human approval steps") and
 * 2026-10-24 ("do all"). A patch is one block of learned reply rules the real-answers drafter
 * appends to its prompt. This migration stores the patches and marks the sealed-exam runs that
 * drafted with a candidate block. The loop that writes, examines, activates and retires patches
 * fills the decision columns.
 *
 *   - sms_prompt_patches: one row per rule block. The block is immutable after insert
 *     (patch_text + patch_sha); only status and the decision columns move. At most ONE row is
 *     'active' and at most ONE is 'candidate' (partial unique indexes), so the drafter appends
 *     at most one block. version_tag is the one uppercase letter a patched prompt_version
 *     carries, handed out once per base prompt identity (UNIQUE (base_version, version_tag)):
 *     no two patches on one base share a version string, so their drafts never share
 *     graduation or exam evidence. A rule the guards refused never gets a tag (status 'rejected').
 *   - sms_sealed_eval_runs.prompt_patch_id: marks an EXAM-ONLY run that drafted with a candidate
 *     block applied. The live drafter never sees a candidate; the exam path passes it in.
 */

exports.up = async function up(knex) {
  await knex.raw('CREATE SEQUENCE IF NOT EXISTS sms_prompt_patch_no_seq');

  if (!(await knex.schema.hasTable('sms_prompt_patches'))) {
    await knex.schema.createTable('sms_prompt_patches', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.integer('patch_no').notNullable().unique().defaultTo(knex.raw("nextval('sms_prompt_patch_no_seq')"));
      t.uuid('source_proposal_id').unique().references('id').inTable('sms_patch_proposals').onDelete('SET NULL');
      t.uuid('parent_patch_id').references('id').inTable('sms_prompt_patches').onDelete('SET NULL');
      t.string('surface', 40);
      t.string('failure_mode', 60);
      // The rules in the block, oldest first (a stacked patch carries its parent's rules).
      t.jsonb('rules').notNullable();
      t.text('patch_text').notNullable();
      t.string('patch_sha', 64).notNullable();
      // The live prompt identity (no patch tag) this block was built and examined against.
      t.string('base_version', 40).notNullable();
      t.specificType('version_tag', 'char(1)');
      t.string('status', 12).notNullable().defaultTo('candidate');
      t.string('mode_at_creation', 10).notNullable();
      t.string('exam_leg', 20);
      t.integer('exam_attempts').notNullable().defaultTo(0);
      t.uuid('exam_run_id').references('id').inTable('sms_sealed_eval_runs').onDelete('SET NULL');
      t.uuid('baseline_run_id').references('id').inTable('sms_sealed_eval_runs').onDelete('SET NULL');
      t.timestamp('decided_at');
      // observe mode: the exam rule said promote, nothing was activated.
      t.boolean('would_promote');
      t.string('decision_reason', 80);
      t.jsonb('decision_detail');
      // The prompt version that was live before activation (the rollback comparison group) and
      // the one the patched drafts stamp (the group the monitor reads).
      t.string('prior_version', 40);
      t.string('active_version', 40);
      t.timestamp('activated_at');
      t.timestamp('retired_at');
      t.string('retired_reason', 80);
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
      t.index(['status']);
    });
    await knex.raw(`
      ALTER TABLE sms_prompt_patches
        ADD CONSTRAINT sms_prompt_patches_status_check
        CHECK (status IN ('candidate', 'active', 'retired', 'rejected')),
        ADD CONSTRAINT sms_prompt_patches_mode_check
        CHECK (mode_at_creation IN ('observe', 'true')),
        ADD CONSTRAINT sms_prompt_patches_rules_check
        CHECK (jsonb_typeof(rules) = 'array' AND patch_no >= 1),
        ADD CONSTRAINT sms_prompt_patches_version_tag_check
        CHECK (
          (version_tag IS NULL OR version_tag ~ '^[A-Z]$')
          AND (version_tag IS NOT NULL OR status = 'rejected')
        )
    `);
    await knex.raw("CREATE UNIQUE INDEX sms_prompt_patches_one_active ON sms_prompt_patches ((true)) WHERE status = 'active'");
    await knex.raw("CREATE UNIQUE INDEX sms_prompt_patches_one_candidate ON sms_prompt_patches ((true)) WHERE status = 'candidate'");
    await knex.raw('CREATE UNIQUE INDEX sms_prompt_patches_base_tag ON sms_prompt_patches (base_version, version_tag)');
  }

  if (!(await knex.schema.hasColumn('sms_sealed_eval_runs', 'prompt_patch_id'))) {
    await knex.schema.alterTable('sms_sealed_eval_runs', (t) => {
      t.uuid('prompt_patch_id').references('id').inTable('sms_prompt_patches').onDelete('SET NULL');
      t.index(['prompt_patch_id']);
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('sms_sealed_eval_runs', 'prompt_patch_id')) {
    await knex.schema.alterTable('sms_sealed_eval_runs', (t) => {
      t.dropColumn('prompt_patch_id');
    });
  }
  await knex.schema.dropTableIfExists('sms_prompt_patches');
  await knex.raw('DROP SEQUENCE IF EXISTS sms_prompt_patch_no_seq');
};
