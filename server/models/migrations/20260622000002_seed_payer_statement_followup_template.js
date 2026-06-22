/**
 * Payer NET-terms statement DUNNING email template (`payer.statement.followup`).
 *
 * Third-party payer Phase 2 — P4 (dunning). When an unpaid statement passes its
 * due date, the followup engine (server/services/payer-statement-followups.js)
 * emails the payer's AP inbox a terms-aware reminder. ONE template is reused for
 * every step; the per-step tone ("friendly" → "final notice") rides the
 * `reminder_line` variable supplied by the step config — so editing cadence/tone
 * never needs a new template.
 *
 * Unlike `payer.statement.sent` (no CTA), the followup DOES carry a pay CTA: P3
 * shipped the self-serve `/pay/statement/:token` surface, so the nudge is
 * actionable. The PDF is NOT re-attached — AP already has it from the original
 * statement send; the reminder is a short prompt with the amount + a pay link.
 *
 * Transactional billing document → `transactional_required` stream (never
 * marketing-suppressed). Mirrors the publish pattern in
 * 20260620000002_seed_payer_statement_email_template.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';

const TEMPLATE = {
  key: 'payer.statement.followup',
  name: 'Payer NET Statement — Payment Reminder',
  description: 'Statement-level dunning reminder to a third-party payer AP inbox (due+0/+15/+30).',
  purpose: 'billing',
  audience: 'payer',
  mode: 'service',
  stream: 'transactional_required',
  legal: 'transactional_relationship',
  required: ['statement_number', 'amount_due'],
  optional: ['company_name', 'due_date', 'days_past_due', 'reminder_line', 'pay_url', 'terms'],
  ctaLabel: 'Pay this statement',
  ctaUrlVariable: 'pay_url',
  subject: 'Reminder: Waves statement {{statement_number}} — {{amount_due}} due',
  preview: 'A quick reminder about your Waves Pest Control statement balance.',
  blocks: [
    { type: 'paragraph', content: 'Hello {{company_name}}, {{reminder_line}}' },
    {
      type: 'details',
      rows: [
        { label: 'Statement', value: '{{statement_number}}' },
        { label: 'Amount due', value: '{{amount_due}}' },
        { label: 'Due date', value: '{{due_date}}' },
        { label: 'Terms', value: '{{terms}}' },
      ],
    },
    { type: 'paragraph', content: 'You can pay online using the button below, or reply with the date your check/ACH is scheduled and we will note it on your account.' },
    { type: 'small_note', content: 'Already paid? Please disregard this notice — it may have crossed with your payment. Questions? Reply to this email or call (941) 297-5749.' },
  ],
  fixture: {
    company_name: 'West Bay Property Management',
    statement_number: 'S-1042',
    amount_due: '$1,284.00',
    due_date: 'Jun 30, 2026',
    days_past_due: '15',
    reminder_line: 'this is a reminder that your Waves Pest Control statement S-1042 is now 15 days past due.',
    pay_url: 'https://portal.wavespestcontrol.com/pay/statement/abc123',
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
  await knex('email_templates').where({ template_key: 'payer.statement.followup' }).del();
};
