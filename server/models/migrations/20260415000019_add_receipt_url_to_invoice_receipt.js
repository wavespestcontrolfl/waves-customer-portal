/**
 * Adds {receipt_url} placeholder to the invoice_receipt SMS template body
 * so customers get a tap-through link to view their paid invoice.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  const body = 'Payment received — thank you, {first_name}!\n\nInvoice: {invoice_number}\nAmount: ${amount}{card_line}\n\nView receipt: {receipt_url}\n\nYour property is protected. See you at your next service!\n\n— Waves Pest Control';
  const variables = JSON.stringify(['first_name', 'invoice_number', 'amount', 'card_line', 'receipt_url']);

  await knex('sms_templates')
    .where({ template_key: 'invoice_receipt' })
    .update({ body, variables, updated_at: knex.fn.now() });
};

exports.down = async function () {};
