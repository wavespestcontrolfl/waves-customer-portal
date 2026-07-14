'use strict';

/**
 * Seed estimate.payment_step_abandoned — the follow-up email for customers
 * who reached the save-a-card step (Auto Pay card on a recurring accept, or
 * the one-time card hold) but never completed the acceptance. Replaces the
 * retired deposit-abandonment recovery for the card-on-file accept flow
 * (deposits are dark; estimate.deposit_abandoned stays archived-in-place as
 * legacy). Sent once by the follow-up engine's payment-step stage, gated by
 * GATE_PAYMENT_STEP_FOLLOWUP (unset in prod — shadow-counts until flipped).
 *
 * Copy follows the card-on-file owner rules: nothing is charged today, the
 * card only secures the plan/spot, billing happens after a COMPLETED SERVICE
 * (never "application"). 2026-07 email copy standard: one job, one primary
 * CTA, no invented numbers. Same upsert mechanics as 20260707000002.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';
const REAL_PHONE = '(941) 297-5749';

const SHARED_VARIABLES = ['first_name', 'customer_portal_url', 'company_phone', 'company_email'];

const TEMPLATE = {
  key: 'estimate.payment_step_abandoned',
  name: 'Estimate — Payment Step Not Completed',
  category: 'estimate',
  sensitivity: 'account',
  stream: 'service_operational',
  description: 'The customer reached the save-a-card step of accepting their estimate (Auto Pay card or one-time card hold) but the acceptance never completed. Sent once by the follow-up engine’s payment-step stage (gated by GATE_PAYMENT_STEP_FOLLOWUP). No money is involved: the card only secures the plan.',
  required: ['first_name', 'estimate_url'],
  optional: [],
  subject: 'Almost done — one quick step to confirm your service',
  preview: 'Everything is saved right where you left it. Finishing takes about a minute.',
  blocks: [
    { type: 'paragraph', content: 'Hi {{first_name}}, you were one step away from confirming your Waves service — everything is saved right where you left it. The last step is saving a card, and it takes about a minute.' },
    { type: 'paragraph', content: 'Nothing is charged today. The card on file simply secures your spot, and you’re only billed after your service is completed.' },
    { type: 'small_note', content: 'Ran into trouble, or have a question first? Reply to this email or call {{company_phone}} — a real person answers.' },
    { type: 'cta', label: 'Pick up where I left off', url_variable: 'estimate_url' },
    { type: 'signature', content: 'We look forward to servicing your home. — The Waves Team' },
  ],
  fixture: {
    first_name: 'Taylor',
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
  if (await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions')) {
    await upsertTemplate(knex, TEMPLATE);
  }
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
