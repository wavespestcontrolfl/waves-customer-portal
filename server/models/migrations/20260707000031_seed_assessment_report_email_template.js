/**
 * Seed the photo-assessment report email template (assessment.report_link).
 *
 * One template serves BOTH assessment types (lawn assessment + pest
 * identification) — the type only changes {{report_type_label}} and the
 * report URL, so a single row keeps one kill switch: pausing/archiving the
 * email_templates row stops every assessment-report send with no deploy.
 *
 * This email is ONLY dispatched by the manual admin "Send report" button
 * (routes/admin-photo-assessments.js) — never by a cron, webhook, or funnel
 * event. Standing rule: the owner sends all customer comms; the button is the
 * owner's explicit click.
 *
 * Same upsert shape as 20260707000001 (deposit receipt): idempotent up,
 * archive-not-delete down (send logs reference the row).
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';
const REAL_PHONE = '(941) 297-5749';

const SHARED_VARIABLES = ['first_name', 'company_phone', 'company_email'];

const TEMPLATE = {
  key: 'assessment.report_link',
  name: 'Photo Assessment Report',
  category: 'lead_nurture',
  sensitivity: 'account',
  // A report the prospect asked us for (photo upload / phone request) —
  // relationship-transactional, not promotional.
  stream: 'service_operational',
  description: 'Manual admin send only: links a prospect (or customer) to their tokenized photo-assessment report — lawn assessment or pest identification. Fired exclusively from the admin “Send report” button; no automated sender uses this key.',
  // expires_note is REQUIRED (the sender always passes it) so the small_note
  // block never renders a raw {{expires_note}} token on a missing optional.
  required: ['first_name', 'report_type_label', 'report_url', 'expires_note'],
  optional: [],
  subject: 'Your {{report_type_label}} from Waves is ready, {{first_name}}',
  preview: 'The results of your {{report_type_label}} are ready to view.',
  // Copy promises only what every report shows: findings + a recommended next
  // step. No guarantees, no cure claims, no confirmed-diagnosis language —
  // termite/WDO-adjacent reports carry their own inspection-first framing
  // inside the report itself.
  blocks: [
    { type: 'paragraph', content: 'Hi {{first_name}}, your {{report_type_label}} is ready. It walks through what we saw in your photos and the next step we recommend.' },
    { type: 'cta', label: 'View my report', url_variable: 'report_url' },
    { type: 'small_note', content: '{{expires_note}}' },
    { type: 'small_note', content: 'Questions about anything in it? Reply to this email or call {{company_phone}} — a real person answers.' },
    { type: 'signature', content: 'We look forward to helping. — The Waves Team' },
  ],
  fixture: {
    first_name: 'Taylor',
    report_type_label: 'Lawn Assessment',
    report_url: 'https://portal.wavespestcontrol.com/lawn-report/example-token',
    expires_note: 'This private link is just for you and expires in 30 days.',
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
