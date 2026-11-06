'use strict';

/**
 * GATE_DAY_ONLY_PROMISE part B2 (owner 2026-11-05 "D2 a", 2026-11-06 "office"): until the 24-hour reminder a customer is
 * promised only the DAY of a visit. With the gate on, a move notice (an office move to another date, a customer move
 * that chose "any time that day", a rain move, a series move) of a visit more than 24.25 h out uses the rows below
 * instead of the window rows. Nothing reads them while the gate is off (services/day-only-move-notice.js).
 *
 * Seeds (each only when its key is absent, so a re-run, or a row an administrator made or edited first, is never
 * overwritten; each seeded row writes one audit event):
 *  - sms_templates appointment_rescheduled_day_v1: the reschedule text (appointment_rescheduled's day twin).
 *  - sms_templates rain_out_moved_day_v1: the short rain-out moved text (rain_out_moved_v3's day twin).
 *  - sms_templates appointment_series_rescheduled_day_v1 and appointment_recurring_placement_confirmed_day_v1: the two
 *    series notices, each saying "We'll text the arrival window the day before each visit."
 *  - email template appointment.rescheduled_day: the same words by email (no hour anywhere). The send still records the
 *    event type appointment.rescheduled, which the no-show detector reads.
 * None of the bodies carries {window} or {time}: a day row that quoted an hour would break the promise it exists for.
 * A missing, disabled or unrenderable day row sends today's window copy instead (a customer always gets a message).
 * Texts say "Waves", never "Waves Pest Control" (owner 2026-11-04); GSM-7 only (straight apostrophes).
 *
 * The column scheduled_services.customer_asked_time is B1's migration (20261106120000); this one adds no column.
 *
 * Idempotent. down() is a documented no-op: the rows may carry edits and sends, and with the gate off nothing reads them.
 */

const MIGRATION_ID = '20261106130000_day_only_move_templates';
const REASON = 'Day-only move copy (owner 2026-11-05 "D2 a", GATE_DAY_ONLY_PROMISE)';

const SMS_TEMPLATES = [
  {
    key: 'appointment_rescheduled_day_v1',
    name: 'Appointment Rescheduled - Day Only',
    baseKeys: ['appointment_rescheduled'],
    category: 'service',
    body: "Hi {first_name}, your Waves {service_type} is now {day}, {date}. We'll text your arrival window the day before.\n\n{different_time_line}",
    variables: ['first_name', 'service_type', 'day', 'date', 'different_time_line'],
  },
  {
    key: 'rain_out_moved_day_v1',
    name: 'Rain Out - Appointment Moved (Day Only)',
    baseKeys: ['rain_out_moved_v3', 'rain_out_moved_v2'],
    category: 'service',
    body: "Hi {first_name} - {weather_lead}, so we moved your {service_type} to {new_option}. We'll text your arrival window the day before.{link_clause}\n\nQuestions? Reply here. Reply STOP to opt out.",
    variables: ['first_name', 'weather_lead', 'service_type', 'new_option', 'link_clause'],
  },
  {
    key: 'appointment_series_rescheduled_day_v1',
    name: 'Series Rescheduled - Day Only',
    baseKeys: ['appointment_series_rescheduled'],
    category: 'service',
    body: "Hi {first_name}, your recurring Waves visits now start {start_date}.\n\nWe'll text the arrival window the day before each visit.",
    variables: ['first_name', 'start_date'],
  },
  {
    key: 'appointment_recurring_placement_confirmed_day_v1',
    name: 'Recurring Placement Confirmed - Day Only',
    baseKeys: ['appointment_recurring_placement_confirmed'],
    category: 'service',
    body: "Hi {first_name}, your next Waves {service_name} is {start_date}.\n\nWe'll text the arrival window the day before each visit.",
    variables: ['first_name', 'service_name', 'start_date'],
  },
];

const SERVICE_FROM = 'contact@wavespestcontrol.com';
const SHARED_EMAIL_VARIABLES = ['first_name', 'customer_name', 'customer_portal_url', 'company_phone', 'company_email'];
const EMAIL_PREVIEW_PAYLOAD = {
  first_name: 'Stan',
  customer_name: 'Stan Example',
  customer_portal_url: 'https://portal.wavespestcontrol.com/login',
  company_phone: '(941) 555-0000',
  company_email: SERVICE_FROM,
  service_type: 'Quarterly Pest Control',
  appointment_day: 'Tuesday',
  appointment_date: 'June 23, 2026',
  property_label: 'Primary property',
  card_hold_policy_note: '',
};

