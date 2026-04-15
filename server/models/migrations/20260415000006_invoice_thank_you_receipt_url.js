/**
 * Update the seeded invoice_thank_you template to include the {receipt_url}
 * variable so customers can tap straight to their branded service report
 * after paying. The prior seed migration uses if-not-exists, so this
 * targeted update is needed for environments where the template was
 * already inserted.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  await knex('sms_templates')
    .where({ template_key: 'invoice_thank_you' })
    .update({
      body:
        '{first_name}, got it — thank you for the payment! Your account is all caught up. ' +
        'View your receipt + service report: {receipt_url}\n\nSee you at your next service. — Waves 🌊',
      variables: JSON.stringify(['first_name', 'receipt_url']),
    });
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await knex('sms_templates')
    .where({ template_key: 'invoice_thank_you' })
    .update({
      body:
        '{first_name}, got it — thank you for the payment! Your account is all caught up. ' +
        'See you at your next service. — Waves 🌊',
      variables: JSON.stringify(['first_name']),
    });
};
