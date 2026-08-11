/**
 * Take "Reply STOP to opt out." off customer-transactional SMS (owner
 * directive 2026-08-10).
 *
 * Extends the 2026-08-01 ruling (see 20260801000001_sms_house_voice_sweep):
 * a customer who already knows they have an appointment — or knows they're a
 * customer — should not get opt-out boilerplate on every operational text.
 * That now includes appointment confirmations, the rain-out reschedule
 * notice (v3 shipped 07-30 and slipped past the 08-01 sweep), the secure
 * card-on-file booking-completion texts (excluded from the 07-30 audit as
 * owned by the then-in-flight cancel-fee migration), the auto-renewal
 * notice, and earned-referral-reward notifications.
 *
 * STOP disclosure still lives where compliance wants it: the
 * recipient_optin_request CTIA copy, lead first-contact templates
 * (missed_call, lead_auto_reply_biz, voicemail_quote_link,
 * dropped_call_address_request, booking_abandonment_recovery), estimate
 * delivery (program entry), onboarding welcomes (plausibly the first SMS a
 * new customer receives), and marketing solicitations (referral invite +
 * nudge, upsells, renewal win-back, review requests). The STOP keyword keeps
 * working regardless of copy — it is registered on the approved A2P campaign
 * and enforced by Twilio number-level opt-out plus our own detector.
 *
 * Bonus copy fixes riding along:
 *   - secure_appointment_card_plans: tightened intro ("To finish booking
 *     your {service_type}: prepay the year and save, or pay per visit…").
 *     With the STOP line gone this takes the only 3-segment template in the
 *     active fleet down to 2 segments at typical render lengths, with every
 *     disclosure intact (the truth-conditioned "unless you prepay", the
 *     cancel-fee clause, and the card-security line).
 *   - service_complete_paid_receipt: blank line between the report link and
 *     the receipt link — the two link blocks rendered jammed together
 *     (owner screenshot 2026-08-10).
 *
 * ADMIN-EDIT SAFETY (same contract as 20260730000020): each swap carries the
 * exact prod body audited 2026-08-10. A row whose body drifted (admin edited
 * since) gets the mechanical STOP-drop only, so admin wording is preserved;
 * the spacing-only receipt fix is snapshot-or-skip. Experiment variants
 * render INSTEAD of the base body, so the same keys are covered in
 * sms_template_variants, and the legacy referral columns on
 * referral_program_settings (reward/milestone render outside sms_templates)
 * get the same STOP-drop.
 */

