'use strict';

/**
 * Seed the card.issued email template — the "here's your Waves card" email a
 * customer gets after their FIRST completed visit (digital business card
 * lane, services/customer-card.js). Sending is dark behind
 * GATE_DIGITAL_BUSINESS_CARD; this seed only makes the template exist so the
 * owner can preview/edit it in /admin before flipping the gate.
 *
 * Deliberately NO review ask in this email — the review QR/link lives at the
 * bottom of the card page itself, and active review asks stay in the
 * review-request lanes so a customer is never double-asked.
 *
 * Chrome/suppression: transactional relationship email in the branded service
 * glass chrome (service_pinned_v1), service_operational stream — same class
 * as the other post-visit service emails. Same upsert mechanics as
 * 20260708000002 (referral friend invite seed).
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';
const REAL_PHONE = '(941) 297-5749';

const SHARED_VARIABLES = ['company_phone', 'company_email'];

const TEMPLATE = {
  key: 'card.issued',
  name: 'Digital Business Card (after first visit)',
  category: 'card',
  audience: 'customer',
  sensitivity: 'normal',
  mode: 'service',
  legal: 'transactional_relationship',
  layout: 'service_pinned_v1',
  stream: 'service_operational',
  description: 'Sent once, after a customer’s first completed visit: their personal Waves card link (tech on record, text/call buttons, app links, save-contact). Dark behind GATE_DIGITAL_BUSINESS_CARD.',
  required: ['first_name', 'tech_first_name', 'card_url'],
  optional: [],
  subject: 'Your Waves card from {{tech_first_name}}',
  preview: 'Save our contact, get the app, and reach {{tech_first_name}} in a tap.',
  blocks: [
    { type: 'paragraph', content: 'Hi {{first_name}}, thanks for having us out. Here’s your Waves card — it keeps {{tech_first_name}}’s line, our app, and everything else one tap away.' },
    { type: 'cta', label: 'Open your Waves card', url_variable: 'card_url' },
    { type: 'small_note', content: 'Save the contact from the card and it works any time you need us — no digging through old texts.' },
    { type: 'signature', content: 'See you next visit. — {{tech_first_name}}, Waves Pest Control' },
  ],
  fixture: {
    first_name: 'Jordan',
    tech_first_name: 'Adam',
    card_url: 'https://portal.wavespestcontrol.com/card/EXAMPLE',
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
    audience: t.audience || 'customer',
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
  const hasTables = await knex.schema.hasTable('email_templates');
  if (!hasTables) return;
  const template = await knex('email_templates').where({ template_key: TEMPLATE.key }).first();
  if (!template) return;
  // Mirror of the other seed downs: retire rather than hard-delete so any
  // send history keyed on the template survives a rollback.
  await knex('email_templates').where({ id: template.id }).update({
    status: 'archived',
    updated_at: new Date(),
  });
};
