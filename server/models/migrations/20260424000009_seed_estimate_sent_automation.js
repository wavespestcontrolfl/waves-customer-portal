/**
 * Adds the estimate_sent automation template + default step.
 *
 * Fires when an estimate is dispatched via POST /api/admin/estimates/:id/send.
 * Default step lands 2 hours after enrollment so it feels like a
 * personal follow-up, not a duplicate of the immediate "estimate ready"
 * email (which still ships transactionally through Gmail SMTP).
 */

exports.up = async function (knex) {
  await knex('automation_templates')
    .insert({
      key: 'estimate_sent',
      name: 'Estimate Sent',
      description: 'Personal follow-up after we deliver an estimate — opens the door for questions',
      asm_group: 'service',
      tags: JSON.stringify(['estimate', 'follow-up']),
      sms_template: null,
      enabled: true,
    })
    .onConflict('key').ignore();

  const existing = await knex('automation_steps').where({ template_key: 'estimate_sent', step_order: 0 }).first();
  if (existing) return;

  await knex('automation_steps').insert({
    template_key: 'estimate_sent',
    step_order: 0,
    delay_hours: 2,
    subject: 'A quick note on your Waves estimate, {{first_name}}',
    preview_text: 'No sales pitch — just making sure you got it.',
    html_body: `<h2>Hi {{first_name}} — thanks for considering Waves</h2>
<p>We sent your estimate over a couple of hours ago and wanted to follow up personally. No sales pitch — just making sure it landed and answering anything you're wondering about.</p>

<h2>A few things folks usually ask</h2>
<ul>
  <li><strong>When can I start?</strong> Whenever. Most new customers pick a start date within 1–2 weeks.</li>
  <li><strong>Am I locked in?</strong> No. We don't do commitment contracts — you can pause or cancel anytime.</li>
  <li><strong>What if I see activity between visits?</strong> Free re-service. Reply to a service reminder text and we're back out.</li>
  <li><strong>Is the price locked in?</strong> Yes, for the quoted service. We'll always tell you before anything changes.</li>
</ul>

<p>If you've got a question that's not on that list, just reply to this email. It goes straight to our team in Bradenton — no call center, no ticket queue.</p>

<p>— The Waves Pest Control team</p>`,
    text_body: 'Hi {{first_name}} — thanks for considering Waves. No sales pitch, just a quick follow-up to make sure the estimate landed. A few common questions: you can start whenever (most folks pick 1–2 weeks out); no commitment contracts, pause/cancel anytime; free re-service between visits if you see activity; price is locked in for the quoted service. Reply with any questions — it goes straight to our team in Bradenton. — The Waves Pest Control team',
    from_name: 'Waves Pest Control',
    from_email: 'automations@wavespestcontrol.com',
    reply_to: 'contact@wavespestcontrol.com',
    enabled: true,
  });
};

exports.down = async function (knex) {
  await knex('automation_steps').where({ template_key: 'estimate_sent' }).del();
  await knex('automation_templates').where({ key: 'estimate_sent' }).del();
};
