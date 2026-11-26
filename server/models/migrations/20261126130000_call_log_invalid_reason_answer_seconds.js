/**
 * One count of bad inbound calls per lead source (owner 2026-11-26, "ok build").
 *
 *   call_log.invalid_reason  why the call was not a real prospect: spam,
 *                            wrong_number, solicitor, out_of_area,
 *                            service_not_offered or silent. NULL = not judged
 *                            invalid. Stamped by services/call-invalid-reason.js
 *                            from the signals the pipeline already writes.
 *   call_log.answer_seconds  seconds from the inbound call's start to a person
 *                            accepting it (the press-1 accept). NULL = nobody
 *                            accepted, or the call predates this column.
 *
 * Additive and idempotent: each column and the CHECK are guarded, so a re-run
 * (or a partial earlier run) is a no-op. Both columns are nullable with no
 * default, so no existing row or reader changes.
 */
const CHECK_NAME = 'call_log_invalid_reason_check';
const REASONS = ['spam', 'wrong_number', 'solicitor', 'out_of_area', 'service_not_offered', 'silent'];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('call_log'))) return;
  if (!(await knex.schema.hasColumn('call_log', 'invalid_reason'))) {
    await knex.schema.alterTable('call_log', (t) => {
      t.text('invalid_reason');
    });
  }
  if (!(await knex.schema.hasColumn('call_log', 'answer_seconds'))) {
    await knex.schema.alterTable('call_log', (t) => {
      t.integer('answer_seconds');
    });
  }
  const list = REASONS.map((r) => `'${r}'`).join(', ');
  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${CHECK_NAME}' AND conrelid = 'call_log'::regclass) THEN
        ALTER TABLE call_log ADD CONSTRAINT ${CHECK_NAME} CHECK (invalid_reason IS NULL OR invalid_reason IN (${list})) NOT VALID;
      END IF;
    END $$;
  `);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('call_log'))) return;
  await knex.raw(`ALTER TABLE call_log DROP CONSTRAINT IF EXISTS ${CHECK_NAME}`);
  if (await knex.schema.hasColumn('call_log', 'answer_seconds')) {
    await knex.schema.alterTable('call_log', (t) => {
      t.dropColumn('answer_seconds');
    });
  }
  if (await knex.schema.hasColumn('call_log', 'invalid_reason')) {
    await knex.schema.alterTable('call_log', (t) => {
      t.dropColumn('invalid_reason');
    });
  }
};
