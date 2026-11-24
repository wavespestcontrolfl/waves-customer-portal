'use strict';

/**
 * new_lead drip steps 1 and 2 (owner 2026-11-24, "go with your recs").
 *
 * new_lead had one step (0, sent at once: 236 sent, 17 clicked in 90 days). This adds:
 *   step 1, 48 hours after step 0: what quarterly pest control costs at a home like the lead's.
 *   step 2, 72 hours after step 1 (day 5): one question, "what are you seeing at home?".
 * Both are dark behind GATE_NEW_LEAD_DRIP_STEPS: with the gate off the runner never loads steps 1 and 2
 * (automation-runner.js enabledSequenceSteps), so a lead still gets the first email only. They are read at delivery
 * against the stop rules in services/new-lead-drip-stops.js. Step 0 is not touched here (its copy has its own migration).
 *
 * PRICE: "$105 to $120 per application" in step 1 comes from live data on 2026-11-24: completed quarterly pest visits in the last
 * 120 days, middle half $105 to $117. UPDATE THIS COPY (Admin > Automations > New Lead, step 1, or a new migration) WHEN
 * PRICES CHANGE. Nothing recomputes it.
 *
 * Step 1 carries no booking button: the consultation block (lead-consultation-email-block.js) is for step 0 only
 * (20260924020001 strips it from every later step) and its words say "free consultation". The reply line stands in.
 *
 * The two rows carry FIXED ids (the same ids as NEW_LEAD_DRIP_STEP_IDS in services/new-lead-drip-stops.js): the runner hides
 * and stops exactly these rows by id, never "every step at order 1 or more", so a step the owner adds in Admin is left alone.
 * Idempotent: ON CONFLICT (template_key, step_order) DO NOTHING, so a re-run or an owner-edited row is never overwritten
 * (a step an owner already put at order 1 or 2 means the seeded row is skipped, and the gate then has nothing to show).
 * Rolling deploy: this inserts enabled rows, and a runner from before this change would load them. It would only advance an
 * enrollment to step 1 (due 48 hours out); the runner of this change filters step 1 out when the gate is off, so nothing sends.
 * Enrollments already completed when the gate flips are not touched: the runner only picks active enrollments, so only a
 * lead enrolled after the flip (or one still active then) gets steps 1 and 2. No backfill.
 * down() is a documented no-op (waves-db skill §4): the copy is editable in Admin, and a rollback by subject cannot tell the
 * seeded words from an edit that kept the subject. To remove the emails, delete the rows in Admin or ship a forward migration.
 */

const STEPS = [
  {
    id: 'c215d7f2-8052-47ac-94ac-e5c049ed2ca2',
    step_order: 1,
    delay_hours: 48,
    subject: 'What pest control costs at a home like yours',
    preview_text: 'Most homes we treat pay about $105 to $120 per application. Here is what that covers.',
    html_body: `<p>Hi {{first_name}},</p>
<p>Most people ask about price first, so here it is. Most homes we treat for quarterly pest control pay about $105 to $120 per application, every 3 months.</p>

<ul>
  <li>Inside and outside treatment at each visit</li>
  <li>Free return visits if pests come back between visits</li>
  <li>No long contract. Stop any time.</li>
</ul>

<p>Your exact price depends on your home's size and what you are seeing. A booked assessment gives you the real number.</p>

<p>Reply with your address and a good time, and we will book your assessment.</p>

<p style="color:#71717A;font-size:12px;margin-top:16px;">Rather talk? Call <a href="tel:+19412975749">(941) 297-5749</a>, or reply with a good time.</p>

<p>— The Waves Team</p>`,
    text_body: `Hi {{first_name}},

Most people ask about price first, so here it is. Most homes we treat for quarterly pest control pay about $105 to $120 per application, every 3 months.

- Inside and outside treatment at each visit
- Free return visits if pests come back between visits
- No long contract. Stop any time.

Your exact price depends on your home's size and what you are seeing. A booked assessment gives you the real number.

Reply with your address and a good time, and we will book your assessment.

Rather talk? Call (941) 297-5749, or reply with a good time.

— The Waves Team`,
  },
  {
    id: '04ca91c9-8bcf-49f2-95a3-5b6c3a359602',
    step_order: 2,
    delay_hours: 72,
    subject: 'One question, {{first_name}}',
    preview_text: 'What are you seeing at home? A one-word reply is enough.',
    html_body: `<p>Hi {{first_name}},</p>
<p>One question: what are you seeing at home right now? Ants, roaches, something in the lawn, or something else?</p>

<p>Reply with one word. We will tell you what usually causes it and what fixes it. No sales call unless you ask for one.</p>

<p>Already sorted it out, or went with someone else? Tell us that too. We will stop emailing.</p>

<p>— The Waves Team</p>`,
    text_body: `Hi {{first_name}},

One question: what are you seeing at home right now? Ants, roaches, something in the lawn, or something else?

Reply with one word. We will tell you what usually causes it and what fixes it. No sales call unless you ask for one.

Already sorted it out, or went with someone else? Tell us that too. We will stop emailing.

— The Waves Team`,
  },
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('automation_steps'))) return;
  const template = await knex('automation_templates').where({ key: 'new_lead' }).first('key');
  if (!template) return;
  for (const step of STEPS) {
    await knex('automation_steps')
      .insert({
        template_key: 'new_lead',
        ...step,
        from_name: 'Waves Pest Control',
        from_email: 'automations@wavespestcontrol.com',
        reply_to: 'contact@wavespestcontrol.com',
        enabled: true,
      })
      .onConflict(['template_key', 'step_order'])
      .ignore();
  }
};

// Documented no-op (see the header).
exports.down = async function down() {};
