/**
 * Stop stale follow-up sequences for invoices that can no longer be paid.
 *
 * The runtime now stops the sequence when an invoice is voided. This backfills
 * rows created before that hook existed so admin state matches cron behavior.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('invoice_followup_sequences'))) return;
  if (!(await knex.schema.hasTable('invoices'))) return;

  await knex.raw(`
    UPDATE invoice_followup_sequences AS s
    SET
      status = 'stopped',
      stopped_reason = COALESCE(s.stopped_reason, 'invoice_terminal_status:' || i.status),
      next_touch_at = NULL,
      updated_at = CURRENT_TIMESTAMP
    FROM invoices AS i
    WHERE i.id = s.invoice_id
      AND s.status IN ('active', 'paused', 'autopay_hold')
      AND i.status IN ('void', 'refunded', 'canceled', 'cancelled')
  `);
};

exports.down = async function down() {
  // Intentionally no-op: restoring reminder sequences for terminal invoices
  // would risk customer-facing billing messages for non-payable invoices.
};
