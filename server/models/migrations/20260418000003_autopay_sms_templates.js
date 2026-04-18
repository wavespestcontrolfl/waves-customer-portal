/**
 * Seed autopay-billing SMS templates so billing-cron stops using hardcoded
 * strings (which had the wrong callback number — 239 area code instead of 941).
 *
 * All autopay-related customer SMS now go through sms_templates with these
 * keys. Inline fallbacks in billing-cron match these bodies, so if the
 * template row is missing or corrupt the customer experience is unchanged.
 */

const TEMPLATES = [
  {
    template_key: 'autopay_charge_success',
    name: 'Autopay — Charge Success',
    category: 'billing',
    body: 'Hi {first_name}, your WaveGuard monthly payment of ${amount} was successfully processed. Thank you!{receipt_line}',
    variables: ['first_name', 'amount', 'receipt_line'],
    sort_order: 20,
  },
  {
    template_key: 'autopay_charge_failed',
    name: 'Autopay — First Failure',
    category: 'billing',
    body: "Hi {first_name}, your WaveGuard monthly payment of ${amount} couldn't be processed. We'll retry automatically in a few days — update your card here if you'd like to fix it now: {update_card_url}\n\nQuestions? (941) 318-7612",
    variables: ['first_name', 'amount', 'update_card_url'],
    sort_order: 21,
  },
  {
    template_key: 'autopay_retry_success',
    name: 'Autopay — Retry Success',
    category: 'billing',
    body: 'Hi {first_name}, great news — your payment of ${amount} just went through. Thank you for being a Waves customer!{receipt_line}',
    variables: ['first_name', 'amount', 'receipt_line'],
    sort_order: 22,
  },
  {
    template_key: 'autopay_retry_failed',
    name: 'Autopay — Retry Failed',
    category: 'billing',
    body: "Hi {first_name}, your payment of ${amount} still didn't go through. We'll try again in a few days — or update your card here to fix it now: {update_card_url}\n\nQuestions? (941) 318-7612",
    variables: ['first_name', 'amount', 'update_card_url'],
    sort_order: 23,
  },
  {
    template_key: 'autopay_retry_final_failed',
    name: 'Autopay — Final Failure (all retries exhausted)',
    category: 'billing',
    body: "Hi {first_name}, after several attempts we still couldn't process your payment of ${amount}. Please update your card to keep your service active: {update_card_url}\n\nQuestions? Call (941) 318-7612 or reply to this message.",
    variables: ['first_name', 'amount', 'update_card_url'],
    sort_order: 24,
  },
];

exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable('sms_templates');
  if (!hasTable) return;

  for (const tpl of TEMPLATES) {
    const row = {
      template_key: tpl.template_key,
      name: tpl.name,
      category: tpl.category,
      body: tpl.body,
      variables: JSON.stringify(tpl.variables),
      sort_order: tpl.sort_order,
    };
    const existing = await knex('sms_templates').where({ template_key: tpl.template_key }).first();
    if (existing) {
      await knex('sms_templates').where({ id: existing.id }).update(row);
    } else {
      await knex('sms_templates').insert(row);
    }
  }
};

exports.down = async function (knex) {
  const hasTable = await knex.schema.hasTable('sms_templates');
  if (!hasTable) return;
  for (const tpl of TEMPLATES) {
    await knex('sms_templates').where({ template_key: tpl.template_key }).del();
  }
};
