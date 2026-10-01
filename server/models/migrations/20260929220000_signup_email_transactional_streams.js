'use strict';

/**
 * ONE SIGNUP EMAIL, round 1 (GATE_SIGNUP_SINGLE_EMAIL, dark) — follow-up to
 * 20260929200000, which is already applied and frozen.
 *
 *  1. The combined signup email replaces two emails that ride
 *     transactional_required (membership.started, the Auto Pay confirmation),
 *     so it must too: a SendGrid-side unsubscribe on the suppressible
 *     service_operational stream would otherwise swallow the plan record and
 *     the authorization copy after the two emails that carried them were
 *     skipped. Streams are per-template and gate-off must stay byte-identical
 *     (the plain estimate.accepted_onboarding keeps service_operational), so
 *     the gate-on email is its own template, estimate.accepted_signup, cloned
 *     from the onboarding template's settings and CURRENT active blocks — the
 *     Property / Your plan / Payment sections are taken from them when
 *     20260929200000 already published them, and inserted here when it did not
 *     (its publish skips itself, by design, when it loses a race or finds a
 *     custom plain-text body; this migration does not depend on it).
 *  2. The short per-property template moves to transactional_required too.
 *
 * Idempotent (an existing template is left whole — admin edits are kept) and
 * NOT silent on a race: any error, including a unique violation from a
 * concurrent template create, aborts the transaction and the migration, so it
 * is not recorded as applied and runs again. `down` is a documented no-op.
 */

const { validationFor } = require('../../services/email-template-library');
const first = require('./20260929200000_signup_single_email_templates');

const MARKER = 'migration:20260929220000';
const BASE_KEY = 'estimate.accepted_onboarding';
const SIGNUP_KEY = 'estimate.accepted_signup';
const SHORT_KEY = 'estimate.accepted_additional_property';
const STREAM = 'transactional_required';

function json(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
}
const unique = (list) => [...new Set(list)];

async function seedSignupTemplate(trx) {
  if (await trx('email_templates').where({ template_key: SIGNUP_KEY }).first()) return 'exists';
  const base = await trx('email_templates').where({ template_key: BASE_KEY }).forUpdate().first();
  if (!base?.active_version_id) return 'no_base';
  const active = await trx('email_template_versions').where({ id: base.active_version_id }).first();
  if (!active) return 'no_base';
  const baseBlocks = json(active.blocks, null);
  if (!Array.isArray(baseBlocks)) throw new Error(`${MARKER}: ${BASE_KEY} active blocks unreadable`);
  const { insertSections, BASE_VARIABLES } = first._private;
  const hasSections = JSON.stringify(baseBlocks).includes('{{authorization_text}}');
  const blocks = hasSections ? baseBlocks : insertSections(baseBlocks);

  const now = new Date();
  const {
    id: _id, created_at: _c, updated_at: _u, active_version_id: _a, last_published_at: _lp,
    created_by: _cb, last_published_by: _lpb, ...settings
  } = base;
  const allowed = unique([...json(base.allowed_variables, []), ...BASE_VARIABLES]);
  const optional = unique([...json(base.optional_variables, []), ...BASE_VARIABLES]);
  const [template] = await trx('email_templates').insert({
    ...settings,
    template_key: SIGNUP_KEY,
    name: 'Estimate Accepted — Signup Email (plan and Auto Pay included)',
    description: 'The ONE email at a recurring signup when GATE_SIGNUP_SINGLE_EMAIL is on: what happens next, plus the property, the plan and the Auto Pay authorization copy, on the transactional_required stream like the emails it replaces. The plain estimate.accepted_onboarding is unchanged and still used when the gate is off.',
    send_stream: STREAM,
    suppression_group_key: STREAM,
    allowed_variables: JSON.stringify(allowed),
    optional_variables: JSON.stringify(optional),
    // jsonb arrays come back parsed; pg would send a bare JS array as a PG array literal.
    required_variables: JSON.stringify(json(base.required_variables, [])),
    status: 'active',
    created_at: now,
    updated_at: now,
  }).returning('*');
  const validation = validationFor({ ...template, allowed_variables: allowed }, { subject: active.subject, preview_text: active.preview_text, blocks, text_body: null });
  if (!validation.ok) throw new Error(`${MARKER}: ${SIGNUP_KEY} failed variable validation`);
  const [version] = await trx('email_template_versions').insert({
    template_id: template.id,
    version_number: 1,
    status: 'active',
    subject: active.subject,
    preview_text: active.preview_text,
    blocks: JSON.stringify(blocks),
    text_body: null,
    validation_snapshot: JSON.stringify({ ...validation, source: MARKER }),
    published_at: now,
  }).returning('*');
  await trx('email_templates').where({ id: template.id }).update({ active_version_id: version.id, last_published_at: now, updated_at: now });

  if (await trx.schema.hasTable('email_template_fixtures')) {
    const baseFixtures = await trx('email_template_fixtures').where({ template_id: base.id }).orderBy('created_at');
    const sections = { ...first._private.sectionFixture() };
    delete sections.property_street;
    const rows = [];
    for (const f of baseFixtures) {
      rows.push({ template_id: template.id, name: f.name, is_default: !!f.is_default, payload: JSON.stringify({ ...sections, ...json(f.payload, {}) }), updated_at: now });
    }
    if (!rows.length) {
      rows.push({ template_id: template.id, name: 'Default preview', is_default: true, payload: JSON.stringify({ first_name: 'Taylor', service_type: 'Quarterly Pest Control Service', company_phone: '(941) 297-5749', customer_portal_url: 'https://portal.wavespestcontrol.com/login', ...sections }), updated_at: now });
    }
    if (!rows.some((r) => r.name === 'Signup email — no Auto Pay section')) {
      const seed = json(rows.find((r) => r.is_default)?.payload || rows[0].payload, {});
      rows.push({ template_id: template.id, name: 'Signup email — no Auto Pay section', is_default: false, payload: JSON.stringify(first._private.withoutPayment(seed)), updated_at: now });
    }
    await trx('email_template_fixtures').insert(rows);
  }
  return 'seeded';
}

async function moveShortTemplate(trx) {
  const short = await trx('email_templates').where({ template_key: SHORT_KEY }).forUpdate().first();
  if (!short) return 'missing';
  if (short.send_stream === STREAM && short.suppression_group_key === STREAM) return 'already';
  await trx('email_templates').where({ id: short.id }).update({ send_stream: STREAM, suppression_group_key: STREAM, updated_at: new Date() });
  return 'moved';
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  await knex.transaction(async (trx) => {
    const signup = await seedSignupTemplate(trx);
    const short = await moveShortTemplate(trx);
    console.log(`[${MARKER}] ${SIGNUP_KEY}: ${signup}; ${SHORT_KEY}: ${short}`);
  });
};

exports.down = async function down() {
  // Data-only: staff can archive or republish from the template library; a
  // blanket revert would erase admin edits made after this published.
};

exports._private = { seedSignupTemplate, moveShortTemplate };
