'use strict';

/**
 * UPDATED ESTIMATE WORDING templates (owner 2026-11-04 "updated"; GATE_ESTIMATE_UPDATED_WORDING, dark).
 * Data only, no schema.
 *
 * Seeds the two templates a corrected estimate's send uses (services/estimate-updated-wording.js). Each is inserted
 * only when its key is absent, so a re-run, or a row an admin made first, is never overwritten:
 * - sms_templates `estimate_updated`: the live `estimate_sent` body with "your Waves estimate" read as "your updated
 *   Waves estimate" (DEFAULT_SMS_BODY when the live body has no such phrase or no {estimate_url}). Same category,
 *   variables and event; sorted right after it, so the office sees and edits the two side by side.
 * - email template `estimate.updated_delivery`: the settings of `estimate.delivery` and ONE active version copied from
 *   its active version, with the subject, preview line and first sentence saying "updated". A live copy without that
 *   first sentence (or with a custom plain-text body) gets DEFAULT_BLOCKS instead. Its default fixture is the source's.
 * The send reads them only with the gate on, and an inactive text or a non-active email template sends the normal
 * one. Each inserted row writes one audit_log row (before: null, after: its words). `down` is a documented no-op: by
 * then the rows may carry sends (email_messages) and admin edits.
 */

const MIGRATION = '20261105040000';
const MARKER = `migration:${MIGRATION}`;
const MIGRATION_ID = '20261105040000_estimate_updated_wording_templates';
const REASON = 'Corrected estimate says "updated" (owner 2026-11-04, GATE_ESTIMATE_UPDATED_WORDING)';

const SMS_KEY = 'estimate_updated';
const SMS_SOURCE_KEY = 'estimate_sent';
const DEFAULT_SMS_BODY = 'Hi {first_name}, your updated Waves estimate is ready: {estimate_url}\n\nReply STOP to opt out.';

const EMAIL_KEY = 'estimate.updated_delivery';
const EMAIL_SOURCE_KEY = 'estimate.delivery';
const FIRST_SENTENCE = 'your customized Waves estimate is ready for review.';
const UPDATED_SENTENCE = 'your updated Waves estimate is ready for review. It replaces the one we sent before.';
const DEFAULT_SUBJECT = 'Your updated Waves estimate is ready';
const DEFAULT_PREVIEW = 'Review your updated estimate, what is included, and the next step.';
const DEFAULT_BLOCKS = [
  { type: 'paragraph', content: `Hi {{first_name}}, ${UPDATED_SENTENCE}` },
  { type: 'details', rows: [
    { label: 'Service', value: '{{service_summary}}' },
    { label: 'Property', value: '{{property_address}}' },
    { label: 'Estimated price', value: '{{price_summary}}' },
  ] },
  { type: 'paragraph', content: 'Inside the estimate you can review the service breakdown, compare any available options, and choose the plan or visit that fits your home.' },
  { type: 'paragraph', content: '{{next_step_summary}}' },
  { type: 'cta', label: 'View estimate', url_variable: 'estimate_url' },
  { type: 'paragraph', content: '{{estimate_pdf_note}}' },
  { type: 'small_note', content: 'Questions, timing concerns, or changes to the property details? Reply here and our team will help before you accept.' },
];
// The estimate.delivery settings the copy keeps (its name, description and status are its own).
const TEMPLATE_COLUMNS = ['mode', 'purpose', 'legal_classification', 'audience', 'message_priority', 'content_sensitivity',
  'send_stream', 'suppression_group_key', 'layout_wrapper_id', 'from_name', 'from_email', 'reply_to', 'default_cta_label',
  'default_cta_url_variable'];
const VARIABLE_COLUMNS = ['allowed_variables', 'required_variables', 'optional_variables'];

function json(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
}

// Pure: the live text with its first "your Waves estimate" read as "your updated Waves estimate" (either case).
function updatedSmsBody(liveBody) {
  const body = typeof liveBody === 'string' ? liveBody : '';
  const phrase = /\b([Yy])our Waves estimate\b/;
  if (!phrase.test(body) || !body.includes('{estimate_url}')) return DEFAULT_SMS_BODY;
  return body.replace(phrase, (_match, y) => `${y}our updated Waves estimate`);
}

