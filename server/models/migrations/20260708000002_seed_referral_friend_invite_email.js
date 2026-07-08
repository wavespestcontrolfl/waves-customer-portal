'use strict';

/**
 * Seed the referral.friend_invite email template (owner ask 2026-07-08).
 *
 * The portal Refer tab's "Email" share opened a plain-text mailto draft —
 * a generic, unbranded email (see the attached inbox screenshot). This is
 * the branded-glass replacement: a friend-facing invite the server sends
 * from Waves when a customer emails a referral. The sender wiring lives in
 * routes/referrals-v2.js (POST /invite-email).
 *
 * Distinct from referral.invite, which is CUSTOMER-facing ("your account
 * has a referral link"). This one is addressed to the FRIEND and mentions
 * the referrer by name.
 *
 * Chrome + suppression mirror referral.invite exactly (20260706000010):
 * a commercial referral ask that renders in the branded SERVICE glass
 * chrome (layout_wrapper_id = 'service_pinned_v1', mode 'service' forced
 * at sendTemplate's modeOverride site) while riding the marketing_referral
 * suppression stream, so a referral unsubscribe never touches service
 * email and the CAN-SPAM unsubscribe/ASM footer still renders.
 *
 * The referee offer line comes from the sender (composed from live
 * referral_program_settings), so discount amounts are never baked into
 * copy. Same upsert mechanics as 20260705010040 (lifecycle seed).
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';
const REAL_PHONE = '(941) 297-5749';

const SHARED_VARIABLES = ['company_phone', 'company_email'];

const TEMPLATE = {
  key: 'referral.friend_invite',
  name: 'Referral Invite (to a friend)',
  category: 'referral',
  audience: 'lead',
  sensitivity: 'normal',
  // Referral asks are commercial word-of-mouth: marketing_referral
  // suppression stream + commercial_marketing legal class so a referral
  // unsubscribe never kills a friend's future service email, but the row
  // renders in the branded service glass chrome via the service pin.
  mode: 'service',
  legal: 'commercial_marketing',
  layout: 'service_pinned_v1',
  stream: 'marketing_referral',
  description: 'Friend-facing referral invite the server sends from Waves when a customer emails a referral from the Refer tab. Mentions the referrer by name; the referee offer line comes from the sender so discount amounts are never baked into copy.',
  required: ['referrer_name', 'referral_url', 'referral_offer_line'],
  optional: ['friend_name'],
  subject: '{{referrer_name}} thinks you’ll like Waves Pest Control',
  preview: 'A referral from {{referrer_name}} — and a little something for your first service.',
  blocks: [
    { type: 'paragraph', content: 'Hi {{friend_name}}, {{referrer_name}} is a Waves Pest Control customer and thought you might want our info.' },
    { type: 'paragraph', content: '{{referral_offer_line}}' },
    { type: 'small_note', content: 'Waves is a family-owned pest control and lawn care company serving Manatee, Sarasota, and Charlotte counties — we treat your home like our own.' },
    { type: 'cta', label: 'See your referral offer', url_variable: 'referral_url' },
    { type: 'signature', content: 'Hope to see you soon. — The Waves Team' },
  ],
  fixture: {
    friend_name: 'Jordan',
    referrer_name: 'Taylor',
    referral_url: 'https://portal.wavespestcontrol.com/r/WAVES-EXAMPLE',
    referral_offer_line: 'Book your first service through their referral link and you’ll get $25 off — our way of saying welcome.',
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
  if (!(await knex.schema.hasTable('email_templates'))) return;
  // Archive rather than delete — send logs may reference the row.
  await knex('email_templates')
    .where({ template_key: TEMPLATE.key })
    .update({ status: 'archived', updated_at: new Date() });
};
