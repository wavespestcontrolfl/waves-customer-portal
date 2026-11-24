'use strict';

/**
 * NEW-LEAD DRIP EMAIL WORDS (owner "fix" 2026-11-24; approved copy, no gate).
 * Data only, no schema. Same class as 20261122140000_estimate_followup_copy_words_app_line and
 * 20260926120200_customer_copy_audit_automations: an owner-approved copy change.
 *
 * The live new_lead drip email (automation_steps, template_key new_lead, step 0):
 *   - said the company is "in Lakewood Ranch" to leads of all four offices (Lakewood Ranch,
 *     Parrish, Sarasota, Venice): it now names the four offices;
 *   - offered "a free inspection" and to "swing by" (owner ruling 2026-11-23: no free
 *     inspections, book an assessment): it now says "we'll book your assessment";
 *   - said "No up-sells at the door. Quotes come from the office" (owner ruling 2026-11-22:
 *     technicians now sell add-ons on route): that line is gone, in the plain-text body too.
 *
 * Exact-value compare-and-swap per field, as in 20260926120200: a row an administrator has edited
 * since is left alone. subject and preview_text are not touched; {{consultation_booking}} and
 * {{consultation_booking_text}} stay. One audit_log row per changed field.
 *
 * down: a no-op, as in 20260926120200 and 20261122140000. A revert by content cannot tell this
 * migration's words from the same words an administrator saved before it ran, so it could undo an
 * administrator's edit. To go back, ship a forward migration.
 */

const MIGRATION = '20261124130000';
const COPY_MIGRATION = '20261124130000_new_lead_drip_copy_offices_assessment';
const KEY = 'new_lead';
// Step 0 only: the seeded first email. A later new_lead step is another email and stays as it is.
const STEP_ORDER = 0;

const STEP_SWAPS = [
  {
    "field": "html_body",
    "before": "<h2>Hi {{first_name}} — thanks for your interest in Waves</h2>\n<p>We're a family-owned pest control and lawn care company based right here in Lakewood Ranch. Our trucks run Manatee, Sarasota, and Charlotte counties — and our techs are the ones you'll actually see at your door.</p>\n\n<h2>How we work</h2>\n<ul>\n  <li><strong>No commitment contracts.</strong> You can pause or cancel anytime.</li>\n  <li><strong>No up-sells at the door.</strong> Quotes come from the office, not from whoever's at your house.</li>\n  <li><strong>Free re-services on recurring plans.</strong> If pests come back between scheduled visits, so do we — no extra charge.</li>\n</ul>\n\n{{consultation_booking}}\n<h2>What's next</h2>\n<p>If you'd like a quote or a free inspection, just reply to this email with your address and a good time for us to swing by. Or give us a call at <a href=\"tel:+19412975749\">(941) 297-5749</a>.</p>\n\n<p>— The Waves Pest Control team</p>\n<p style=\"color:#71717A;font-size:12px;margin-top:16px;\">Reply to this email anytime — it goes straight to our team.</p>",
    "after": "<h2>Hi {{first_name}} — thanks for your interest in Waves</h2>\n<p>We're a family-owned pest control and lawn care company with offices in Lakewood Ranch, Parrish, Sarasota, and Venice. Our trucks run Manatee, Sarasota, and Charlotte counties — and our techs are the ones you'll actually see at your door.</p>\n\n<h2>How we work</h2>\n<ul>\n  <li><strong>No commitment contracts.</strong> You can pause or cancel anytime.</li>\n  <li><strong>Free re-services on recurring plans.</strong> If pests come back between scheduled visits, so do we — no extra charge.</li>\n</ul>\n\n{{consultation_booking}}\n<h2>What's next</h2>\n<p>If you'd like a quote, just reply to this email with your address and a good time, and we'll book your assessment. Or give us a call at <a href=\"tel:+19412975749\">(941) 297-5749</a>.</p>\n\n<p>— The Waves Pest Control team</p>\n<p style=\"color:#71717A;font-size:12px;margin-top:16px;\">Reply to this email anytime — it goes straight to our team.</p>"
  },
  {
    "field": "text_body",
    "before": "Hi {{first_name}} — thanks for your interest in Waves. We're a family-owned pest control + lawn care company in Lakewood Ranch, serving Manatee, Sarasota, and Charlotte counties. No commitment contracts. No door-step upsells. Free re-services between visits on recurring plans. {{consultation_booking_text}}\nReply with your address and a good time and we'll swing by, or call (941) 297-5749. — The Waves Pest Control team",
    "after": "Hi {{first_name}} — thanks for your interest in Waves. We're a family-owned pest control + lawn care company with offices in Lakewood Ranch, Parrish, Sarasota, and Venice, serving Manatee, Sarasota, and Charlotte counties. No commitment contracts. Free re-services between visits on recurring plans. {{consultation_booking_text}}\nReply with your address and a good time and we'll book your assessment, or call (941) 297-5749. — The Waves Pest Control team"
  }
];

async function auditStep(knex, id, field) {
  const { recordAuditEvent } = require('../../services/audit-log');
  await recordAuditEvent({
    actor_type: 'system',
    action: 'automation_copy_updated',
    resource_type: 'automation_steps',
    resource_id: id == null ? null : String(id),
    metadata: { migration: COPY_MIGRATION, template_key: KEY, field },
    critical: true,
    trx: knex,
  });
}

async function swapSteps(knex) {
  if (!(await knex.schema.hasTable('automation_steps'))) return {};
  const hasAudit = await knex.schema.hasTable('audit_log');
  const results = {};
  for (const { field, before, after } of STEP_SWAPS) {
    const rows = await knex('automation_steps').where({ template_key: KEY, step_order: STEP_ORDER, [field]: before }).select('id');
    let changedRows = 0;
    for (const { id } of rows) {
      const changed = await knex('automation_steps')
        .where({ id, step_order: STEP_ORDER, [field]: before })
        .update({ [field]: after, updated_at: knex.fn.now() });
      if (changed) {
        changedRows += 1;
        if (hasAudit) await auditStep(knex, id, field);
      }
    }
    results[`${KEY}.${field}`] = changedRows;
  }
  return results;
}

exports.up = async function up(knex) {
  await knex.transaction(async (trx) => {
    const steps = await swapSteps(trx);
    console.log(`[migration:${MIGRATION}] steps: ${JSON.stringify(steps)}`);
  });
};

exports.down = async function down() {
  // Intentionally no-op: a revert by content could erase an administrator's edit (see the header).
};

exports._private = { STEP_SWAPS };
