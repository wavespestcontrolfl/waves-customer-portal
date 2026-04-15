/**
 * Remove the invoice_thank_you SMS template. Stripe auto-emails the receipt
 * and the customer's existing pay link flips to a "Paid" view with the full
 * service report after payment clears, so the SMS is a redundant third
 * notification for the same payment.
 *
 * The followup engine has thankYou.enabled = false in config so this template
 * row would never be read anyway — this keeps the admin UI clean.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await knex('sms_templates').where({ template_key: 'invoice_thank_you' }).del();
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await knex('sms_templates').insert({
    template_key: 'invoice_thank_you',
    name: 'Invoice — Thank You (Post-Payment)',
    category: 'billing',
    body:
      '{first_name}, got it — thank you for the payment! Your account is all caught up. ' +
      'View your receipt + service report: {receipt_url}\n\nSee you at your next service. — Waves 🌊',
    variables: JSON.stringify(['first_name', 'receipt_url']),
    sort_order: 22,
  }).onConflict('template_key').ignore();
};
