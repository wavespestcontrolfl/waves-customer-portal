/**
 * Pre-visit payment reminders for UNPAID annual-prepay terms.
 *
 * An accept-time prepay term sits in payment_pending until its invoice is
 * paid. Nothing nudged the customer between acceptance and the first visit
 * (the estimate follow-up cadence stops at accept), so an unpaid prepay
 * rode silently into service week. These columns give the daily renewal
 * cron durable 3-day / 1-day-before-term_start reminder state, mirroring
 * the renewal notice_* sent/claim column pattern on the same table.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('annual_prepay_terms')) {
    const addColumn = async (name) => {
      if (!(await knex.schema.hasColumn('annual_prepay_terms', name))) {
        await knex.schema.alterTable('annual_prepay_terms', (t) => {
          t.timestamp(name).nullable();
        });
      }
    };
    await addColumn('payment_reminder_3d_sent_at');
    await addColumn('payment_reminder_3d_claimed_at');
    await addColumn('payment_reminder_1d_sent_at');
    await addColumn('payment_reminder_1d_claimed_at');
  }

  if (await knex.schema.hasTable('sms_templates')) {
    const cols = await knex('sms_templates').columnInfo();
    const now = new Date();
    const template = {
      template_key: 'annual_prepay_payment_reminder',
      name: 'Annual Prepay Payment Reminder',
      category: 'billing',
      body: 'Hi {first_name}! A quick reminder that your Waves annual prepay invoice{amount_text} is still open ahead of your first visit on {first_visit_date}. Pay here: {pay_link}\n\nIf the prepay isn’t settled before the visit, no problem — we’ll simply bill that visit individually instead. Questions? Reply to this message.',
      variables: JSON.stringify(['first_name', 'amount_text', 'first_visit_date', 'pay_link']),
      ...(cols.is_active ? { is_active: true } : {}),
      ...(cols.sort_order ? { sort_order: 51 } : {}),
      ...(cols.updated_at ? { updated_at: now } : {}),
      ...(cols.created_at ? { created_at: now } : {}),
    };

    const existing = await knex('sms_templates').where({ template_key: template.template_key }).first();
    if (existing) {
      await knex('sms_templates').where({ template_key: template.template_key }).update({
        name: template.name,
        category: template.category,
        body: template.body,
        variables: template.variables,
        ...(cols.is_active ? { is_active: true } : {}),
        ...(cols.updated_at ? { updated_at: now } : {}),
      });
    } else {
      await knex('sms_templates').insert(template);
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('sms_templates')) {
    await knex('sms_templates').where({ template_key: 'annual_prepay_payment_reminder' }).del();
  }

  if (await knex.schema.hasTable('annual_prepay_terms')) {
    for (const name of [
      'payment_reminder_3d_sent_at',
      'payment_reminder_3d_claimed_at',
      'payment_reminder_1d_sent_at',
      'payment_reminder_1d_claimed_at',
    ]) {
      if (await knex.schema.hasColumn('annual_prepay_terms', name)) {
        await knex.schema.alterTable('annual_prepay_terms', (t) => {
          t.dropColumn(name);
        });
      }
    }
  }
};
