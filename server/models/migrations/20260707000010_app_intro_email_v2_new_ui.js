'use strict';

/**
 * App-intro email v2 — refreshed for the glass customer UI (screenshots
 * rendered 2026-07-06) and expanded to cover the features that shipped after
 * the original seed: Waves AI on every tab, on-site video recaps +
 * re-entry guidance in service reports, and AI-assisted rescheduling.
 *
 * Ships as its OWN migration: the template was seeded by 20260626000004,
 * which prod has already recorded in knex_migrations — an in-place edit to
 * that file would be a silent no-op (knex tracks migrations by filename).
 * This upserts the v2 copy over whatever seed version ran; down() restores
 * the v1 copy from the original seed's TEMPLATE export.
 *
 * New portal-hosted screenshots (client/public/app-email/, PNG for Outlook):
 *   https://portal.wavespestcontrol.com/app-email/app-home.png
 *   https://portal.wavespestcontrol.com/app-email/app-report.png
 *   https://portal.wavespestcontrol.com/app-email/app-reschedule.png
 * The v1 images (app-tracking.png, app-visits.png) stay on disk so any
 * already-delivered copies of v1 keep rendering.
 */

const { TEMPLATE: TEMPLATE_V1 } = require('./20260626000004_seed_app_intro_email_template');

const SERVICE_FROM = 'contact@wavespestcontrol.com';
const IMG = 'https://portal.wavespestcontrol.com/app-email';
const APP_STORE_URL = 'https://apps.apple.com/us/app/waves-pest-control/id6782775654';
const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.wavespestcontrol.portal';

const SHARED_VARIABLES = ['first_name', 'customer_portal_url', 'company_phone', 'company_email'];

const TEMPLATE = {
  key: 'app_intro',
  name: 'App Intro (First Visit)',
  category: 'onboarding',
  sensitivity: 'account',
  description: 'Introduces the Waves iOS/Android app to a new recurring customer when their tech goes en route to the first visit.',
  required: ['first_name'],
  optional: ['app_store_url', 'play_store_url'],
  subject: 'Track your visit live, {{first_name}} — meet the Waves app',
  preview: "Your tech is on the way. Watch them arrive live, get their video recap, and reschedule by just asking.",
  blocks: [
    { type: 'heading', content: 'Your Waves account is now an app, {{first_name}} 📱' },
    { type: 'paragraph', content: "Your technician is heading your way for your first visit — and everything about your Waves service now lives in one app, on iPhone and Android. No more calling the office to ask when we're coming, digging through email for an invoice, or wondering what we treated. You open the app and it's all there." },
    { type: 'image', src: `${IMG}/app-home.png`, alt: 'Waves app home — your plan, your next visit, and Waves AI', width: 168, radius: 18 },

    { type: 'heading', content: 'Watch your tech arrive — live' },
    { type: 'paragraph', content: "On the day of service, the app shows you where your technician is. About an hour before arrival you get a live-GPS heads-up with their ETA — like watching a rideshare on the way — so you're not stuck guessing inside a four-hour window." },

    { type: 'heading', content: 'Every visit documented — photos, notes, even video' },
    { type: 'paragraph', content: "Tap any completed visit for the full report: what we treated, the products we used, what we found, and photos from your property. Your technician can even record a short video recap on-site, and the report shows when treated areas are dry and safe for kids and pets. Lawn customers also get a health score that tracks your turf, visit over visit." },
    { type: 'image', src: `${IMG}/app-report.png`, alt: 'Waves app service report — video recap and re-entry guidance', width: 168, radius: 18 },

    { type: 'heading', content: 'Need to move a visit? Just say when' },
    { type: 'paragraph', content: 'Life happens, so rescheduling takes about ten seconds. Open the visit and pick from real open times — or tell Waves AI what works, like "anything next Tuesday afternoon," and it finds them for you. Only that visit moves; the rest of your regular schedule stays put.' },
    { type: 'image', src: `${IMG}/app-reschedule.png`, alt: 'Waves app rescheduling — search open times by date or time', width: 168, radius: 18 },

    { type: 'heading', content: 'Pay in seconds, and control your alerts' },
    { type: 'paragraph', content: 'See your balance and pay an invoice in a couple of taps — card, ACH, Apple Pay, or Google Pay — or turn on autopay and stop thinking about due dates. Every notification, from reminders to the "tech en route" heads-up to billing, can be set to text, email, both, or off. Payments run through Stripe, so your card details never touch our servers.' },
    { type: 'paragraph', content: 'Anything else? Just ask — the Waves AI bar at the top of every screen answers from your actual account: "explain my last charge," "when\'s my next visit," even "I\'m seeing ants again." You can also loop a spouse or property manager into appointment texts and lock everything behind Face ID.' },

    { type: 'divider' },
    { type: 'heading', content: 'Get the app — it’s free' },
    { type: 'paragraph', content: "Download below, then sign in with the phone number on your account — we'll text you a code. No new password to remember." },
    { type: 'image', src: `${IMG}/apple-app-store-badge.png`, alt: 'Download on the App Store', width: 168, url_variable: 'app_store_url' },
    { type: 'image', src: `${IMG}/google-play-badge.png`, alt: 'Get it on Google Play', width: 152, url_variable: 'play_store_url' },
    { type: 'small_note', content: "Already have the app? You're all set — this visit will show up automatically." },
    { type: 'signature', content: 'See you soon — The Waves Team' },
    { type: 'small_note', content: 'P.S. Once you\'re in, tap Refer — sending your link to a neighbor takes about thirty seconds and earns you account credit.' },
  ],
};

const PREVIEW_PAYLOAD = {
  first_name: 'Stan',
  customer_portal_url: 'https://portal.wavespestcontrol.com/login',
  company_phone: '(941) 555-0000',
  company_email: SERVICE_FROM,
  app_store_url: APP_STORE_URL,
  play_store_url: PLAY_STORE_URL,
};

function templateRow(t) {
  const allowed = [...new Set([...SHARED_VARIABLES, ...(t.required || []), ...(t.optional || [])])];
  const required = [...new Set(t.required || [])];
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
    // Same stream rationale as the seed: onboarding content, NOT a required
    // notice — service_operational so customer unsubscribes are honored.
    send_stream: 'service_operational',
    suppression_group_key: 'service_operational',
    layout_wrapper_id: 'service_default_v1',
    from_name: 'Waves Pest Control',
    from_email: SERVICE_FROM,
    reply_to: SERVICE_FROM,
    default_cta_label: null,
    default_cta_url_variable: null,
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
  await upsertTemplate(knex, TEMPLATE);
};

exports.down = async function down(knex) {
  const hasTables = await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions');
  if (!hasTables) return;
  await upsertTemplate(knex, TEMPLATE_V1);
};

exports.TEMPLATE = TEMPLATE;
