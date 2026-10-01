'use strict';

/**
 * ONE SIGNUP EMAIL, owner ruling 2026-09-30 (GATE_SIGNUP_SINGLE_EMAIL, dark):
 * the "Auto Pay is set up" confirmation stays its OWN email, so the combined
 * "You're booked" email has NO Payment section. Follow-up to 20260929200000 and
 * 20260929220000, which are already applied and frozen.
 *
 * Those migrations put a variable-driven Payment section (heading, method row,
 * charge timing, the stored authorization text, manage line) into
 * estimate.accepted_onboarding, estimate.accepted_signup and
 * estimate.accepted_additional_property, plus preview fixtures that fill it.
 * The senders no longer pass any payment variable, so the section renders
 * empty in a real send; but the admin PREVIEW fixtures still show it, which
 * would mislead the owner's pre-flip review. This migration removes it:
 *
 *  - per template, a new ACTIVE version without the Payment blocks, published
 *    read-modify-write with the same compare-and-swap on the active version the
 *    earlier migrations use (template row locked first, only the version it
 *    replaces archived). The blocks are removed ONLY as the exact run the
 *    earlier migration inserted; a template whose blocks were reshaped by an
 *    admin, that has a custom plain-text body, or that has no Payment run is
 *    left whole and logged, never half-patched;
 *  - per template, the payment fixture variables are dropped from every
 *    preview fixture, and the fixtures that existed only to show "with /
 *    without Payment" (exact seeded names, never a default, payload now
 *    identical to a fixture that stays) are removed. The leftover
 *    "no new payment method" name on the surviving added-property fixture is
 *    renamed.
 *
 * The allowed/optional variable lists are left alone (an older version that
 * still names them must keep validating if staff republish it). Idempotent: a
 * second run finds nothing to do. `down` is a documented no-op: a revert would
 * erase admin edits made after this published, and the earlier migrations'
 * blocks render empty without payment variables anyway.
 */

const MARKER = 'migration:20260930000000';
const TEMPLATE_KEYS = [
  'estimate.accepted_onboarding',
  'estimate.accepted_signup',
  'estimate.accepted_additional_property',
];
const PAYMENT_VARIABLES = [
  'payment_heading', 'payment_method_label', 'payment_timing_line',
  'authorization_intro', 'authorization_text', 'payment_manage_line',
];
// Exactly what 20260929200000 inserted (its PAYMENT_BLOCKS).
const PAYMENT_BLOCKS = [
  { type: 'heading', content: '{{payment_heading}}' },
  { type: 'details', rows: [{ label: 'Auto Pay method', value: '{{payment_method_label}}' }] },
  { type: 'paragraph', content: '{{payment_timing_line}}' },
  { type: 'paragraph', content: '{{authorization_intro}}' },
  { type: 'paragraph', content: '{{authorization_text}}' },
  { type: 'paragraph', content: '{{payment_manage_line}}' },
];
// Fixtures the earlier migrations created only to show the with/without split.
const REDUNDANT_FIXTURE_NAMES = [
  'Signup email — no Auto Pay section',
  'Added property — new payment method',
];
const RENAMES = { 'Added property — no new payment method': 'Added property' };

function json(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
}

// Key-order-insensitive equality: jsonb hands object keys back in its own order.
const canonical = (v) => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
};
const same = (a, b) => canonical(a) === canonical(b);

// Index of the exact PAYMENT_BLOCKS run inside `blocks`, or -1.
function findPaymentRun(blocks) {
  for (let i = 0; i + PAYMENT_BLOCKS.length <= blocks.length; i += 1) {
    if (PAYMENT_BLOCKS.every((b, k) => same(blocks[i + k], b))) return i;
  }
  return -1;
}

const referencesPayment = (blocks) => {
  const text = JSON.stringify(blocks || []);
  return PAYMENT_VARIABLES.some((v) => text.includes(`{{${v}}}`));
};

const omit = (obj, key) => { const { [key]: _drop, ...rest } = obj || {}; return rest; };

function stripPayment(payload) {
  const next = { ...payload };
  for (const key of PAYMENT_VARIABLES) delete next[key];
  return next;
}

