/**
 * Runtime prompt patches for the SMS house-voice drafter (GATE_SMS_PROMPT_AUTOPROMOTE).
 *
 * Owner rulings 2026-09-27 ("the texting AI should improve with NO human approval steps") and
 * 2026-10-24 ("do all"). This replaces the older design rule of sms-pathology-ledger.js ("a
 * proposal never auto-applies"): a pathology proposal can now become a candidate patch, be
 * examined on the sealed exam, and go live without a person, then roll back by itself.
 *
 *   - sms_prompt_patches: one row per candidate rule block. The block is immutable after insert
 *     (patch_text + patch_sha); only status and the decision columns move. At most ONE row is
 *     'active' and at most ONE is 'candidate' (partial unique indexes), so the drafter appends
 *     at most one block and the loop works on one candidate at a time. patch_no is the
 *     number behind the one-letter tag (patch_no mod 26) the prompt_version identity carries:
 *     every draft stamped with a patch is cohort-distinct from every draft without it, and from
 *     the next patch (numbers are consecutive).
 *   - sms_prompt_patch_events: the audit trail. One row per step (created, exam, rejected,
 *     promoted, would_promote, rolled_back). Numbers and codes only: no message text.
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
        CHECK (status IN ('candidate', 'active', 'retired', 'rejected'))
    `);
    await knex.raw(`
      ALTER TABLE sms_prompt_patches
        ADD CONSTRAINT sms_prompt_patches_mode_check
        CHECK (mode_at_creation IN ('observe', 'true')),
        ADD CONSTRAINT sms_prompt_patches_rules_check
        CHECK (jsonb_typeof(rules) = 'array' AND patch_no >= 1)
    `);
    await knex.raw("CREATE UNIQUE INDEX sms_prompt_patches_one_active ON sms_prompt_patches ((true)) WHERE status = 'active'");
    await knex.raw("CREATE UNIQUE INDEX sms_prompt_patches_one_candidate ON sms_prompt_patches ((true)) WHERE status = 'candidate'");
  }

  if (!(await knex.schema.hasTable('sms_prompt_patch_events'))) {
    await knex.schema.createTable('sms_prompt_patch_events', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      // Insertion order: several events can share one timestamp inside a transaction.
      t.specificType('seq', 'bigint generated always as identity');
      t.uuid('patch_id').notNullable().references('id').inTable('sms_prompt_patches').onDelete('CASCADE');
      t.string('event', 24).notNullable();
      t.string('reason', 80);
      t.jsonb('detail');
      t.string('actor', 40).notNullable().defaultTo('auto');
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.index(['patch_id', 'created_at']);
      t.index(['event', 'created_at']);
    });
    await knex.raw(`
      ALTER TABLE sms_prompt_patch_events
        ADD CONSTRAINT sms_prompt_patch_events_event_check
        CHECK (event IN ('created', 'exam_started', 'exam_failed', 'rejected', 'would_promote', 'promoted', 'rolled_back', 'restored_parent'))
    `);
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
  await knex.schema.dropTableIfExists('sms_prompt_patch_events');
  await knex.schema.dropTableIfExists('sms_prompt_patches');
  await knex.raw('DROP SEQUENCE IF EXISTS sms_prompt_patch_no_seq');
};
