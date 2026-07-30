// SMS template audit (owner-adopted 2026-07-30). Four coordinated changes
// across the fleet, computed offline from the live prod bodies and applied
// as exact old→new swaps (data file alongside this migration):
//
//   1. GSM-7 normalization — em-dashes/curly quotes forced UCS-2 encoding on
//      49 active templates, shrinking segments from 153 to 67 chars (~2-3x
//      send cost). Typography only, no wording changes.
//   2. STOP policy — "Reply STOP to opt out" stays on marketing/outreach/
//      first-touch templates and is removed from transactional ones.
//      Disclosure is preserved via appointment_confirmation (program start),
//      reminder_72h (periodic for active customers), and
//      recipient_optin_request (full CTIA disclosure). STOP always works
//      regardless of copy (Twilio number-level opt-out).
//   3. Structure — paragraph breaks on dense prep guides, link-last on the
//      worst offenders, card-hold policy line moved BEFORE the closing line
//      on reminder_24h, standard "Hello {first_name}!" greeting.
//
// Safety: a row whose body no longer matches the snapshot (admin edited it
// after the audit) is NOT hand-swapped — it gets the mechanical passes only
// (GSM normalization + policy STOP-drop) so admin wording is preserved.
// secure_appointment_card / _plans are excluded (owned by the in-flight
// cancel-fee migration 20260730000010).
const TRANSFORMS = require('./20260730000020_sms_template_audit.data.json');

const KEEP_STOP = new Set([
  'appointment_confirmation', 'reminder_72h',
  'missed_call', 'lead_auto_reply_biz', 'voicemail_quote_link',
  'referral_enrollment', 'referral_nudge', 'referral_invite', 'referral_reward', 'referral_milestone',
  'renewal_reminder', 'annual_prepay_renewal_reminder',
  'upsell_interest_confirmation', 'upsell_tier_upgrade', 'upsell_add_service',
  'review_request', 'review_request_followup',
  'booking_abandonment_recovery', 'recipient_optin_request', 'seasonal_reactivation',
  'estimate_sent', 'estimate_followup_unviewed', 'estimate_followup_viewed', 'estimate_followup_final',
  'estimate_followup_expiring', 'estimate_followup_deposit', 'quote_wizard_booking_invite', 'estimate_extended',
  'auto_new_recurring', 'auto_new_appointment',
  'cancellation_save_step1_price', 'cancellation_save_step1_moving', 'cancellation_save_step1_quality',
  'cancellation_save_step1_default', 'cancellation_save_step2_price', 'cancellation_save_step2_moving',
  'cancellation_save_step2_quality', 'cancellation_save_step2_default', 'cancellation_save_step3',
  'cancellation_save_accepted_offer', 'cancellation_save_callback_requested', 'cancellation_save_cancelled',
]);

