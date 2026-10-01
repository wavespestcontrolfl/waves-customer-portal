/**
 * email-division/eligibility.js — the fail-closed allow/deny authority for
 * every future marketing/lifecycle email sender (rails only; no caller yet).
 *
 * Pins: every named REASONS value fires; fail-closed on a DB read error;
 * the stream-flag matrix (broadcast strict === true, alert/referral loose
 * !== false); the lifecycle/win-back/nurture relationship rule; caps read
 * `sent` rows only and are marketing-class-scoped; a happy path returns
 * ok:true with checks.allowPitch; the marketing class is resolved from the
 * stream and key (a caller can only tighten it); an absent channel column
 * reads as its schema default (referral/alert SMS, marketing email).
 */

jest.mock('../models/db', () => jest.fn());

const db = require('../models/db');
const { eligibleForEmail, resolveMarketingClass, REASONS } = require('../services/email-division/eligibility');

const NOW = new Date('2026-09-28T15:00:00Z'); // Mon Sep 28, 11:00 ET

function chain({ result = [], first, firstError } = {}) {
  const q = {};
  ['where', 'whereIn', 'whereRaw', 'whereNotNull', 'select', 'orderBy'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => { if (firstError) throw firstError; return first; });
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(result).catch(reject);
  return q;
}

function customerRow(overrides = {}) {
  return {
    id: 'cust-1', email: 'sandy@example.test', phone: '+19415550100',
    active: true, churned_at: null, deleted_at: null, pipeline_stage: 'active_customer', ...overrides,
  };
}

// Wires every table an eligible lifecycle/relationship-class check reads, so
// a single leg can be overridden per test, then evaluates. `tables` fully
// replaces the table map (used by the relationship-class exemption and
// LOOKUP_FAILED cases, which must not wire ledger/sms_log/call_log at all).
function evalWith({
  customer = customerRow(), suppressions = [], dnc,
  // Channel columns set to 'email' so the alert/referral cases below exercise
  // their own rule, not the SMS schema default (tested on its own).
  prefs = {
    email_enabled: true, marketing_offers: true, weather_alerts: true, referral_nudge: true, weather_alert_channel: 'email', referral_channel: 'email',
  },
  estimates, ledger = [], smsOutbound, smsInbound, callInbound, callOutbound, tables,
} = {}, args = {}) {
  db.mockImplementation((table) => {
    const map = tables || {
      customers: chain({ first: customer }),
      messaging_suppression: chain({ first: dnc }),
      email_suppressions: chain({ result: suppressions }),
      notification_prefs: chain({ first: prefs }),
      estimates: chain({ first: estimates }),
      marketing_email_ledger: ledger,
      sms_log: [chain({ first: smsOutbound }), chain({ first: smsInbound })],
      call_log: [chain({ first: callInbound }), chain({ first: callOutbound })],
    };
    const supply = map[table];
    if (!supply) throw new Error(`Unexpected db table ${table}`);
    if (Array.isArray(supply)) {
      if (!supply.length) throw new Error(`Exhausted db queue for ${table}`);
      return supply.shift();
    }
    return supply;
  });
  return eligibleForEmail({
    customerId: 'cust-1', stream: 'lifecycle', marketingClass: 'relationship', emailKey: 'lc.welcome', now: NOW, ...args,
  });
}

