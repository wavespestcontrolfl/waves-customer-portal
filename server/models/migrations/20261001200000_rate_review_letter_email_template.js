'use strict';

/**
 * Annual rate review — the customer letter (plan
 * ~/.claude/plans/annual-rate-review-2026-09-30.md, build step 4, the comms
 * lane; stacked on the apply lane's 20260930230000).
 *
 * Seeds ONE email template, billing.rate_review_notice: the annual rate
 * review letter (Adam's voice, dollars per application, the reason, what
 * stays the same, how to reach us) with a button to the tokened
 * /price-change/:token notice page. Every slot is filled by
 * services/rate-review-comms.js from stored, deterministic facts (the
 * ranking row, the notice row and the owner's hand-written cost block) —
 * no generated text. A customer with several reviewed plan lines gets ONE
 * letter; the four line slots render only when filled (the library drops
 * a details row with a blank value and a paragraph that resolves blank).
 *
 * transactional_required stream, like billing.price_change_notice: a
 * billing-terms notice must always deliver (global bounce suppression
 * still blocks). The SMS leg reuses the existing price_change_notice SMS
 * template unchanged (the pointer to the same page).
 *
 * Idempotent: seeds the version only when the template has no active
 * version — a re-run never overwrites an operator's edits.
 * down() is a documented NO-OP: once seeded, the template is
 * admin-editable in the Email Template Library, and deleting or archiving
 * it on rollback would destroy those edits; the sender is dark behind
 * GATE_RATE_REVIEW, so an unused template row is inert.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';
const KEY = 'billing.rate_review_notice';

const LINE_SLOTS = 4;

function lineDetails(n) {
  return {
    type: 'details',
    rows: [
      { label: 'Service', value: `{{line${n}_service}}` },
      { label: 'Now', value: `{{line${n}_now}}` },
      { label: `{{line${n}_new_label}}`, value: `{{line${n}_new}}` },
      { label: `{{line${n}_first_label}}`, value: `{{line${n}_first}}` },
    ],
  };
}

const lineVars = [];
for (let n = 1; n <= LINE_SLOTS; n += 1) {
  for (const v of ['service', 'now', 'new_label', 'new', 'first_label', 'first', 'why']) lineVars.push(`line${n}_${v}`);
}

const TEMPLATE = {
  key: KEY,
  name: 'Annual Rate Review Letter',
  description: 'The once-a-year rate review letter: old and new price per application for each reviewed plan line, the first application at the new rate, the reason, and how to reach us. Links to the tokened notice page. Every slot is filled from stored facts; nothing generated.',
  category: 'billing',
  subject: 'Your Waves rate from {{effective_date}}',
  preview: 'Your rate is going up. Here is the math, at least 30 days ahead.',
  required: ['first_name', 'effective_date', 'cost_block', 'notice_url', 'line1_service', 'line1_now', 'line1_new_label', 'line1_new', 'line1_first_label', 'line1_first', 'line1_why'],
  optional: [...lineVars.filter((v) => !v.startsWith('line1_')), 'prepay_note', 'company_phone', 'company_email'],
  blocks: [
    { type: 'paragraph', content: 'Hi {{first_name}},' },
    { type: 'paragraph', content: "It's Adam at Waves. Once a year I review every account, and this is yours. Your rate is going up, and I want to show you the math instead of sending a form letter." },
    ...Array.from({ length: LINE_SLOTS }, (_, i) => lineDetails(i + 1)),
    { type: 'heading', content: 'What changed on our side this year' },
    { type: 'paragraph', content: '{{cost_block}}' },
    { type: 'heading', content: 'Why your rate specifically' },
    ...Array.from({ length: LINE_SLOTS }, (_, i) => ({ type: 'paragraph', content: `{{line${i + 1}_why}}` })),
    { type: 'heading', content: 'What stays the same' },
    { type: 'paragraph', content: 'Same team, same products, same guarantee: if you see activity between applications, we come back at no charge. No contract. You can cancel any time, before or after this change, by replying to this email, texting us, or from your portal. Any application completed before the new-rate date shown above is billed at your current rate.' },
    { type: 'paragraph', content: '{{prepay_note}}' },
    { type: 'paragraph', content: "If anything here doesn't look right for your home, reply and I'll read it myself." },
    { type: 'cta', label: 'View your notice', url_variable: 'notice_url' },
    { type: 'signature', content: 'Adam\nWaves Pest Control · {{company_phone}}' },
  ],
};

function templateRow(t) {
  const required = [...new Set(t.required)];
  const allowed = [...new Set([...required, ...t.optional])];
  const optional = allowed.filter((key) => !required.includes(key));
  return {
    template_key: t.key,
    name: t.name,
    description: t.description,
    mode: 'service',
    purpose: t.category,
    legal_classification: 'transactional_relationship',
    audience: 'customer',
    message_priority: 'normal',
    content_sensitivity: 'service',
    send_stream: 'transactional_required',
    suppression_group_key: 'transactional_required',
    layout_wrapper_id: 'service_default_v1',
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

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  let template = await knex('email_templates').where({ template_key: KEY }).first();
  if (!template) {
    [template] = await knex('email_templates').insert({ ...templateRow(TEMPLATE), created_at: new Date() }).returning('*');
  }
  if (template.active_version_id) return; // seeded already — never overwrite operator edits
  const latest = await knex('email_template_versions').where({ template_id: template.id }).max('version_number as max').first();
  const [version] = await knex('email_template_versions').insert({
    template_id: template.id,
    version_number: Number(latest?.max || 0) + 1,
    status: 'active',
    subject: TEMPLATE.subject,
    preview_text: TEMPLATE.preview,
    blocks: JSON.stringify(TEMPLATE.blocks),
    text_body: null,
    published_at: new Date(),
    created_at: new Date(),
    updated_at: new Date(),
  }).returning('*');
  await knex('email_templates').where({ id: template.id }).update({ active_version_id: version.id, updated_at: new Date() });
};

// Documented no-op — see the header.
exports.down = async function down() {};

exports._private = { TEMPLATE, KEY, LINE_SLOTS };
