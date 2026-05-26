/**
 * Update SMS templates that refer to card processing fees so customer copy
 * only describes the credit card surcharge.
 */
exports.up = async function (knex) {
  const updates = [
    {
      template_key: 'ach_failover_card_switched',
      old: 'Card payments include a processing fee.',
      next: 'Credit card payments include a surcharge.',
    },
    {
      template_key: 'ach_failover_payment_method_changed',
      old: 'Card payments include a processing fee.',
      next: 'Credit card payments include a surcharge.',
    },
  ];

  for (const update of updates) {
    const row = await knex('sms_templates')
      .where({ template_key: update.template_key })
      .first();

    if (row?.body?.includes(update.old)) {
      await knex('sms_templates')
        .where({ template_key: update.template_key })
        .update({ body: row.body.replace(update.old, update.next) });
    }
  }
};

exports.down = async function (knex) {
  const rollbacks = [
    {
      template_key: 'ach_failover_card_switched',
      old: 'Credit card payments include a surcharge.',
      next: 'Card payments include a processing fee.',
    },
    {
      template_key: 'ach_failover_payment_method_changed',
      old: 'Credit card payments include a surcharge.',
      next: 'Card payments include a processing fee.',
    },
  ];

  for (const rollback of rollbacks) {
    const row = await knex('sms_templates')
      .where({ template_key: rollback.template_key })
      .first();

    if (row?.body?.includes(rollback.old)) {
      await knex('sms_templates')
        .where({ template_key: rollback.template_key })
        .update({ body: row.body.replace(rollback.old, rollback.next) });
    }
  }
};
