/**
 * Adds {receipt_url} placeholder to the invoice_receipt SMS template body
 * so customers get a tap-through link to view their paid invoice.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  const body = 'Hello {first_name}! Thank you for your payment — we truly appreciate your business. You can view your receipt here: {receipt_url}.\n\nIf you have any questions or need assistance, simply reply to this message. Thanks again for choosing Waves!';
  const variables = JSON.stringify(['first_name', 'invoice_number', 'amount', 'receipt_url']);

  await knex('sms_templates')
    .where({ template_key: 'invoice_receipt' })
    .update({ body, variables, updated_at: knex.fn.now() });
};

exports.down = async function () {};
