'use strict';

/**
 * ONE SIGNUP EMAIL, round 4 follow-up (GATE_SIGNUP_SINGLE_EMAIL, dark). Data
 * only. 20260929200000, 20260929220000 and 20260930000000 are already applied
 * and FROZEN; this migration fixes what they left behind.
 *
 *  1. Names and descriptions. After the owner's 2026-09-30 ruling (Auto Pay
 *     stays its own email) the admin library still described
 *     estimate.accepted_signup as "plan and Auto Pay included" and
 *     estimate.accepted_additional_property as having "a payment section". Each
 *     name and description is rewritten ONLY where it still equals the text the
 *     earlier migration seeded, so anything staff edited is preserved.
 *  2. Audit trail. The earlier signup migrations changed live email templates
 *     (0929200000 already writes its audit event). One audit_log event is now
 *     written, on the migration's own transaction, for the changes made by
 *     20260929220000, 20260930000000 and this migration, each only when that
 *     migration's change is actually present, and never twice (an event with
 *     the same action is not written again), so a re-run adds nothing.
 *
 * `down` is a documented no-op: a revert would erase admin edits made after
 * this published.
 */

const MARKER = 'migration:20260930010000';
const STREAMS = 'migration:20260929220000';
const DROP_PAYMENT = 'migration:20260930000000';

const SIGNUP_KEY = 'estimate.accepted_signup';
const SHORT_KEY = 'estimate.accepted_additional_property';

const TEXT = {
  [SIGNUP_KEY]: {
    name: {
      from: 'Estimate Accepted — Signup Email (plan and Auto Pay included)',
      to: 'Estimate Accepted — Signup Email',
    },
    description: {
      from: 'The ONE email at a recurring signup when GATE_SIGNUP_SINGLE_EMAIL is on: what happens next, plus the property, the plan and the Auto Pay authorization copy, on the transactional_required stream like the emails it replaces. The plain estimate.accepted_onboarding is unchanged and still used when the gate is off.',
      to: 'The ONE email at a recurring signup when GATE_SIGNUP_SINGLE_EMAIL is on: what happens next, plus the property and the plan, on the transactional_required stream like the emails it replaces. The "Auto Pay is set up" email stays separate. The plain estimate.accepted_onboarding is unchanged and still used when the gate is off.',
    },
  },
  [SHORT_KEY]: {
    name: {
      from: 'Estimate Accepted — Added Property',
      to: 'Estimate Accepted — Added Property',
    },
    description: {
      from: 'Sent instead of the full "You\'re booked" email when the same customer accepts another estimate the same day: names the property, gives the first visit and the plan, and a payment section only for a payment method not already confirmed. No app section. Gated behind GATE_SIGNUP_SINGLE_EMAIL.',
      to: 'Sent instead of the full "You\'re booked" email when the same customer accepts another estimate the same day: names the property, gives the first visit and the plan. No app section and no payment section (the "Auto Pay is set up" email stays separate). Gated behind GATE_SIGNUP_SINGLE_EMAIL.',
    },
  },
};

const clean = (v) => String(v == null ? '' : v).trim();

async function updateText(knex) {
  const changed = {};
  for (const [key, fields] of Object.entries(TEXT)) {
    const template = await knex('email_templates').where({ template_key: key }).forUpdate().first();
    if (!template) continue;
    const patch = {};
    for (const [field, { from, to }] of Object.entries(fields)) {
      if (from !== to && clean(template[field]) === clean(from)) patch[field] = to;
    }
    if (!Object.keys(patch).length) continue;
    await knex('email_templates').where({ id: template.id }).update({ ...patch, updated_at: new Date() });
    changed[key] = Object.keys(patch);
  }
  return changed;
}

// Template keys whose active or archived versions were published by `source`.
async function keysPublishedBy(knex, source) {
  if (!(await knex.schema.hasTable('email_template_versions'))) return [];
  const rows = await knex('email_template_versions as v')
    .join('email_templates as t', 't.id', 'v.template_id')
    .whereRaw("v.validation_snapshot->>'source' = ?", [source])
    .distinct('t.template_key');
  return rows.map((r) => r.template_key).sort();
}

async function audit(trx, action, metadata) {
  const { recordAuditEvent } = require('../../services/audit-log');
  const existing = await trx('audit_log').where({ action }).first('id');
  if (existing) return false;
  await recordAuditEvent({
    actor_type: 'system',
    action,
    resource_type: 'email_template',
    resource_id: null,
    metadata,
    critical: true,
    trx,
  });
  return true;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  await knex.transaction(async (trx) => {
    const changed = await updateText(trx);
    const streamKeys = await keysPublishedBy(trx, STREAMS);
    const short = await trx('email_templates').where({ template_key: SHORT_KEY }).first('send_stream', 'suppression_group_key');
    const movedShort = short?.send_stream === 'transactional_required' && short?.suppression_group_key === 'transactional_required';
    const droppedKeys = await keysPublishedBy(trx, DROP_PAYMENT);
    const written = [];
    if (await trx.schema.hasTable('audit_log')) {
      if (streamKeys.length || movedShort) {
        if (await audit(trx, `${STREAMS}:publish`, {
          template_keys: [...new Set([...streamKeys, ...(movedShort ? [SHORT_KEY] : [])])].sort(),
          change: 'seeded estimate.accepted_signup on transactional_required; moved estimate.accepted_additional_property to transactional_required',
          recorded_by: MARKER,
        })) written.push(STREAMS);
      }
      if (droppedKeys.length) {
        if (await audit(trx, `${DROP_PAYMENT}:publish`, {
          template_keys: droppedKeys,
          change: 'removed the Payment section from the signup email templates and their preview fixtures',
          recorded_by: MARKER,
        })) written.push(DROP_PAYMENT);
      }
      if (Object.keys(changed).length) {
        if (await audit(trx, `${MARKER}:publish`, {
          template_keys: Object.keys(changed).sort(),
          fields: changed,
          change: 'template names and descriptions no longer mention Auto Pay / a payment section (only where still the seeded text)',
        })) written.push(MARKER);
      }
    }
    console.log(`[${MARKER}] text updated: ${JSON.stringify(changed)}; audit events written: ${JSON.stringify(written)}`);
  });
};

exports.down = async function down() {
  // Data-only: a revert would erase admin edits made after this published.
};

exports._private = { TEXT, updateText, keysPublishedBy };