describe('email-division eligibility', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  test('a compliant lifecycle relationship email is allowed, with allowPitch surfaced', async () => {
    const result = await evalWith();
    expect(result).toEqual({ ok: true, reason: null, checks: expect.objectContaining({ allowPitch: true }) });
  });

  test('CUSTOMER_MISSING when the customer row does not exist', async () => {
    expect((await evalWith({ customer: null })).reason).toBe(REASONS.CUSTOMER_MISSING);
  });

  test('CUSTOMER_DELETED when deleted_at is set', async () => {
    const r = await evalWith({ customer: customerRow({ deleted_at: new Date('2026-01-01') }) });
    expect(r.reason).toBe(REASONS.CUSTOMER_DELETED);
  });

  test('NO_EMAIL when the customer has no address on file', async () => {
    expect((await evalWith({ customer: customerRow({ email: null }) })).reason).toBe(REASONS.NO_EMAIL);
  });

  test('STAFF_DNC when an active manual_dnc covers the customer phone', async () => {
    expect((await evalWith({ dnc: { phone: '+19415550100' } })).reason).toBe(REASONS.STAFF_DNC);
  });

  test('EMAIL_SUPPRESSED_GLOBAL on a null-group active suppression', async () => {
    expect((await evalWith({ suppressions: [{ group_key: null }] })).reason).toBe(REASONS.EMAIL_SUPPRESSED_GLOBAL);
  });

  test("EMAIL_SUPPRESSED_GROUP when the suppression covers this stream's group", async () => {
    const r = await evalWith({ suppressions: [{ group_key: 'service_operational' }] });
    expect(r.reason).toBe(REASONS.EMAIL_SUPPRESSED_GROUP);
  });

  test('EMAIL_SUPPRESSED_GLOBAL on a bounce even when it carries an unrelated group_key (codex pre-push r2 P1)', async () => {
    const r = await evalWith({ suppressions: [{ group_key: 'marketing_newsletter', suppression_type: 'bounce' }] });
    expect(r.reason).toBe(REASONS.EMAIL_SUPPRESSED_GLOBAL);
  });

  test('EMAIL_SWITCH_OFF when notification_prefs.email_enabled is false', async () => {
    expect((await evalWith({ prefs: { email_enabled: false } })).reason).toBe(REASONS.EMAIL_SWITCH_OFF);
  });

  test('STREAM_FLAG_OFF for a broadcast when marketing_offers is not exactly true', async () => {
    const r = await evalWith({ prefs: { email_enabled: true, marketing_offers: null } },
      { stream: 'broadcast', marketingClass: 'marketing', emailKey: 'mkt.broadcast.fall' });
    expect(r.reason).toBe(REASONS.STREAM_FLAG_OFF);
  });

  test('an alert passes the stream flag when weather_alerts is merely unset (loose rule)', async () => {
    // An alert is marketing class whatever the caller says, so the caps and
    // recent-contact legs run: one weekly-cap read, one same-day read.
    const r = await evalWith({
      prefs: { email_enabled: true, weather_alerts: undefined, marketing_offers: null, weather_alert_channel: 'email' },
      ledger: [chain({ first: undefined }), chain({ result: [] })],
    }, { stream: 'alert', emailKey: 'lc.alert.storm' });
    expect(r.ok).toBe(true);
    expect(r.checks.allowPitch).toBe(false);
    expect(r.checks.marketingClass).toBe('marketing');
  });

  test.each([
    ['broadcast', 'mkt.broadcast.fall', 'marketing_channel'],
    ['alert', 'lc.alert.storm', 'weather_alert_channel'],
    ['lifecycle', 'lc.referral.friend', 'referral_channel'],
  ])('STREAM_CHANNEL_NOT_EMAIL for %s when its channel column is sms-only (codex round-1 P1)', async (stream, emailKey, column) => {
    const prefs = {
      email_enabled: true, marketing_offers: true, weather_alerts: true, referral_nudge: true, [column]: 'sms',
    };
    const r = await evalWith({ prefs }, { stream, marketingClass: 'marketing', emailKey });
    expect(r.reason).toBe(REASONS.STREAM_CHANNEL_NOT_EMAIL);
  });

  test.each([undefined, null, 'email', 'both', 'carrier-pigeon'])('a broadcast passes the channel check when marketing_channel is %s (the schema default is email; an unknown value reads as the default, as legacyChannel does)', async (value) => {
    const prefs = { email_enabled: true, marketing_offers: true, marketing_channel: value };
    const r = await evalWith({ prefs, ledger: [chain({ first: undefined }), chain({ result: [] })] },
      { stream: 'broadcast', emailKey: 'mkt.broadcast.fall' });
    expect(r.ok).toBe(true);
  });

  describe('channel columns read as their schema defaults when absent (codex GitHub round P1)', () => {
    test('no notification_prefs row at all: alert and referral mail are SMS-only, as the portal reports them', async () => {
      const alert = await evalWith({ prefs: null }, { stream: 'alert', emailKey: 'lc.alert.storm' });
      expect(alert.reason).toBe(REASONS.STREAM_CHANNEL_NOT_EMAIL);
      const referral = await evalWith({ prefs: null }, { emailKey: 'lc.referral_ask' });
      expect(referral.reason).toBe(REASONS.STREAM_CHANNEL_NOT_EMAIL);
    });

    test.each([
      ['a null weather_alert_channel', 'alert', 'lc.alert.storm', { weather_alert_channel: null }],
      ['an unrecognised weather_alert_channel', 'alert', 'lc.alert.storm', { weather_alert_channel: 'carrier-pigeon' }],
      ['a null referral_channel', 'lifecycle', 'lc.referral_ask', { referral_channel: null }],
    ])('%s reads as the SMS default and blocks email', async (_label, stream, emailKey, column) => {
      const prefs = {
        email_enabled: true, marketing_offers: true, weather_alerts: true, referral_nudge: true, weather_alert_channel: 'email', referral_channel: 'email', ...column,
      };
      const r = await evalWith({ prefs }, { stream, emailKey });
      expect(r.reason).toBe(REASONS.STREAM_CHANNEL_NOT_EMAIL);
    });
  });

  describe('the marketing class is resolved from the stream and key, never trusted from the caller (pre-push audit P1)', () => {
    test.each([
      ['broadcast', 'mkt.broadcast.fall', 'relationship', 'marketing'],
      ['alert', 'lc.alert.storm', undefined, 'marketing'],
      ['nurture', 'nur.tip1', 'relationship', 'marketing'],
      ['lifecycle', 'lc.referral_ask', 'relationship', 'marketing'],
      ['lifecycle', 'lc.winback_60', undefined, 'marketing'],
      ['lifecycle', 'lc.welcome', undefined, 'relationship'],
      ['lifecycle', 'lc.welcome', 'relationship', 'relationship'],
      ['lifecycle', 'lc.pest_tip', 'marketing', 'marketing'],
    ])('%s / %s requested as %s resolves to %s', (stream, emailKey, requested, expected) => {
      expect(resolveMarketingClass(stream, emailKey, requested)).toBe(expected);
    });

    test('an unknown requested class is refused outright', () => {
      expect(() => resolveMarketingClass('lifecycle', 'lc.welcome', 'promo')).toThrow(/marketingClass/);
    });

    test('a broadcast passed as relationship is still capped, and the resolved class is surfaced on checks', async () => {
      const r = await evalWith({ ledger: [chain({ first: { id: 'led-1' } })] },
        { stream: 'broadcast', marketingClass: 'relationship', emailKey: 'mkt.broadcast.fall' });
      expect(r.reason).toBe(REASONS.CAP_WEEKLY_BROADCAST);
      expect(r.checks.marketingClass).toBe('marketing');
    });

    test('the referral ask is marketing class (capped, human-contact checked) but answers to referral_nudge and referral_channel, never marketing_offers', async () => {
      const prefs = { email_enabled: true, marketing_offers: false, referral_nudge: true, referral_channel: 'email' };
      const ok = await evalWith({ prefs, ledger: [chain({ result: [] })] }, { emailKey: 'lc.referral_ask' });
      expect(ok.ok).toBe(true);
      expect(ok.checks.marketingClass).toBe('marketing');
      const nudgeOff = await evalWith({ prefs: { ...prefs, referral_nudge: false } }, { emailKey: 'lc.referral_ask' });
      expect(nudgeOff.reason).toBe(REASONS.STREAM_FLAG_OFF);
      const capped = await evalWith({ prefs, ledger: [chain({ result: [{ sent_at: NOW.toISOString() }] })] }, { emailKey: 'lc.referral_ask' });
      expect(capped.reason).toBe(REASONS.CAP_SAME_DAY);
    });
  });

  test.each([
    ['broadcast', 'mkt.broadcast.fall'],
    ['alert', 'lc.alert.storm'],
  ])('RELATIONSHIP_NOT_ELIGIBLE for a %s to a CRM lead — active alone is not a customer (pre-push audit P1)', async (stream, emailKey) => {
    const prefs = { email_enabled: true, marketing_offers: true, weather_alerts: true, weather_alert_channel: 'email' };
    const r = await evalWith({ customer: customerRow({ pipeline_stage: 'new_lead' }), prefs }, { stream, emailKey });
    expect(r.reason).toBe(REASONS.RELATIONSHIP_NOT_ELIGIBLE);
  });

  test('RELATIONSHIP_NOT_ELIGIBLE for nurture with no estimates on file', async () => {
    const r = await evalWith({}, { stream: 'nurture', marketingClass: 'marketing', emailKey: 'nur.tip1' });
    expect(r.reason).toBe(REASONS.RELATIONSHIP_NOT_ELIGIBLE);
  });

  test.each([
    ['a CRM lead (active=true, no churn stamp, pipeline_stage new_lead)', { pipeline_stage: 'new_lead' }],
    ['an estimate-stage lead', { pipeline_stage: 'estimate_sent' }],
    ['a past customer', { pipeline_stage: 'past_customer' }],
    ['a churned customer', { pipeline_stage: 'churned' }],
    ['a customer row with no pipeline stage at all', { pipeline_stage: null }],
  ])('RELATIONSHIP_NOT_ELIGIBLE for a lifecycle email to %s — a live customer is the canonical customer-stages condition (codex GitHub P1)', async (_label, overrides) => {
    const r = await evalWith({ customer: customerRow(overrides) }, { emailKey: 'lc.welcome' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(REASONS.RELATIONSHIP_NOT_ELIGIBLE);
  });

  test.each([
    ['active_customer with a stale churned_at from an earlier churn', { pipeline_stage: 'active_customer', churned_at: new Date('2025-01-01T00:00:00Z') }],
    ['won', { pipeline_stage: 'won' }],
    ['at_risk', { pipeline_stage: 'at_risk' }],
  ])('a lifecycle email to a live customer in stage %s is eligible', async (_label, overrides) => {
    const r = await evalWith({ customer: customerRow(overrides) }, { emailKey: 'lc.welcome' });
    expect(r.ok).toBe(true);
  });

  test('RELATIONSHIP_NOT_ELIGIBLE for lifecycle win-back on a customer who never churned', async () => {
    const r = await evalWith({ customer: customerRow({ churned_at: null }) }, { emailKey: 'lc.winback.60d' });
    expect(r.reason).toBe(REASONS.RELATIONSHIP_NOT_ELIGIBLE);
  });

  test('win-back is eligible on pipeline_stage churned even with no churned_at timestamp (codex push-audit P1)', async () => {
    // A legacy churned row can lack the historical churned_at column
    // entirely — the live pipeline_stage is what must decide this. Win-back
    // is marketing class, so the same-day cap read runs too.
    const r = await evalWith(
      { customer: customerRow({ pipeline_stage: 'churned', churned_at: null }), ledger: [chain({ result: [] })] },
      { emailKey: 'lc.winback.60d' },
    );
    expect(r.ok).toBe(true);
    expect(r.checks.marketingClass).toBe('marketing');
  });

  test('win-back is RELATIONSHIP_NOT_ELIGIBLE once re-activated, even with a stale churned_at still on file', async () => {
    // churned_at can persist after a customer re-subscribes — only the
    // current pipeline_stage may say "still churned".
    const r = await evalWith(
      { customer: customerRow({ pipeline_stage: 'active_customer', churned_at: new Date('2026-01-01') }) },
      { emailKey: 'lc.winback.60d' },
    );
    expect(r.reason).toBe(REASONS.RELATIONSHIP_NOT_ELIGIBLE);
  });

  test('CAP_WEEKLY_BROADCAST when a broadcast already sent in the last 7 days', async () => {
    const r = await evalWith({ ledger: [chain({ first: { id: 'led-1' } })] },
      { stream: 'broadcast', marketingClass: 'marketing', emailKey: 'mkt.broadcast.fall' });
    expect(r.reason).toBe(REASONS.CAP_WEEKLY_BROADCAST);
  });

  test('CAP_WEEKLY_ALERT when an alert already sent in the last 7 days', async () => {
    const r = await evalWith({ ledger: [chain({ first: { id: 'led-1' } })] },
      { stream: 'alert', marketingClass: 'marketing', emailKey: 'mkt.alert.storm' });
    expect(r.reason).toBe(REASONS.CAP_WEEKLY_ALERT);
  });

  test('CAP_SAME_PEST_14D when the same pest_key already sent in the last 14 days', async () => {
    const r = await evalWith({ ledger: [chain({ first: { id: 'led-1' } })] },
      { marketingClass: 'marketing', emailKey: 'lc.pest_tip', pestKey: 'ants' });
    expect(r.reason).toBe(REASONS.CAP_SAME_PEST_14D);
  });

  test('CAP_SAME_DAY when any marketing-class row already sent today (ET)', async () => {
    const r = await evalWith({ ledger: [chain({ result: [{ sent_at: NOW.toISOString() }] })] },
      { marketingClass: 'marketing', emailKey: 'lc.pest_tip' });
    expect(r.reason).toBe(REASONS.CAP_SAME_DAY);
  });

  test('RECENT_HUMAN_CONTACT on a staff-authored outbound text in the last 3 days', async () => {
    const r = await evalWith({ ledger: [chain({ result: [] })], smsOutbound: { id: 'sms-1' } },
      { marketingClass: 'marketing', emailKey: 'lc.pest_tip' });
    expect(r.reason).toBe(REASONS.RECENT_HUMAN_CONTACT);
  });

  test('RECENT_HUMAN_CONTACT on an inbound call in the last 3 days', async () => {
    const r = await evalWith({ ledger: [chain({ result: [] })], callInbound: { id: 'call-1' } },
      { marketingClass: 'marketing', emailKey: 'lc.pest_tip' });
    expect(r.reason).toBe(REASONS.RECENT_HUMAN_CONTACT);
  });

  test('RECENT_HUMAN_CONTACT on a connected staff-placed outbound call in the last 3 days (codex GitHub P2)', async () => {
    const outboundQ = chain({ first: { id: 'call-2' } });
    const r = await evalWith({ ledger: [chain({ result: [] })], tables: {
      customers: chain({ first: customerRow() }),
      messaging_suppression: chain({ first: undefined }),
      email_suppressions: chain({ result: [] }),
      notification_prefs: chain({ first: { email_enabled: true, marketing_offers: true, weather_alerts: true, referral_nudge: true } }),
      estimates: chain({ first: undefined }),
      marketing_email_ledger: [chain({ result: [] })],
      sms_log: [chain({ first: undefined }), chain({ first: undefined })],
      call_log: [chain({ first: undefined }), outboundQ],
    } }, { marketingClass: 'marketing', emailKey: 'lc.pest_tip' });
    expect(r.reason).toBe(REASONS.RECENT_HUMAN_CONTACT);
    // Only staff-placed, connected calls count — the query names both.
    expect(outboundQ.whereIn).toHaveBeenCalledWith('source', ['admin-click', 'admin-callback', 'tech-click']);
    // …and only once the CUSTOMER leg was dialed: /outbound-connect stamps bridged_at.
    expect(outboundQ.whereNotNull).toHaveBeenCalledWith('bridged_at');
    expect(outboundQ.whereIn).toHaveBeenCalledWith('status', ['completed', 'in-progress', 'answered', 'bridged']);
  });

  test('a lifecycle send classified as MARKETING answers to the marketing rules, not the operational exemption (codex GitHub P1)', async () => {
    const marketing = { stream: 'lifecycle', marketingClass: 'marketing', emailKey: 'lc.pest_tip' };
    const noOffers = await evalWith({ ledger: [chain({ result: [] })], prefs: { email_enabled: true, marketing_offers: false } }, marketing);
    expect(noOffers.reason).toBe(REASONS.STREAM_FLAG_OFF);
    const unsubscribed = await evalWith({ ledger: [chain({ result: [] })],
      suppressions: [{ email: 'sandy@example.test', group_key: 'marketing_newsletter', suppression_type: 'unsubscribe', status: 'active' }] }, marketing);
    expect(unsubscribed.reason).toBe(REASONS.EMAIL_SUPPRESSED_GROUP);
    const smsOnly = await evalWith({ ledger: [chain({ result: [] })], prefs: { email_enabled: true, marketing_offers: true, marketing_channel: 'sms' } }, marketing);
    expect(smsOnly.reason).toBe(REASONS.STREAM_CHANNEL_NOT_EMAIL);
    // the operational welcome email is untouched by any of that
    const operational = await evalWith({ prefs: { email_enabled: true, marketing_offers: false, marketing_channel: 'sms' } }, { emailKey: 'lc.welcome' });
    expect(operational.ok).toBe(true);
    expect(operational.checks.allowPitch).toBe(false);
  });

  test('an SMS-only marketing channel switches the embedded pitch off even with marketing_offers on (codex GitHub P1)', async () => {
    const r = await evalWith({ prefs: { email_enabled: true, marketing_offers: true, marketing_channel: 'sms' } }, { emailKey: 'lc.welcome' });
    expect(r.ok).toBe(true);
    expect(r.checks.allowPitch).toBe(false);
  });

  test('a manual or Intelligence Bar text (message_type manual, no admin uuid) is recent human contact (codex GitHub P2)', async () => {
    const staffQ = chain({ first: { id: 'sms-ib' } });
    const r = await evalWith({ ledger: [chain({ result: [] })], tables: {
      customers: chain({ first: customerRow() }),
      messaging_suppression: chain({ first: undefined }),
      email_suppressions: chain({ result: [] }),
      notification_prefs: chain({ first: { email_enabled: true, marketing_offers: true, weather_alerts: true, referral_nudge: true } }),
      estimates: chain({ first: undefined }),
      marketing_email_ledger: [chain({ result: [] })],
      sms_log: [staffQ, chain({ first: undefined })],
      call_log: [chain({ first: undefined }), chain({ first: undefined })],
    } }, { marketingClass: 'marketing', emailKey: 'lc.pest_tip' });
    expect(r.reason).toBe(REASONS.RECENT_HUMAN_CONTACT);
    // the provenance predicate is a grouped where (admin uuid OR a manual message type)
    expect(staffQ.where).toHaveBeenCalledWith(expect.any(Function));
    // …and a text the customer definitely never received is not contact (codex GitHub round P2):
    // the second grouped where keeps null/in-flight statuses and drops the failed ones.
    const grouped = { whereNotNull: jest.fn(), orWhereIn: jest.fn(), whereNull: jest.fn(), orWhereNotIn: jest.fn() };
    Object.keys(grouped).forEach((m) => grouped[m].mockReturnValue(grouped));
    staffQ.where.mock.calls.filter((c) => typeof c[0] === 'function').forEach((c) => c[0](grouped));
    expect(grouped.orWhereIn).toHaveBeenCalledWith('message_type', ['manual', 'manual_reply', 'staff_reply']);
    expect(grouped.whereNull).toHaveBeenCalledWith('status');
    expect(grouped.orWhereNotIn).toHaveBeenCalledWith('status', ['failed', 'undelivered', 'blocked', 'canceled', 'cancelled']);
  });

  test('a marketing unsubscribe (marketing_newsletter group) does not block an OPERATIONAL lifecycle email but does switch the embedded pitch off (codex GitHub P1)', async () => {
    const r = await evalWith({
      suppressions: [{ email: 'sandy@example.test', group_key: 'marketing_newsletter', suppression_type: 'unsubscribe', status: 'active' }],
    }, { emailKey: 'lc.welcome' });
    expect(r.ok).toBe(true);
    expect(r.checks.allowPitch).toBe(false);
  });

  test('relationship class is exempt from caps and recent-contact checks (no ledger/sms_log/call_log wired)', async () => {
    const r = await evalWith({
      tables: {
        customers: chain({ first: customerRow() }),
        messaging_suppression: chain({ first: undefined }),
        email_suppressions: chain({ result: [] }),
        notification_prefs: chain({ first: { email_enabled: true } }),
      },
    });
    expect(r.ok).toBe(true);
  });

  test('LOOKUP_FAILED when a read throws (fail closed, never an accidental allow)', async () => {
    const r = await evalWith({ tables: { customers: chain({ firstError: new Error('connection reset') }) } });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(REASONS.LOOKUP_FAILED);
  });

  test('LOOKUP_FAILED on an unrecognized stream (never falls through to an allow)', async () => {
    const r = await eligibleForEmail({ customerId: 'cust-1', stream: 'bogus', marketingClass: 'relationship', emailKey: 'x', now: NOW });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(REASONS.LOOKUP_FAILED);
  });
});
