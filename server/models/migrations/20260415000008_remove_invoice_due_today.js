/**
 * Drop the day-0 "Due Today" reminder. The followup engine no longer has a
 * step at that position — first reminder is now the 3-day friendly nudge.
 *
 * Removes the SMS template row and re-anchors any in-flight sequences so
 * they don't try to fire a step that no longer exists.
 */
exports.up = async function (knex) {
  if (await knex.schema.hasTable('sms_templates')) {
    await knex('sms_templates').where({ template_key: 'invoice_due_today' }).del();
  }

  // Re-anchor in-flight sequences. The step array shrank by one at the front,
  // so every sequence past step 0 must decrement to keep pointing at the same
  // severity (a row that was about to fire d7 should still fire d7). Then
  // recompute next_touch_at against the new step's daysAfterDue so the cron
  // picks them up at the right time.
  if (await knex.schema.hasTable('invoice_followup_sequences')) {
    await knex('invoice_followup_sequences')
      .whereIn('status', ['active', 'paused', 'autopay_hold'])
      .where('step_index', '>', 0)
      .decrement('step_index', 1);

    // New step_index → days after due (matches config.steps order):
    //   0 = d3_friendly (3), 1 = d7_firmer (7), 2 = d14_urgent (14), 3 = d30_final (30)
    await knex.raw(`
      UPDATE invoice_followup_sequences s
      SET next_touch_at = (i.due_date + (
        CASE s.step_index
          WHEN 0 THEN INTERVAL '3 days'
          WHEN 1 THEN INTERVAL '7 days'
          WHEN 2 THEN INTERVAL '14 days'
          WHEN 3 THEN INTERVAL '30 days'
          ELSE INTERVAL '0 days'
        END
      ))::timestamp + INTERVAL '10 hours'
      FROM invoices i
      WHERE s.invoice_id = i.id
        AND s.status = 'active'
        AND s.step_index < 4
    `);

    // Anything past the last step is done.
    await knex('invoice_followup_sequences')
      .where('step_index', '>=', 4)
      .update({ status: 'completed', next_touch_at: null });
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  await knex('sms_templates').insert({
    template_key: 'invoice_due_today',
    name: 'Invoice — Due Today',
    category: 'billing',
    body:
      'Hi {first_name}! Quick reminder from Waves — your invoice for {invoice_title} ' +
      '(${amount}) is due today. Pay here: {pay_url}\n\nAlready paid? Disregard — ' +
      'takes a few hours to clear. Reply with any questions. — Waves',
    variables: JSON.stringify(['first_name', 'invoice_title', 'amount', 'pay_url']),
    sort_order: 17,
  }).onConflict('template_key').ignore();
};
