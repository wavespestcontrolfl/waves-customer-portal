/**
 * Seed the two SETUP variants of the weekly irrigation email
 * (irrigation-weekly-email.js).
 *
 * The three original templates (cut_back / add_water / on_track) all report a
 * water BALANCE, which needs the customer's weekly irrigation inches. Owner
 * directive 2026-08-01: the weekly email goes to the whole recurring-lawn
 * book, not just the customers who filled in the portal form — the rainfall
 * number is measured at their own coordinates and stands on its own. So two
 * more templates carry the same measured rain plus the seasonal target, and
 * ask for the missing piece:
 *
 *   irrigation.weekly_setup_schedule  (sprinkler system on file, no inches —
 *                                      "tell us how long you run it")
 *   irrigation.weekly_setup_system    (nothing on file — "do you water with a
 *                                      system or by hand?")
 *
 * Neither claims a balance, a total, or a recommendation to change anything:
 * we don't know what they apply, so the copy stops at what we measured. Same
 * service_operational stream and suppression group as the advice templates,
 * so unsubscribes and the Seasonal Lawn Tips opt-out are honored identically.
 * Weeks without a full trusted rainfall window still send nothing.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';

const SHARED_VARIABLES = ['first_name', 'customer_portal_url', 'company_phone', 'company_email'];

// No irrigation_inches / total_inches / difference_inches here by design —
// those are exactly the numbers we do NOT have for these customers.
const REQUIRED = ['first_name', 'grass_label', 'rain_last_week', 'target_inches'];
const OPTIONAL = ['forecast_line', 'week_ending'];

const RAIN_DETAILS_BLOCK = {
  type: 'details',
  rows: [
    { label: 'Rain at your home last week', value: '{{rain_last_week}}"' },
    { label: 'What your {{grass_label}} needs right now', value: '{{target_inches}}" per week' },
  ],
};

// The advice templates credit "the irrigation schedule you shared" — these
// customers haven't shared one, so the note stops at what actually informed
// the email.
const FOOTER_NOTE_BLOCK = {
  type: 'small_note',
  content: 'This check-in is based on rainfall and weather measured near your home and University of Florida turf guidance. Local watering restrictions still apply — check your county\'s assigned days. Prefer not to get these weekly check-ins? Turn off Seasonal Lawn Tips under Notification Preferences in your portal, or just reply and we\'ll take care of it.',
};

const OPENING_PARAGRAPH = 'About {{rain_last_week}}" of rain fell near your home last week. This time of year your {{grass_label}} needs roughly {{target_inches}}" of water a week — rain and watering counted together.';

const TEMPLATES = [
  {
    key: 'irrigation.weekly_setup_schedule',
    name: 'Irrigation Weekly — Setup (Schedule Needed)',
    category: 'lawn',
    sensitivity: 'account',
    description: 'Weekly rainfall check-in for a recurring lawn customer whose portal says they have an irrigation system but has no weekly inches on file. Reports measured rain + the seasonal target, and asks for the run time so future check-ins can give a real recommendation.',
    required: REQUIRED,
    subject: 'Here\'s what fell on your lawn last week, {{first_name}}',
    preview: 'About {{rain_last_week}}" of rain near your home — here\'s how that compares to what your lawn needs.',
    ctaLabel: 'ADD MY WATERING SCHEDULE',
    ctaUrlVariable: 'customer_portal_url',
    blocks: [
      { type: 'heading', content: 'Your weekly lawn water check-in, {{first_name}}' },
      { type: 'paragraph', content: OPENING_PARAGRAPH },
      RAIN_DETAILS_BLOCK,
      { type: 'callout', content: 'We have a sprinkler system on file for you, but not how much you run it. Add your weekly watering schedule in the portal and these check-ins become real recommendations — ease back this week, add a few minutes, or you\'re right on track.' },
      { type: 'paragraph', content: '{{forecast_line}}' },
      { type: 'cta', label: 'ADD MY WATERING SCHEDULE', url_variable: 'customer_portal_url' },
      FOOTER_NOTE_BLOCK,
      { type: 'signature', content: '— The Waves Team' },
    ],
  },
  {
    key: 'irrigation.weekly_setup_system',
    name: 'Irrigation Weekly — Setup (System Unknown)',
    category: 'lawn',
    sensitivity: 'account',
    description: 'Weekly rainfall check-in for a recurring lawn customer with no irrigation details in the portal at all. Reports measured rain + the seasonal target and asks how they water — deliberately does not assume a sprinkler system exists.',
    required: REQUIRED,
    subject: 'Here\'s what fell on your lawn last week, {{first_name}}',
    preview: 'About {{rain_last_week}}" of rain near your home — here\'s how that compares to what your lawn needs.',
    ctaLabel: 'TELL US HOW YOU WATER',
    ctaUrlVariable: 'customer_portal_url',
    blocks: [
      { type: 'heading', content: 'Your weekly lawn water check-in, {{first_name}}' },
      { type: 'paragraph', content: OPENING_PARAGRAPH },
      RAIN_DETAILS_BLOCK,
      { type: 'callout', content: 'Do you water with a sprinkler system, or by hand? Tell us in the portal — once we know how you water and roughly how much, we can tell you each week whether to ease back, add a little, or leave it alone.' },
      { type: 'paragraph', content: '{{forecast_line}}' },
      { type: 'cta', label: 'TELL US HOW YOU WATER', url_variable: 'customer_portal_url' },
      FOOTER_NOTE_BLOCK,
      { type: 'signature', content: '— The Waves Team' },
    ],
  },
];

const PREVIEW_PAYLOAD = {
  first_name: 'Stan',
  grass_label: 'St. Augustine',
  rain_last_week: '0.6',
  target_inches: '1.25',
  forecast_line: 'Looking ahead: about 1.4" of rain is in the forecast for your area over the next 7 days.',
  week_ending: '2026-08-02',
  customer_portal_url: 'https://portal.wavespestcontrol.com/?tab=property',
  company_phone: '(941) 555-0000',
  company_email: SERVICE_FROM,
};

function templateRow(t) {
  const required = [...new Set(t.required || REQUIRED)];
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
    // Same stream as the advice templates — a watering check-in is
    // operational, not a required notice, so unsubscribes are honored.
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
exports.__private = { TEMPLATES, templateRow, PREVIEW_PAYLOAD, SHARED_VARIABLES, REQUIRED, OPTIONAL };
