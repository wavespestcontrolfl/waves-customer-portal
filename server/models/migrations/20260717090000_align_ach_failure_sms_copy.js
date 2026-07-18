'use strict';

// Align the ACH failure SMS templates with what the failure handlers
// actually do at each escalation step, and give every notice an
// actionable billing link ({billing_url} is already supplied by the
// sending site for all three keys).
//
// Only rows still carrying the seeded body are updated (admin-edited
// copy is preserved); is_active is never touched.

const TEMPLATES = [
  {
    template_key: 'ach_retry_notice',
    old_body: 'Hello {first_name}! Your bank payment did not go through. We will retry automatically in 3 business days. No action is needed right now.\n\nQuestions or requests? Reply here.',
    new_body: 'Hello {first_name}! Your bank payment did not go through. If your account bills automatically, we will retry it in the next few days. You can also pay or update your payment method here: {billing_url}\n\nQuestions or requests? Reply here.',
    old_variables: ['first_name'],
    new_variables: ['first_name', 'billing_url'],
  },
  {
    template_key: 'ach_card_fallback',
    old_body: 'Hello {first_name}! Your bank payment failed again, so we switched this payment to your card on file. Card payments include a processing fee. You can switch back to bank payment once your account is verified.\n\nQuestions or requests? Reply here.',
    new_body: 'Hello {first_name}! Your bank payment did not go through again. Please verify your bank account or update your payment method here: {billing_url}\n\nQuestions or requests? Reply here.',
    old_variables: ['first_name'],
    new_variables: ['first_name', 'billing_url'],
  },
  {
    template_key: 'ach_suspended',
    old_body: 'Hello {first_name}! Your bank payment failed again. We updated your default payment to your card. Card payments include a processing fee.\n\nTo pay by bank with no added fee, update your bank account here: {billing_url}\n\nQuestions or requests? Reply here.',
    new_body: 'Hello {first_name}! Your bank payment failed again, so bank payments are paused on your account. If you have a card on file, we will use it for future payments (card payments include a processing fee). You can update your payment method here: {billing_url}\n\nQuestions or requests? Reply here.',
    old_variables: ['first_name', 'billing_url'],
    new_variables: ['first_name', 'billing_url'],
  },
];

async function replaceTemplates(knex, direction) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const columns = await knex('sms_templates').columnInfo();
  for (const t of TEMPLATES) {
    const fromBody = direction === 'up' ? t.old_body : t.new_body;
    const toBody = direction === 'up' ? t.new_body : t.old_body;
    const toVariables = direction === 'up' ? t.new_variables : t.old_variables;
    const patch = { body: toBody };
    if (columns.variables) patch.variables = JSON.stringify(toVariables);
    if (columns.updated_at) patch.updated_at = new Date();
    await knex('sms_templates')
      .where({ template_key: t.template_key, body: fromBody })
      .update(patch);
  }
}

exports.up = async function up(knex) {
  await replaceTemplates(knex, 'up');
};

exports.down = async function down(knex) {
  await replaceTemplates(knex, 'down');
};

exports.TEMPLATES = TEMPLATES;