const EMAIL_TEMPLATES = [
  {
    key: 'appointment.rescheduled_day',
    name: 'Appointment Rescheduled - Day Only',
    description: 'Email version of the day-only reschedule text (GATE_DAY_ONLY_PROMISE): the day, no hour. Sent in place of Appointment Rescheduled; a status other than active sends Appointment Rescheduled.',
    required: ['first_name', 'service_type', 'appointment_day', 'appointment_date'],
    optional: ['property_label'],
    subject: 'Your Waves appointment has a new day',
    preview: 'Your Waves service appointment has moved to a new day.',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}},' },
      { type: 'paragraph', content: 'Your {{service_type}} with Waves is now {{appointment_day}}, {{appointment_date}}.' },
      { type: 'details', rows: [
        { label: 'Service', value: '{{service_type}}' },
        { label: 'Day', value: '{{appointment_day}}' },
        { label: 'Date', value: '{{appointment_date}}' },
        { label: 'Property', value: '{{property_label}}' },
      ] },
      { type: 'paragraph', content: "We'll send your arrival window the day before." },
      { type: 'small_note', content: 'Need a different day or a set time? Reply to this email or call {{company_phone}} and we will help.' },
      { type: 'cta', label: 'View appointment', url_variable: 'customer_portal_url' },
      { type: 'signature', content: 'Thank you, The Waves Team' },
    ],
  },
];

async function seedSms(knex, t) {
  if (await knex('sms_templates').where({ template_key: t.key }).first('id')) return null;
  let base = null;
  for (const key of t.baseKeys) {
    base = await knex('sms_templates').where({ template_key: key }).first('category', 'sort_order');
    if (base) break;
  }
  const row = {
    template_key: t.key,
    name: t.name,
    category: base?.category || t.category,
    body: t.body,
    variables: JSON.stringify(t.variables),
    sort_order: Number.isFinite(Number(base?.sort_order)) ? Number(base.sort_order) + 1 : 99,
    is_active: true,
  };
  const [inserted] = await knex('sms_templates').insert(row).returning(['id', 'body', 'is_active']);
  return inserted || null;
}

function emailTemplateRow(t) {
  const allowed = [...new Set([...SHARED_EMAIL_VARIABLES, ...t.required, ...t.optional])];
  const required = [...new Set(t.required)];
  return {
    template_key: t.key,
    name: t.name,
    description: t.description,
    mode: 'service',
    purpose: 'appointment',
    legal_classification: 'transactional_relationship',
    audience: 'customer',
    message_priority: 'normal',
    content_sensitivity: 'service',
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
    optional_variables: JSON.stringify(allowed.filter((key) => !required.includes(key))),
    status: 'active',
  };
}

async function seedEmail(knex, t, hasFixtures) {
  if (await knex('email_templates').where({ template_key: t.key }).first('id')) return null;
  const now = new Date();
  const [template] = await knex('email_templates').insert({ ...emailTemplateRow(t), created_at: now, updated_at: now }).returning('*');
  const [version] = await knex('email_template_versions').insert({
    template_id: template.id,
    version_number: 1,
    status: 'active',
    subject: t.subject,
    preview_text: t.preview,
    blocks: JSON.stringify(t.blocks),
    text_body: null,
    published_at: now,
    created_at: now,
    updated_at: now,
  }).returning('*');
  await knex('email_templates').where({ id: template.id }).update({
    active_version_id: version.id, last_published_at: now, updated_at: now,
  });
  if (hasFixtures) {
    await knex('email_template_fixtures').insert({
      template_id: template.id, name: 'Happy path', payload: JSON.stringify(EMAIL_PREVIEW_PAYLOAD), is_default: true,
      created_at: now, updated_at: now,
    });
  }
  return { template, version };
}

async function audit(knex, action, resourceType, id, key, after) {
  const { recordAuditEvent } = require('../../services/audit-log');
  await recordAuditEvent({
    actor_type: 'system', action, resource_type: resourceType, resource_id: String(id), critical: true, trx: knex,
    metadata: { migration: MIGRATION_ID, template_key: key, reason: REASON, changes: { created: { before: null, after } } },
  });
}

async function seedAllSms(knex, hasAudit) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  for (const t of SMS_TEMPLATES) {
    const row = await seedSms(knex, t);
    if (row && hasAudit) await audit(knex, 'sms_template.seeded', 'sms_template', row.id, t.key, { body: t.body, is_active: true });
  }
}

async function seedAllEmail(knex, hasAudit) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  const hasFixtures = await knex.schema.hasTable('email_template_fixtures');
  for (const t of EMAIL_TEMPLATES) {
    const made = await seedEmail(knex, t, hasFixtures);
    if (made && hasAudit) {
      await audit(knex, 'email_template.seeded', 'email_template', made.template.id, t.key,
        { subject: t.subject, preview_text: t.preview, blocks: t.blocks });
    }
  }
}

exports.up = async function up(knex) {
  const hasAudit = await knex.schema.hasTable('audit_log');
  await knex.transaction(async (trx) => {
    await seedAllSms(trx, hasAudit);
    await seedAllEmail(trx, hasAudit);
  });
};

exports.down = async function down() {
  // The rows stay (documented no-op: they may carry edits and sends; with the gate off nothing reads them).
};

exports._test = { SMS_TEMPLATES, EMAIL_TEMPLATES, EMAIL_PREVIEW_PAYLOAD, emailTemplateRow, MIGRATION_ID };
