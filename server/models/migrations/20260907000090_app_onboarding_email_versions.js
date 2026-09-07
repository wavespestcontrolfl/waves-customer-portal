'use strict';

// Publish new versions from the active rows. Old versions and template-level
// delivery settings stay intact. Unknown anchors fail before publication;
// custom prose outside the replaced seed blocks is retained for staff review.
// Data-only rollback is deliberately a no-op: staff can republish a prior
// version in the library without a down migration erasing subsequent edits.
const { TEMPLATE: APP_V4 } = require('./20260708000011_app_intro_email_v4_track_reminders');
const { recordAuditEvent } = require('../../services/audit-log');
const { validationFor } = require('../../services/email-template-library');

const MIGRATION = '20260907000090';
const APP_PAGE = 'https://www.wavespestcontrol.com/app/';
const GUIDE = 'https://www.wavespestcontrol.com/pest-control/waves-app-guide/';
const guideLink = (source, anchor) => `${GUIDE}?utm_source=${source}&utm_medium=email&utm_campaign=app_onboarding#${anchor}`;
const START_LINK = guideLink('welcome', 'start-here-sign-in');
const TRACK_LINK = guideLink('app_intro', 'follow-your-technician');
const REPORT_LINK = guideLink('service_report', 'read-your-service-report');
const LAWN_NOTE = 'If you have lawn service, your first scored report sets a baseline for future visits. Look for your saved Weekly Watering Plan under My Property when available.';
const SETUP_COPY = 'Visit the Waves app page for iPhone and Android downloads or the browser portal. Sign in with the mobile number on your Waves account, then enter the six-digit code from your text message. There is no password to create. On Home, find Next Visit to check your appointment, confirm it, or choose Reschedule.';
const SETUP_HELP = 'If your sign-in code does not arrive or work, request a fresh one and enter the newest code. Still stuck? Call or text {{company_phone}}.';
const ACCEPTED_POINTER = `You can get ready now: [get started with the Waves app](${APP_PAGE}), sign in with the mobile number on your account, and enter your texted code. Home shows your next visit. Our [sign-in guide](${guideLink('estimate_accepted', 'start-here-sign-in')}) walks through each step.`;