function gsmNormalize(body) {
  return String(body)
    .replace(/[—–]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/ /g, ' ');
}
function dropStop(body) {
  return String(body)
    .replace(/\n{1,2}Reply STOP to opt out\.?/g, '')
    .replace(/ ?Reply STOP to opt out\.?/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trimEnd();
}
// STOP is dropped ONLY for keys explicitly audited as transactional — the
// snapshot's changed keys minus the keep-list. An UNKNOWN key (a template or
// variant created after the audit, possibly marketing) keeps its opt-out
// line and gets typography normalization only (Codex #3080 P1: defaulting
// unknown keys to "transactional" would strip a marketing template's
// required disclosure).
const DROP_STOP = new Set(TRANSFORMS.map((t) => t.key).filter((k) => !KEEP_STOP.has(k)));

function mechanical(key, body) {
  let next = gsmNormalize(body);
  if (DROP_STOP.has(key)) next = dropStop(next);
  return next;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  for (const entry of TRANSFORMS) {
    const row = await knex('sms_templates').where({ template_key: entry.key }).first('id', 'body');
    if (!row || typeof row.body !== 'string') continue;
    let next;
    if (row.body === entry.expect) {
      next = entry.set;
    } else {
      // Admin edited since the audit snapshot — mechanical passes only.
      next = mechanical(entry.key, row.body);
    }
    if (next !== row.body) {
      await knex('sms_templates').where({ id: row.id }).update({ body: next, updated_at: new Date() });
    }
  }

  // Any template NOT in the snapshot (created after the audit) still gets the
  // mechanical passes so the fleet stays uniform.
  const snapshotKeys = new Set(TRANSFORMS.map((t) => t.key));
  const rest = await knex('sms_templates')
    .whereNotIn('template_key', [...snapshotKeys, 'secure_appointment_card', 'secure_appointment_card_plans'])
    .select('id', 'template_key', 'body');
  for (const row of rest) {
    if (typeof row.body !== 'string') continue;
    const next = mechanical(row.template_key, row.body);
    if (next !== row.body) {
      await knex('sms_templates').where({ id: row.id }).update({ body: next, updated_at: new Date() });
    }
  }

  // Experiment variants render INSTEAD of the base body — same passes.
  if (await knex.schema.hasTable('sms_template_variants')) {
    const variants = await knex('sms_template_variants').select('id', 'template_key', 'body');
    for (const v of variants) {
      if (typeof v.body !== 'string') continue;
      if (v.template_key === 'secure_appointment_card' || v.template_key === 'secure_appointment_card_plans') continue;
      let next = mechanical(v.template_key, v.body);
      if (v.template_key === 'autopay_pre_charge') {
        // A selected variant renders INSTEAD of the rewritten base body —
        // carry the plan-aware label into it too, or a tierless monthly
        // customer could receive the misbranded "WaveGuard" literal this
        // migration exists to eliminate (the outbound guard that used to
        // block it is retired in this same change). The sender always
        // supplies {autopay_label}.
        next = next.replace(/WaveGuard auto-pay/g, '{autopay_label}');
      }
      if (next !== v.body) {
        await knex('sms_template_variants').where({ id: v.id }).update({ body: next, updated_at: new Date() });
      }
    }
  }

  // autopay_pre_charge now renders a per-customer {autopay_label}
  // ("WaveGuard auto-pay" for members, "Waves auto-pay" otherwise) — declare
  // the new variable so admin edits keep validating (add-only, preserves any
  // admin-added variables).
  {
    const row = await knex('sms_templates').where({ template_key: 'autopay_pre_charge' }).first('id', 'variables');
    if (row) {
      try {
        const list = Array.isArray(row.variables) ? row.variables : JSON.parse(row.variables || '[]');
        if (!list.includes('autopay_label')) {
          list.push('autopay_label');
          await knex('sms_templates').where({ id: row.id }).update({ variables: JSON.stringify(list), updated_at: new Date() });
        }
      } catch { /* unparseable metadata — leave untouched */ }
    }
  }

  // Legacy referral copy stored on referral_program_settings renders OUTSIDE
  // sms_templates (referral-engine legacy path) — GSM-normalize it too so the
  // encoding win covers referral sends. (Unifying that path into
  // sms_templates is a flagged follow-up, not this migration's job.)
  if (await knex.schema.hasTable('referral_program_settings')) {
    const row = await knex('referral_program_settings').where({ id: 1 })
      .first('id', 'invite_sms_template', 'reward_sms_template', 'milestone_sms_template');
    if (row) {
      const patch = {};
      for (const col of ['invite_sms_template', 'reward_sms_template', 'milestone_sms_template']) {
        if (typeof row[col] === 'string' && row[col]) {
          const next = gsmNormalize(row[col]);
          if (next !== row[col]) patch[col] = next;
        }
      }
      if (Object.keys(patch).length) {
        await knex('referral_program_settings').where({ id: row.id }).update({ ...patch, updated_at: new Date() });
      }
    }
  }
};

exports.down = async function down(knex) {
  // Copy-only migration: restore the audited bodies from the snapshot where
  // the current body matches what up() set. Mechanical-pass-only rows and
  // metadata cleanup are not restored (no snapshot of their prior state).
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  for (const entry of TRANSFORMS) {
    const row = await knex('sms_templates').where({ template_key: entry.key }).first('id', 'body');
    if (!row || row.body !== entry.set) continue;
    await knex('sms_templates').where({ id: row.id }).update({ body: entry.expect, updated_at: new Date() });
  }
};
