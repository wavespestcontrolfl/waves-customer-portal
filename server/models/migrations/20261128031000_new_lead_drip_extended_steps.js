'use strict';

/**
 * Extended new_lead drip email steps 3 (Day 10) and 4 (Day 21) (owner 2026-11-27 "ok go", Decision 2).
 *
 * Ships 100% DARK behind GATE_NEW_LEAD_DRIP_EXTENDED (`enabled: false` stored in DB, identical safety
 * pattern to PR #8452 `20261124140100_new_lead_drip_steps_disabled`). While the gate is off,
 * `automation-runner.js` never selects these fixed step IDs and no customer receives them.
 * When later flipped ON by the owner, every send passes all 7 stop rules in `new-lead-drip-stops.js`.
 *
 * down() is a documented no-op (matching 20261124140000_new_lead_drip_steps.js: copy is editable
 * in Admin, so remove via Admin or a forward migration).
 */

const EXTENDED_STEPS = [
  {
    id: '6f4b2c10-9e3a-4b18-8c2d-7a1e5f903401',
    step_order: 3,
    delay_hours: 120, // Day 10 (5 days after Day 5 Step 2)
    subject: 'Still seeing pests around the house, {{first_name}}?',
    preview_text: 'Local family-owned team, outside every visit plus inside whenever you ask, no long contract.',
    html_body: `<p>Hi {{first_name}},</p>
<p>Checking in once more in case bugs or yard issues are still popping up at home.</p>

<p>With Waves Pest Control, every quarterly pest visit covers the outside, plus an inside spray on your first visit and whenever you ask — with free return visits between stops and no long contract.</p>

<p>Reply with your address for your exact price, or call us any time at <a href="tel:+19412975749">(941) 297-5749</a>.</p>

<p>— The Waves Team</p>`,
    text_body: `Hi {{first_name}},

Checking in once more in case bugs or yard issues are still popping up at home.

With Waves Pest Control, every quarterly pest visit covers the outside, plus an inside spray on your first visit and whenever you ask — with free return visits between stops and no long contract.

Reply with your address for your exact price, or call us any time at (941) 297-5749.

— The Waves Team`,
  },
  {
    id: '8d9c4e21-3f5b-4a29-9d3e-1b2c6a804502',
    step_order: 4,
    delay_hours: 264, // Day 21 (11 days after Day 10 Step 3)
    subject: 'Should we close your Waves file?',
    preview_text: 'Quick yes or no so we do not clutter your inbox.',
    html_body: `<p>Hi {{first_name}},</p>
<p>We have not heard back, so we do not want to keep filling up your inbox.</p>

<p>If you still want a quote for your home or yard, reply with your address and we will send your exact price right over. Otherwise we will close out your request for now, and you can reach us any time at <a href="tel:+19412975749">(941) 297-5749</a>.</p>

<p>— The Waves Team</p>`,
    text_body: `Hi {{first_name}},

We have not heard back, so we do not want to keep filling up your inbox.

If you still want a quote for your home or yard, reply with your address and we will send your exact price right over. Otherwise we will close out your request for now, and you can reach us any time at (941) 297-5749.

— The Waves Team`,
  },
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('automation_steps'))) return;
  const template = await knex('automation_templates').where({ key: 'new_lead' }).first('key');
  if (!template) return;
  for (const step of EXTENDED_STEPS) {
    await knex('automation_steps')
      .insert({
        template_key: 'new_lead',
        ...step,
        from_name: 'Waves Pest Control',
        from_email: 'automations@wavespestcontrol.com',
        reply_to: 'contact@wavespestcontrol.com',
        enabled: false,
      })
      .onConflict(['template_key', 'step_order'])
      .ignore();
  }
};

exports.down = async function down() {};
