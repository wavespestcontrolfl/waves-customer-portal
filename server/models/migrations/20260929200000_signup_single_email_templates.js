'use strict';

/**
 * ONE SIGNUP EMAIL (owner-approved 2026-09-29; GATE_SIGNUP_SINGLE_EMAIL, dark).
 *
 * Two data changes, no schema:
 *
 *  1. A NEW ACTIVE VERSION of estimate.accepted_onboarding ("You're booked")
 *     with optional sections that drop out when empty: Property, Your plan and
 *     Payment (the card or bank label, how Auto Pay works and the stored
 *     authorization text, word for word). Every new block is driven by a
 *     variable the sender only fills under the gate, so with the gate off the
 *     email renders exactly as it does today (renderBlocks drops a heading,
 *     paragraph or details block whose variables are blank). The existing
 *     "Get the app" paragraph and the acceptance-terms copy are untouched.
 *  2. A NEW TEMPLATE, estimate.accepted_additional_property: the short email a
 *     later acceptance by the same customer the same ET day gets ("Added
 *     <street address> to your Waves plan" — first visit, plan, no app section,
 *     a payment section only for a payment method not already confirmed). It
 *     is cloned from the onboarding template's settings (stream, sender,
 *     wrapper) and carries {{acceptance_note}} so the promised copy of the
 *     accepted terms still goes out with every acceptance.
 *
 * Preview fixtures are added so the admin template preview renders every
 * section before the owner flips the gate.
 *
 * Read-modify-write of the live template (admin edits are preserved), the
 * customer-copy-audit publish pattern: template row locked first, the new
 * version published by compare-and-swap on the active version, only the
 * version it replaces archived. A template that already carries the sections,
 * has no active version, or has a custom plain-text body (the renderer's
 * generated text would no longer carry the new blocks) is left whole and
 * logged, never half-patched: the senders then keep sending the separate
 * emails, so nothing is lost. `down` is a documented no-op — a blanket revert
 * would erase admin edits made after this published.
 */

const MIGRATION = '20260929200000';
const MARKER = `migration:${MIGRATION}`;
const BASE_KEY = 'estimate.accepted_onboarding';
const SHORT_KEY = 'estimate.accepted_additional_property';

const PROPERTY_BLOCKS = [
  { type: 'heading', content: '{{property_heading}}' },
  { type: 'paragraph', content: '{{property_address}}' },
];

const PLAN_BLOCKS = [
  { type: 'heading', content: '{{plan_heading}}' },
  {
    type: 'details',
    rows: [
      { label: 'Plan', value: '{{plan_name}}' },
      { label: 'Effective date', value: '{{plan_effective_date}}' },
      { label: 'Rate', value: '{{plan_rate}}' },
      { label: 'Billing cadence', value: '{{plan_billing}}' },
      { label: 'Included services', value: '{{plan_services}}' },
    ],
  },
];

const PAYMENT_BLOCKS = [
  { type: 'heading', content: '{{payment_heading}}' },
  { type: 'details', rows: [{ label: 'Auto Pay method', value: '{{payment_method_label}}' }] },
  { type: 'paragraph', content: '{{payment_timing_line}}' },
  { type: 'paragraph', content: '{{authorization_intro}}' },
  { type: 'paragraph', content: '{{authorization_text}}' },
  { type: 'paragraph', content: '{{payment_manage_line}}' },
];

const NEW_VARIABLES = [
  'property_heading', 'property_address', 'property_street',
  'plan_heading', 'plan_name', 'plan_effective_date', 'plan_rate', 'plan_billing', 'plan_services',
  'payment_heading', 'payment_method_label', 'payment_timing_line',
  'authorization_intro', 'authorization_text', 'payment_manage_line',
];
// property_street only rides the short template's subject and heading.
const BASE_VARIABLES = NEW_VARIABLES.filter((v) => v !== 'property_street');

const SHORT_BLOCKS = [
  { type: 'heading', content: 'Added {{property_street}} to your Waves plan' },
  { type: 'paragraph', content: 'Hi {{first_name}}, your {{service_type}} is confirmed at {{property_address}}.' },
  { type: 'paragraph', content: '{{appointment_line}}' },
  ...PLAN_BLOCKS,
  ...PAYMENT_BLOCKS,
  { type: 'paragraph', content: '{{acceptance_note}}' },
  { type: 'small_note', content: 'Questions before we come out? Reply to this email or call {{company_phone}} — a real person answers.' },
  { type: 'cta', label: 'View my account', url_variable: 'customer_portal_url' },
  { type: 'signature', content: 'We look forward to servicing your home. — The Waves Team' },
];

