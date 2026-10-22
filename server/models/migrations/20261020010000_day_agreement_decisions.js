/**
 * Day-only agreement shadow (GATE_DAY_AGREEMENT_SHADOW, owner 2026-10-20, PR 1 of 2).
 *
 * day_agreement_decisions holds one row per AGREEMENT MOMENT the shadow sweep
 * (services/day-agreement-shadow.js) judged in a phone call or a text thread:
 * a moment where Waves staff and the customer agreed a DAY for a visit (or a
 * move of one) but no clock time. The row says what the agent WOULD have done.
 * Nothing here books, moves or texts anyone; a week of rows is scored against
 * what staff really did (scripts/day-agreement-shadow-report.js).
 *
 *   source_kind    call | sms
 *   source_key     unique id of ONE moment: 'call:<call_log id>#<n>' or
 *                  'sms:<last 10 digits>:<id of the latest inbound text>#<n>',
 *                  n = 0, 1, ... in the order the model listed the moments.
 *                  Every judged source has an '#0' row, which is how the sweep
 *                  knows a source was judged (it is never judged twice).
 *   call_log_id    the call (call rows only); SET NULL if the call row goes
 *   phone_digits   last 10 digits of the customer's number (text rows only)
 *   customer_id    the linked customer; NULL when the source had none
 *   agreed_at      when the agreement was made (the call start, or the
 *                  timestamp of the text that completed the agreement)
 *   judged         the model's object for the moment, with the free-text
 *                  reason clipped and number-scrubbed. NULL when the sweep
 *                  skipped the source before asking the model. Never the
 *                  transcript or any text message.
 *   verdict        would_book | would_move | skip
 *   skip_reason    why a skip was a skip (set exactly when verdict = skip)
 *   target_date    the agreed day (ET date)
 *   from_visit_id  the one visit a move would move; SET NULL if the visit goes
 *   chosen_*       the first slot the time picker would take on that day
 *   model, prompt_version   which model and prompt produced the judgment
 *
 * Nothing else reads or writes this table in PR 1. down() drops it: it holds
 * only what the sweep wrote.
 */
const TABLE = 'day_agreement_decisions';
const VERDICTS = ['would_book', 'would_move', 'skip'];
const SOURCE_KINDS = ['call', 'sms'];

exports.VERDICTS = VERDICTS;
exports.SOURCE_KINDS = SOURCE_KINDS;

exports.up = async function up(knex) {
  if (await knex.schema.hasTable(TABLE)) return;
  await knex.schema.createTable(TABLE, (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('source_kind', 8).notNullable();
    t.string('source_key', 80).notNullable();
    t.uuid('call_log_id').nullable().references('id').inTable('call_log').onDelete('SET NULL');
    t.string('phone_digits', 10).nullable();
    t.uuid('customer_id').nullable().references('id').inTable('customers').onDelete('SET NULL');
    t.timestamp('agreed_at', { useTz: true }).nullable();
    t.jsonb('judged').nullable();
    t.string('verdict', 12).notNullable();
    t.string('skip_reason', 40).nullable();
    t.date('target_date').nullable();
    t.uuid('from_visit_id').nullable().references('id').inTable('scheduled_services').onDelete('SET NULL');
    t.time('chosen_window_start').nullable();
    t.uuid('chosen_technician_id').nullable().references('id').inTable('technicians').onDelete('SET NULL');
    t.string('model', 80).nullable();
    t.string('prompt_version', 40).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT day_agreement_decisions_source_kind_check
    CHECK (source_kind IN (${SOURCE_KINDS.map((v) => `'${v}'`).join(', ')}))`);
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT day_agreement_decisions_verdict_check
    CHECK (verdict IN (${VERDICTS.map((v) => `'${v}'`).join(', ')}))`);
  // A skip always says why; a would_book / would_move never carries a reason.
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT day_agreement_decisions_skip_reason_check
    CHECK ((verdict = 'skip') = (skip_reason IS NOT NULL))`);
  // One row per moment; a double tick or a second instance can never add a second.
  await knex.raw(`CREATE UNIQUE INDEX day_agreement_decisions_source_key_unique ON ${TABLE} (source_key)`);
  await knex.raw(`CREATE INDEX day_agreement_decisions_created_at_index ON ${TABLE} (created_at)`);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists(TABLE);
};
