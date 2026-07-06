'use strict';

/**
 * Seed the deposit.receipt email template (owner go 2026-07-06).
 *
 * A paid estimate deposit already texts a receipt (deposit_receipt SMS,
 * 20260706000010), but customers whose payment_receipt_channel is
 * email-only got nothing — the deposit PaymentIntent is customerless and
 * carries no receipt_email. This template is the email leg; the sender
 * wiring lives in estimate-deposits.js (channel-dispatched next to the
 * SMS leg, exactly-once via the markDepositReceived transition + a
 * per-PaymentIntent idempotency key).
 *
 * Kill switch = this template row's status (archive/pause stops the email
 * leg the same way the deposit_receipt SMS row gates the text).
 *
 * Copy follows the 2026-07 email copy standard: one job, one primary CTA,
 * no invented numbers. The amount is rendered from the verified deposit
 * ledger amount — the template never does money math.
 *
 * Same upsert mechanics as 20260705010040 (lifecycle seed).
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';
const REAL_PHONE = '(941) 297-5749';

const SHARED_VARIABLES = ['first_name', 'customer_portal_url', 'company_phone', 'company_email'];

const TEMPLATE = {
  key: 'deposit.receipt',
  name: 'Deposit Receipt',
  category: 'billing',
  sensitivity: 'account',
  // Payment receipts are required transactional messages — matches
  // invoice.receipt.
  stream: 'transactional_required',
  description: 'Sent once when an estimate deposit payment lands: confirms the amount, explains that it credits toward the first invoice, and links to the estimate. Email twin of the deposit_receipt SMS; sends when the customer’s receipt channel is email or both (and to email-only leads).',
  required: ['first_name', 'amount', 'estimate_url'],
  optional: ['paid_at_line'],
  subject: 'Deposit received — {{amount}}, thank you {{first_name}}',
  preview: 'We received your {{amount}} deposit. It credits toward your first invoice.',
  blocks: [
    { type: 'paragraph', content: 'Hi {{first_name}}, we received your {{amount}} deposit — thank you. {{paid_at_line}}Your spot is reserved.' },
    { type: 'paragraph', content: 'This deposit is credited toward your first invoice, so it comes right off what you owe after your first visit. Nothing else to do right now.' },
    { type: 'small_note', content: 'Keep this email for your records. Questions? Reply to this email or call {{company_phone}} — a real person answers.' },
    { type: 'cta', label: 'View my estimate', url_variable: 'estimate_url' },
    { type: 'signature', content: 'We look forward to servicing your home. — The Waves Team' },
  ],
  fixture: {
    first_name: 'Taylor',
    amount: '$49',
    paid_at_line: 'Paid July 6, 2026. ',
    estimate_url: 'https://portal.wavespestcontrol.com/estimate/example-token',
  },
};

function templateRow(t) {
  const allowed = [...new Set([...SHARED_VARIABLES, ...(t.required || []), ...(t.optional || [])])];
  const required = [...new Set(t.required || [])];
  const optional = allowed.filter((key) => !required.includes(key));
  return {
    template_key: t.key,
    name: t.name,
    description: t.description || null,
    mode: t.mode || 'service',
    purpose: t.category,
    legal_classification: t.legal || 'transactional_relationship',
    audience: 'customer',
    message_priority: 'normal',
    content_sensitivity: t.sensitivity || 'account',
    send_stream: t.stream || 'service_operational',
    suppression_group_key: t.stream || 'service_operational',
    layout_wrapper_id: t.layout || 'service_default_v1',
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
    const payload = { company_phone: REAL_PHONE, company_email: SERVICE_FROM, ...(t.fixture || {}) };
    const fixture = await knex('email_template_fixtures')
      .where({ template_id: template.id, is_default: true })
      .first();
    if (fixture) {
      await knex('email_template_fixtures').where({ id: fixture.id }).update({
        payload: JSON.stringify(payload),
        updated_at: new Date(),
      });
    } else {
      await knex('email_template_fixtures').insert({
        template_id: template.id,
        name: 'Default preview',
        is_default: true,
        payload: JSON.stringify(payload),
        created_at: new Date(),
        updated_at: new Date(),
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
  if (!(await knex.schema.hasTable('email_templates'))) return;
  // Archive rather than delete — send logs may reference the row.
  await knex('email_templates')
    .where({ template_key: TEMPLATE.key })
    .update({ status: 'archived', updated_at: new Date() });
};
