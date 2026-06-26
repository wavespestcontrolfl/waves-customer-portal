/**
 * Seed the email channel for the multi-touch review cadence (template_key
 * 'review_request_email'). Sent by ReviewService.sendOutreachTouch when a
 * sequence step (or a customer whose review_request_channel is email/both)
 * routes to email instead of SMS.
 *
 * The CTA points at the SAME tokenized NPS rate page as the SMS ({{review_url}}
 * → /rate/<token>), so the happy→Google / unhappy→private gate is preserved on
 * the email channel too. Sent on the service_operational stream so customer
 * email unsubscribes are honored (a review ask is not a required notice).
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';

const SHARED_VARIABLES = ['first_name', 'customer_portal_url', 'company_phone', 'company_email'];

const TEMPLATE = {
  key: 'review_request_email',
  name: 'Review Request (Email)',
  category: 'reviews',
  sensitivity: 'account',
  description: 'Email touch in the multi-touch review-request cadence. CTA links to the tokenized NPS rate page (happy → Google, issue → private recovery).',
  required: ['first_name', 'review_url'],
  optional: ['tech_name'],
  subject: 'A quick favor, {{first_name}}?',
  preview: 'If we earned it, a 15-second Google review would mean the world to our small family business.',
  ctaLabel: 'Leave a quick review',
  ctaUrlVariable: 'review_url',
  blocks: [
    { type: 'heading', content: 'Thanks for trusting Waves, {{first_name}} 🙏' },
    { type: 'paragraph', content: "We're a small, family-owned pest and lawn company here in Southwest Florida, and word of mouth is how neighbors find us. If your recent service hit the mark, would you take 15 seconds to share a quick review?" },
    { type: 'cta', label: 'Leave a quick review', url_variable: 'review_url' },
    { type: 'paragraph', content: "It genuinely makes our day — and helps other local families decide who to trust with their home. If anything fell short, the same link lets you tell us privately first so we can make it right." },
    { type: 'signature', content: '— The Waves Team' },
  ],
};

const PREVIEW_PAYLOAD = {
  first_name: 'Stan',
  review_url: 'https://portal.wavespestcontrol.com/rate/preview-token',
  tech_name: 'Adam',
  customer_portal_url: 'https://portal.wavespestcontrol.com/login',
  company_phone: '(941) 555-0000',
  company_email: SERVICE_FROM,
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
    // A review ask is operational, not a required security/billing/legal notice
    // — use the service_operational stream so customer email unsubscribes are
    // honored (transactional_required would bypass them).
    send_stream: 'service_operational',
    suppression_group_key: 'service_operational',
    layout_wrapper_id: 'service_default_v1',
    from_name: 'Waves Pest Control',
    from_email: SERVICE_FROM,
    reply_to: SERVICE_FROM,
    default_cta_label: t.ctaLabel || null,
    default_cta_url_variable: t.ctaUrlVariable || null,
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
    const existingFixture = await knex('email_template_fixtures')
      .where({ template_id: template.id, is_default: true })
      .first();
    const payload = JSON.stringify(PREVIEW_PAYLOAD);
    if (existingFixture) {
      await knex('email_template_fixtures').where({ id: existingFixture.id }).update({
        name: 'Happy path', payload, updated_at: new Date(),
      });
    } else {
      await knex('email_template_fixtures').insert({
        template_id: template.id, name: 'Happy path', payload, is_default: true,
        created_at: new Date(), updated_at: new Date(),
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
  await knex('email_templates').where({ template_key: TEMPLATE.key }).del();
};

exports.TEMPLATE = TEMPLATE;
