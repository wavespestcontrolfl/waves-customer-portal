'use strict';

/**
 * Pre-visit late-balance reminder (owner directive 2026-07-17):
 *
 * 1. scheduled_services.balance_reminder_sent_at — the one-reminder-per-
 *    appointment atomic claim (same pattern as card_link_sent_at).
 * 2. previsit_balance_reminder SMS template — seeded INACTIVE: the sweep is
 *    dark until the owner reviews the copy and activates it (and flips
 *    PREVISIT_BALANCE_REMINDER=true — both levers required).
 * 3. billing.previsit_balance email template — same copy in email form,
 *    sent through the account-membership transactional pipeline.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';

const SHARED_VARIABLES = [
  'first_name',
  'customer_name',
  'customer_portal_url',
  'company_phone',
  'company_email',
];

const EMAIL_TEMPLATE = {
  key: 'billing.previsit_balance',
  name: 'Pre-Visit Balance Reminder',
  category: 'billing',
  sensitivity: 'account',
  description:
    'Sent a few days before an upcoming recurring-service visit when the account has a late recurring balance (unpaid monthly dues or overdue recurring-visit invoices). Never sent ahead of one-time visits and never for one-time invoice debt.',
  required: ['first_name', 'amount'],
  optional: ['service_type', 'visit_date', 'billing_url'],
  subject: 'A quick note before your upcoming visit',
  preview: 'Your account has a past-due balance.',
  blocks: [
    { type: 'paragraph', content: 'Hello {{first_name}},' },
    { type: 'paragraph', content: 'Ahead of your upcoming {{service_type}} visit on {{visit_date}}, a quick reminder that your account has a past-due balance of {{amount}}.' },
    { type: 'cta', label: 'View and pay your balance', url_variable: 'billing_url' },
    { type: 'paragraph', content: 'If you have already taken care of this, thank you — no action is needed. If something looks off, reply to this email or call us at {{company_phone}} and we will sort it out.' },
    { type: 'signature', content: 'Thank you, The Waves Team' },
  ],
};

const PREVIEW_PAYLOAD = {
  first_name: 'Stan',
  customer_name: 'Stan Example',
  customer_portal_url: 'https://portal.wavespestcontrol.com/login',
  company_phone: '(941) 555-0000',
  company_email: SERVICE_FROM,
  amount: '$96.60',
  service_type: 'Quarterly Pest Control Service',
  visit_date: 'July 28, 2026',
  billing_url: 'https://portal.wavespestcontrol.com/?tab=billing',
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
  if (version) {
    await knex('email_template_versions').where({ id: version.id }).update({
      status: 'active',
      subject: t.subject,
      preview_text: t.preview || null,
      blocks: JSON.stringify(t.blocks || []),
      text_body: null,
      published_at: new Date(),
      updated_at: new Date(),
    });
  } else {
    const latest = await knex('email_template_versions')
      .where({ template_id: template.id })
      .max('version_number as max')
      .first();
    const nextVersion = Number(latest?.max || 0) + 1;
    [version] = await knex('email_template_versions').insert({
      template_id: template.id,
      version_number: nextVersion,
      status: 'active',
      subject: t.subject,
      preview_text: t.preview || null,
      blocks: JSON.stringify(t.blocks || []),
      text_body: null,
      published_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    }).returning('*');
  }

  await knex('email_templates').where({ id: template.id }).update({
    active_version_id: version?.id || template.active_version_id,
    last_published_at: new Date(),
    updated_at: new Date(),
  });

  const existingFixture = await knex('email_template_fixtures')
    .where({ template_id: template.id, is_default: true })
    .first();
  const payload = JSON.stringify(PREVIEW_PAYLOAD);
  if (existingFixture) {
    await knex('email_template_fixtures').where({ id: existingFixture.id }).update({
      name: 'Happy path',
      payload,
      updated_at: new Date(),
    });
  } else {
    await knex('email_template_fixtures').insert({
      template_id: template.id,
      name: 'Happy path',
      payload,
      is_default: true,
      created_at: new Date(),
      updated_at: new Date(),
    });
  }
}

exports.up = async function up(knex) {
  // 1. One-reminder-per-appointment claim column.
  const hasSs = await knex.schema.hasTable('scheduled_services');
  if (hasSs && !(await knex.schema.hasColumn('scheduled_services', 'balance_reminder_sent_at'))) {
    await knex.schema.alterTable('scheduled_services', (t) => {
      t.timestamp('balance_reminder_sent_at', { useTz: true }).nullable();
    });
  }

  // 2. SMS template — seeded INACTIVE (owner reviews copy, then activates).
  if (await knex.schema.hasTable('sms_templates')) {
    const existing = await knex('sms_templates').where({ template_key: 'previsit_balance_reminder' }).first();
    if (!existing) {
      await knex('sms_templates').insert({
        template_key: 'previsit_balance_reminder',
        name: 'Pre-Visit Balance Reminder (recurring only)',
        category: 'billing',
        body: 'Hello {first_name}! Ahead of your {service_type} visit on {visit_date}, a quick reminder: your account has a past-due balance of ${amount}. You can take care of it here: {billing_url}\n\nAlready handled it? Thank you — no action needed.',
        variables: JSON.stringify(['first_name', 'service_type', 'visit_date', 'amount', 'billing_url']),
        is_active: false,
        sort_order: 60,
      });
    }
  }

  // 3. Email template.
  const hasEmailTables = await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions')
    && await knex.schema.hasTable('email_template_fixtures');
  if (hasEmailTables) {
    await upsertTemplate(knex, EMAIL_TEMPLATE);
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('scheduled_services')
    && await knex.schema.hasColumn('scheduled_services', 'balance_reminder_sent_at')) {
    await knex.schema.alterTable('scheduled_services', (t) => {
      t.dropColumn('balance_reminder_sent_at');
    });
  }
  if (await knex.schema.hasTable('sms_templates')) {
    await knex('sms_templates').where({ template_key: 'previsit_balance_reminder' }).del();
  }
  if (await knex.schema.hasTable('email_templates')) {
    await knex('email_templates').where({ template_key: EMAIL_TEMPLATE.key }).del();
  }
};

exports.__private = { EMAIL_TEMPLATE, templateRow };
