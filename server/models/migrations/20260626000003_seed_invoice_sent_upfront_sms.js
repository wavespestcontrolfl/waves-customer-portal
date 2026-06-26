// Dedicated invoice-ready SMS for upfront (pre-service) invoices.
//
// The generic `invoice_sent` template frames every invoice as a finished visit
// ("Your invoice for {service_type} completed on {service_date} is ready"). The
// setup + first-application invoice auto-sent the moment a customer accepts an
// estimate is the opposite: nothing has been performed yet, and its service_date
// points at the FUTURE auto-scheduled first visit — so the generic copy asserts a
// service that hasn't happened and prints a future date as if it were completed.
// This variant drops the "completed on {service_date}" clause entirely (no date
// placeholder at all) and frames the charge as getting started. The send path
// (services/invoice.js sendViaSMS) selects it when the invoice's service date is
// still in the future in ET, and falls back to `invoice_sent` if this row is
// missing/disabled. No dollar amount in the body — payment-link SMS keeps the
// amount on the pay page only.
const TEMPLATE = {
  template_key: 'invoice_sent_upfront',
  name: 'Invoice Sent - Upfront (Pre-Service)',
  category: 'billing',
  body: 'Hello {first_name}! Your invoice to get started with {service_type} is ready: {pay_url}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!',
  variables: JSON.stringify(['first_name', 'service_type', 'pay_url']),
  is_active: true,
  sort_order: 12,
  updated_at: new Date(),
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await knex('sms_templates')
    .insert({ ...TEMPLATE, created_at: new Date() })
    .onConflict('template_key')
    .merge(TEMPLATE);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await knex('sms_templates')
    .where({ template_key: TEMPLATE.template_key })
    .del();
};

// Exported so the copy contract (no "completed on", no date placeholder) can be
// asserted against the source of truth in tests.
exports.TEMPLATE = TEMPLATE;