const SHORT_TEMPLATE_VARIABLES = [
  'first_name', 'service_type', 'appointment_line', 'acceptance_note',
  'customer_portal_url', 'company_phone', ...NEW_VARIABLES,
];
const SHORT_REQUIRED = ['first_name', 'service_type', 'property_address', 'property_street', 'company_phone'];

const FALLBACK_AUTH_TEXT = 'By checking this box, I authorize Waves Pest Control, LLC to save this card and charge it for future service visits and invoices as agreed, until I revoke authorization.';

function authorizationFixtureText() {
  try {
    const { CARD_CONSENT_TEXT } = require('../../services/payment-method-consent-text');
    return CARD_CONSENT_TEXT || FALLBACK_AUTH_TEXT;
  } catch {
    return FALLBACK_AUTH_TEXT;
  }
}

function sectionFixture() {
  return {
    property_heading: 'Property',
    property_address: '123 Example Street, Bradenton, FL 34205',
    property_street: '123 Example Street',
    plan_heading: 'Your plan',
    plan_name: 'WaveGuard Gold',
    plan_effective_date: 'October 6, 2026',
    plan_rate: '$89.00',
    plan_billing: 'monthly',
    plan_services: 'Quarterly Pest Control, Lawn Care',
    payment_heading: 'Payment',
    payment_method_label: 'Visa ending 4242',
    payment_timing_line: 'Your monthly plan amount is charged to your card on your billing day each month, and you get a receipt every time.',
    authorization_intro: 'Your Auto Pay authorization, exactly as you agreed to it:',
    authorization_text: authorizationFixtureText(),
    payment_manage_line: 'You can turn Auto Pay off or remove your payment method anytime in the Waves app or your customer portal.',
  };
}

function withoutPayment(payload) {
  return {
    ...payload,
    payment_heading: '',
    payment_method_label: '',
    payment_timing_line: '',
    authorization_intro: '',
    authorization_text: '',
    payment_manage_line: '',
  };
}

function json(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
}

function unique(list) {
  return [...new Set(list)];
}

const referencesVariable = (blocks, name) => JSON.stringify(blocks || []).includes(`{{${name}}}`);

// Where the new blocks go — anchored on the seeded structure, with a safe
// fallback when an admin has reshaped the email (never a throw: a migration
// that fails blocks every deploy).
function insertSections(blocksIn) {
  const blocks = blocksIn.map((b) => ({ ...b }));
  // Property: right under the opening paragraph.
  const opener = blocks.findIndex((b) => b?.type === 'paragraph' && String(b.content || '').startsWith('Hi {{first_name}}'));
  blocks.splice(opener >= 0 ? opener + 1 : Math.min(1, blocks.length), 0, ...PROPERTY_BLOCKS.map((b) => ({ ...b })));
  // Plan + Payment: before "After every visit"; else before the acceptance
  // copy; else before the closing note / button / signature; else the end.
  let at = blocks.findIndex((b) => b?.type === 'heading' && b.content === 'After every visit');
  if (at < 0) at = blocks.findIndex((b) => referencesVariable([b], 'acceptance_note'));
  if (at < 0) at = blocks.findIndex((b) => ['small_note', 'cta', 'signature'].includes(b?.type));
  if (at < 0) at = blocks.length;
  blocks.splice(at, 0, ...PLAN_BLOCKS.map((b) => ({ ...b })), ...PAYMENT_BLOCKS.map((b) => ({ ...b })));
  return blocks;
}

