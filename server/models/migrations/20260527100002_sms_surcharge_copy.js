/**
 * Update SMS templates that say "Card payments include a processing fee"
 * to "Credit card payments include a surcharge" — debit/prepaid should
 * not be implied as surcharged.
 */
exports.up = async function (knex) {
  const updates = [
    {
      template_key: 'ach_failover_card_switched',
      old: 'Card payments include a processing fee.',
      new: 'Credit card payments include a surcharge.',
    },
    {
      template_key: 'ach_failover_payment_method_changed',
      old: 'Card payments include a processing fee.',
      new: 'Credit card payments include a surcharge.',
    },
  ];

  for (const u of updates) {
    const row = await knex('sms_templates').where({ template_key: u.template_key }).first();
    if (row && row.body && row.body.includes(u.old)) {
      await knex('sms_templates')
        .where({ template_key: u.template_key })
        .update({ body: row.body.replace(u.old, u.new) });
    }
  }
};

exports.down = async function (knex) {
  const rollbacks = [
    {
      template_key: 'ach_failover_card_switched',
      old: 'Credit card payments include a surcharge.',
      new: 'Card payments include a processing fee.',
    },
    {
      template_key: 'ach_failover_payment_method_changed',
      old: 'Credit card payments include a surcharge.',
      new: 'Card payments include a processing fee.',
    },
  ];

  for (const u of rollbacks) {
    const row = await knex('sms_templates').where({ template_key: u.template_key }).first();
    if (row && row.body && row.body.includes(u.old)) {
      await knex('sms_templates')
        .where({ template_key: u.template_key })
        .update({ body: row.body.replace(u.old, u.new) });
    }
  }
};
