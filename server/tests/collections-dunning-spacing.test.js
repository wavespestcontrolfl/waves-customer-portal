/**
 * collections/dunning-spacing — the seven-day overdue-message window the
 * policy and the ledger share (GATE_DUNNING_SPACING).
 *
 * Pins: the window is a full 7×24 hours from the send;
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
  test('a message holds for a full 7×24 hours from the moment it went out', () => {
    expect(DunningSpacing.spacingHeldUntil('2026-09-29T18:00:00Z').toISOString()).toBe('2026-10-06T18:00:00.000Z');
    // Across the fall-back week too: elapsed time, not the wall clock.
    expect(DunningSpacing.spacingHeldUntil('2026-10-31T04:30:00Z').toISOString()).toBe('2026-11-07T04:30:00.000Z');
  });

  // codex #5108 r2: a late-evening message must not reopen at the start of
  // the same weekday next week.
  test('a Tuesday 23:30 ET message still holds the next Tuesday morning run', () => {
    const tuesdayNight = { id: 'l-1', channel: 'sms', source: 'late_payment_checker', occurred_at: '2026-09-30T03:30:00Z', metadata: null };
    expect(DunningSpacing.holdsNextMessage(tuesdayNight, new Date('2026-10-06T14:16:00Z'))).toBe(true);
    expect(DunningSpacing.holdsNextMessage(tuesdayNight, new Date('2026-10-07T03:30:00Z'))).toBe(false);
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

  test('a message stops holding exactly 7×24 hours after it went out', () => {
    const sent = row({ occurred_at: '2026-09-24T14:16:30Z' });
    expect(DunningSpacing.holdsNextMessage(sent, new Date('2026-10-01T14:16:29Z'))).toBe(true);
    expect(DunningSpacing.holdsNextMessage(sent, new Date('2026-10-01T14:16:30Z'))).toBe(false);
  });
});

describe('spacing episodes (one message, several channels)', () => {
  test('an explicit episode wins; a reservation key names its message without the channel', () => {
    expect(DunningSpacing.spacingEpisodeOf({ spacingEpisode: 'ep-1', idempotencyKey: 'x:sms' })).toBe('ep-1');
    expect(DunningSpacing.spacingEpisodeOf({ idempotencyKey: 'invoice_followups:seq-1:step-2:email' }))
      .toBe('invoice_followups:seq-1:step-2');
    expect(DunningSpacing.spacingEpisodeOf({ idempotencyKey: 'billing-reminder:abc:push' })).toBe('billing-reminder:abc');
    expect(DunningSpacing.spacingEpisodeOf({ idempotencyKey: 'followup-replay:rk-1' })).toBe('followup-replay:rk-1');
    expect(DunningSpacing.spacingEpisodeOf({})).toBeNull();
  });

  test('a stored row reads its episode from metadata, else from its key', () => {
    expect(DunningSpacing.rowEpisode({ metadata: '{"spacing_episode":"ep-2"}', idempotency_key: null })).toBe('ep-2');
    expect(DunningSpacing.rowEpisode({ metadata: null, idempotency_key: 'late_payment_checker:inv-1:14:sms' }))
      .toBe('late_payment_checker:inv-1:14');
    expect(DunningSpacing.rowEpisode({ metadata: null, idempotency_key: null })).toBeNull();
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