function json(value, fallback) {
  if (value == null) return fallback;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function anchor(blocks, predicate, label) {
  const index = blocks.findIndex(predicate);
  if (index < 0) throw new Error(`App onboarding: missing ${label} anchor; review the active template before publishing`);
  return index;
}

function refreshWelcome(blocks) {
  const first = anchor(blocks, b => b.type === 'paragraph' && b.content?.startsWith('On the first recurring visit,'), 'welcome first visit');
  blocks[first] = { ...blocks[first], content: 'At your first visit, your technician will inspect the property and explain the next steps for your booked service.' };
  const tour = anchor(blocks, b => b.type === 'paragraph' && b.content?.startsWith('After service, you can review reports,'), 'welcome portal');
  blocks.splice(tour, 1,
    { type: 'paragraph', content: SETUP_COPY },
    { type: 'paragraph', content: SETUP_HELP },
    { type: 'paragraph', content: LAWN_NOTE });
  const cta = anchor(blocks, b => b.type === 'cta' && ['portal_url', 'customer_portal_url'].includes(b.url_variable), 'welcome button');
  blocks[cta] = { ...blocks[cta], label: 'Get started with the Waves app', url_variable: '', url: APP_PAGE };
  blocks.splice(cta + 1, 0, { type: 'small_note', content: `[Read the sign-in guide](${START_LINK}).` });
  return blocks;
}

function refreshAppIntro(blocks) {
  anchor(blocks, b => b.type === 'heading' && b.content === 'Watch your tech arrive — live', 'app tracking');
  anchor(blocks, b => b.type === 'heading' && b.content === 'Whatever you need — just ask Waves AI', 'app AI tour');
  // Replace the known tour while preserving staff-added blocks, the active
  // store badge artwork/URLs, signature, and already-installed note.
  const seedKeys = new Set(APP_V4.blocks.map(b => `${b.type}:${b.content || b.src || ''}`));
  for (const seed of APP_V4.blocks) {
    if (seed.type === 'signature' || ['app_store_url', 'play_store_url'].includes(seed.url_variable) || (seed.type === 'small_note' && seed.content?.startsWith('Already have the app?'))) continue;
    const key = `${seed.type}:${seed.content || seed.src || ''}`;
    if (!blocks.some(b => `${b.type}:${b.content || b.src || ''}` === key)) {
      throw new Error('App onboarding: edited app tour block; review the active template before publishing');
    }
  }
  const retained = blocks.filter(b =>
    !seedKeys.has(`${b.type}:${b.content || b.src || ''}`)
    || b.type === 'signature'
    || ['app_store_url', 'play_store_url'].includes(b.url_variable)
    || (b.type === 'small_note' && b.content?.startsWith('Already have the app?')));
  return [
    { type: 'heading', content: 'Your technician is on the way, {{first_name}}' },
    { type: 'paragraph', content: 'Follow along in the Waves app: the tracker appears at the top of Home on service day. You can also open Track live from your en-route text in the browser.' },
    { type: 'paragraph', content: 'The tracker may show how many stops are ahead of you, then an arrival countdown when your technician is driving to you. Route timing can change, and GPS sometimes needs to reconnect.' },
    { type: 'cta', label: 'Track your technician', url_variable: 'track_url' },
    { type: 'cta', label: 'Open the Waves app', url_variable: 'customer_portal_url' },
    { type: 'paragraph', content: 'Use the tracker’s TEXT button if the gate is locked, a pet is outside, or access instructions have changed. The button includes your technician’s name.' },
    { type: 'paragraph', content: 'After the visit, watch for your service report. It stays in Visits → Completed, with the treatment details and any re-entry instructions.' },
    { type: 'small_note', content: `[See the tracker guide](${TRACK_LINK}). New to the app? Download below and sign in with your account mobile number and texted code.` },
    ...retained,
  ];
}

function refreshAccepted(blocks) {
  const index = anchor(blocks, b => b.type === 'cta' && b.url_variable === 'customer_portal_url', 'accepted account button');
  const signature = blocks.findIndex(b => b.type === 'signature');
  blocks.splice(signature >= 0 && signature < index ? signature : index, 0, { type: 'paragraph', content: ACCEPTED_POINTER });
  return blocks;
}

function refreshReport(blocks) {
  const index = anchor(blocks, b => b.type === 'cta' && b.url_variable === 'report_url', 'full report button');
  blocks.splice(index + 1, 0,
    { type: 'paragraph', content: '{{first_report_note}}' },
    { type: 'cta', variant: 'link', label: 'How to read your report', url_variable: 'first_report_guide_url' });
  return blocks;
}

const UPDATES = {
  'welcome.new_recurring': {
    transform: refreshWelcome,
    subject: 'Your Waves app: start here',
    preview: 'Sign in with your phone number and find your first visit.',
    variables: [],
    fixture: { company_phone: '(941) 297-5749' },
  },
  'estimate.accepted_onboarding': {
    transform: refreshAccepted,
    variables: [],
    fixture: {},
  },
  app_intro: {
    transform: refreshAppIntro,
    subject: 'Your technician is on the way — follow along',
    preview: 'Follow the arrival estimate and text your technician from the tracker.',
    variables: ['track_url'],
    fixture: { track_url: `https://portal.wavespestcontrol.com/track/${'a'.repeat(64)}`, customer_portal_url: '' },
  },
  'service.report_ready': {
    transform: refreshReport,
    variables: ['first_report_note', 'first_report_guide_url'],
    fixture: {
      first_report_note: 'This is your first Waves report. Start with Ready to Re-enter where shown, then the service summary and Products Applied. Find your reports in Visits → Completed or Documents → Service Reports. Something worries you after we leave? Reply to this email or use Request in the app.',
      first_report_guide_url: REPORT_LINK,
    },
  },
};

function buildVersion(key, active) {
  const update = UPDATES[key];
  const blocks = update.transform(structuredClone(json(active.blocks, [])));
  // Explicit plaintext may contain staff edits outside the blocks. For the
  // two additive templates append only the new material. The two rewritten
  // tours require block-derived text (no custom plaintext override);
  // do not silently discard a custom plaintext version.
  let textBody = active.text_body;
  if (textBody && ['welcome.new_recurring', 'app_intro'].includes(key)) {
    throw new Error(`App onboarding: ${key} has custom plaintext; review it before publishing`);
  }
  if (textBody && key === 'estimate.accepted_onboarding') textBody += `\n\n${ACCEPTED_POINTER}`;
  if (textBody && key === 'service.report_ready') textBody += '\n\n{{first_report_note}}\n{{first_report_guide_url}}';
  return {
    subject: update.subject || active.subject,
    preview_text: update.preview || active.preview_text,
    blocks: JSON.stringify(blocks),
    text_body: textBody || null,
  };
}

async function publishUpdate(trx, key) {
  const template = await trx('email_templates').where({ template_key: key }).forUpdate().first();
  if (!template?.active_version_id) throw new Error(`App onboarding: ${key} has no active version`);
  const prior = await trx('email_template_versions').where({ template_id: template.id })
    .whereRaw("validation_snapshot->>'migration' = ?", [MIGRATION]).first('id');
  if (prior) return;
  const active = await trx('email_template_versions').where({ id: template.active_version_id, template_id: template.id }).first();
  if (!active) throw new Error(`App onboarding: ${key} active version is missing`);
  const versionFields = buildVersion(key, active);
  const variables = UPDATES[key].variables;
  const allowed = [...new Set([...json(template.allowed_variables, []), ...variables])];
  const validation = validationFor({ ...template, allowed_variables: allowed }, versionFields);
  if (!validation.ok) throw new Error(`App onboarding: ${key} version failed variable validation`);
  versionFields.validation_snapshot = JSON.stringify({ ...validation, migration: MIGRATION });
  const latest = await trx('email_template_versions').where({ template_id: template.id }).max('version_number as max').first();
  const [version] = await trx('email_template_versions').insert({
    ...versionFields, template_id: template.id, version_number: Number(latest?.max || 0) + 1,
    status: 'active', published_at: new Date(),
  }).returning('id');
  await trx('email_templates').where({ id: template.id }).update({
    allowed_variables: JSON.stringify(allowed),
    optional_variables: JSON.stringify([...new Set([...json(template.optional_variables, []), ...variables])]),
    active_version_id: version.id, last_published_at: new Date(), updated_at: new Date(),
  });
  if (await trx.schema.hasTable('email_template_fixtures')) {
    const fixtures = await trx('email_template_fixtures').where({ template_id: template.id });
    for (const fixture of fixtures) {
      const payload = { ...UPDATES[key].fixture, ...json(fixture.payload, {}) };
      // Existing default app fixtures point to Home; when the new track URL
      // is present, mirror the sender's single-primary-button choice.
      if (key === 'app_intro' && payload.track_url) payload.customer_portal_url = '';
      if (key === 'service.report_ready' && payload.first_report_note) payload.pressure_summary = '';
      await trx('email_template_fixtures').where({ id: fixture.id }).update({ payload: JSON.stringify(payload), updated_at: new Date() });
    }
    const base = json(fixtures.find(f => f.is_default)?.payload || fixtures[0]?.payload, {});
    const examples = {
      app_intro: [['Tracker unavailable — app login', { track_url: '', customer_portal_url: 'https://portal.wavespestcontrol.com/login' }]],
      'service.report_ready': [
        ['Later report — no introduction', { first_report_note: '', first_report_guide_url: '' }],
        ['First lawn report', {
          service_label: 'Lawn Care', pressure_summary: '',
          finding_summary: 'Lawn score baseline recorded.', application_summary: 'Two lawn applications documented.',
          first_report_note: 'This is your first Waves report. Your lawn score sets a baseline; progress charts develop after at least two scored visits. Find your reports in Visits → Completed or Documents → Service Reports. Something worries you after we leave? Reply to this email or use Request in the app.',
          first_report_guide_url: REPORT_LINK,
        }],
      ],
    };
    for (const [name, payload] of examples[key] || []) {
      if (!fixtures.some(f => f.name === name)) await trx('email_template_fixtures').insert({
        template_id: template.id, name, is_default: false,
        payload: JSON.stringify({ ...base, ...payload }), updated_at: new Date(),
      });
    }
  }
  await recordAuditEvent({
    actor_type: 'system', action: `migration:${MIGRATION}:publish`,
    resource_type: 'email_template', resource_id: template.id,
    metadata: { template_key: key, prior_version_id: active.id, version_id: version.id },
    critical: true, trx,
  });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  await knex.transaction(async trx => {
    for (const key of Object.keys(UPDATES)) await publishUpdate(trx, key);
  });
};

exports.down = async function down() {
  // No destructive rollback of staff-editable template versions or audits.
};

exports.buildVersion = buildVersion;
exports.UPDATES = UPDATES;