// Pure: the live blocks with the first sentence saying "updated"; null when no paragraph carries that sentence.
// The input is never mutated.
function updatedBlocks(blocksIn) {
  if (!Array.isArray(blocksIn)) return null;
  let changed = false;
  const blocks = blocksIn.map((b) => {
    if (!changed && b && typeof b === 'object' && b.type === 'paragraph'
      && typeof b.content === 'string' && b.content.includes(FIRST_SENTENCE)) {
      changed = true;
      return { ...b, content: b.content.replace(FIRST_SENTENCE, UPDATED_SENTENCE) };
    }
    return b;
  });
  return changed ? blocks : null;
}

function updatedSubject(subject) {
  const s = typeof subject === 'string' ? subject : '';
  return /\bYour Waves estimate\b/.test(s) ? s.replace(/\bYour Waves estimate\b/, 'Your updated Waves estimate') : DEFAULT_SUBJECT;
}

function updatedPreview(preview) {
  const p = typeof preview === 'string' ? preview : '';
  return /\byour service estimate\b/.test(p) ? p.replace(/\byour service estimate\b/, 'your updated estimate') : DEFAULT_PREVIEW;
}

// Pure: the version to publish from the source's active version (null = none): copied text, or the defaults.
function updatedVersion(prior) {
  const copied = prior ? updatedBlocks(json(prior.blocks, null)) : null;
  const customText = prior?.text_body != null && String(prior.text_body).trim() !== '';
  return {
    subject: prior ? updatedSubject(prior.subject) : DEFAULT_SUBJECT,
    preview_text: prior ? updatedPreview(prior.preview_text) : DEFAULT_PREVIEW,
    blocks: copied && !customText ? copied : DEFAULT_BLOCKS,
    copiedBlocks: Boolean(copied && !customText),
  };
}

// Each seed returns { status } plus, when it inserted, what the audit row names.
async function seedSms(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return { status: 'no_table' };
  if (await knex('sms_templates').where({ template_key: SMS_KEY }).first()) return { status: 'already' };
  const source = await knex('sms_templates').where({ template_key: SMS_SOURCE_KEY }).first();
  const variables = json(source?.variables, null);
  const row = {
    template_key: SMS_KEY,
    name: 'Estimate Updated',
    category: source?.category || 'estimates',
    body: updatedSmsBody(source?.body),
    description: 'Sent instead of Estimate Sent when an estimate the customer already received goes out again after its services, address or price changed (GATE_ESTIMATE_UPDATED_WORDING). Turn it off to send Estimate Sent.',
    variables: JSON.stringify(Array.isArray(variables) ? variables : ['first_name', 'estimate_url']),
    is_active: true,
    sort_order: Number.isFinite(Number(source?.sort_order)) ? Number(source.sort_order) + 1 : 21,
  };
  if (await knex.schema.hasColumn('sms_templates', 'is_internal')) row.is_internal = false;
  if (await knex.schema.hasColumn('sms_templates', 'trigger_event_key')) row.trigger_event_key = source?.trigger_event_key || null;
  const [inserted] = await knex('sms_templates').insert(row).returning('*');
  return { status: 'seeded', row: inserted };
}

