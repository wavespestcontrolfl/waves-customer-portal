/**
 * Seed the `estimate.followup_final` email template — the 5-day "last
 * check-in" nudge stage that estimate-follow-up.js fires before letting an
 * estimate go cold. Tone differs from `estimate.viewed_followup` (48h)
 * intentionally: lighter touch, "no pressure, that's OK" framing.
 *
 * Mirrors the shape of the bulk seed in
 * 20260518000001_email_template_library.js so the email_templates UI shows
 * it next to the other estimate.* templates.
 *
 * Idempotent — re-running the migration on an env that already has the row
 * is a no-op. Down drops the template + its version + fixture.
 */

const TEMPLATE = {
  key: 'estimate.followup_final',
  name: 'Estimate Final Follow-Up',
  description: 'Last check-in for an estimate that has been viewed but not accepted after 5 days.',
  purpose: 'estimate',
  audience: 'lead',
  mode: 'service',
  stream: 'service_operational',
  required: ['first_name', 'estimate_url'],
  subject: 'Last check-in on your Waves estimate',
  preview: 'No pressure — just a friendly final reminder that your estimate is still here.',
  ctaLabel: 'Review estimate',
  ctaUrlVariable: 'estimate_url',
  blocks: [
    { type: 'paragraph', content: 'Hi {{first_name}}, just a quick last check-in. Your Waves estimate is still available whenever you are ready.' },
    { type: 'paragraph', content: "No pressure at all — if we are not the right fit, that is OK. But if you want to move forward, or have a question we can answer, reply here and we will help." },
    { type: 'cta', label: 'Review estimate', url_variable: 'estimate_url' },
  ],
  fixture: { first_name: 'Taylor', estimate_url: 'https://portal.wavespestcontrol.com/estimate/sample' },
};

function templateRow(t) {
  const allowed = [...(t.required || []), ...(t.optional || [])];
  return {
    template_key: t.key,
    name: t.name,
    description: t.description || null,
    mode: t.mode || 'service',
    purpose: t.purpose || 'general',
    legal_classification: t.legal || 'transactional_relationship',
    audience: t.audience || 'customer',
    message_priority: 'normal',
    content_sensitivity: 'normal',
    send_stream: t.stream || 'service_operational',
    suppression_group_key: t.stream || 'service_operational',
    layout_wrapper_id: 'service_default_v1',
    from_name: 'Waves Pest Control',
    from_email: 'contact@wavespestcontrol.com',
    reply_to: 'contact@wavespestcontrol.com',
    default_cta_label: t.ctaLabel || null,
    default_cta_url_variable: t.ctaUrlVariable || null,
    allowed_variables: JSON.stringify(allowed),
    required_variables: JSON.stringify(t.required || []),
    optional_variables: JSON.stringify(t.optional || []),
    status: 'active',
  };
}

exports.up = async function up(knex) {
  const hasTables = await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions')
    && await knex.schema.hasTable('email_template_fixtures');
  if (!hasTables) return;

  // Idempotent: skip if a row with this template_key already exists.
  const existing = await knex('email_templates').where({ template_key: TEMPLATE.key }).first();
  if (existing) return;

  const [template] = await knex('email_templates').insert(templateRow(TEMPLATE)).returning('*');
  const [version] = await knex('email_template_versions').insert({
    template_id: template.id,
    version_number: 1,
    status: 'active',
    subject: TEMPLATE.subject,
    preview_text: TEMPLATE.preview || null,
    blocks: JSON.stringify(TEMPLATE.blocks || []),
    text_body: null,
    published_at: new Date(),
  }).returning('*');
  await knex('email_templates').where({ id: template.id }).update({
    active_version_id: version.id,
    last_published_at: new Date(),
  });
  await knex('email_template_fixtures').insert({
    template_id: template.id,
    name: 'Happy path',
    payload: JSON.stringify(TEMPLATE.fixture || {}),
    is_default: true,
  });
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('email_templates');
  if (!hasTable) return;
  // CASCADE on email_template_versions + email_template_fixtures handles
  // child rows when we delete the template.
  await knex('email_templates').where({ template_key: TEMPLATE.key }).del();
};
