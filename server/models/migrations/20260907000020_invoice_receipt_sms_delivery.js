// Invoice-specific proof of a texted receipt, separate from the existing
// receipt_sent_at stamp (which also covers email). Historical evidence must
// name this invoice; a shared service_record_id cannot identify its receipt.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('invoices'))) return;
  if (!(await knex.schema.hasColumn('invoices', 'receipt_sms_sent_at'))) {
    await knex.schema.alterTable('invoices', (table) => {
      table.timestamp('receipt_sms_sent_at', { useTz: true }).nullable();
    });
  }
  if (!(await knex.schema.hasTable('messaging_audit_log'))) return;

  // The queued completion's exact invoice reference lives on its sms_log
  // claim. The audit must prove that replay actually reached Twilio; merely
  // scheduling it, emailing it, push delivery and kill-switch sentinels do
  // not qualify. Unknown historical linkage remains unavailable to re-share.
  await knex.raw(`
    WITH texted AS (
      SELECT i.id, MIN(a.sent_at) AS sent_at
      FROM invoices i
      JOIN messaging_audit_log a ON a.customer_id = i.customer_id
      LEFT JOIN sms_log s ON a.metadata->>'scheduled_sms_log_id' = s.id::text
        AND s.customer_id = i.customer_id
      WHERE i.payer_id IS NULL
        AND a.channel = 'sms' AND a.provider = 'twilio' AND a.blocked_code IS NULL
        AND a.sent_at IS NOT NULL
        AND a.provider_message_id ~* '^(SM|MM)[a-f0-9]{32}$'
        AND (
          (a.purpose = 'payment_receipt' AND a.metadata->>'original_message_type' = 'receipt'
            AND a.invoice_id = i.id::text)
          OR (a.purpose = 'appointment'
            AND a.metadata->>'original_message_type' = 'service_complete_paid_receipt'
            AND COALESCE(NULLIF(a.invoice_id, ''), NULLIF(a.metadata->>'invoice_id', ''),
              CASE WHEN s.message_type = 'service_complete_paid_receipt'
                THEN s.metadata->>'stamp_receipt_invoice_id' END) = i.id::text)
        )
      GROUP BY i.id
    )
    UPDATE invoices i SET receipt_sms_sent_at = texted.sent_at
    FROM texted WHERE texted.id = i.id AND i.receipt_sms_sent_at IS NULL
  `);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('invoices'))) return;
  if (await knex.schema.hasColumn('invoices', 'receipt_sms_sent_at')) {
    await knex.schema.alterTable('invoices', (table) => table.dropColumn('receipt_sms_sent_at'));
  }
};
