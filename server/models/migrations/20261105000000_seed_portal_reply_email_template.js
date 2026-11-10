'use strict';

/**
 * Seed the portal reply email (template_key 'portal_reply'), owner 2026-11-04, "lets build it out" (answer
 * customers inside the portal), dark behind GATE_PORTAL_MESSAGES.
 *
 * The office answers a customer's portal ask from Admin > Communications > Portal ("Reply in portal"). The
 * answer is saved in the customer's portal thread and the customer gets one notice: a push to the Waves app,
 * or, when no app device took the push, this email (services/account-membership-email.js sendPortalReply)
 * with the whole answer and a link to the portal's Messages page. A staff member pressed Send on the exact
 * text in {{reply_body}}; nothing sends this on its own.
 *
 * Insert-only: an existing template is left alone, so a re-run never overwrites an office edit. Each inserted
 * template writes one audit_log row. down() is a documented no-op: the template may carry office edits by
 * then, and with the gate off nothing sends it. Retire it from the template editor.
 *
 * The template row carries the service stream and suppression group like the moving email
 * (20261102120100). The send goes through the same account email path (account-membership-email.js
 * sendTemplate): the same recipient checks and the portal "Email Messages" switch.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';
const MIGRATION_ID = '20261105000000_seed_portal_reply_email_template';
const AUDIT_ACTION = 'email_template.seeded';

const SHARED_VARIABLES = ['first_name', 'customer_portal_url', 'company_phone', 'company_email'];

const TEMPLATE = {
  key: 'portal_reply',
  name: 'Portal Reply',
  description: 'Sent when the office answers a customer in the portal and the Waves app did not take the push: the whole answer and a link to the Messages page.',
  required: ['first_name', 'reply_body', 'messages_url'],
  optional: [],
  subject: 'Your answer from Waves Pest Control',
  preview: 'We answered your question. You can read it and write back in your Waves portal.',
  blocks: [
    { type: 'heading', content: 'Hi {{first_name}}, here is our answer' },
    { type: 'callout', content: '{{reply_body}}' },
    { type: 'paragraph', content: 'You can read it again and write back on the Messages page of your Waves portal.' },
    { type: 'cta', label: 'Open Messages', url_variable: 'messages_url' },
    { type: 'small_note', content: 'Rather talk? Call or text us at {{company_phone}}.' },
    { type: 'signature', content: 'The Waves Team' },
  ],
};

const PREVIEW_PAYLOAD = {
  first_name: 'Stan',
  reply_body: 'Yes, we can bundle the two. Quarterly Pest Control Service with lawn care every 6 weeks comes to a lower monthly price, and we can keep the pest visits to the outside of the home.',
  messages_url: 'https://portal.wavespestcontrol.com/?tab=messages',
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
        reason: 'Portal reply email: the office answer from the Portal tab when the app push did not land (owner 2026-11-04)',
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
