const {
  checkFloridaQuietHours,
  isFederalHolidayET,
  nextAllowedSendAt,
} = require('../services/messaging/quiet-hours');

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

  test('blocks non-urgent sends on federal holidays', () => {
    const julyFourth = new Date('2026-07-04T16:00:00Z');
    expect(isFederalHolidayET(julyFourth)).toBe(true);
    expect(checkFloridaQuietHours(
      input('marketing'),
      { requireConsent: 'marketing' },
      julyFourth
    )).toMatchObject({ ok: false, code: 'QUIET_HOURS_HOLD' });
  });

  test('finds a future allowed time', () => {
    const next = nextAllowedSendAt(new Date('2026-05-25T02:30:00Z'));
    expect(next.getTime()).toBeGreaterThan(new Date('2026-05-25T02:30:00Z').getTime());
  });
});