async function seedEmail(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return { status: 'no_table' };
  if (await knex('email_templates').where({ template_key: EMAIL_KEY }).first()) return { status: 'already' };
  const source = await knex('email_templates').where({ template_key: EMAIL_SOURCE_KEY }).first();
  if (!source) {
    console.warn(`[${MARKER}] ${EMAIL_SOURCE_KEY} missing; ${EMAIL_KEY} not seeded (the send keeps the normal email)`);
    return { status: 'no_source' };
  }
  const prior = source.active_version_id
    ? await knex('email_template_versions').where({ id: source.active_version_id }).first()
    : null;
  const version = updatedVersion(prior);
  const now = new Date();
  const template = {
    template_key: EMAIL_KEY,
    name: 'Updated Estimate Delivery',
    description: 'Sent instead of Estimate Delivery when an estimate the customer already received goes out again after its services, address or price changed (GATE_ESTIMATE_UPDATED_WORDING). A status other than active sends Estimate Delivery.',
    status: 'active',
  };
  for (const col of TEMPLATE_COLUMNS) template[col] = source[col];
  const variables = Object.fromEntries(VARIABLE_COLUMNS.map((col) => [col, json(source[col], [])]));
  const { validationFor } = require('../../services/email-template-library');
  const validation = validationFor({ ...template, ...variables }, version);
  if (!validation.ok) {
    console.warn(`[${MARKER}] ${EMAIL_KEY}: the copied version failed variable validation; not seeded`);
    return { status: 'skipped' };
  }
  const [inserted] = await knex('email_templates').insert({
    ...template,
    ...Object.fromEntries(VARIABLE_COLUMNS.map((col) => [col, JSON.stringify(variables[col])])),
    last_published_at: now,
  }).returning('*');
  const [published] = await knex('email_template_versions').insert({
    template_id: inserted.id,
    version_number: 1,
    status: 'active',
    subject: version.subject,
    preview_text: version.preview_text,
    blocks: JSON.stringify(version.blocks),
    text_body: null,
    validation_snapshot: JSON.stringify({
      ...validation, source: MARKER, copied_from: prior ? `${EMAIL_SOURCE_KEY} v${prior.version_number}` : null, copied_blocks: version.copiedBlocks,
    }),
    published_at: now,
  }).returning('*');
  await knex('email_templates').where({ id: inserted.id }).update({ active_version_id: published.id, updated_at: now });
  if (await knex.schema.hasTable('email_template_fixtures')) {
    const fixture = await knex('email_template_fixtures').where({ template_id: source.id, is_default: true }).first();
    await knex('email_template_fixtures').insert({
      template_id: inserted.id,
      name: fixture?.name || 'Happy path',
      payload: JSON.stringify(json(fixture?.payload, {})),
      is_default: true,
    });
  }
  return {
    status: version.copiedBlocks ? 'seeded' : 'seeded_default',
    template: inserted,
    version: published,
    copiedFrom: prior ? `${EMAIL_SOURCE_KEY} v${prior.version_number}` : null,
  };
}

exports.up = async function up(knex) {
  await knex.transaction(async (trx) => {
    const sms = await seedSms(trx);
    const email = await seedEmail(trx);
    console.log(`[${MARKER}] ${SMS_KEY}: ${sms.status}; ${EMAIL_KEY}: ${email.status}`);
    if (!(await trx.schema.hasTable('audit_log'))) return;
    const { recordAuditEvent } = require('../../services/audit-log');
    if (sms.row) {
      await recordAuditEvent({
        actor_type: 'system',
        action: 'sms_template.seeded',
        resource_type: 'sms_template',
        resource_id: String(sms.row.id),
        critical: true,
        trx,
        metadata: {
          migration: MIGRATION_ID, template_key: SMS_KEY, reason: REASON,
          changes: { created: { before: null, after: { body: sms.row.body, is_active: sms.row.is_active } } },
        },
      });
    }
    if (email.template) {
      await recordAuditEvent({
        actor_type: 'system',
        action: 'email_template.seeded',
        resource_type: 'email_template',
        resource_id: String(email.template.id),
        critical: true,
        trx,
        metadata: {
          migration: MIGRATION_ID, template_key: EMAIL_KEY, reason: REASON, copied_from: email.copiedFrom,
          to_version_id: email.version.id, to_version_number: email.version.version_number,
          changes: { created: { before: null, after: { subject: email.version.subject, preview_text: email.version.preview_text, blocks: json(email.version.blocks, []) } } },
        },
      });
    }
  });
};

exports.down = async function down() {
  // Data-only seed: by now the rows may carry sends and admin edits. Turning them off is the rollback (the SMS row's
  // Active toggle; the email template's status), and with GATE_ESTIMATE_UPDATED_WORDING unset neither is read.
};

exports._test = { updatedSmsBody, updatedBlocks, updatedSubject, updatedPreview, updatedVersion, seedSms, seedEmail, DEFAULT_SMS_BODY, DEFAULT_BLOCKS, MARKER };
