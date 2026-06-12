/**
 * Deposit-abandonment follow-up (estimate follow-up stage 5).
 *
 * Required deposits went live with ESTIMATE_DEPOSIT_REQUIRED: customers now
 * hit a Stripe card form when accepting an estimate, and some mint a
 * PaymentIntent (estimate_deposits status='pending') but never complete it.
 * That drop-off is the highest-intent abandonment signal in the funnel and
 * none of the four existing follow-up stages cover it.
 *
 * Adds the per-stage claim flag (same independence rationale as
 * 20260417000009_estimate_followup_per_stage_flags) and seeds the SMS
 * template the stage renders. The stage itself ships dark behind
 * GATE_ESTIMATE_DEPOSIT_ABANDONMENT_SMS.
 */

exports.up = async function (knex) {
  const has = await knex.schema.hasColumn('estimates', 'followup_deposit_abandoned_sent');
  if (!has) {
    await knex.schema.alterTable('estimates', (t) => {
      t.boolean('followup_deposit_abandoned_sent').defaultTo(false);
    });
  }

  if (!(await knex.schema.hasTable('sms_templates'))) return;

  const template = {
    template_key: 'estimate_followup_deposit',
    name: 'Estimate Follow-Up — Deposit Not Completed',
    category: 'estimates',
    body: 'Hello {first_name}! Your Waves appointment is almost reserved — your estimate is saved and just needs the ${deposit_amount} deposit to lock in your spot: {estimate_url}\n\nQuestions or requests? Reply here.',
    variables: JSON.stringify(['first_name', 'deposit_amount', 'estimate_url']),
    sort_order: 27,
    updated_at: new Date(),
  };
  const existing = await knex('sms_templates')
    .where({ template_key: template.template_key })
    .first();
  if (existing) {
    await knex('sms_templates')
      .where({ template_key: template.template_key })
      .update(template);
  } else {
    await knex('sms_templates').insert({ ...template, created_at: new Date() });
  }
};

exports.down = async function (knex) {
  const has = await knex.schema.hasColumn('estimates', 'followup_deposit_abandoned_sent');
  if (has) {
    await knex.schema.alterTable('estimates', (t) => {
      t.dropColumn('followup_deposit_abandoned_sent');
    });
  }
  if (await knex.schema.hasTable('sms_templates')) {
    await knex('sms_templates')
      .where({ template_key: 'estimate_followup_deposit' })
      .del();
  }
};
