/**
 * Stop stale follow-up sequences for paid invoices.
 *
 * The earlier terminal cleanup migration may already have run in production,
 * so paid invoices need their own migration instead of editing that file.
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
      AND i.status = 'paid'
  `);
};

exports.down = async function down() {
  // Intentionally no-op: restoring reminder sequences for paid invoices would
  // risk customer-facing billing messages for invoices that are no longer due.
};