async function publishBase(knex) {
  const template = await knex('email_templates').where({ template_key: BASE_KEY }).forUpdate().first();
  if (!template?.active_version_id) return 'missing';
  const prior = await knex('email_template_versions').where({ id: template.active_version_id }).first();
  if (!prior) return 'missing';

  // Fixtures first: the preview must render every section whichever way the
  // version publish below goes. Existing values win (admin edits are kept).
  if (await knex.schema.hasTable('email_template_fixtures')) {
    const fixtures = await knex('email_template_fixtures').where({ template_id: template.id });
    const sections = sectionFixture();
    for (const f of fixtures) {
      const payload = json(f.payload, {});
      const next = { ...payload };
      let changed = false;
      for (const [k, v] of Object.entries(sections)) {
        if (k === 'property_street') continue;
        if (next[k] === undefined) { next[k] = v; changed = true; }
      }
      if (changed) await knex('email_template_fixtures').where({ id: f.id }).update({ payload: JSON.stringify(next), updated_at: new Date() });
    }
    const named = 'Signup email — no Auto Pay section';
    if (!fixtures.some((f) => f.name === named)) {
      const baseFixture = json((fixtures.find((f) => f.is_default) || fixtures[0])?.payload, {});
      await knex('email_template_fixtures').insert({
        template_id: template.id,
        name: named,
        is_default: false,
        payload: JSON.stringify(withoutPayment({ ...sectionFixture(), ...baseFixture })),
        updated_at: new Date(),
      });
    }
  }

  const blocks = json(prior.blocks, null);
  if (!Array.isArray(blocks)) {
    console.warn(`[${MARKER}] ${BASE_KEY}: active blocks unreadable; template left as-is`);
    return 'skipped';
  }
  if (prior.text_body != null && String(prior.text_body).trim()) {
    console.warn(`[${MARKER}] ${BASE_KEY}: custom plain-text body present; template left as-is (separate emails keep sending)`);
    return 'skipped';
  }
  if (referencesVariable(blocks, 'plan_name') || referencesVariable(blocks, 'authorization_text')) return 'already';

  const allowed = unique([...json(template.allowed_variables, []), ...BASE_VARIABLES]);
  const optional = unique([...json(template.optional_variables, []), ...BASE_VARIABLES]);
  const now = new Date();
  await knex('email_templates').where({ id: template.id }).update({
    allowed_variables: JSON.stringify(allowed),
    optional_variables: JSON.stringify(optional),
    updated_at: now,
  });

  const nextBlocks = insertSections(blocks);
  const { validationFor } = require('../../services/email-template-library');
  const validation = validationFor({ ...template, allowed_variables: allowed }, { ...prior, blocks: nextBlocks });
  if (!validation.ok) {
    console.warn(`[${MARKER}] ${BASE_KEY}: new version failed variable validation; template left as-is`);
    return 'skipped';
  }
  const latest = await knex('email_template_versions').where({ template_id: template.id }).orderBy('version_number', 'desc').first();
  let created;
  try {
    // Savepoint: the admin editor allocates draft numbers the same way
    // (max + 1, no lock), so a concurrent draft can take this number.
    created = await knex.transaction(async (sp) => {
      const [row] = await sp('email_template_versions').insert({
        template_id: template.id,
        version_number: (latest?.version_number || 0) + 1,
        status: 'active',
        subject: prior.subject,
        preview_text: prior.preview_text,
        blocks: JSON.stringify(nextBlocks),
        text_body: null,
        validation_snapshot: JSON.stringify({ ...validation, source: MARKER, supersedes_version: prior.version_number }),
        published_at: now,
      }).returning('*');
      return row;
    });
  } catch (err) {
    if (err?.code !== '23505') throw err;
    console.warn(`[${MARKER}] ${BASE_KEY}: version number taken by a concurrent draft; template left as-is`);
    return 'raced';
  }
  const moved = await knex('email_templates')
    .where({ id: template.id, active_version_id: prior.id })
    .update({ active_version_id: created.id, last_published_at: now, updated_at: now });
  if (!moved) {
    await knex('email_template_versions').where({ id: created.id }).update({ status: 'archived', updated_at: now });
    return 'raced';
  }
  await knex('email_template_versions').where({ id: prior.id, status: 'active' }).update({ status: 'archived', updated_at: now });
  return 'published';
}

