/**
 * prep.sprinkler_timer — the one-time "Running your sprinklers by hand"
 * guide (owner concept 2026-09-05, docs/irrigation-controller-guide-scope.md).
 *
 * Sent ONCE, by hand, from the Communications "Send prep guide" button, to a
 * lawn customer who has never opened the controller box. It names the
 * Monday-morning watering plan the customer already receives
 * (irrigation-weekly-email.js) so the reason for the send is the first thing
 * they read, then teaches ONE weekly move — dial to MANUAL, enter Monday's
 * minutes, walk away, back to OFF — instead of five settings. Manual-first
 * is the owner's direction: OFF is the resting position (nothing waters
 * unless the customer starts it, so a builder's leftover program can never
 * fire); a programmed schedule is the optional path at the end of each hub
 * brand page.
 *
 * The five stacked cta blocks are the brand row: under the glass theme every
 * cta renders as the full gold button (owner call 2026-07-06, ctaChip in
 * email-template.js), so this is five identical gold bars by design. They
 * deep-link to the hub guides (wavespestcontrol.com/sprinkler-timers/…),
 * which ship in the astro repo — no portal page, no visit prep token.
 *
 * `watering_block` is rendered at send time by prep-guide-sender.js from
 * the CURRENT restriction policy (config/irrigation-restrictions.js — day
 * count only, fail closed) and the customer's irrigation_run_minutes. No
 * weekday, no hour window: the policy cannot resolve either.
 *
 * Same upsert discipline as 20260828000004 (active version updated in place
 * on re-run; no staff edits to preserve yet).
 */
const SERVICE_FROM = 'contact@wavespestcontrol.com';
const TEMPLATE_KEY = 'prep.sprinkler_timer';
const HUB_GUIDES = 'https://www.wavespestcontrol.com/sprinkler-timers';

const SHARED_VARIABLES = ['first_name', 'customer_portal_url', 'company_phone', 'company_email'];
const REQUIRED = ['first_name', 'watering_block'];
const OPTIONAL = [];

const TEMPLATE = {
  key: TEMPLATE_KEY,
  name: 'Sprinkler Timer Guide',
  category: 'prep',
  description: 'One-time guide for a lawn customer who has never opened the sprinkler controller: run it by hand once a week from the Monday watering plan. Brand buttons deep-link to the hub guides; watering_block carries the current day count and the customer\'s minutes per zone.',
  subject: 'Running your sprinklers by hand, {{first_name}}',
  preview: 'The easiest way to follow Monday\'s watering plan. Find the brand on the box, tap it, follow the photos.',
  ctaLabel: null,
  ctaUrlVariable: null,
  blocks: [
    { type: 'heading', content: 'Running your sprinklers by hand, {{first_name}}' },
    { type: 'paragraph', content: 'Every Monday morning we email you your lawn\'s watering plan for the week: how many minutes to run each zone, and whether to skip because of rain. Your county sets the day. That plan only helps if you can make the sprinklers run. This one-time guide shows the easiest way: run them by hand, once a week, straight from the plan.' },
    { type: 'paragraph', content: 'You do not need to be handy for this. Open the little box in your garage or on the side of the house and look for the brand name printed on the front. Then tap that name below for photos of your exact box.' },
    { type: 'cta', label: 'RAIN BIRD', url: `${HUB_GUIDES}/rain-bird/` },
    { type: 'cta', label: 'HUNTER', url: `${HUB_GUIDES}/hunter/` },
    { type: 'cta', label: 'ORBIT B-HYVE', url: `${HUB_GUIDES}/orbit-b-hyve/` },
    { type: 'cta', label: 'RACHIO', url: `${HUB_GUIDES}/rachio/` },
    { type: 'cta', label: 'NOT SURE? TEXT US A PHOTO', url: `${HUB_GUIDES}/identify/` },
    { type: 'callout', content: '{{watering_block}}' },
    { type: 'paragraph', content: 'Three steps, and the guide shows where each one lives on your box.' },
    {
      type: 'list',
      items: [
        'Between runs, leave the dial on OFF. Nothing waters unless you start it, including any old schedule the builder left behind.',
        'Each week: start a run of all zones with the minutes from Monday\'s email (your brand guide shows the exact buttons). The box runs every zone in turn and goes quiet by itself. When it finishes, turn the dial back to OFF the same day, so an old schedule cannot sneak in while it sits on Run.',
        'When Monday\'s email says skip this week, do nothing. The dial is already off.',
      ],
    },
    { type: 'paragraph', content: 'One rule that matters: a hand run counts the same as a scheduled one. Press it only on your assigned day and inside your county\'s allowed hours. Where the hours are overnight, it is easier to set it up as a schedule instead; each guide has a short section on that at the end.' },
    { type: 'small_note', content: 'Stuck at any step? Text a photo of your timer to {{company_phone}} and we will point you to the right page. Waves does not repair sprinklers. If a zone will not run or a head is broken, we will refer you to an irrigation contractor we trust.' },
    { type: 'signature', content: '— The Waves Team' },
  ],
};

