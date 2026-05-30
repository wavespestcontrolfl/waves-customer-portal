const {
  checkFloridaQuietHours,
  isFederalHolidayET,
  nextAllowedSendAt,
} = require('../services/messaging/quiet-hours');
const { etParts } = require('../utils/datetime-et');

function input(purpose) {
  return {
    channel: 'sms',
    audience: 'customer',
    purpose,
  };
}

describe('Florida SMS quiet-hours policy', () => {
  test('blocks non-urgent lifecycle sends outside the ET window', () => {
    const result = checkFloridaQuietHours(
      input('review_request'),
      { requireConsent: 'transactional' },
      new Date('2026-05-25T02:30:00Z')
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'QUIET_HOURS_HOLD',
    });
    expect(result.nextAllowedAt).toBeInstanceOf(Date);
  });

  test('allows appointment messages outside quiet hours', () => {
    expect(checkFloridaQuietHours(
      input('appointment_reminder_24h'),
      { requireConsent: 'transactional' },
      new Date('2026-05-25T02:30:00Z')
    )).toEqual({ ok: true });
  });

  test('blocks review requests before 9 AM and at or after 5 PM ET', () => {
    const policy = { requireConsent: 'transactional' };

    expect(checkFloridaQuietHours(
      input('review_request'),
      policy,
      new Date('2026-05-26T12:59:00Z') // 8:59 AM ET
    )).toMatchObject({ ok: false, code: 'QUIET_HOURS_HOLD' });

    expect(checkFloridaQuietHours(
      input('review_request'),
      policy,
      new Date('2026-05-26T20:59:00Z') // 4:59 PM ET
    )).toEqual({ ok: true });

    const eveningHold = checkFloridaQuietHours(
      input('review_request'),
      policy,
      new Date('2026-05-26T23:49:00Z') // 7:49 PM ET
    );
    expect(eveningHold).toMatchObject({ ok: false, code: 'QUIET_HOURS_HOLD' });
    expect(etParts(eveningHold.nextAllowedAt)).toMatchObject({
      year: 2026,
      month: 5,
      day: 27,
      hour: 9,
    });
  });

  test('blocks non-urgent sends on federal holidays', () => {
    const julyFourth = new Date('2026-07-04T16:00:00Z');
    expect(isFederalHolidayET(julyFourth)).toBe(true);
    expect(checkFloridaQuietHours(
      input('marketing'),
      { requireConsent: 'marketing' },
      julyFourth
    )).toMatchObject({ ok: false, code: 'QUIET_HOURS_HOLD' });
  });

  test('allows explicit admin quiet-hours overrides', () => {
    const julyFourth = new Date('2026-07-04T16:00:00Z');
    expect(checkFloridaQuietHours(
      {
        ...input('estimate_followup'),
        entryPoint: 'admin_estimate_send',
        metadata: { quietHoursOverride: true },
      },
      { requireConsent: 'transactional' },
      julyFourth
    )).toEqual({ ok: true });
  });

  test('blocks adjacent-year observed federal holidays', () => {
    // New Year's Day 2028 is observed on Friday, December 31, 2027.
    const observedNewYears = new Date('2027-12-31T16:00:00Z');
    expect(isFederalHolidayET(observedNewYears)).toBe(true);
    expect(checkFloridaQuietHours(
      input('marketing'),
      { requireConsent: 'marketing' },
      observedNewYears
    )).toMatchObject({ ok: false, code: 'QUIET_HOURS_HOLD' });
  });

  test('finds a future allowed time', () => {
    const next = nextAllowedSendAt(new Date('2026-05-25T02:30:00Z'));
    expect(next.getTime()).toBeGreaterThan(new Date('2026-05-25T02:30:00Z').getTime());
  });
});
