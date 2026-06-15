const { TEMPLATES } = require('./20260514000002_tighten_sms_template_copy');

const TEMPLATE_KEYS = [
  'manual_payment_receipt',
  'balance_reminder_gentle',
  'balance_reminder_firm',
  'balance_reminder_urgent',
  'balance_payment_received',
  'ach_retry_notice',
  'ach_card_fallback',
  'ach_suspended',
  'bank_verification_incomplete',
  'bank_verification_failed',
  'estimate_sent',
  'estimate_followup_unviewed',
  'estimate_accepted_onetime',
  'estimate_extended',
  'referral_enrollment',
  'referral_invite',
  'referral_reward',
  'referral_milestone',
  'upsell_interest_confirmation',
  'upsell_tier_upgrade',
  'upsell_add_service',
  'cancellation_save_step1_price',
  'cancellation_save_step1_moving',
  'cancellation_save_step1_quality',
  'cancellation_save_step1_default',
  'cancellation_save_step2_price',
  'cancellation_save_step2_moving',
  'cancellation_save_step2_quality',
  'cancellation_save_step2_default',
  'cancellation_save_step3',
  'cancellation_save_accepted_offer',
  'cancellation_save_callback_requested',
  'cancellation_save_cancelled',
  'review_request',
  'service_complete',
  'service_complete_with_invoice',
  'service_complete_prepaid',
  'service_complete_concise',
  'appointment_series_rescheduled',
  'service_report_v1',
  'service_report_v1_with_invoice',
  'project_report_ready',
  'service_request_confirmation',
  'lawn_health_report_ready',
];

function rowForTemplate(cols, template, now) {
  const row = {
    template_key: template.template_key,
    name: template.name,
    category: template.category,
    body: template.body,
    variables: JSON.stringify(template.variables || []),
    sort_order: template.sort_order || 0,
  };

  if (cols.is_active) row.is_active = template.is_active !== undefined ? template.is_active : true;
  if (cols.is_internal) row.is_internal = template.is_internal !== undefined ? template.is_internal : false;
  if (cols.updated_at) row.updated_at = now;

  return row;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  const cols = await knex('sms_templates').columnInfo();
  const now = new Date();
  const selected = TEMPLATES.filter((template) => TEMPLATE_KEYS.includes(template.template_key));

  for (const template of selected) {
    const row = rowForTemplate(cols, template, now);
    const existing = await knex('sms_templates')
      .where({ template_key: template.template_key })
      .first();

    if (existing) {
      await knex('sms_templates')
        .where({ template_key: template.template_key })
        .update(row);
      continue;
    }

    await knex('sms_templates').insert({
      ...row,
      ...(cols.created_at ? { created_at: now } : {}),
    });
  }
};

exports.down = async function down() {
  // Template-copy migration. Rollback is intentionally a no-op.
};
