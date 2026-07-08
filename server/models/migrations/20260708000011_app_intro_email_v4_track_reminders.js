'use strict';

/**
 * App-intro email v4 — drops in the two screenshots the 07-08 store-asset
 * refresh finally made possible, plus a desktop pointer to the app page:
 *
 *  - app-track.png: the live-tracking section has shipped IMAGELESS since v2
 *    (the old capture showed "Live map unavailable"); the new capture shows
 *    the working live map ("Adam arrives in 12 min" — built-in demo data).
 *  - app-reminders.png: the REMINDER SETTINGS toggle list, illustrating the
 *    text/email/both notification controls the alerts paragraph promises.
 *  - a small_note pointing desktop readers at wavespestcontrol.com/app
 *    (store badges + web portal in one place).
 *
 * Both images live in client/public/app-email/ (500px wide, sharp-compressed,
 * metadata stripped — same treatment as the v2/v3 shots).
 *
 * v4 blocks are derived from v3's exported TEMPLATE by inserting at exact
 * anchors; buildV4() THROWS if an anchor is missing so a silent half-email
 * can never ship (deterministic against the imported v3 literal — proven by
 * the content-contract test, not discovered at deploy time). Ships as its own
 * migration (v3 = 20260707000020 already ran in prod; knex tracks by
 * filename). down() restores v3 verbatim.
 */

const { TEMPLATE: TEMPLATE_V3 } = require('./20260707000020_app_intro_email_lawn_waves_ai');

const IMG = 'https://portal.wavespestcontrol.com/app-email';

const TRACK_IMAGE = {
  type: 'image',
  src: `${IMG}/app-track.png`,
  alt: 'Waves app live tracking — your technician on the map with a live ETA',
  width: 168,
  radius: 18,
};

const REMINDERS_IMAGE = {
  type: 'image',
  src: `${IMG}/app-reminders.png`,
  alt: 'Waves app reminder settings — each notification set to text, email, or both',
  width: 168,
  radius: 18,
};

const APP_PAGE_NOTE = {
  type: 'small_note',
  content: 'Reading this on a computer? wavespestcontrol.com/app has the download links — and the web portal, if you prefer the browser.',
};

function insertAfter(blocks, predicate, block, label) {
  const idx = blocks.findIndex(predicate);
  if (idx === -1) throw new Error(`app_intro v4: anchor not found — ${label}`);
  blocks.splice(idx + 1, 0, block);
}

function buildV4() {
  const template = JSON.parse(JSON.stringify(TEMPLATE_V3));
  const blocks = template.blocks;

  // Live-tracking section: image goes under its paragraph (the section has
  // been imageless since v2 — the old capture showed a broken map).
  const trackHeadingIdx = blocks.findIndex(
    (b) => b.type === 'heading' && b.content === 'Watch your tech arrive — live',
  );
  if (trackHeadingIdx === -1) throw new Error('app_intro v4: anchor not found — track heading');
  const trackParagraph = blocks[trackHeadingIdx + 1];
  if (!trackParagraph || trackParagraph.type !== 'paragraph') {
    throw new Error('app_intro v4: track paragraph not where expected');
  }
  blocks.splice(trackHeadingIdx + 2, 0, TRACK_IMAGE);

  // Alerts: the toggle-list screenshot closes the notifications section.
  insertAfter(
    blocks,
    (b) => b.type === 'paragraph' && b.content.startsWith('You can also loop a spouse'),
    REMINDERS_IMAGE,
    'alerts paragraph',
  );

  // Get-the-app: desktop pointer to the /app page, after the already-have-it note.
  insertAfter(
    blocks,
    (b) => b.type === 'small_note' && b.content.startsWith('Already have the app?'),
    APP_PAGE_NOTE,
    'already-have-the-app note',
  );

  return template;
}

const TEMPLATE = buildV4();

const SERVICE_FROM = 'contact@wavespestcontrol.com';
const APP_STORE_URL = 'https://apps.apple.com/us/app/waves-pest-control/id6782775654';
const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.wavespestcontrol.portal';

const SHARED_VARIABLES = ['first_name', 'customer_portal_url', 'company_phone', 'company_email'];

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
  await upsertTemplate(knex, TEMPLATE_V3);
};

exports.TEMPLATE = TEMPLATE;
