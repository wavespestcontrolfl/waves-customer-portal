/**
 * Seed the weekly irrigation recommendation emails (irrigation-weekly-email.js).
 *
 * Three templates — sent Monday morning to lawn-care customers who entered a
 * weekly irrigation-inches value in the customer portal, one per outcome of
 * last week's water balance vs. the seasonal target for their grass:
 *   irrigation.weekly_cut_back    (surplus — ease back)
 *   irrigation.weekly_add_water   (deficit — add a little time)
 *   irrigation.weekly_on_track    (balanced, or a light week the upcoming
 *                                  rain forecast covers — no change needed;
 *                                  owner directive 2026-07-02: on-target
 *                                  customers hear "you're good" every week)
 *
 * Sent on the service_operational stream so customer email unsubscribes are
 * honored (a watering tip is not a required notice). Weeks without a full
 * trusted rainfall window send nothing — never claim numbers we don't have.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';

const SHARED_VARIABLES = ['first_name', 'customer_portal_url', 'company_phone', 'company_email'];

// The two action templates (cut back / add water) quote the differential; the
// on-track template instead carries a computed summary_line (its lead sentence
// differs between a truly balanced week and a light week that incoming
// forecast rain covers). Required variables must be referenced by the
// template's blocks, so the lists are per-template.
const REQUIRED_ACTION = [
  'first_name',
  'grass_label',
  'rain_last_week',
  'irrigation_inches',
  'total_inches',
  'target_inches',
  'difference_inches',
];
const REQUIRED_ON_TRACK = [
  'first_name',
  'grass_label',
  'rain_last_week',
  'irrigation_inches',
  'total_inches',
  'target_inches',
  'summary_line',
];
const OPTIONAL = ['forecast_line', 'week_ending'];

const WATER_DETAILS_BLOCK = {
  type: 'details',
  rows: [
    { label: 'Rain at your home last week', value: '{{rain_last_week}}"' },
    { label: 'Your weekly irrigation setting', value: '{{irrigation_inches}}"' },
    { label: 'Total water your lawn received', value: '{{total_inches}}"' },
    { label: 'What your {{grass_label}} needs right now', value: '{{target_inches}}"' },
  ],
};

const FOOTER_NOTE_BLOCK = {
  type: 'small_note',
  content: 'This tip is based on the irrigation schedule you shared in your customer portal, rainfall and weather measured near your home, and University of Florida turf guidance. Local watering restrictions still apply — check your county\'s assigned days.',
};

const TEMPLATES = [
  {
    key: 'irrigation.weekly_on_track',
    name: 'Irrigation Weekly — On Track',
    category: 'lawn',
    sensitivity: 'account',
    description: 'Weekly watering check-in when no change is needed: the week was balanced, or a light week is covered by the upcoming rain forecast. The lead sentence arrives as summary_line because those two cases read differently.',
    required: REQUIRED_ON_TRACK,
    subject: 'Your lawn\'s watering is right on track, {{first_name}}',
    preview: 'No changes needed this week — your current schedule has it covered.',
    ctaLabel: 'UPDATE MY IRRIGATION INFO',
    ctaUrlVariable: 'customer_portal_url',
    blocks: [
      { type: 'heading', content: 'You\'re good to go this week, {{first_name}}' },
      { type: 'paragraph', content: '{{summary_line}}' },
      WATER_DETAILS_BLOCK,
      { type: 'callout', content: 'No changes needed — keep your current schedule running as-is. We check this every week and we\'ll tell you the moment something should change.' },
      { type: 'paragraph', content: '{{forecast_line}}' },
      { type: 'paragraph', content: 'If your sprinkler schedule has changed, take 30 seconds to update it in your portal so these check-ins stay accurate.' },
      { type: 'cta', label: 'UPDATE MY IRRIGATION INFO', url_variable: 'customer_portal_url' },
      FOOTER_NOTE_BLOCK,
      { type: 'signature', content: '— The Waves Team' },
    ],
  },
  {
    key: 'irrigation.weekly_cut_back',
    name: 'Irrigation Weekly — Cut Back (Surplus)',
    category: 'lawn',
    sensitivity: 'account',
    description: 'Weekly watering check-in when last week\'s rain + the customer\'s irrigation schedule ran above the seasonal target for their grass. Recommends easing back.',
    // Neutral on the water source: a surplus can be all sprinkler in a dry
    // week (rain 0"), so the subject must not credit the rain.
    subject: 'You can ease up on the sprinklers this week, {{first_name}}',
    preview: 'Your lawn got about {{total_inches}}" of water — more than it needs. Here\'s how to dial it in.',
    ctaLabel: 'UPDATE MY IRRIGATION INFO',
    ctaUrlVariable: 'customer_portal_url',
    blocks: [
      { type: 'heading', content: 'Good news, {{first_name}} — you can ease up on the sprinklers this week' },
      { type: 'paragraph', content: 'Between the rain that fell near your home last week ({{rain_last_week}}") and your irrigation schedule ({{irrigation_inches}}" per week), your lawn got about {{total_inches}}" of water — roughly {{difference_inches}}" more than the {{target_inches}}" your {{grass_label}} needs this time of year.' },
      WATER_DETAILS_BLOCK,
      { type: 'callout', content: 'This week: skip a watering day or trim a few minutes off each zone. Too much water is the #1 thing we see feeding fungus, mushrooms, and weeds in SWFL lawns — easing back actually makes your lawn healthier.' },
      { type: 'paragraph', content: '{{forecast_line}}' },
      { type: 'paragraph', content: 'If your sprinkler schedule has changed, take 30 seconds to update it in your portal so these check-ins stay accurate.' },
      { type: 'cta', label: 'UPDATE MY IRRIGATION INFO', url_variable: 'customer_portal_url' },
      FOOTER_NOTE_BLOCK,
      { type: 'signature', content: '— The Waves Team' },
    ],
  },
  {
    key: 'irrigation.weekly_add_water',
    name: 'Irrigation Weekly — Add Water (Deficit)',
    category: 'lawn',
    sensitivity: 'account',
    description: 'Weekly watering check-in when last week\'s rain + the customer\'s irrigation schedule ran below the seasonal target for their grass. Recommends adding a little time.',
    subject: 'Your lawn could use a little more water this week, {{first_name}}',
    preview: 'Rain was light near your home — your lawn came up about {{difference_inches}}" short. A small bump will help.',
    ctaLabel: 'UPDATE MY IRRIGATION INFO',
    ctaUrlVariable: 'customer_portal_url',
    blocks: [
      { type: 'heading', content: 'Quick watering check-in, {{first_name}}' },
      { type: 'paragraph', content: 'Rain was light near your home last week ({{rain_last_week}}"), so with your irrigation schedule ({{irrigation_inches}}" per week) your lawn got about {{total_inches}}" of water — roughly {{difference_inches}}" short of the {{target_inches}}" your {{grass_label}} needs this time of year.' },
      WATER_DETAILS_BLOCK,
      { type: 'callout', content: 'This week: add a few minutes per zone, or one extra watering day if your county\'s restrictions allow it. Water in the early morning — evening watering invites fungus.' },
      { type: 'paragraph', content: '{{forecast_line}}' },
      { type: 'paragraph', content: 'If your sprinkler schedule has changed, take 30 seconds to update it in your portal so these check-ins stay accurate.' },
      { type: 'cta', label: 'UPDATE MY IRRIGATION INFO', url_variable: 'customer_portal_url' },
      FOOTER_NOTE_BLOCK,
      { type: 'signature', content: '— The Waves Team' },
    ],
  },
];

const PREVIEW_PAYLOAD = {
  first_name: 'Stan',
  grass_label: 'St. Augustine',
  rain_last_week: '2.1',
  irrigation_inches: '1',
  total_inches: '3',
  target_inches: '1.25',
  difference_inches: '1.75',
  summary_line: 'Between last week\'s rain (2.1") and your irrigation schedule (1"), your lawn got about 3" of water — right in line with what your St. Augustine needs this time of year.',
  forecast_line: 'Looking ahead: about 1.4" of rain is in the forecast for your area over the next 7 days — more than your lawn needs on its own, so easing back now will really pay off.',
  week_ending: '2026-06-28',
  customer_portal_url: 'https://portal.wavespestcontrol.com/?tab=property',
  company_phone: '(941) 555-0000',
  company_email: SERVICE_FROM,
};

function templateRow(t) {
  const required = [...new Set(t.required || REQUIRED_ACTION)];
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
    content_sensitivity: t.sensitivity || 'account',
    // A watering tip is operational, not a required security/billing/legal
    // notice — service_operational so customer email unsubscribes are honored.
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
      await knex('email_template_fixtures').where({ id: existingFixture.id }).update({
        name: 'Happy path', payload, updated_at: new Date(),
      });
    } else {
      await knex('email_template_fixtures').insert({
        template_id: template.id, name: 'Happy path', payload, is_default: true,
        created_at: new Date(), updated_at: new Date(),
      });
    }
  }
}

exports.up = async function up(knex) {
  const hasTables = await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions');
  if (!hasTables) return;
  for (const template of TEMPLATES) {
    await upsertTemplate(knex, template);
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  await knex('email_templates').whereIn('template_key', TEMPLATES.map((t) => t.key)).del();
};

exports.TEMPLATES = TEMPLATES;
exports.__private = { TEMPLATES, templateRow, PREVIEW_PAYLOAD, SHARED_VARIABLES, REQUIRED_ACTION, REQUIRED_ON_TRACK, OPTIONAL };
