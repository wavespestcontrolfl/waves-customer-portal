/**
 * payment_plans lifecycle stamps. Plans were record-only (status never left
 * 'active'), yet an active row blocks invoice edits / credit reversal / auto
 * credit. Add the columns the cancel route and the paid-invoice auto-complete
 * hook write so the transition is auditable.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('payment_plans'))) return;
  await knex.schema.alterTable('payment_plans', (t) => {
    t.timestamp('completed_at');
    t.timestamp('cancelled_at');
    t.string('cancelled_by', 200);
  });
  // Backfill: plans never transitioned before these columns existed, so an
  // invoice that already settled still carries an 'active' plan that blocks
  // edits / credit reversal / auto-credit. Complete those historical rows.
  if (await knex.schema.hasTable('invoices')) {
    await knex.raw(`
      UPDATE payment_plans pp
         SET status = 'completed',
             completed_at = NOW(),
             updated_at = NOW()
        FROM invoices i
       WHERE pp.invoice_id = i.id
         AND pp.status = 'active'
         AND i.status IN ('paid', 'prepaid')
      `);
    // Mirror completeActivePlansForInvoice for the historical rows too: plan
    // creation left the invoice's follow-up sequence 'stopped' with a
    // payment_plan_created:<id> stamp and stopOnPayment skips stopped rows,
    // so a settled invoice still reads isDunningStopped() = true. If a later
    // dispute reopens it, every reminder path stays suppressed forever.
    // Flip those plan-owned stops to 'completed' alongside the plans.
    // 'paused' rows are covered too: the pre-change plan-creation route
    // called pauseSequence(reason: 'payment_plan_created') after its
    // transactional stop, so historical plan-owned rows can sit paused
    // (the stopped_reason stamp survives the pause) — a stale paused row
    // reads as ACTIVE to hasActiveSequence and suppresses every reminder
    // just the same.
    if (await knex.schema.hasTable('invoice_followup_sequences')) {
      await knex.raw(`
        UPDATE invoice_followup_sequences s
           SET status = 'completed',
               next_touch_at = NULL,
               updated_at = NOW()
          FROM invoices i
         WHERE s.invoice_id = i.id
           AND s.status IN ('stopped', 'paused')
           AND s.stopped_reason LIKE 'payment_plan_created:%'
           AND i.status IN ('paid', 'prepaid')
      `);
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('payment_plans'))) return;
  await knex.schema.alterTable('payment_plans', (t) => {
    t.dropColumn('completed_at');
    t.dropColumn('cancelled_at');
    t.dropColumn('cancelled_by');
  });
};