async function cleanFixtures(knex, template) {
  if (!(await knex.schema.hasTable('email_template_fixtures'))) return { stripped: 0, removed: 0, renamed: 0 };
  const fixtures = await knex('email_template_fixtures').where({ template_id: template.id }).orderBy('created_at');
  let stripped = 0;
  const kept = [];
  for (const f of fixtures) {
    const payload = json(f.payload, {});
    const next = stripPayment(payload);
    if (!same(next, payload)) {
      await knex('email_template_fixtures').where({ id: f.id }).update({ payload: JSON.stringify(next), updated_at: new Date() });
      stripped += 1;
    }
    kept.push({ ...f, payload: next });
  }
  let removed = 0;
  const survivors = [];
  for (const f of kept) {
    // property_street only feeds the added-property subject; a fixture that
    // differs from its twin by that one key alone is still a duplicate.
    const twin = kept.find((o) => o.id !== f.id && !REDUNDANT_FIXTURE_NAMES.includes(o.name)
      && same(omit(o.payload, 'property_street'), omit(f.payload, 'property_street')));
    if (!f.is_default && REDUNDANT_FIXTURE_NAMES.includes(f.name) && twin) {
      await knex('email_template_fixtures').where({ id: f.id }).del();
      removed += 1;
    } else {
      survivors.push(f);
    }
  }
  let renamed = 0;
  for (const f of survivors) {
    const to = RENAMES[f.name];
    if (to && !survivors.some((o) => o.name === to)) {
      await knex('email_template_fixtures').where({ id: f.id }).update({ name: to, updated_at: new Date() });
      renamed += 1;
    }
  }
  return { stripped, removed, renamed };
}

async function dropPaymentSection(knex, key) {
  const template = await knex('email_templates').where({ template_key: key }).forUpdate().first();
  if (!template) return 'missing';
  // Fixtures first: the preview must lose the section whichever way the
  // version publish below goes (existing admin edits to other values stay).
  const fixtures = await cleanFixtures(knex, template);
  if (!template.active_version_id) return `no_active_version (fixtures ${JSON.stringify(fixtures)})`;
  const prior = await knex('email_template_versions').where({ id: template.active_version_id }).first();
  if (!prior) return 'no_active_version';
  const blocks = json(prior.blocks, null);
  if (!Array.isArray(blocks)) {
    console.warn(`[${MARKER}] ${key}: active blocks unreadable; template left as-is`);
    return 'skipped';
  }
  if (!referencesPayment(blocks)) return `already (fixtures ${JSON.stringify(fixtures)})`;
  if (prior.text_body != null && String(prior.text_body).trim()) {
    console.warn(`[${MARKER}] ${key}: custom plain-text body present; template left as-is`);
    return 'skipped';
  }
  const at = findPaymentRun(blocks);
  if (at < 0) {
    console.warn(`[${MARKER}] ${key}: Payment blocks are not the seeded run (edited by staff); template left as-is`);
    return 'skipped';
  }
  const nextBlocks = [...blocks.slice(0, at), ...blocks.slice(at + PAYMENT_BLOCKS.length)];
  if (referencesPayment(nextBlocks)) {
    console.warn(`[${MARKER}] ${key}: payment variables still referenced after removal; template left as-is`);
    return 'skipped';
  }
  const { validationFor } = require('../../services/email-template-library');
  const validation = validationFor(
    { ...template, allowed_variables: json(template.allowed_variables, []), required_variables: json(template.required_variables, []) },
    { ...prior, blocks: nextBlocks, text_body: null },
  );
  if (!validation.ok) {
    console.warn(`[${MARKER}] ${key}: new version failed variable validation; template left as-is`);
    return 'skipped';
  }
  const latest = await knex('email_template_versions').where({ template_id: template.id }).orderBy('version_number', 'desc').first();
  const now = new Date();
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
    console.warn(`[${MARKER}] ${key}: version number taken by a concurrent draft; template left as-is`);
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
  return `published (fixtures ${JSON.stringify(fixtures)})`;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  await knex.transaction(async (trx) => {
    const results = {};
    for (const key of TEMPLATE_KEYS) results[key] = await dropPaymentSection(trx, key);
    console.log(`[${MARKER}] ${JSON.stringify(results)}`);
  });
};

exports.down = async function down() {
  // Data-only: a blanket revert would erase admin edits made after this
  // published. Staff can republish an earlier version from the template library.
};

exports._private = { findPaymentRun, stripPayment, PAYMENT_BLOCKS, PAYMENT_VARIABLES, TEMPLATE_KEYS };
