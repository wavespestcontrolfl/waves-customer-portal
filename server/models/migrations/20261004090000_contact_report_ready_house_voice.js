/**
 * contact_report_ready in the house voice (owner 2026-10-04: "just use
 * Waves, and keep on brand"). Same shape as the account holder's
 * service_report_v1 text: "Hello {first_name}!", "Waves", the report link,
 * and the standard closing line. {first_name} is the CONTACT's first name.
 *
 * Only the seeded wording is replaced: a body an admin has edited since
 * 20261003150000 is left as it is.
 */

const TEMPLATE_KEY = 'contact_report_ready';
const SEEDED_BODY = 'Waves Pest Control: The service report for {street_address} is ready: {report_url}';
const SEEDED_VARIABLES = ['street_address', 'report_url'];
// GSM-7 only; no STOP line on a transactional text (docs/sms-stop-line-policy.md).
const BODY = 'Hello {first_name}! The Waves service report for {street_address} is ready: {report_url}\n\nQuestions or requests? Reply here.';
const VARIABLES = ['first_name', 'street_address', 'report_url'];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await knex('sms_templates')
    .where({ template_key: TEMPLATE_KEY, body: SEEDED_BODY })
    .update({ body: BODY, variables: JSON.stringify(VARIABLES), updated_at: new Date() });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await knex('sms_templates')
    .where({ template_key: TEMPLATE_KEY, body: BODY })
    .update({ body: SEEDED_BODY, variables: JSON.stringify(SEEDED_VARIABLES), updated_at: new Date() });
};

exports.TEMPLATE_KEY = TEMPLATE_KEY;
exports.BODY = BODY;
exports.VARIABLES = VARIABLES;
exports.SEEDED_BODY = SEEDED_BODY;
