'use strict';

/**
 * Seed the two card-enrollment confirmation templates (owner directive
 * 2026-07-13, from the Auto Pay authorization-form question):
 *
 *   autopay.enrollment_confirmation — the customer's COPY of the Auto Pay
 *     authorization they just granted (card-network stored-credential
 *     guidance: give the cardholder the agreement at enrollment). Carries
 *     the locked consent text verbatim as {{authorization_text}}.
 *   cardhold.confirmation — the one-time twin: the card holds the visit,
 *     nothing charged today, charged after completion; the fee line uses
 *     the FROZEN hold-row terms, never live config.
 *
 * Templates are seeded ACTIVE for admin preview, but the senders are
 * gated OFF behind GATE_CARD_ENROLLMENT_EMAILS (owner flips) — nothing
 * sends until then. Copy standard: no witty copy; "completed service"
 * (owner Auto Pay override); rescheduling is always free; billing
 * questions route to billing@wavespestcontrol.com.
 *
 * Same upsert mechanics as 20260705010040 (lifecycle seed).
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';
const BILLING_EMAIL = 'billing@wavespestcontrol.com';
const REAL_PHONE = '(941) 297-5749';

const SHARED_VARIABLES = ['first_name', 'customer_portal_url', 'company_phone', 'company_email'];

const TEMPLATES = [
  {
    key: 'autopay.enrollment_confirmation',
    name: 'Auto Pay Enrolled — Your Authorization Copy',
    category: 'billing',
    // Must be a member of the admin route's SENSITIVITIES enum (Codex r3)
    // or later admin saves of the seeded template fail validation.
    sensitivity: 'financial',
    // The authorization copy is a required transactional record, never a
    // marketing send — same stream class as appointment notices.
    stream: 'transactional_required',
    description: "Sent when a customer's card is enrolled in Auto Pay: confirms the enrollment and gives them a copy of the exact authorization text they agreed to, with the revocation paths. Gated behind GATE_CARD_ENROLLMENT_EMAILS.",
    required: ['first_name', 'card_line', 'charge_timing_line', 'authorization_text'],
    optional: [],
    subject: 'Auto Pay is set up on your Waves account',
    preview: 'Your card on file, and a copy of the authorization you approved.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, Auto Pay is now set up on your account using {{card_line}}.' },
      { type: 'heading', content: 'How Auto Pay works' },
      // SENDER-COMPOSED by billing mode (Codex r3): monthly-billed
      // accounts are charged by the monthly cron, not per completed
      // service — a fixed per-service sentence would misstate their
      // authorization's timing/amount basis.
      { type: 'paragraph', content: '{{charge_timing_line}}' },
      { type: 'heading', content: 'Your authorization' },
      { type: 'paragraph', content: '{{authorization_text}}' },
      { type: 'paragraph', content: 'You can turn Auto Pay off or remove your card anytime in the Waves app or your customer portal.' },
      { type: 'cta', label: 'Manage my payment methods', url_variable: 'customer_portal_url' },
      { type: 'signature', content: '— Waves Pest Control' },
    ],
    fixture: {
      first_name: 'Taylor',
      card_line: 'your Visa ending 4242',
      charge_timing_line: "After each completed service, your card is charged that service's amount automatically, and you get a receipt every time.",
      authorization_text: 'By checking this box, I authorize Waves Pest Control, LLC to save this card and charge it for future service visits and invoices as agreed, until I revoke authorization…',
      customer_portal_url: 'https://portal.wavespestcontrol.com/login',
      company_email: BILLING_EMAIL,
    },
  },
  {
    key: 'cardhold.confirmation',
    name: 'Card on File — Visit Hold Confirmation',
    category: 'billing',
    sensitivity: 'financial',
    stream: 'transactional_required',
    description: 'Sent when a one-time visit is booked with a card hold: nothing charged today, charged after completion; the fee line is SENDER-COMPOSED from the FROZEN hold-row terms (never live config). Gated behind GATE_CARD_ENROLLMENT_EMAILS.',
    required: ['first_name', 'card_line', 'fee_line', 'surcharge_line'],
    optional: [],
    subject: 'Your card securely holds your Waves visit — nothing charged today',
    preview: 'What your card on file covers for your upcoming visit.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, your visit is booked and {{card_line}} securely holds your appointment. Nothing is charged today.' },
      { type: 'heading', content: 'How your card is used' },
      // surcharge_line is SENDER-COMPOSED from the canonical consent copy
      // (Codex r3): the capture UI disclosed the card surcharge with the
      // hold terms, so the customer's copy must carry the same term.
      { type: 'paragraph', content: 'After your service is completed, your card is charged the final total you approved. {{fee_line}} {{surcharge_line}}' },
      { type: 'paragraph', content: "Rescheduling is always free — reply to your reminder text or call {{company_phone}} and we'll find a new time." },
      { type: 'cta', label: 'View my account', url_variable: 'customer_portal_url' },
      { type: 'signature', content: '— Waves Pest Control' },
    ],
    fixture: {
      first_name: 'Taylor',
      card_line: 'your Visa ending 4242',
      fee_line: 'A $49.00 fee applies only if you cancel within 24 hours of your visit or we cannot get access.',
      surcharge_line: 'A credit card surcharge of up to 2.9% may apply; debit cards, prepaid cards, and bank transfers have no added card surcharge.',
      customer_portal_url: 'https://portal.wavespestcontrol.com/login',
      company_email: BILLING_EMAIL,
    },
  },
];

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
    const payload = { company_phone: REAL_PHONE, company_email: BILLING_EMAIL, ...(t.fixture || {}) };
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
  for (const t of TEMPLATES) {
    await upsertTemplate(knex, t);
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  // Archive rather than delete — send logs may reference the rows.
  await knex('email_templates')
    .whereIn('template_key', TEMPLATES.map((t) => t.key))
    .update({ status: 'archived', updated_at: new Date() });
};

// Test-only (knex ignores extra exports): lets the suite pin that every
// seeded field stays inside the admin route's validation enums.
exports._TEMPLATES = TEMPLATES;
