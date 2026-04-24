/**
 * Rewrite the invoice_followup_{7,14,30}day SMS bodies to be send-anchored
 * rather than overdue-anchored, matching the cadence change in
 * server/config/invoice-followups.js (steps now fire N days after the
 * invoice was sent, not N days after the due date).
 *
 * We only rewrite the existing rows; they were seeded by
 * 20260415000005_invoice_followup_templates.js, so they exist on every
 * environment. If a row is missing for any reason, we skip it — the
 * service falls back to the hardcoded body in config.
 */
const UPDATES = [
  {
    template_key: 'invoice_followup_7day',
    name: 'Invoice — 7-Day Reminder',
    body:
      'Hi {first_name}, just a friendly reminder from Waves — your invoice for ' +
      '{invoice_title}{service_date_clause} is still open. You can pay here: ' +
      '{pay_url}\n\nQuestions? Reply to this message. — Waves',
  },
  {
    template_key: 'invoice_followup_14day',
    name: 'Invoice — 14-Day Check-In',
    body:
      'Hi {first_name}, checking in on your Waves invoice for ' +
      '{invoice_title}{service_date_clause} — we\'d appreciate payment at your ' +
      'earliest convenience: {pay_url}\n\nReply if you need anything. — Waves',
  },
  {
    template_key: 'invoice_followup_30day',
    name: 'Invoice — 30-Day Final Notice',
    body:
      'Hi {first_name}, this is a final notice on your Waves invoice for ' +
      '{invoice_title}{service_date_clause}. Please pay now to keep the ' +
      'account in good standing: {pay_url}\n\nReply to discuss a payment plan. — Waves',
  },
];

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  for (const u of UPDATES) {
    await knex('sms_templates')
      .where({ template_key: u.template_key })
      .update({ name: u.name, body: u.body, updated_at: knex.fn.now() });
  }
};

// Reverting restores the previous "X days overdue" copy — matches what the
// 20260415000005 migration seeded originally.
const DOWN = [
  {
    template_key: 'invoice_followup_7day',
    name: 'Invoice — 7-Day Follow-Up',
    body:
      'Hello {first_name}, this is a reminder from Waves. Your invoice for {invoice_title}' +
      '{service_date_clause} is now 7 days overdue.\n\nPlease make your payment here: ' +
      '{pay_url}\n\nQuestions? Reply to this message. Thank you for choosing Waves!',
  },
  {
    template_key: 'invoice_followup_14day',
    name: 'Invoice — 14-Day Urgent',
    body:
      'Hello {first_name}, your invoice for {invoice_title}{service_date_clause} is now ' +
      '14 days overdue. Please make payment as soon as possible: {pay_url}\n\n' +
      'Questions? Reply to this message. — Waves',
  },
  {
    template_key: 'invoice_followup_30day',
    name: 'Invoice — 30-Day Final Notice',
    body:
      'Hello {first_name}, this is a final reminder. Your invoice for {invoice_title}' +
      '{service_date_clause} is 30 days overdue. Please pay immediately to avoid ' +
      'collections: {pay_url}\n\nReply to discuss or request a payment plan. — Waves',
  },
];

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  for (const u of DOWN) {
    await knex('sms_templates')
      .where({ template_key: u.template_key })
      .update({ name: u.name, body: u.body, updated_at: knex.fn.now() });
  }
};
