'use strict';

/**
 * Seed account.cancellation_refund — the ONE combined email the admin
 * cancel-signup flow sends (customer-offboarding.js): cancellation
 * confirmed + deposit refund issued. Owner rulings 2026-07-15: a single
 * combined message (no separate membership-canceled email on this path)
 * and the refund is the deposit's FACE VALUE.
 *
 * Ships status:'paused' — sends fail soft (EMAIL_TEMPLATE_DISABLED) until
 * the owner reviews the copy and activates the template in the email
 * template admin. That activation is the flow's customer-facing switch;
 * the cancel/refund mechanics work regardless.
 *
 * Copy rules: transactional voice, no invented numbers beyond the standard
 * 5–10 business day card-refund window, one job per email. Same upsert
 * mechanics as 20260714000041.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';
const REAL_PHONE = '(941) 297-5749';

const SHARED_VARIABLES = ['first_name', 'customer_portal_url', 'company_phone', 'company_email'];

const TEMPLATE = {
  key: 'account.cancellation_refund',
  name: 'Account — Cancellation Confirmed + Deposit Refund',
  category: 'account',
  sensitivity: 'financial',
  stream: 'transactional_required',
  description: 'Sent once by the admin cancel-signup action after the deposit refund is issued: confirms the plan cancellation and states the refund amount and timing. Deposits have no payments row, so the standard refund-issued template never covers this case.',
  required: ['first_name', 'refund_amount', 'refund_date'],
  optional: ['plan_label'],
  subject: 'Your cancellation is confirmed — refund on the way',
  preview: 'Your plan is cancelled and your deposit refund has been issued.',
  blocks: [
    { type: 'paragraph', content: 'Hi {{first_name}}, your Waves service plan has been cancelled as requested. Nothing further will be scheduled, and nothing further will be billed.' },
    { type: 'details', rows: [
      { label: 'Refund issued', value: '{{refund_amount}}' },
      { label: 'Refund date', value: '{{refund_date}}' },
      { label: 'Plan cancelled', value: '{{plan_label}}' },
    ] },
    { type: 'paragraph', content: 'The refund goes back to your original payment method. Depending on your bank, it can take 5–10 business days to appear on your statement.' },
    { type: 'small_note', content: 'Change of heart, or have a question about the refund? Reply to this email or call {{company_phone}} — a real person answers.' },
    { type: 'signature', content: 'Thank you for giving Waves a try. — The Waves Team' },
  ],
  fixture: {
    first_name: 'Taylor',
    refund_amount: '$49.00',
    refund_date: 'July 15, 2026',
    plan_label: 'WaveGuard Bronze',
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
    send_stream: t.stream || 'transactional_required',
    suppression_group_key: t.stream || 'transactional_required',
    layout_wrapper_id: t.layout || 'service_default_v1',
    from_name: 'Waves Pest Control',
    from_email: SERVICE_FROM,
    reply_to: SERVICE_FROM,
    default_cta_label: null,
    default_cta_url_variable: null,
    allowed_variables: JSON.stringify(allowed),
    required_variables: JSON.stringify(required),
    optional_variables: JSON.stringify(optional),
    // Paused until the owner approves the copy — this is the send switch.
    status: 'paused',
    updated_at: new Date(),
  };
}

async function upsertTemplate(knex, t) {
  const existing = await knex('email_templates').where({ template_key: t.key }).first();
  let template = existing;
  const row = templateRow(t);

  if (template) {
    // Never un-approve a template the owner already activated.
    if (String(template.status || '').toLowerCase() === 'active') row.status = 'active';
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
  if (!(await knex.schema.hasTable('email_templates'))) return;
  await upsertTemplate(knex, TEMPLATE);
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('email_templates')) {
    // Archive rather than delete — email_messages may reference the row.
    await knex('email_templates')
      .where({ template_key: TEMPLATE.key })
      .update({ status: 'archived', updated_at: new Date() });
  }
};

// Exported for the seed-pinning test.
exports._TEMPLATE = TEMPLATE;
