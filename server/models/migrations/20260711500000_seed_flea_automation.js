/**
 * Adds the flea automation template + default step.
 *
 * Fleas were the one first-time treatment with prep messaging (prep.flea /
 * auto_flea) but no entry in the Automations tab, so operators had no
 * sequence to send manually the way bed_bug / cockroach have. Mirrors
 * 20260424000009 (estimate_sent): template row + one starter step the
 * operator can edit or AI-redraft in the Automations editor.
 *
 * Copy is adapted from the already-approved flea prep guide
 * (prep.flea, 20260521000004) in the voice of the bed_bug / cockroach
 * starter steps (20260424000007).
 *
 * Idempotent: ON CONFLICT DO NOTHING on the template key, and the step is
 * skipped when a step_order=0 row already exists — re-running never
 * clobbers operator edits.
 */

const BRAND_FOOTER = `
<p>— The Waves Pest Control team</p>
<p style="color:#71717A;font-size:12px;margin-top:16px;">Reply to this email anytime — it goes straight to our team.</p>`;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('automation_templates'))) return;

  await knex('automation_templates')
    .insert({
      key: 'flea',
      name: 'Flea Treatment',
      description: 'For first-time customers who have booked a flea treatment',
      asm_group: 'service',
      tags: JSON.stringify(['flea treatment', 'first-time']),
      sms_template: null,
      enabled: true,
    })
    .onConflict('key').ignore();

  const existing = await knex('automation_steps').where({ template_key: 'flea', step_order: 0 }).first();
  if (existing) return;

  await knex('automation_steps').insert({
    template_key: 'flea',
    step_order: 0,
    delay_hours: 0,
    subject: 'Your flea treatment prep guide',
    preview_text: 'A little prep beforehand makes the treatment work the first time.',
    html_body: `<h2>Hi {{first_name}} — let's get your home flea-free</h2>
<p>Flea treatments work best when the home, the pets, and the activity areas get handled together. Twenty minutes of prep before we arrive makes the difference between one treatment and a repeat visit.</p>

<h2>Before we arrive</h2>
<ul>
  <li>Vacuum carpets, rugs, furniture edges, pet resting areas, and along baseboards — then empty the vacuum outside.</li>
  <li>Wash pet bedding, blankets, and washable throws on a hot cycle.</li>
  <li>Coordinate pet flea control with your veterinarian — treating the home without treating the pets is how fleas come back.</li>
  <li>Pick up toys, clothes, and clutter from the floor so we can treat the full carpet area.</li>
</ul>

<h2>After the treatment</h2>
<p>Keep people and pets off treated areas until they're dry. You may still see some flea activity for a short while as immature fleas emerge — that's expected, and continued vacuuming helps break the cycle.</p>

<p>Reply to this email if anything on the list is unclear — we'd rather answer now than re-treat later.</p>
${BRAND_FOOTER}`,
    text_body: "Hi {{first_name}} — let's get your home flea-free. Before we arrive: vacuum carpets, rugs, furniture edges, pet resting areas, and baseboards (empty the vacuum outside); wash pet bedding on a hot cycle; coordinate pet flea control with your vet; clear floor clutter so we can treat the full carpet area. After: keep people and pets off treated areas until they're dry, and keep vacuuming — brief flea activity after treatment is expected as immature fleas emerge. — The Waves Pest Control team",
    from_name: 'Waves Pest Control',
    from_email: 'automations@wavespestcontrol.com',
    reply_to: 'contact@wavespestcontrol.com',
    enabled: true,
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('automation_templates'))) return;
  await knex('automation_steps').where({ template_key: 'flea' }).del();
  await knex('automation_templates').where({ key: 'flea' }).del();
};
