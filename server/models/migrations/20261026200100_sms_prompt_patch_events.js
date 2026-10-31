/**
 * Audit trail of the SMS prompt auto-promote loop (GATE_SMS_PROMPT_AUTOPROMOTE).
 *
 * Owner rulings 2026-09-27 ("the texting AI should improve with NO human approval steps") and
 * 2026-10-24 ("do all"). One row per step the loop takes on a sms_prompt_patches row: created,
 * exam_started, exam_failed, rejected, would_promote, and the activation steps promoted,
 * rolled_back and restored_parent. Numbers and codes only: no message text.
 */

exports.up = async function up(knex) {
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
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('sms_prompt_patch_events');
};
