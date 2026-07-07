'use strict';

/**
 * Email-program gap fixes (owner go 2026-07-06, from the email template
 * audit):
 *
 * 1. Seed estimate.deposit_abandoned — email twin of the
 *    estimate_followup_deposit SMS. The follow-up engine's
 *    deposit-abandoned stage becomes channel-aware in this PR; until now
 *    it was SMS-only AND its SMS template was inactive, so a customer who
 *    started paying a deposit and dropped got no follow-up on any channel.
 * 2. Reactivate the estimate_followup_deposit SMS row (owner go). The
 *    stage itself stays dark behind GATE_ESTIMATE_DEPOSIT_ABANDONMENT_SMS
 *    (unset in prod) — flipping that env var is the go-live switch for
 *    BOTH channels; the template rows are the per-channel kill switches.
 * 3. Archive prep.wildlife — wildlife is a prohibited service (Waves
 *    doesn't offer it; content rules ban it), so an active prep template
 *    for it is a foot-gun. Archive, not delete: email_messages may
 *    reference the row, and archive is the library's kill state.
 *
 * Copy follows the 2026-07 email copy standard (one job, one primary CTA,
 * no invented numbers). deposit_amount renders from the follow-up
 * engine's refund-netted outstanding amount — the template never does
 * money math. Same upsert mechanics as 20260705010040.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';
const REAL_PHONE = '(941) 297-5749';

const SHARED_VARIABLES = ['first_name', 'customer_portal_url', 'company_phone', 'company_email'];

const TEMPLATE = {
  key: 'estimate.deposit_abandoned',
  name: 'Estimate — Deposit Not Completed',
  category: 'estimate',
  sensitivity: 'account',
  stream: 'service_operational',
  description: 'Email twin of the estimate_followup_deposit SMS: the customer started paying their estimate deposit but the payment never completed, so their spot is not reserved. Sent once by the follow-up engine’s deposit-abandoned stage (gated by GATE_ESTIMATE_DEPOSIT_ABANDONMENT_SMS).',
  required: ['first_name', 'deposit_amount', 'estimate_url'],
  optional: [],
  subject: 'Almost reserved — your ${{deposit_amount}} deposit didn’t finish',
  preview: 'Your estimate is saved. The deposit takes about a minute to complete.',
  blocks: [
    { type: 'paragraph', content: 'Hi {{first_name}}, your Waves appointment is almost reserved — your estimate is saved and just needs the ${{deposit_amount}} deposit to lock in your spot. It looks like the payment didn’t finish processing.' },
    { type: 'paragraph', content: 'Completing it takes about a minute, and nearby appointment slots go fastest — finishing now usually means we’re out within days.' },
    { type: 'small_note', content: 'Already paid, or something look off? Reply to this email or call {{company_phone}} — a real person answers.' },
    { type: 'cta', label: 'Finish my deposit', url_variable: 'estimate_url' },
    { type: 'signature', content: 'We look forward to servicing your home. — The Waves Team' },
  ],
  fixture: {
    first_name: 'Taylor',
    deposit_amount: '49',
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

    // Wildlife is a prohibited service — archive its prep template.
    await knex('email_templates')
      .where({ template_key: 'prep.wildlife' })
      .update({ status: 'archived', updated_at: new Date() });
  }

  // Reactivate the deposit-abandoned SMS (owner go). Only the flag flips —
  // the body stays whatever the admin last saved.
  if (await knex.schema.hasTable('sms_templates')) {
    await knex('sms_templates')
      .where({ template_key: 'estimate_followup_deposit', is_active: false })
      .update({ is_active: true, updated_at: new Date() });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('email_templates')) {
    // Archive rather than delete — send logs may reference the row.
    await knex('email_templates')
      .where({ template_key: TEMPLATE.key })
      .update({ status: 'archived', updated_at: new Date() });
    await knex('email_templates')
      .where({ template_key: 'prep.wildlife' })
      .update({ status: 'active', updated_at: new Date() });
  }
  if (await knex.schema.hasTable('sms_templates')) {
    await knex('sms_templates')
      .where({ template_key: 'estimate_followup_deposit' })
      .update({ is_active: false, updated_at: new Date() });
  }
};
