/**
 * SMS pathology ledger — a running (harness surface × failure mode) record
 * of WHY drafts fail, plus parked patch proposals.
 *
 *   - sms_pathology_entries: one row per classified piece of evidence
 *     (draft_unsafe judgments — corrected suggestions flow in through the
 *     same judgments table since #2612). UNIQUE(evidence_type, evidence_id)
 *     keeps the nightly classifier idempotent.
 *   - sms_patch_proposals: model-written harness-patch proposals per
 *     pathology cell. ALWAYS parked (status='pending') — a prompt change is
 *     a PROMPT_VERSION bump shipped by a human; nothing here auto-applies.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_pathology_entries'))) {
    await knex.schema.createTable('sms_pathology_entries', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('evidence_type', 30).notNullable().defaultTo('judgment');
      t.uuid('evidence_id').notNullable();
      t.string('surface', 40).notNullable();
      t.string('failure_mode', 60).notNullable();
      t.string('intent', 50);
      t.string('prompt_version', 40);
      // Deterministic telemetry: the draft's verify loop signed off
      // (converged) and the judge still flagged it — a verifier miss,
      // regardless of which surface the classifier picks.
      t.boolean('verifier_missed').notNullable().defaultTo(false);
      t.text('summary');
      t.string('model', 80);
      t.string('schema_version', 40).notNullable().defaultTo('sms-pathology.v1');
      t.timestamp('classified_at').notNullable().defaultTo(knex.fn.now());
      t.unique(['evidence_type', 'evidence_id']);
      t.index(['surface', 'failure_mode']);
      t.index('prompt_version');
    });
  }

  if (!(await knex.schema.hasTable('sms_patch_proposals'))) {
    await knex.schema.createTable('sms_patch_proposals', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('surface', 40).notNullable();
      t.string('failure_mode', 60).notNullable();
      t.integer('evidence_count').notNullable().defaultTo(0);
      t.jsonb('evidence_ids');
      // The exact instant this proposal's evidence window CLOSED — the next
      // run measures freshness against this, not created_at, so entries
      // classified while the proposer's LLM call ran are never skipped.
      t.timestamp('evidence_cutoff_at');
      t.text('proposal').notNullable();
      t.string('status', 20).notNullable().defaultTo('pending');
      t.string('reviewed_by', 100);
      t.timestamp('reviewed_at');
      t.string('model', 80);
      t.string('schema_version', 40).notNullable().defaultTo('sms-pathology.v1');
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.index(['status']);
      t.index(['surface', 'failure_mode']);
    });
    await knex.raw(`
      ALTER TABLE sms_patch_proposals
        ADD CONSTRAINT sms_patch_proposals_status_check
        CHECK (status IN ('pending', 'accepted', 'dismissed', 'superseded'))
    `);
    // One reviewable card per cell: the proposer supersedes-then-inserts in a
    // single transaction, and this index makes two concurrent pendings for
    // the same cell impossible even if a second proposer slipped the lock.
    await knex.raw(`
      CREATE UNIQUE INDEX sms_patch_proposals_one_pending
        ON sms_patch_proposals (surface, failure_mode)
        WHERE status = 'pending'
    `);
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('sms_patch_proposals')) {
    await knex.schema.dropTable('sms_patch_proposals');
  }
  if (await knex.schema.hasTable('sms_pathology_entries')) {
    await knex.schema.dropTable('sms_pathology_entries');
  }
};
