'use strict';

/**
 * Estimate follow-up cadence collapse — the template half (schema half:
 * 20260702000030_estimate_followup_cadence_timestamps).
 *
 * Three touches while the quote is live replace the old five-flavor ladder:
 *   1. Questions opener (48-72h after send) — final copy, two state variants:
 *      one for leads who viewed the quote, one for not-yet-viewed. A reply
 *      routes the thread to Virginia (the reply-pause already stops the cron).
 *   2. Day-5 check-in — INTERIM neutral copy. This is the slot the offer
 *      engine's First-Year Protection Credit will occupy (PR 2 replaces the
 *      body); the template key is already `estimate_followup_credit` so the
 *      stage claim column and key don't churn again.
 *   3. Last-day notice (expiry -1d) — INTERIM copy without offer language;
 *      the loss-framed version naming the credit + Fast-Start Bonus lands
 *      with PR 3 once both offers actually exist.
 *
 * The old unviewed / viewed / final templates retire (deleted, matching the
 * house remove-* pattern). Copy is intentionally overwritten — this is an
 * owner-approved cadence redesign, not an incidental seed repair.
 *
 * All bodies use plain hyphens and straight apostrophes: em-dashes knock SMS
 * out of GSM-7 into UCS-2 and roughly double the per-message segment count.
 */

const NEW_TEMPLATES = [
  {
    template_key: 'estimate_followup_questions',
    name: 'Estimate Follow-Up — Questions (viewed)',
    category: 'estimates',
    body: "Hi {first_name}! I saw you had a chance to look over your Waves plan - any questions I can answer? Happy to walk through pricing, scheduling, or what's covered.\n\nYour quote is here whenever you're ready: {estimate_url}\n\nJust reply to this text and it comes straight to us.",
    variables: ['first_name', 'estimate_url'],
    trigger_event_key: 'estimate.followup_questions',
    sort_order: 22,
  },
  {
    template_key: 'estimate_followup_questions_unviewed',
    name: 'Estimate Follow-Up — Questions (not yet viewed)',
    category: 'estimates',
    body: 'Hey {first_name}, your Waves Pest Control plan for {address} is ready - your quoted price is locked until {expires_at}.\n\nTake a look here: {estimate_url}\n\nAny questions at all, just reply to this text.',
    variables: ['first_name', 'address', 'expires_at', 'estimate_url'],
    trigger_event_key: 'estimate.followup_questions',
    sort_order: 23,
  },
  {
    template_key: 'estimate_followup_credit',
    name: 'Estimate Follow-Up — Day-5 Check-In',
    category: 'estimates',
    body: 'Hi {first_name}, just checking in on your Waves plan - everything is ready whenever you are, and your quoted price is locked until {expires_at}.\n\nPick your first visit here: {estimate_url}\n\nAny questions, just reply.',
    variables: ['first_name', 'expires_at', 'estimate_url'],
    trigger_event_key: 'estimate.followup_checkin',
    sort_order: 26,
  },
  {
    template_key: 'estimate_followup_expiring',
    name: 'Estimate Follow-Up — Last Day',
    category: 'estimates',
    body: "Last day, {first_name} - your locked Waves quote expires after {expires_at}, and we'd have to re-quote from scratch.\n\nTwo minutes to lock it in and pick your first visit: {estimate_url}",
    variables: ['first_name', 'expires_at', 'estimate_url'],
    trigger_event_key: 'estimate.expiring_soon',
    sort_order: 29,
  },
];

const RETIRED_KEYS = [
  'estimate_followup_unviewed',
  'estimate_followup_viewed',
  'estimate_followup_final',
];

// Last-known hardcoded bodies (20260514000002_tighten_sms_template_copy) so
// down() leaves the old cron code, restored by the schema down(), functional.
const RETIRED_TEMPLATES = [
  {
    template_key: 'estimate_followup_unviewed',
    name: 'Estimate Follow-Up — Unviewed (24h) (hardcoded)',
    category: 'estimates',
    body: 'Hello {first_name}! Just making sure you saw your Waves estimate: {estimate_url}\n\nQuestions or requests? Reply here.',
    variables: ['first_name', 'estimate_url'],
    trigger_event_key: 'estimate.sent',
    sort_order: 22,
  },
  {
    template_key: 'estimate_followup_viewed',
    name: 'Estimate Follow-Up — Viewed Not Accepted (48h) (hardcoded)',
    category: 'estimates',
    body: "Hello {first_name}! Saw you opened your Waves estimate. Any questions we can answer? {estimate_url}\n\nReply here and we'll help.",
    variables: ['first_name', 'estimate_url'],
    trigger_event_key: 'estimate.viewed',
    sort_order: 26,
  },
  {
    template_key: 'estimate_followup_final',
    name: 'Estimate Follow-Up — Final Nudge (5d) (hardcoded)',
    category: 'estimates',
    body: 'Hello {first_name}! One last check-in. Your Waves estimate is still available: {estimate_url}\n\nNo pressure - reply here if you have questions.',
    variables: ['first_name', 'estimate_url'],
    trigger_event_key: 'estimate.followup_final',
    sort_order: 28,
  },
];

async function upsertTemplates(knex, templates) {
  const cols = await knex('sms_templates').columnInfo();
  const now = new Date();
  for (const template of templates) {
    const row = {
      template_key: template.template_key,
      name: template.name,
      category: template.category,
      body: template.body,
      variables: JSON.stringify(template.variables),
      sort_order: template.sort_order,
    };
    if (cols.trigger_event_key) row.trigger_event_key = template.trigger_event_key;
    if (cols.updated_at) row.updated_at = now;

    const existing = await knex('sms_templates')
      .where({ template_key: template.template_key })
      .first();
    if (existing) {
      await knex('sms_templates')
        .where({ template_key: template.template_key })
        .update(row);
      continue;
    }
    await knex('sms_templates').insert({
      ...row,
      ...(cols.is_active ? { is_active: true } : {}),
      ...(cols.is_internal ? { is_internal: false } : {}),
      ...(cols.created_at ? { created_at: now } : {}),
    });
  }
}

async function removeTemplates(knex, keys) {
  await knex('sms_templates').whereIn('template_key', keys).del();
  // A/B creative variants hang off template_key with no FK — clear them so
  // retired keys don't leave orphan rows the variants admin UI would list.
  if (await knex.schema.hasTable('sms_template_variants')) {
    await knex('sms_template_variants').whereIn('template_key', keys).del();
  }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await upsertTemplates(knex, NEW_TEMPLATES);
  await removeTemplates(knex, RETIRED_KEYS);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await removeTemplates(knex, NEW_TEMPLATES.map((t) => t.template_key)
    .filter((k) => k !== 'estimate_followup_expiring'));
  await upsertTemplates(knex, RETIRED_TEMPLATES);
  // estimate_followup_expiring predates this migration — down() keeps the row
  // (the old cron uses it) with the new copy; copy rollback isn't meaningful.
};

exports.NEW_TEMPLATES = NEW_TEMPLATES;
exports.RETIRED_KEYS = RETIRED_KEYS;
