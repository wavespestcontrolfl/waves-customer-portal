'use strict';

/**
 * Seed the moving email (template_key 'moving_link'), owner 2026-11-02, "a
 * moving email where they can do it", dark behind GATE_MOVING_FLOW.
 *
 * The office sends it by hand from the Customer 360 Moving card
 * (services/account-membership-email.js sendMovingLink). It points at the
 * customer's /moving/:token page, where they enter a new address and move
 * dates. The words carry no price and no street address: the move is priced
 * later, on an estimate page the customer approves.
 *
 * Insert-only: an existing template is left alone, so a re-run never
 * overwrites an office edit. Each inserted template writes one audit_log row.
 * down() is a documented no-op: the template may carry office edits by then,
 * and with the gate off nothing sends it. Retire it from the template editor.
 *
 * The template row carries the service stream and suppression group like the
 * app intro email (20260626000004). The send itself goes through the same
 * account email path as the app intro (account-membership-email.js
 * sendTemplate): the same recipient checks and the portal "Email Messages"
 * switch.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';
const MIGRATION_ID = '20261102120100_seed_moving_link_email_template';
const AUDIT_ACTION = 'email_template.seeded';

const SHARED_VARIABLES = ['first_name', 'customer_portal_url', 'company_phone', 'company_email'];

const TEMPLATE = {
  key: 'moving_link',
  name: 'Moving Link',
  description: 'Sent by the office on a staff click: the link where a customer enters a new address and move dates.',
  required: ['first_name', 'moving_url'],
  optional: [],
  subject: 'Moving, {{first_name}}? Bring your Waves plan with you',
  preview: 'Tell us your new address and move dates. Your WaveGuard level comes with you.',
  blocks: [
    { type: 'heading', content: 'Moving soon, {{first_name}}?' },
    { type: 'paragraph', content: 'Tell us your new address and when you move. We will price your new home and show you before anything changes.' },
    { type: 'paragraph', content: 'Your WaveGuard level comes with you, and there is no setup fee at the new home.' },
    { type: 'cta', label: 'Tell us about your move', url_variable: 'moving_url' },
    { type: 'small_note', content: 'Not sure of the address yet? Add your move dates now and the address later, with the same link.' },
    { type: 'signature', content: 'The Waves Team' },
  ],
};

const PREVIEW_PAYLOAD = {
  first_name: 'Stan',
  moving_url: 'https://portal.wavespestcontrol.com/moving/0123456789abcdef0123456789abcdef0123456789abcdef',
  customer_portal_url: 'https://portal.wavespestcontrol.com/login',
  company_phone: '(941) 555-0000',
  company_email: SERVICE_FROM,
};

function templateRow(t) {
  const allowed = [...new Set([...SHARED_VARIABLES, ...t.required, ...t.optional])];
  const required = [...new Set(t.required)];
  const optional = allowed.filter((key) => !required.includes(key));
  return {
    template_key: t.key,
    name: t.name,
    description: t.description,
    mode: 'service',
    purpose: 'service',
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
    default_cta_label: null,
    default_cta_url_variable: null,
    allowed_variables: JSON.stringify(allowed),
    required_variables: JSON.stringify(required),
    optional_variables: JSON.stringify(optional),
    status: 'active',
  };
}

async function insertTemplate(trx, t, hasFixtures) {
  if (await trx('email_templates').where({ template_key: t.key }).first('id')) return null;
  const now = new Date();
  const [template] = await trx('email_templates').insert({ ...templateRow(t), created_at: now, updated_at: now }).returning('*');
  const [version] = await trx('email_template_versions').insert({
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
  await trx('email_templates').where({ id: template.id }).update({
    active_version_id: version.id,
    last_published_at: now,
    updated_at: now,
  });
  if (hasFixtures) {
    await trx('email_template_fixtures').insert({
      template_id: template.id, name: 'Happy path', payload: JSON.stringify(PREVIEW_PAYLOAD), is_default: true,
      created_at: now, updated_at: now,
    });
  }
  return { template, version };
}

exports.up = async function up(knex) {
  const hasTables = await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions');
  if (!hasTables) return;
  const hasFixtures = await knex.schema.hasTable('email_template_fixtures');
  const { recordAuditEvent } = require('../../services/audit-log');
  await knex.transaction(async (trx) => {
    const created = await insertTemplate(trx, TEMPLATE, hasFixtures);
    if (!created) return;
    await recordAuditEvent({
      actor_type: 'system',
      action: AUDIT_ACTION,
      resource_type: 'email_template',
      resource_id: created.template.id,
      critical: true,
      trx,
      metadata: {
        migration: MIGRATION_ID,
        template_key: TEMPLATE.key,
        to_version_id: created.version.id,
        to_version_number: created.version.version_number,
        reason: 'Moving email: a link to enter a new address and move dates (owner 2026-11-02)',
        changes: { created: { before: null, after: { subject: TEMPLATE.subject, blocks: TEMPLATE.blocks } } },
      },
    });
  });
};

exports.down = async function down() {
  // No-op on purpose (see the header): rollback must not delete admin-owned content.
};

exports.AUDIT_ACTION = AUDIT_ACTION;
exports.__private = { TEMPLATE, PREVIEW_PAYLOAD, templateRow };