// [template_key, expected prod body 2026-08-10, new body]
const SWAPS = [
  ['appointment_confirmation',
    'Hello {first_name}! Your {service_type} is confirmed for {date} at {time}.\n\n{reschedule_line}Reply STOP to opt out.',
    'Hello {first_name}! Your {service_type} is confirmed for {date} at {time}.\n\n{reschedule_line}'],
  ['appointment_confirmation_v2',
    'Hello {first_name}! Your {service_type} is booked for {date}, {window}.\n\n{appointment_line}Reply STOP to opt out.',
    'Hello {first_name}! Your {service_type} is booked for {date}, {window}.\n\n{appointment_line}'],
  ['rain_out_moved_v3',
    'Hi {first_name}, {weather_lead}, so we moved your {service_type} to {new_option}.{link_clause}\n\nReply STOP to opt out.',
    'Hi {first_name}, {weather_lead}, so we moved your {service_type} to {new_option}.{link_clause}'],
  ['secure_appointment_card',
    'Hi {first_name}! To finish booking your {service_type} visit{date_line}, add a card on file: {secure_link}\n\nNothing is charged today, only after the service is done.{cancel_fee_line}\nWe never take card numbers by phone. Reply STOP to opt out.',
    'Hi {first_name}! To finish booking your {service_type} visit{date_line}, add a card on file: {secure_link}\n\nNothing is charged today, only after the service is done.{cancel_fee_line}\nWe never take card numbers by phone.'],
  ['secure_appointment_card_plans',
    "Hi {first_name}! To finish booking your {service_type} visit{date_line}, pick how you'd like to pay - prepay the year and save, or pay per visit with a card on file. Nothing is charged today unless you choose to prepay: {secure_link}{cancel_fee_line}\nWe never take card numbers by phone. Reply STOP to opt out.",
    "Hi {first_name}! To finish booking your {service_type}{date_line}: prepay the year and save, or pay per application with a card on file. Nothing is charged today unless you prepay: {secure_link}{cancel_fee_line}\nWe never take card numbers by phone."],
  ['upsell_interest_confirmation',
    "Hello {first_name}! Thanks for your interest in {service_name}. We'll follow up within 24 hours to get you set up, and your {new_tier} WaveGuard discount applies automatically.\n\nReply STOP to opt out.",
    "Hello {first_name}! Thanks for your interest in {service_name}. We'll follow up within 24 hours to get you set up, and your {new_tier} WaveGuard discount applies automatically."],
  ['annual_prepay_renewal_reminder',
    "Hello {first_name}! Your prepaid plan year ends on {term_end}.{last_service_sentence}\n\nIt continues into next year on its own. Want to change or cancel? Reply and we'll help.\n\nReply STOP to opt out.",
    "Hello {first_name}! Your prepaid plan year ends on {term_end}.{last_service_sentence}\n\nIt continues into next year on its own. Want to change or cancel? Reply and we'll help."],
  ['referral_milestone',
    'Congrats {referrer_name}! You reached {milestone_level} with {count} referrals and earned {bonus_amount}. Thanks for helping Waves grow.\n\nReply STOP to opt out.',
    'Congrats {referrer_name}! You reached {milestone_level} with {count} referrals and earned {bonus_amount}. Thanks for helping Waves grow.'],
  ['referral_reward',
    '{referrer_name}, your referral {referee_name} signed up and you earned {reward_amount}. Thank you for sharing Waves.\n\nReply STOP to opt out.',
    '{referrer_name}, your referral {referee_name} signed up and you earned {reward_amount}. Thank you for sharing Waves.'],
  // Spacing only — no STOP line involved. Snapshot-or-skip (no mechanical
  // fallback: a drifted body means the admin already reshaped this copy).
  ['service_complete_paid_receipt',
    'Hello {first_name}! Payment received, ${amount}{card_line}. Thank you.\n\nYour {service_type} report: {portal_url}\nReceipt: {receipt_url}',
    'Hello {first_name}! Payment received, ${amount}{card_line}. Thank you.\n\nYour {service_type} report: {portal_url}\n\nReceipt: {receipt_url}'],
];

// Keys whose drifted/variant bodies still get the mechanical STOP-drop.
// service_complete_paid_receipt is deliberately absent (spacing-only).
const STOP_KEYS = new Set(SWAPS.map(([k]) => k).filter((k) => k !== 'service_complete_paid_receipt'));

