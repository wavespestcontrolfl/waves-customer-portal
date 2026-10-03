/**
 * Report text to on-location contacts (GATE_CONTACT_REPORT_TEXT, owner
 * 2026-10-03). When the account holder's visit-complete text goes out, each
 * confirmed on-location contact gets this plain text with the report link:
 * no pay link, no review ask (services/contact-report-text.js).
 *
 * The wording is owner-approved. The row is active: the gate is the switch.
 * Deactivating the row also stops the text.
 */

const TEMPLATE = {
  template_key: 'contact_report_ready',
  name: 'Service Report Ready (On-location Contact)',
  category: 'service-reports',
  // GSM-7 only; "Waves Pest Control" named; no STOP line on a transactional
  // text (docs/sms-stop-line-policy.md).
  body: 'Waves Pest Control: The service report for {street_address} is ready: {report_url}',
  description: 'Sent to each confirmed on-location contact when the account holder\'s visit-complete text goes out (GATE_CONTACT_REPORT_TEXT). Report link only: no pay link, no review ask.',
  variables: ['street_address', 'report_url'],
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const existing = await knex('sms_templates').where({ template_key: TEMPLATE.template_key }).first('id');
  if (existing) return;
  await knex('sms_templates').insert({
    template_key: TEMPLATE.template_key,
    name: TEMPLATE.name,
    category: TEMPLATE.category,
    body: TEMPLATE.body,
    description: TEMPLATE.description,
    variables: JSON.stringify(TEMPLATE.variables),
    sort_order: 9,
    is_active: true,
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await knex('sms_templates').where({ template_key: TEMPLATE.template_key }).del();
};

exports.TEMPLATE = TEMPLATE;
