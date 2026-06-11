// A failed autopay attempt whose retry later collected is "superseded":
// the money came in on the retry's own paid row, so the failed row must
// stop counting as an outstanding balance (billing-v2 /balance, AI
// outstanding-balance tools) without being falsified to status='paid'
// (which double-counted revenue — one Stripe charge, two paid rows).
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('payments'))) return;

  const hasColumn = await knex.schema.hasColumn('payments', 'superseded_by_payment_id');
  if (!hasColumn) {
    await knex.schema.alterTable('payments', (t) => {
      t.uuid('superseded_by_payment_id').nullable()
        .references('id').inTable('payments').onDelete('SET NULL');
    });
  }

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_payments_superseded_by
      ON payments (superseded_by_payment_id)
      WHERE superseded_by_payment_id IS NOT NULL
  `);

  // Backfill: the old retry path flipped the ORIGINAL failed row to
  // status='paid' (metadata.retried_at + metadata.retry_payment_id) on
  // retry success, leaving two 'paid' rows per collected charge. Restore
  // those originals to their truthful failed/superseded state so revenue
  // sums stop double-counting them. Only rows whose referenced retry
  // payment exists and actually collected are touched.
  await knex.raw(`
    UPDATE payments p
    SET superseded_by_payment_id = r.id,
        status = 'failed'
    FROM payments r
    WHERE p.status = 'paid'
      AND p.superseded_by_payment_id IS NULL
      AND p.metadata->>'retried_at' IS NOT NULL
      AND p.metadata->>'retry_payment_id' IS NOT NULL
      AND r.id::text = p.metadata->>'retry_payment_id'
      AND r.id <> p.id
      AND r.status = 'paid'
  `);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('payments'))) return;
  const hasColumn = await knex.schema.hasColumn('payments', 'superseded_by_payment_id');
  if (hasColumn) {
    await knex.schema.alterTable('payments', (t) => {
      t.dropColumn('superseded_by_payment_id');
    });
  }
};
