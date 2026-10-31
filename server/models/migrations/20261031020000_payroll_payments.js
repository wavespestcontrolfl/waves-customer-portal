/**
 * Payroll Mercury paychecks (owner plan A, 2026-10-30): the payment record for a
 * bank-transfer paycheck. Dark behind GATE_PAYROLL_MERCURY_STATUS and
 * GATE_PAYROLL_MERCURY_PAY; additive.
 *
 * technicians.mercury_recipient_id: Mercury's id for the technician as a payee, typed by
 * the owner after he adds the technician in Mercury from the signed direct-deposit form.
 * No account number and no routing number is ever stored here.
 *
 * payroll_payments: one row per attempt to pay one finalized paycheck. payroll_checks stay
 * immutable (their trigger is untouched): every payment fact lives only here.
 *   queued     row written, request not sent yet (written and committed BEFORE the request)
 *   requested  Mercury holds an approval request
 *   unknown    the request may or may not have reached Mercury: never sent again by code
 *   approved   approved in Mercury, money not out yet
 *   sent       money left the account
 *   failed / rejected / cancelled / returned   closed, a new attempt is allowed
 *   paper      paid by paper check instead
 * A check has at most one row in an open or paid state (partial unique index), so a double
 * click or two concurrent sends make one row. `unknown` counts as open.
 */
exports.up = async function up(knex) {
  await knex.raw(`ALTER TABLE technicians
    ADD COLUMN mercury_recipient_id text NULL`);
  await knex.raw(`ALTER TABLE technicians
    ADD CONSTRAINT technicians_mercury_recipient_check CHECK (mercury_recipient_id IS NULL OR char_length(mercury_recipient_id) BETWEEN 1 AND 64)`);
  await knex.raw('CREATE UNIQUE INDEX technicians_mercury_recipient_unique ON technicians (mercury_recipient_id) WHERE mercury_recipient_id IS NOT NULL');

  await knex.schema.createTable('payroll_payments', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('check_id').notNullable().references('id').inTable('payroll_checks').onDelete('RESTRICT');
    t.integer('attempt').notNullable();
    t.text('state').notNullable();
    t.text('idempotency_key').nullable();
    t.text('note').nullable();
    t.text('mercury_request_id').nullable();
    t.text('mercury_transaction_id').nullable();
    t.bigInteger('amount_cents').notNullable();
    t.text('recipient_id').nullable();
    t.text('account_id').nullable();
    t.date('posted_on').nullable();
    t.text('check_number').nullable();
    t.text('error').nullable();
    t.uuid('created_by').nullable().references('id').inTable('technicians');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('last_polled_at', { useTz: true }).nullable();
    t.timestamp('resolved_at', { useTz: true }).nullable();
    t.text('resolution').nullable();
    t.index(['check_id'], 'payroll_payments_check_idx');
  });
  await knex.raw(`ALTER TABLE payroll_payments
    ADD CONSTRAINT payroll_payments_state_check CHECK (state IN
      ('queued', 'requested', 'unknown', 'approved', 'sent', 'failed', 'rejected', 'cancelled', 'returned', 'paper')),
    ADD CONSTRAINT payroll_payments_amount_check CHECK (amount_cents > 0),
    ADD CONSTRAINT payroll_payments_attempt_check CHECK (attempt >= 1),
    ADD CONSTRAINT payroll_payments_paper_check CHECK (
      (state = 'paper') = (check_number IS NOT NULL)
      AND (state <> 'paper' OR char_length(check_number) BETWEEN 1 AND 30)),
    ADD CONSTRAINT payroll_payments_mercury_check CHECK (
      state = 'paper' OR (idempotency_key IS NOT NULL AND note IS NOT NULL AND recipient_id IS NOT NULL AND account_id IS NOT NULL))`);
  await knex.raw('CREATE UNIQUE INDEX payroll_payments_attempt_unique ON payroll_payments (check_id, attempt)');
  await knex.raw('CREATE UNIQUE INDEX payroll_payments_idempotency_unique ON payroll_payments (idempotency_key) WHERE idempotency_key IS NOT NULL');
  await knex.raw('CREATE UNIQUE INDEX payroll_payments_request_unique ON payroll_payments (mercury_request_id) WHERE mercury_request_id IS NOT NULL');
  await knex.raw(`CREATE UNIQUE INDEX payroll_payments_one_open_per_check ON payroll_payments (check_id)
    WHERE state IN ('queued', 'requested', 'unknown', 'approved', 'sent', 'paper')`);
  await knex.raw(`CREATE INDEX payroll_payments_poll_idx ON payroll_payments (state, last_polled_at)
    WHERE state IN ('queued', 'requested', 'unknown', 'approved', 'sent')`);
};

exports.down = async function down(knex) {
  // A payment row is payroll evidence: preserve it and roll forward.
  if (await knex.schema.hasTable('payroll_payments') && await knex('payroll_payments').first('id')) {
    throw new Error('payroll_payments holds payment evidence. Preserve the schema and roll forward; do not delete it.');
  }
  await knex.schema.dropTableIfExists('payroll_payments');
  if (await knex.schema.hasColumn('technicians', 'mercury_recipient_id')
    && await knex('technicians').whereNotNull('mercury_recipient_id').first('id')) {
    throw new Error('technicians holds Mercury recipient ids. Preserve the schema and roll forward; do not delete it.');
  }
  await knex.raw('DROP INDEX IF EXISTS technicians_mercury_recipient_unique');
  await knex.raw('ALTER TABLE technicians DROP CONSTRAINT IF EXISTS technicians_mercury_recipient_check');
  await knex.raw('ALTER TABLE technicians DROP COLUMN IF EXISTS mercury_recipient_id');
};
