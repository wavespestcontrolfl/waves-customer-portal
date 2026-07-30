/**
 * Guards the SMS-audit transform table (migration 20260730000020): every
 * rewritten body must stay GSM-7-safe, keep single-brace token syntax, honor
 * the owner-adopted STOP policy, and never introduce or drop template
 * variables relative to the audited body.
 */

const TRANSFORMS = require('../models/migrations/20260730000020_sms_template_audit.data.json');

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
]);

const tokens = (body) => [...String(body).matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map((m) => m[1]).sort();

describe('sms template audit transform table', () => {
  test('covers a meaningful slice of the fleet and every entry changes something', () => {
    expect(TRANSFORMS.length).toBeGreaterThan(50);
    for (const t of TRANSFORMS) expect(t.set).not.toBe(t.expect);
  });

  test('rewritten bodies are GSM-7-safe (no em-dash, curly quotes, ellipsis, nbsp)', () => {
    const offenders = TRANSFORMS.filter((t) => /[\u2014\u2013\u2018\u2019\u201C\u201D\u2026\u00A0]/.test(t.set)).map((t) => t.key);
    expect(offenders).toEqual([]);
  });

  test('no double-brace syntax anywhere', () => {
    const offenders = TRANSFORMS.filter((t) => /\{\{|\}\}/.test(t.set)).map((t) => t.key);
    expect(offenders).toEqual([]);
  });

  test('STOP policy: dropped from transactional, kept on marketing/outreach', () => {
    const leaks = TRANSFORMS
      .filter((t) => !KEEP_STOP.has(t.key) && !t.key.startsWith('cancellation_save_'))
      .filter((t) => /Reply STOP/i.test(t.set))
      .map((t) => t.key)
      // recipient_optin_request carries the full CTIA disclosure by design.
      .filter((k) => k !== 'recipient_optin_request');
    expect(leaks).toEqual([]);

    for (const t of TRANSFORMS) {
      if (KEEP_STOP.has(t.key) && /Reply STOP to opt out/.test(t.expect)) {
        expect(t.set).toMatch(/STOP/);
      }
    }
  });

  test('rewrites preserve the exact variable set of the audited body', () => {
    // autopay_pre_charge is the ONE deliberate variable change: the hardcoded
    // "WaveGuard" brand became a per-customer {autopay_label} (owner ruling
    // 2026-07-30 — the old copy misbranded non-WaveGuard monthly customers
    // and was guard-blocked for everyone).
    const VAR_CHANGE_EXCEPTIONS = { autopay_pre_charge: ['autopay_label', 'charge_date', 'first_name'] };
    for (const t of TRANSFORMS) {
      const before = tokens(t.expect);
      const after = tokens(t.set);
      if (VAR_CHANGE_EXCEPTIONS[t.key]) {
        expect({ key: t.key, vars: after }).toEqual({ key: t.key, vars: VAR_CHANGE_EXCEPTIONS[t.key] });
        continue;
      }
      expect({ key: t.key, vars: after }).toEqual({ key: t.key, vars: before });
    }
  });

  test('no trailing whitespace or blank-line runs in rewritten bodies', () => {
    for (const t of TRANSFORMS) {
      expect(t.set).not.toMatch(/\n{3,}/);
      expect(t.set).not.toMatch(/[ \t]+\n/);
      expect(t.set).not.toMatch(/\s+$/);
    }
  });
});