async function seedShort(knex) {
  const base = await knex('email_templates').where({ template_key: BASE_KEY }).first();
  if (!base) return 'missing';
  // An existing row (a re-run, or an admin-authored one) is never overwritten.
  if (await knex('email_templates').where({ template_key: SHORT_KEY }).first()) return 'exists';
  const now = new Date();
  const {
    id, created_at: _c, updated_at: _u, active_version_id: _a, last_published_at: _lp,
    created_by: _cb, last_published_by: _lpb, ...settings
  } = base;
  const optional = SHORT_TEMPLATE_VARIABLES.filter((v) => !SHORT_REQUIRED.includes(v));
  const [template] = await knex('email_templates').insert({
    ...settings,
    template_key: SHORT_KEY,
    name: 'Estimate Accepted — Added Property',
    description: 'Sent instead of the full "You\'re booked" email when the same customer accepts another estimate the same day: names the property, gives the first visit and the plan, and a payment section only for a payment method not already confirmed. No app section. Gated behind GATE_SIGNUP_SINGLE_EMAIL.',
    allowed_variables: JSON.stringify(unique([...json(base.allowed_variables, []), ...SHORT_TEMPLATE_VARIABLES])),
    required_variables: JSON.stringify(SHORT_REQUIRED),
    optional_variables: JSON.stringify(optional),
    status: 'active',
    created_at: now,
    updated_at: now,
  }).returning('*');
  const versionFields = {
    subject: 'Added {{property_street}} to your Waves plan',
    preview_text: '{{property_address}} — first visit and plan details.',
    blocks: JSON.stringify(SHORT_BLOCKS),
  };
  const { validationFor } = require('../../services/email-template-library');
  const validation = validationFor({ ...template, allowed_variables: json(template.allowed_variables, []), required_variables: SHORT_REQUIRED }, { ...versionFields, blocks: SHORT_BLOCKS, text_body: null });
  if (!validation.ok) throw new Error(`${MARKER}: ${SHORT_KEY} failed variable validation`);
  const [version] = await knex('email_template_versions').insert({
    template_id: template.id,
    version_number: 1,
    status: 'active',
    ...versionFields,
    text_body: null,
    validation_snapshot: JSON.stringify({ ...validation, source: MARKER }),
    published_at: now,
  }).returning('*');
  await knex('email_templates').where({ id: template.id }).update({ active_version_id: version.id, last_published_at: now, updated_at: now });
  if (await knex.schema.hasTable('email_template_fixtures')) {
    const shared = {
      first_name: 'Taylor',
      service_type: 'Quarterly Pest Control Service',
      appointment_line: 'Your first visit is scheduled for Tuesday, October 6 with an 8–10 AM arrival window.',
      acceptance_note: 'You accepted electronically on Tuesday, September 29, 2026 at 3:04 PM ET (terms v2026-09). What you accepted: “Accepting authorizes these services at the price shown. Cancel anytime — completed visits are still due.”',
      customer_portal_url: 'https://portal.wavespestcontrol.com/login',
      company_phone: '(941) 297-5749',
    };
    const full = { ...shared, ...sectionFixture() };
    await knex('email_template_fixtures').insert([
      { template_id: template.id, name: 'Added property — no new payment method', is_default: true, payload: JSON.stringify(withoutPayment(full)), updated_at: now },
      { template_id: template.id, name: 'Added property — new payment method', is_default: false, payload: JSON.stringify(full), updated_at: now },
    ]);
  }
  return 'seeded';
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  await knex.transaction(async (trx) => {
    const base = await publishBase(trx);
    const short = await seedShort(trx);
    console.log(`[${MARKER}] ${BASE_KEY}: ${base}; ${SHORT_KEY}: ${short}`);
    if (await trx.schema.hasTable('audit_log')) {
      const { recordAuditEvent } = require('../../services/audit-log');
      await recordAuditEvent({
        actor_type: 'system',
        action: `${MARKER}:publish`,
        resource_type: 'email_template',
        resource_id: null,
        metadata: { template_keys: [BASE_KEY, SHORT_KEY], base, short },
        critical: true,
        trx,
      });
    }
  });
};

exports.down = async function down() {
  // Data-only publish: a blanket revert would erase admin edits made after
  // it. Staff can republish the prior version from the template library.
};

exports._private = { insertSections, sectionFixture, withoutPayment, SHORT_BLOCKS, PLAN_BLOCKS, PAYMENT_BLOCKS, PROPERTY_BLOCKS, BASE_VARIABLES, SHORT_TEMPLATE_VARIABLES, SHORT_REQUIRED };
