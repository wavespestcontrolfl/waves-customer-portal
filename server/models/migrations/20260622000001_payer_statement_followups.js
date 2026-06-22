/**
 * Third-party Payer Phase 2 — P4 (AR + dunning).
 *
 * `payer_statement_followups`: one dunning sequence per statement, the
 * statement-level mirror of `invoice_followup_sequences`. When an unpaid
 * statement passes its `due_date`, a terms-aware reminder chain (due+0 / +15 /
 * +30) fires to the payer's AP inbox — NEVER the homeowner. The row tracks which
 * step fires next and admin pause/stop overrides; the cron (`runPending`) drives
 * eligibility off the statement's own status + due_date.
 *
 * Keyed on `statement_id` (UNIQUE — at most one sequence per statement) with an
 * ON DELETE RESTRICT FK, mirroring `invoices.payer_statement_id`: a statement is
 * never hard-deleted (voided instead), so RESTRICT just blocks a raw delete of a
 * statement that still has a dunning history.
 *
 * Schema only; behaviour is gated behind GATE_PAYER_STATEMENTS.
 * Design: docs/design/payer-net-statements-plan.md (Dunning + AR/aging).
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('payer_statement_followups')) return;

  await knex.schema.createTable('payer_statement_followups', (t) => {
    t.bigIncrements('id').primary();
    // RESTRICT (not SET NULL/CASCADE): the sequence is meaningless without its
    // statement, and statements are voided, never hard-deleted (no DELETE route).
    t.bigInteger('statement_id').notNullable().unique()
      .references('id').inTable('payer_statements').onDelete('RESTRICT');
    // Denormalized for AR filtering / audit (the statement carries the canonical link).
    t.integer('payer_id').references('id').inTable('payers').onDelete('SET NULL');

    // active → completed (chain exhausted or statement settled) | paused | stopped.
    t.string('status', 20).notNullable().defaultTo('active');
    t.integer('step_index').notNullable().defaultTo(0);
    t.integer('touches_sent').notNullable().defaultTo(0);

    t.timestamp('next_touch_at');
    t.timestamp('last_touch_at');

    // Admin overrides (mirror invoice_followup_sequences).
    t.text('paused_reason');
    t.timestamp('paused_until');
    t.integer('paused_by_admin_id');
    t.text('stopped_reason');
    t.integer('stopped_by_admin_id');

    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());

    t.index(['status', 'next_touch_at'], 'payer_statement_followups_due_idx');
    t.index(['payer_id'], 'payer_statement_followups_payer_idx');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('payer_statement_followups');
};
