// Dedicated invoice-ready SMS for annual-prepay invoices.
//
// The generic `invoice_sent` template frames every invoice as a single visit
// ("Your invoice for {service_type} completed on {service_date} is ready"). For
// an annual prepayment — a full year of recurring visits paid up front — that
// past-tense, single-service wording misrepresents what the customer is paying
// for. This template states the coverage (e.g. "4 quarterly visits, June 2026
// through June 2027") instead. The send path (services/invoice.js sendViaSMS)
// selects it when the invoice has an annual_prepay_term, and falls back to
// `invoice_sent` if this row is missing/disabled. No dollar amount in the body —
// payment-link SMS keeps the amount on the pay page only.
const TEMPLATE = {
  template_key: 'invoice_sent_annual_prepay',
  name: 'Invoice Sent - Annual Prepay',
  category: 'billing',
  body: 'Hi {first_name}! Your Waves annual plan invoice is ready — it prepays {coverage_summary}.{first_visit_clause} Pay here: {pay_url}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!',
  variables: JSON.stringify(['first_name', 'coverage_summary', 'first_visit_clause', 'pay_url']),
  is_active: true,
  sort_order: 11,
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
