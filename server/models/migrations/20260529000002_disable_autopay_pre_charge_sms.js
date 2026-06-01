const AUTOPAY_SMS_TEMPLATE_KEYS = [
  'autopay_pre_charge',
  'autopay_charge_success',
  'autopay_charge_failed',
  'autopay_retry_success',
  'autopay_retry_failed',
  'autopay_retry_final_failed',
  'autopay_card_expired',
  'autopay_card_expiring',
  'payment_method_expiry',
];

exports.up = async function(knex) {
  const exists = await knex.schema.hasTable('sms_templates');
  if (!exists) return;

  await knex('sms_templates')
    .whereIn('template_key', AUTOPAY_SMS_TEMPLATE_KEYS)
    .update({ is_active: false });
};

exports.down = async function(knex) {
  const exists = await knex.schema.hasTable('sms_templates');
  if (!exists) return;

  await knex('sms_templates')
    .whereIn('template_key', AUTOPAY_SMS_TEMPLATE_KEYS)
    .update({ is_active: true });
};
