/**
 * Seed the "introducing the Waves app" onboarding email (template_key
 * 'app_intro'), sent once to a new recurring customer when their tech goes
 * en route to the FIRST visit (services/recurring-app-intro-email.js, fired
 * from track-transitions.markEnRoute). Copy + screenshots are adapted from the
 * public app guide (wavespestcontrol.com/pest-control/waves-app-guide).
 *
 * Images are portal-hosted PNGs (email-safe; the guide ships webp):
 *   https://portal.wavespestcontrol.com/app-email/app-tracking.png
 *   https://portal.wavespestcontrol.com/app-email/app-visits.png
 *   https://portal.wavespestcontrol.com/app-email/apple-app-store-badge.png
 *   https://portal.wavespestcontrol.com/app-email/google-play-badge.png
 *
 * The two store badges are clickable `image` blocks whose href comes from the
 * payload (app_store_url / play_store_url), so the links live in the sender,
 * not baked into the template body.
 */

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
  preview: "Your tech is on the way. Get the app to watch them arrive, read your report, and pay in seconds.",
  blocks: [
    { type: 'heading', content: 'Your Waves account is now an app, {{first_name}} 📱' },
    { type: 'paragraph', content: "Your technician is heading your way for your first visit — and everything about your Waves service now lives in one app, on iPhone and Android. No more calling the office to ask when we're coming, digging through email for an invoice, or wondering what we treated. You open the app and it's all there." },

    { type: 'heading', content: 'Watch your tech arrive — live' },
    { type: 'paragraph', content: "On the day of service, the app shows you where your technician is. About an hour before arrival you get a live-GPS heads-up with their ETA — like watching a rideshare on the way — so you're not stuck guessing inside a four-hour window." },
    { type: 'image', src: `${IMG}/app-tracking.png`, alt: 'Waves app — track your technician and control your alerts', width: 168, radius: 18 },

    { type: 'heading', content: 'See every visit, and exactly what we did' },
    { type: 'paragraph', content: 'The Visits tab keeps your full service history in one place. Tap any completed visit to open its report: what we treated, the products we used, what we found, and photos from your property. Lawn customers also get a health score that tracks your turf, visit over visit.' },
    { type: 'image', src: `${IMG}/app-visits.png`, alt: 'Waves app — upcoming visits, service history, and reports', width: 168, radius: 18 },

    { type: 'heading', content: 'Pay in seconds, and control your alerts' },
    { type: 'paragraph', content: 'See your balance and pay an invoice in a couple of taps — card, ACH, Apple Pay, or Google Pay — or turn on autopay and stop thinking about due dates. Every notification, from reminders to the "tech en route" heads-up to billing, can be set to text, email, both, or off. Payments run through Stripe, so your card details never touch our servers.' },
    { type: 'paragraph', content: 'You can also loop your spouse or property manager into appointment texts, refer neighbors for account credit, and lock everything behind Face ID.' },

    { type: 'divider' },
    { type: 'heading', content: 'Get the app — it’s free' },
    { type: 'paragraph', content: "Download below, then sign in with the phone number on your account — we'll text you a code. No new password to remember." },
    { type: 'image', src: `${IMG}/apple-app-store-badge.png`, alt: 'Download on the App Store', width: 168, url_variable: 'app_store_url' },
    { type: 'image', src: `${IMG}/google-play-badge.png`, alt: 'Get it on Google Play', width: 152, url_variable: 'play_store_url' },
    { type: 'small_note', content: "Already have the app? You're all set — this visit will show up automatically." },
    { type: 'signature', content: 'See you soon — The Waves Team' },
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
    send_stream: 'transactional_required',
    suppression_group_key: 'transactional_required',
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

async function ensureTransactionalGroup(knex) {
  if (!(await knex.schema.hasTable('email_preference_groups'))) return;
  const row = {
    key: 'transactional_required',
    name: 'Required account notices',
    description: 'Security, payment, legal, and account notices that must reach the customer.',
    send_stream: 'transactional_required',
    user_can_unsubscribe: false,
    sort_order: 10,
    updated_at: new Date(),
  };
  const existing = await knex('email_preference_groups').where({ key: row.key }).first();
  if (existing) {
    await knex('email_preference_groups').where({ key: row.key }).update(row);
  } else {
    await knex('email_preference_groups').insert({ ...row, created_at: new Date() });
  }
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
  await ensureTransactionalGroup(knex);
  await upsertTemplate(knex, TEMPLATE);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  await knex('email_templates').where({ template_key: TEMPLATE.key }).del();
};

exports.TEMPLATE = TEMPLATE;