const PREVIEW_PAYLOAD = {
  first_name: 'Dorothy',
  watering_block: 'Right now your area allows one watering day a week (SWFWMD Modified Phase III water shortage order), on your assigned day, during your area\'s allowed hours, through October 1. On that day, run each grass zone about 35 minutes.',
  customer_portal_url: 'https://portal.wavespestcontrol.com/?tab=property',
  company_phone: '(941) 297-5749',
  company_email: SERVICE_FROM,
};

function templateRow(t) {
  const required = [...new Set(REQUIRED)];
  const allowed = [...new Set([...SHARED_VARIABLES, ...required, ...OPTIONAL])];
  const optional = allowed.filter((key) => !required.includes(key));
  return {
    template_key: t.key,
    name: t.name,
    description: t.description || null,
    mode: 'service',
    purpose: t.category,
    legal_classification: 'transactional_relationship',
    audience: 'customer',
    message_priority: 'normal',
    content_sensitivity: 'service',
    send_stream: 'service_operational',
    suppression_group_key: 'service_operational',
    layout_wrapper_id: 'service_default_v1',
    from_name: 'Waves Pest Control',
    from_email: SERVICE_FROM,
    reply_to: SERVICE_FROM,
    default_cta_label: t.ctaLabel || null,
    default_cta_url_variable: t.ctaUrlVariable || null,
    allowed_variables: JSON.stringify(allowed),
    required_variables: JSON.stringify(required),
    optional_variables: JSON.stringify(optional),
    status: 'active',
    updated_at: new Date(),
  };
}

async function upsertTemplate(knex, t) {
  const existing = await knex('email_templates').where({ template_key: t.key }).first();
  let template = existing;
  const row = templateRow(t);
  if (template) {
    await knex('email_templates').where({ id: template.id }).update(row);
    template = await knex('email_templates').where({ id: template.id }).first();
  } else {
    [template] = await knex('email_templates').insert({ ...row, created_at: new Date() }).returning('*');
  }

  let version = template.active_version_id
    ? await knex('email_template_versions').where({ id: template.active_version_id }).first()
    : null;
  const versionFields = {
    status: 'active',
    subject: t.subject,
    preview_text: t.preview || null,
    blocks: JSON.stringify(t.blocks || []),
    text_body: null,
    published_at: new Date(),
    updated_at: new Date(),
  };
  if (version) {
    await knex('email_template_versions').where({ id: version.id }).update(versionFields);
  } else {
    const latest = await knex('email_template_versions')
      .where({ template_id: template.id })
      .max('version_number as max')
      .first();
    const nextVersion = Number(latest?.max || 0) + 1;
    [version] = await knex('email_template_versions').insert({
      template_id: template.id,
      version_number: nextVersion,
      created_at: new Date(),
      ...versionFields,
    }).returning('*');
  }
  await knex('email_templates').where({ id: template.id }).update({
    active_version_id: version?.id || template.active_version_id,
    last_published_at: new Date(),
    updated_at: new Date(),
  });

  if (await knex.schema.hasTable('email_template_fixtures')) {
    const existingFixture = await knex('email_template_fixtures')
      .where({ template_id: template.id, is_default: true })
      .first();
    const payload = JSON.stringify(PREVIEW_PAYLOAD);
    if (existingFixture) {
      await knex('email_template_fixtures').where({ id: existingFixture.id }).update({ name: 'Happy path', payload, updated_at: new Date() });
    } else {
      await knex('email_template_fixtures').insert({
        template_id: template.id, name: 'Happy path', payload, is_default: true, created_at: new Date(), updated_at: new Date(),
      });
    }
  }
}

exports.up = async function up(knex) {
  const hasTables = await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions');
  if (!hasTables) return;
  await upsertTemplate(knex, TEMPLATE);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  await knex('email_templates').where({ template_key: TEMPLATE_KEY }).del();
};

exports.TEMPLATES = [TEMPLATE];
exports.__private = { TEMPLATE, TEMPLATE_KEY, HUB_GUIDES, templateRow, PREVIEW_PAYLOAD, REQUIRED, OPTIONAL, SHARED_VARIABLES };
