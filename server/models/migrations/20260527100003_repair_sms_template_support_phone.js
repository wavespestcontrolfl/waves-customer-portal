const SUPPORT_PHONE = '(941) 297-5749';
const LOCATION_PHONE = '(941) 318-7612';

const PHONE_TEMPLATE_KEYS = [
  'billing_reminder',
  'autopay_charge_failed',
  'autopay_retry_failed',
  'autopay_retry_final_failed',
  'referral_invite',
  'seasonal_alert',
  'estimate_auto_renewed',
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  const cols = await knex('sms_templates').columnInfo();
  const now = new Date();

  for (const templateKey of PHONE_TEMPLATE_KEYS) {
    const template = await knex('sms_templates')
      .where({ template_key: templateKey })
      .first();

    if (!template?.body || !template.body.includes(LOCATION_PHONE)) continue;

    const update = {
      body: template.body.split(LOCATION_PHONE).join(SUPPORT_PHONE),
    };
    if (cols.updated_at) update.updated_at = now;

    await knex('sms_templates')
      .where({ template_key: templateKey })
      .update(update);
  }

  const estimateExtended = await knex('sms_templates')
    .where({ template_key: 'estimate_extended' })
    .first();

  if (estimateExtended) {
    const variables = Array.isArray(estimateExtended.variables)
      ? estimateExtended.variables
      : JSON.parse(estimateExtended.variables || '[]');
    const cleanedVariables = variables.filter((variable) => variable !== 'days_added');

    if (cleanedVariables.length !== variables.length) {
      const update = {
        variables: JSON.stringify(cleanedVariables),
      };
      if (cols.updated_at) update.updated_at = now;

      await knex('sms_templates')
        .where({ template_key: 'estimate_extended' })
        .update(update);
    }
  }
};

exports.down = async function down() {
  // Copy cleanup only. Do not reintroduce the old customer-support phone.
};
