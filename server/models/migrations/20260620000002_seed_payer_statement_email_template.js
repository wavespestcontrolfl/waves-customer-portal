/**
 * Payer NET-terms statement delivery email template (`payer.statement.sent`).
 *
 * Third-party payer Phase 2 delivers a consolidated NET statement (PDF attached)
 * to the payer's AP inbox. The sender (`payer-statement-email.js`) renders this
 * SendGrid template; without it, the SendGrid path throws "template not found"
 * and prod (where the SMTP fallback is disabled) would dead-end on
 * `email_unavailable` once GATE_PAYER_STATEMENTS is enabled. Seeding it here so
 * the primary delivery path works the moment the gate flips.
 *
 * Transactional billing document → `transactional_required` stream (never
 * marketing-suppressed). No CTA: there is no online payer statement view yet.
 * Mirrors the publish pattern in 20260619000000_estimate_proposal_delivery_email_template.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';

const TEMPLATE = {
  key: 'payer.statement.sent',
  name: 'Payer NET Statement',
  description: 'Consolidated NET-terms statement delivered to a third-party payer AP inbox (PDF attached).',
  purpose: 'billing',
  audience: 'payer',
  mode: 'service',
  stream: 'transactional_required',
  legal: 'transactional_relationship',
  required: ['statement_number', 'amount_due'],
  optional: ['company_name', 'period_start', 'period_end', 'visit_count', 'due_date', 'terms'],
  subject: 'Waves statement {{statement_number}} — {{amount_due}} due {{due_date}}',
  preview: 'Your consolidated Waves Pest Control statement is attached as a PDF.',
  blocks: [
    { type: 'paragraph', content: 'Hello {{company_name}}, your consolidated Waves Pest Control statement {{statement_number}} is attached to this email as a PDF.' },
    {
      type: 'details',
      rows: [
        { label: 'Statement', value: '{{statement_number}}' },
        { label: 'Service period', value: '{{period_start}} – {{period_end}}' },
        { label: 'Visits billed', value: '{{visit_count}}' },
        { label: 'Amount due', value: '{{amount_due}}' },
        { label: 'Due date', value: '{{due_date}}' },
        { label: 'Terms', value: '{{terms}}' },
      ],
    },
    { type: 'paragraph', content: 'The attached PDF itemizes each visit in this period. Please remit by the due date above.' },
    { type: 'small_note', content: 'Questions about this statement? Reply to this email or call (941) 297-5749 and our team will help.' },
  ],
  fixture: {
    company_name: 'West Bay Property Management',
    statement_number: 'S-1042',
    period_start: 'May 1, 2026',
    period_end: 'May 31, 2026',
    visit_count: '6',
    amount_due: '$1,284.00',
    due_date: 'Jun 30, 2026',
    terms: 'Net 30',
  },
};

function json(value) {
  return JSON.stringify(value || (Array.isArray(value) ? [] : {}));
}

function templateRow(t) {
  const allowed = [...(t.required || []), ...(t.optional || [])];
  return {
    template_key: t.key,
    name: t.name || t.key,
    description: t.description || null,
    mode: t.mode || 'service',
    purpose: t.purpose || 'billing',
    legal_classification: t.legal || 'transactional_relationship',
    audience: t.audience || 'customer',
    message_priority: 'normal',
    content_sensitivity: 'normal',
    send_stream: t.stream || 'transactional_required',
    suppression_group_key: t.stream || 'transactional_required',
    layout_wrapper_id: 'service_default_v1',
    from_name: 'Waves Pest Control',
    from_email: SERVICE_FROM,
    reply_to: SERVICE_FROM,
    default_cta_label: t.ctaLabel || null,
    default_cta_url_variable: t.ctaUrlVariable || null,
    allowed_variables: json(allowed),
    required_variables: json(t.required || []),
    optional_variables: json(t.optional || []),
    status: 'active',
  };
}

async function publishTemplateVersion(knex, t) {
  let template = await knex('email_templates').where({ template_key: t.key }).first();
  const row = templateRow(t);

  if (!template) {
    [template] = await knex('email_templates').insert(row).returning('*');
  } else {
    await knex('email_templates').where({ id: template.id }).update({
      allowed_variables: row.allowed_variables,
      required_variables: row.required_variables,
      optional_variables: row.optional_variables,
      default_cta_label: row.default_cta_label,
      default_cta_url_variable: row.default_cta_url_variable,
      status: 'active',
      updated_at: new Date(),
    });
    template = await knex('email_templates').where({ id: template.id }).first();
  }

  const latest = await knex('email_template_versions')
    .where({ template_id: template.id })
    .orderBy('version_number', 'desc')
    .first();
  const versionNumber = (latest?.version_number || 0) + 1;

  const [version] = await knex('email_template_versions').insert({
    template_id: template.id,
    version_number: versionNumber,
    status: 'active',
    subject: t.subject,
    preview_text: t.preview || null,
    blocks: json(t.blocks || []),
    text_body: null,
    validation_snapshot: json({
      ok: true,
      referenced_variables: [...(t.required || []), ...(t.optional || [])].sort(),
      disallowed_variables: [],
      missing_required_in_template: [],
    }),
    published_at: new Date(),
  }).returning('*');

  await knex('email_template_versions')
    .where({ template_id: template.id })
    .whereNot({ id: version.id })
    .where({ status: 'active' })
    .update({ status: 'archived', updated_at: new Date() });

  await knex('email_templates').where({ id: template.id }).update({
    active_version_id: version.id,
    status: 'active',
    last_published_at: new Date(),
    updated_at: new Date(),
  });

  const existingFixture = await knex('email_template_fixtures')
    .where({ template_id: template.id, is_default: true })
    .first();
  if (existingFixture) {
    await knex('email_template_fixtures').where({ id: existingFixture.id }).update({
      payload: json(t.fixture || {}),
      updated_at: new Date(),
    });
  } else {
    await knex('email_template_fixtures').insert({
      template_id: template.id,
      name: 'Happy path',
      payload: json(t.fixture || {}),
      is_default: true,
    });
  }
}

exports.up = async function up(knex) {
  const hasTables = await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions')
    && await knex.schema.hasTable('email_template_fixtures');
  if (!hasTables) return;
  await publishTemplateVersion(knex, TEMPLATE);
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('email_templates');
  if (!hasTable) return;
  await knex('email_templates').where({ template_key: 'payer.statement.sent' }).del();
};