// Same strip as 20260730000020: handles the "\n\nReply STOP…" tail and the
// same-line "phone. Reply STOP…" form, then tidies whitespace.
function dropStop(body) {
  return String(body)
    .replace(/\n{1,2}Reply STOP to opt out\.?/g, '')
    .replace(/ ?Reply STOP to opt out\.?/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trimEnd();
}

function mechanical(key, body) {
  let next = dropStop(body);
  if (key === 'secure_appointment_card_plans') {
    next = next
      .replace('unless you choose to prepay', 'unless you prepay')
      // Price-unit rule: customer-facing copy says "per application",
      // never "per visit" — normalize drifted/variant bodies too.
      .replace(/\bper visit\b/g, 'per application');
  }
  return next;
}

// The reschedule-reply templates were seeded WITH the STOP line
// (20260707000030) and cleaned by the 20260730000020 mechanical pass, so
// every environment built from the full chain — prod included (verified
// read-only 2026-08-10) — is already clean and this is a no-op there. The
// keys are covered here anyway so the guarantee is structural, not an
// accident of migration history, and so a re-seeded or hand-restored row
// can't resurrect the STOP tail the code fallbacks no longer carry.
const MECHANICAL_ONLY_KEYS = [
  'reschedule_confirmed_today',
  'reschedule_confirmed_tomorrow',
  'reschedule_confirmed_future',
  'reschedule_call_requested',
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  for (const [key, expect, set] of SWAPS) {
    const row = await knex('sms_templates').where({ template_key: key }).first('id', 'body');
    if (!row || typeof row.body !== 'string') continue;
    let next;
    if (row.body === expect) {
      next = set;
    } else if (STOP_KEYS.has(key)) {
      // Admin edited since the 2026-08-10 audit — mechanical STOP-drop only.
      next = mechanical(key, row.body);
    } else {
      continue;
    }
    if (next !== row.body) {
      // Compare-and-swap on the body we read: an admin save landing between
      // the read and this update wins instead of being overwritten.
      await knex('sms_templates').where({ id: row.id, body: row.body }).update({ body: next, updated_at: new Date() });
    }
  }

  // Experiment variants render INSTEAD of the base body — same policy. A
  // variant whose body exactly matches the audited base body gets the full
  // rewrite; a diverged one gets the mechanical STOP-drop only (and the
  // spacing-only receipt fix is exact-match-or-skip, same as the base row).
  if (await knex.schema.hasTable('sms_template_variants')) {
    const swapByKey = new Map(SWAPS.map(([key, expect, set]) => [key, { expect, set }]));
    const variants = await knex('sms_template_variants')
      .whereIn('template_key', SWAPS.map(([key]) => key))
      .select('id', 'template_key', 'body');
    for (const v of variants) {
      if (typeof v.body !== 'string') continue;
      const swap = swapByKey.get(v.template_key);
      let next;
      if (swap && v.body === swap.expect) {
        next = swap.set;
      } else if (STOP_KEYS.has(v.template_key)) {
        next = mechanical(v.template_key, v.body);
      } else {
        continue;
      }
      if (next !== v.body) {
        await knex('sms_template_variants').where({ id: v.id, body: v.body }).update({ body: next, updated_at: new Date() });
      }
    }
  }

  // Reschedule-reply templates: STOP-drop only (see MECHANICAL_ONLY_KEYS).
  {
    const rows = await knex('sms_templates')
      .whereIn('template_key', MECHANICAL_ONLY_KEYS)
      .select('id', 'body');
    for (const row of rows) {
      if (typeof row.body !== 'string') continue;
      const next = dropStop(row.body);
      if (next !== row.body) {
        await knex('sms_templates').where({ id: row.id, body: row.body }).update({ body: next, updated_at: new Date() });
      }
    }
    if (await knex.schema.hasTable('sms_template_variants')) {
      const variants = await knex('sms_template_variants')
        .whereIn('template_key', MECHANICAL_ONLY_KEYS)
        .select('id', 'body');
      for (const v of variants) {
        if (typeof v.body !== 'string') continue;
        const next = dropStop(v.body);
        if (next !== v.body) {
          await knex('sms_template_variants').where({ id: v.id, body: v.body }).update({ body: next, updated_at: new Date() });
        }
      }
    }
  }

  // Legacy referral copy renders OUTSIDE sms_templates (referral-engine
  // legacy path; see 20260730000020). Reward + milestone are transactional
  // notices — same STOP-drop. The invite column keeps its opt-out line
  // (third-party first touch).
  if (await knex.schema.hasTable('referral_program_settings')) {
    const row = await knex('referral_program_settings').where({ id: 1 })
      .first('id', 'reward_sms_template', 'milestone_sms_template');
    if (row) {
      const patch = {};
      for (const col of ['reward_sms_template', 'milestone_sms_template']) {
        if (typeof row[col] === 'string' && row[col]) {
          const next = dropStop(row[col]);
          if (next !== row[col]) patch[col] = next;
        }
      }
      if (Object.keys(patch).length) {
        let q = knex('referral_program_settings').where({ id: row.id });
        for (const col of Object.keys(patch)) q = q.where(col, row[col]);
        await q.update({ ...patch, updated_at: new Date() });
      }
    }
  }
};

exports.down = async function down(knex) {
  // Copy-only migration: restore the audited bodies where the current body
  // matches what up() set — base rows AND exact-match variants (getTemplate
  // prefers an active variant over the base body, so leaving a rewritten
  // variant behind would defeat the rollback). Mechanical-pass rows and the
  // legacy referral columns are not restored (no snapshot of their prior
  // state) — same contract as 20260730000020.
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  for (const [key, expect, set] of SWAPS) {
    const row = await knex('sms_templates').where({ template_key: key }).first('id', 'body');
    if (!row || row.body !== set) continue;
    await knex('sms_templates').where({ id: row.id, body: set }).update({ body: expect, updated_at: new Date() });
  }
  if (await knex.schema.hasTable('sms_template_variants')) {
    for (const [key, expect, set] of SWAPS) {
      const variants = await knex('sms_template_variants')
        .where({ template_key: key })
        .select('id', 'body');
      for (const v of variants) {
        if (v.body !== set) continue;
        await knex('sms_template_variants').where({ id: v.id, body: set }).update({ body: expect, updated_at: new Date() });
      }
    }
  }
};

exports._SWAPS = SWAPS;
exports._dropStop = dropStop;
exports._mechanical = mechanical;
exports._MECHANICAL_ONLY_KEYS = MECHANICAL_ONLY_KEYS;
