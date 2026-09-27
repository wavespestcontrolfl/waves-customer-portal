/**
 * collections/dunning-spacing — the seven-day overdue-message window the
 * policy and the ledger share (GATE_DUNNING_SPACING).
 *
 * Pins: the window counts ET calendar days and is capped at 7×24 hours;
 * a row holds only while the message may have reached the customer
 * (delivery evidence beats a failure stamp); the pay link a customer asks
 * for on a call and the annual prepay renewal reminder neither wait nor
 * hold; the ledger re-check runs only with both gates on.
 */

const DunningSpacing = require('../services/collections/dunning-spacing');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

afterEach(() => {
  delete process.env.GATE_DUNNING_SPACING;
  delete process.env.GATE_COLLECTIONS_POLICY;
});

describe('spacingHeldUntil', () => {
  test('a message holds until that weekday next week begins in ET, whatever the hour', () => {
    // Tue Sep 29 2026, 14:00 EDT and 23:30 EDT (already Wednesday in UTC).
    expect(DunningSpacing.spacingHeldUntil('2026-09-29T18:00:00Z').toISOString()).toBe('2026-10-06T04:00:00.000Z');
    expect(DunningSpacing.spacingHeldUntil('2026-09-30T03:30:00Z').toISOString()).toBe('2026-10-06T04:00:00.000Z');
  });

  test('the fall-back week never holds longer than 7×24 hours', () => {
    // Sat Oct 31 2026, 00:30 EDT. Midnight ET on Nov 7 (EST) is 05:00Z,
    // an hour past 7×24h, so the cap ends the hold at 04:30Z.
    expect(DunningSpacing.spacingHeldUntil('2026-10-31T04:30:00Z').toISOString()).toBe('2026-11-07T04:30:00.000Z');
  });

  test('the spring-forward week ends at midnight ET', () => {
    // Sat Mar 7 2026, 10:00 EST → Sat Mar 14 00:00 EDT.
    expect(DunningSpacing.spacingHeldUntil('2026-03-07T15:00:00Z').toISOString()).toBe('2026-03-14T04:00:00.000Z');
  });
});

describe('holdsNextMessage', () => {
  const now = new Date('2026-10-01T15:00:00Z'); // Thu 11:00 EDT
  const row = (extra = {}) => ({
    id: 'l-1', channel: 'sms', source: 'late_payment_checker',
    occurred_at: new Date(now.getTime() - 2 * DAY).toISOString(), metadata: null, ...extra,
  });

  test('a text, email or push that may have reached the customer holds', () => {
    for (const channel of ['sms', 'email', 'push']) {
      expect(DunningSpacing.holdsNextMessage(row({ channel }), now)).toBe(true);
    }
    expect(DunningSpacing.holdsNextMessage(row({ metadata: '{"delivered":true}' }), now)).toBe(true);
  });

  test('calls, messages that never went out, and exempt sources do not hold', () => {
    expect(DunningSpacing.holdsNextMessage(row({ channel: 'voice' }), now)).toBe(false);
    expect(DunningSpacing.holdsNextMessage(row({ channel: 'manual_call' }), now)).toBe(false);
    expect(DunningSpacing.holdsNextMessage(row({ metadata: { send_failed: true } }), now)).toBe(false);
    expect(DunningSpacing.holdsNextMessage(row({ metadata: '{"resolved":true}' }), now)).toBe(false);
    expect(DunningSpacing.holdsNextMessage(row({ metadata: { never_contacted: 'true' } }), now)).toBe(false);
    for (const source of ['collections_voice_paylink', 'annual_prepay_payment_reminder']) {
      expect(DunningSpacing.holdsNextMessage(row({ source }), now)).toBe(false);
    }
  });

  test('delivery evidence holds even on a row that also carries a failure stamp', () => {
    expect(DunningSpacing.holdsNextMessage(row({ metadata: { send_failed: true, delivered: true } }), now)).toBe(true);
    expect(DunningSpacing.holdsNextMessage(row({ metadata: { resolved: true, delivered: true } }), now)).toBe(true);
  });

  test('a message stops holding when its ET week is up', () => {
    // Last Thursday 23:00 EDT holds through Wednesday; this Thursday is clear.
    const lastThursday = row({ occurred_at: '2026-09-25T03:00:00Z' });
    expect(DunningSpacing.holdsNextMessage(lastThursday, new Date('2026-10-01T03:59:59Z'))).toBe(true);
    expect(DunningSpacing.holdsNextMessage(lastThursday, new Date('2026-10-01T04:00:00Z'))).toBe(false);
  });
});

describe('gating', () => {
  test('the policy rule applies only with GATE_DUNNING_SPACING, only to text channels, never to exempt requesters', () => {
    expect(DunningSpacing.spacingApplies({ channel: 'sms', source: 'invoice_followups' })).toBe(false);
    process.env.GATE_DUNNING_SPACING = 'true';
    expect(DunningSpacing.spacingApplies({ channel: 'sms', source: 'invoice_followups' })).toBe(true);
    expect(DunningSpacing.spacingApplies({ channel: 'email' })).toBe(true);
    expect(DunningSpacing.spacingApplies({ channel: 'voice' })).toBe(false);
    expect(DunningSpacing.spacingApplies({ channel: 'sms', source: 'collections_voice_paylink' })).toBe(false);
    expect(DunningSpacing.spacingApplies({ channel: 'sms', source: 'annual_prepay_payment_reminder' })).toBe(false);
  });

  test('the ledger re-check also needs the collections policy gate', () => {
    process.env.GATE_DUNNING_SPACING = 'true';
    expect(DunningSpacing.reservationGuarded({ channel: 'sms', source: 'invoice_followups' })).toBe(false);
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    expect(DunningSpacing.reservationGuarded({ channel: 'sms', source: 'invoice_followups' })).toBe(true);
    process.env.GATE_DUNNING_SPACING = 'false';
    expect(DunningSpacing.reservationGuarded({ channel: 'sms', source: 'invoice_followups' })).toBe(false);
  });
});
