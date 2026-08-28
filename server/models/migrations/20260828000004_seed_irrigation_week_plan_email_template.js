/**
 * irrigation.weekly_plan — the ONE weekly check-in template used when
 * GATE_IRRIGATION_WEEK_PLAN is on and a legal watering plan could be built.
 * Subject, heading and the bold action line all come from THIS WEEK'S plan
 * (hold / run / rain-conditional); the paragraph above the numbers says what
 * happened LAST week. Those are separate outputs by design — a lawn can be
 * over-watered last week and still need one run this week.
 *
 * Gate off, or plan unavailable (no current restriction policy) → the three
 * pre-plan templates (20260702000001) keep sending exactly as before.
 * Same upsert discipline as that seed (active version updated in place on
 * re-run; this template has no staff edits to preserve yet).
 */
const SERVICE_FROM = 'contact@wavespestcontrol.com';
const TEMPLATE_KEY = 'irrigation.weekly_plan';

const SHARED_VARIABLES = ['first_name', 'customer_portal_url', 'company_phone', 'company_email'];
// first_name is folded into plan_subject / plan_heading by the renderer, so it
// is allowed (shared) but not required — a required variable nothing
// references is rejected by the template library.
const REQUIRED = [
  'plan_subject', 'plan_heading', 'summary_line', 'week_plan',
  'grass_label', 'rain_last_week', 'irrigation_inches', 'total_inches', 'target_inches',
];
const OPTIONAL = ['plan_note', 'restriction_note', 'forecast_line', 'week_ending', 'rain_source_note'];

const TEMPLATE = {
  key: TEMPLATE_KEY,
  name: 'Irrigation Weekly — This Week\'s Plan',
  category: 'lawn',
  description: 'Weekly watering check-in with a concrete legal-first plan for the week ahead: skip, run N minutes per turf zone on the permitted day, or wait for forecast rain. Last week\'s balance arrives as summary_line; the plan as week_plan.',
  subject: '{{plan_subject}}',
  preview: 'Your lawn\'s watering plan for this week, based on rain near your home and your area\'s watering rules.',
  ctaLabel: 'UPDATE MY IRRIGATION INFO',
  ctaUrlVariable: 'customer_portal_url',
  blocks: [
    { type: 'heading', content: '{{plan_heading}}' },
    { type: 'paragraph', content: '{{summary_line}}' },
    { type: 'callout', content: '{{week_plan}}' },
    { type: 'paragraph', content: '{{plan_note}}' },
    {
      type: 'details',
      rows: [
        { label: 'Rain at your home last week', value: '{{rain_last_week}}"' },
        { label: 'Your weekly irrigation setting', value: '{{irrigation_inches}}"' },
        { label: 'Total water your lawn received', value: '{{total_inches}}"' },
        { label: 'What your {{grass_label}} needs right now', value: '{{target_inches}}"' },
      ],
    },
    { type: 'paragraph', content: '{{forecast_line}}' },
    { type: 'small_note', content: '{{restriction_note}}' },
    { type: 'paragraph', content: 'If your sprinkler schedule has changed, take 30 seconds to update it in your portal so these check-ins stay accurate.' },
    { type: 'cta', label: 'UPDATE MY IRRIGATION INFO', url_variable: 'customer_portal_url' },
    { type: 'small_note', content: 'This plan is based on the irrigation details you shared in your customer portal, rainfall and weather measured near your home, your area\'s current watering restrictions, and University of Florida turf guidance. {{rain_source_note}} Prefer not to get these weekly check-ins? Turn off Seasonal Lawn Tips under Notification Preferences in your portal, or just reply and we\'ll take care of it.' },
    { type: 'signature', content: '— The Waves Team' },
  ],
};

const PREVIEW_PAYLOAD = {
  first_name: 'Stan',
  plan_subject: 'This week: about 30 minutes per turf zone, Stan',
  plan_heading: 'Your watering plan for this week, Stan',
  summary_line: 'Between last week\'s rain (0.6") and your irrigation schedule (2" per week), your lawn got about 2.6" of water — roughly 1.35" more than the 1.25" your St. Augustine needs this time of year.',
  week_plan: 'This week: run each turf zone about 30 minutes on your permitted watering day — 10 minutes more than you run now. That\'s about ¾" of water per run — the deep-and-infrequent pattern UF/IFAS recommends.',
  plan_note: 'Your area is limited to one watering day a week right now, so this plan stays inside that even though your St. Augustine could use a little more — one deeper soak does more good than two light ones. Minutes assume typical spray heads rates from University of Florida turf guidance. If you know your system\'s actual weekly output, enter Weekly Inches in your portal and we\'ll tighten this to your numbers.',
  grass_label: 'St. Augustine',
  rain_last_week: '0.6',
  irrigation_inches: '2',
  total_inches: '2.6',
  target_inches: '1.25',
  forecast_line: 'Looking ahead: about 0.3" of rain is in the forecast for your area over the next 7 days.',
  restriction_note: 'SWFWMD Modified Phase III water shortage order: lawn watering is limited to one day a week, on your assigned day, during your area\'s allowed hours, through 2026-10-01. Water on your assigned day only.',
  rain_source_note: '',
  week_ending: '2026-08-23',
  customer_portal_url: 'https://portal.wavespestcontrol.com/?tab=property',
  company_phone: '(941) 555-0000',
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
    content_sensitivity: 'account',
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
exports.__private = { TEMPLATE, TEMPLATE_KEY, templateRow, PREVIEW_PAYLOAD, REQUIRED, OPTIONAL, SHARED_VARIABLES };
