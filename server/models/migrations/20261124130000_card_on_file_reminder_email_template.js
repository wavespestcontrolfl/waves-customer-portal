/**
 * Seed the "add a card" reminder email (payment.card_on_file_reminder): sent 3 days after a customer's last usable
 * payment method was removed or expired, only while they still have none, still have an upcoming visit or an open
 * invoice, and the other send-time checks in services/card-on-file-reminder.js hold. Owner 2026-11-24 ("go with your
 * recs"), dark behind GATE_CARD_ON_FILE_REMINDER (shadow, then true: the owner flips it). The subject, preview and
 * body copy are the owner's approved words, kept exact.
 *
 * Same shape as 20261116120000_seed_ach_failure_email_templates: service mode, transactional_required stream, the
 * transactional preference group first (inserted only when missing), one active version, one preview fixture, one
 * email_template.seeded audit event. Insert-only: a template row is inserted only when its key is absent and its
 * version only when it has no active version, so a re-run never overwrites an operator's edits. down() is a
 * documented NO-OP: once seeded the template is admin-editable, and removing it on rollback would destroy those
 * edits; the sender is dark behind its gate, so an unused template row is inert.
 *
 * Payload contract (services/payment-lifecycle-email.js sendCardOnFileReminder): first_name, property_label and
 * card_url are required; next_visit_date is optional and its details row renders nothing when it is blank (an
 * account with only an open invoice has no next visit). card_url opens the billing tab's Add card form in save-only
 * mode, so adding a card from this email never turns Auto Pay on.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';

const EMAIL_TEMPLATES = [
  {
    key: 'payment.card_on_file_reminder',
    name: 'Card On File Reminder',
    description: 'Sent 3 days after a customer\'s last usable payment method was removed or expired, while they still have none and a visit or an unpaid invoice is open. Adding a card from it never turns Auto Pay on.',
    required: ['first_name', 'property_label', 'card_url'],
    optional: ['next_visit_date'],
    subject: 'Your Waves account has no card on file',
    preview: 'Your next visit is still on. Here is how you want to pay for it.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}},' },
      { type: 'paragraph', content: 'Your Waves visits at {{property_label}} are still on the schedule. Your account has no card on file now.' },
      { type: 'details', rows: [{ label: 'Next visit', value: '{{next_visit_date}}' }] },
      { type: 'paragraph', content: 'After the visit, we send you an invoice to pay by card, bank or check. If you want to keep a card on file, you can add one here.' },
      { type: 'cta', label: 'Add a card', url_variable: 'card_url' },
      { type: 'small_note', content: 'Adding a card does not turn Auto Pay on. Auto Pay starts only if you choose it on the next screen.' },
      { type: 'signature', content: '— The Waves Team' },
    ],
  },
];

const SHARED_EMAIL_VARIABLES = [
  'first_name',
  'customer_name',
  'customer_portal_url',
  'company_phone',
  'company_email',
];

// Synthetic values only (no real customer, address or date).
const PREVIEW_PAYLOAD = {
  first_name: 'Stan',
  customer_name: 'Stan Example',
  customer_portal_url: 'https://portal.wavespestcontrol.com/?tab=billing',
  property_label: '123 Example Street, Bradenton, FL 34205',
  next_visit_date: 'December 2, 2026',
  card_url: 'https://portal.wavespestcontrol.com/?tab=billing&add_card=1',
  company_phone: '(941) 318-7612',
  company_email: SERVICE_FROM,
};

function emailTemplateRow(t) {
  const allowed = [...new Set([...SHARED_EMAIL_VARIABLES, ...t.required, ...t.optional])];
  const required = [...new Set(t.required)];
  const optional = allowed.filter((key) => !required.includes(key));
  return {
    template_key: t.key,
    name: t.name,
    description: t.description,
    mode: 'service',
    purpose: 'payment',
    legal_classification: 'transactional_relationship',
    audience: 'customer',
    message_priority: 'normal',
    content_sensitivity: 'financial',
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

const MIGRATION = '20261124130000_card_on_file_reminder_email_template';

// Inserted only when missing: the group already exists in production (every transactional_required template uses
// it), and an operator's edits to it are never rewritten.
async function ensureTransactionalGroup(knex) {
  if (!(await knex.schema.hasTable('email_preference_groups'))) return;
  const existing = await knex('email_preference_groups').where({ key: 'transactional_required' }).first();
  if (existing) return;
  await knex('email_preference_groups').insert({
    key: 'transactional_required',
    name: 'Required account notices',
    description: 'Security, payment, legal, and account notices that must reach the customer.',
    send_stream: 'transactional_required',
    user_can_unsubscribe: false,
    sort_order: 10,
    created_at: new Date(),
    updated_at: new Date(),
  });
}

async function seedEmailTemplate(knex, definition) {
  let template = await knex('email_templates').where({ template_key: definition.key }).first();
  if (!template) {
    [template] = await knex('email_templates').insert({ ...emailTemplateRow(definition), created_at: new Date() }).returning('*');
  }
  if (template.active_version_id) return; // seeded already: never overwrite operator edits
  const latest = await knex('email_template_versions').where({ template_id: template.id }).max('version_number as max').first();
  const [version] = await knex('email_template_versions').insert({
    template_id: template.id,
    version_number: Number(latest?.max || 0) + 1,
    status: 'active',
    subject: definition.subject,
    preview_text: definition.preview || null,
    blocks: JSON.stringify(definition.blocks),
    text_body: null,
    published_at: new Date(),
    created_at: new Date(),
    updated_at: new Date(),
  }).returning('*');
  await knex('email_templates').where({ id: template.id }).update({
    active_version_id: version.id,
    last_published_at: new Date(),
    updated_at: new Date(),
  });
  if (await knex.schema.hasTable('email_template_fixtures')) {
    const hasFixture = await knex('email_template_fixtures').where({ template_id: template.id }).first('id');
    if (!hasFixture) {
      await knex('email_template_fixtures').insert({
        template_id: template.id,
        name: 'Happy path',
        is_default: true,
        payload: JSON.stringify(PREVIEW_PAYLOAD),
        created_at: new Date(),
        updated_at: new Date(),
      });
    }
  }
  // audit_log is append-only and written through services/audit-log.js.
  if (await knex.schema.hasTable('audit_log')) {
    await require('../../services/audit-log').recordAuditEvent({
      actor_type: 'system',
      action: 'email_template.seeded',
      resource_type: 'email_template',
      resource_id: template.id,
      metadata: { templateKey: definition.key, versionId: version.id, migration: MIGRATION },
      trx: knex,
      critical: true,
    });
  }
}

exports.up = async function up(knex) {
  for (const table of ['email_templates', 'email_template_versions']) {
    if (!(await knex.schema.hasTable(table))) return;
  }
  await ensureTransactionalGroup(knex);
  for (const definition of EMAIL_TEMPLATES) {
    await seedEmailTemplate(knex, definition);
  }
};

// Documented no-op: see the header.
exports.down = async function down() {};

exports.__private = {
  EMAIL_TEMPLATES,
  PREVIEW_PAYLOAD,
};
