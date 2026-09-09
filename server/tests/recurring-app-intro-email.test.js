// Gating for the first-visit app-intro email. The send itself is idempotent
// (app_intro:<customerId>); these tests cover the upstream guards that decide
// whether sendAppIntro is even called from the en-route hook.
//
const mockFirstServiceVisit = jest.fn(async () => true);
jest.mock('../services/customer-visit-history', () => ({
  isFirstServiceVisit: (...args) => mockFirstServiceVisit(...args),
}));
// notification_prefs reader: resolves to the row set by mockPrefs (null =
// no row = allowed), or rejects when mockPrefsError is set (fail closed).
let mockPrefs = null;
let mockPrefsError = null;
jest.mock('../models/db', () => jest.fn(() => ({
  where: () => ({
    first: async () => {
      if (mockPrefsError) throw mockPrefsError;
      return mockPrefs;
    },
  }),
})));
jest.mock('../services/account-membership-email', () => ({
  sendAppIntro: jest.fn(async () => ({ ok: true, messageId: 'm1' })),
}));
jest.mock('../services/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));
// Label provenance defaults to a verified non-label (legacy scenarios);
// override to 'label' / 'unknown' to assert the intro email is suppressed.
const mockTierLabelStatus = jest.fn(async () => 'not_label');
jest.mock('../services/self-booking-plan-sync', () => ({
  tierLabelStatus: (...args) => mockTierLabelStatus(...args),
}));

const AccountMembershipEmail = require('../services/account-membership-email');
const RecurringAppIntro = require('../services/recurring-app-intro-email');

// svc deliberately omits waveguard_tier — it isn't on scheduled_services, so the
// module must source the tier from the customers table, not from svc.
const recurringSvc = { id: 's1', customer_id: 'c1', is_recurring: true, scheduled_date: '2030-01-02', track_view_token: 'a'.repeat(64), track_token_expires_at: new Date(Date.now() + 3600000).toISOString() };

describe('recurring-app-intro-email gating', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFirstServiceVisit.mockResolvedValue(true);
    mockTierLabelStatus.mockResolvedValue('not_label');
    mockPrefs = null;
    mockPrefsError = null;
    process.env.GATE_APP_INTRO_EMAIL = 'true';
  });
  afterAll(() => { delete process.env.GATE_APP_INTRO_EMAIL; });

  test('skips when the gate is off', async () => {
    process.env.GATE_APP_INTRO_EMAIL = 'false';
    const r = await RecurringAppIntro.maybeSendOnEnRoute(recurringSvc);
    expect(r).toMatchObject({ sent: false, reason: 'gate_off' });
    expect(AccountMembershipEmail.sendAppIntro).not.toHaveBeenCalled();
  });

  test.each([false, true])('includes first visits without membership (recurring: %s)', async isRecurring => {
    const r = await RecurringAppIntro.maybeSendOnEnRoute({ ...recurringSvc, is_recurring: isRecurring });
    expect(r).toMatchObject({ ok: true });
    expect(AccountMembershipEmail.sendAppIntro).toHaveBeenCalledTimes(1);
  });

  test.each(['label', 'unknown'])('excludes unverifiable or label-only tiers: %s', async label => {
    mockTierLabelStatus.mockResolvedValue(label);
    const r = await RecurringAppIntro.maybeSendOnEnRoute(recurringSvc);
    expect(r).toMatchObject({ sent: false, reason: 'label_only_tier' });
    expect(AccountMembershipEmail.sendAppIntro).not.toHaveBeenCalled();
  });

  test.each([false, true])('honors the portal-wide email opt-out for the expanded audience (recurring: %s)', async isRecurring => {
    mockPrefs = { email_enabled: false };
    const r = await RecurringAppIntro.maybeSendOnEnRoute({ ...recurringSvc, is_recurring: isRecurring });
    expect(r).toMatchObject({ sent: false, skipped: true, reason: 'email_opted_out' });
    expect(AccountMembershipEmail.sendAppIntro).not.toHaveBeenCalled();
    expect(await RecurringAppIntro.appIntroEligibility(recurringSvc)).toEqual({ eligible: false, reason: 'email_opted_out' });
  });

  test('a missing prefs row or email_enabled=true still sends; an unreadable pref fails CLOSED', async () => {
    mockPrefs = { email_enabled: true };
    await RecurringAppIntro.maybeSendOnEnRoute(recurringSvc);
    expect(AccountMembershipEmail.sendAppIntro).toHaveBeenCalledTimes(1);
    mockPrefsError = new Error('db down');
    const r = await RecurringAppIntro.maybeSendOnEnRoute(recurringSvc);
    expect(r).toMatchObject({ sent: false, skipped: true, reason: 'prefs_unavailable' });
    expect(AccountMembershipEmail.sendAppIntro).toHaveBeenCalledTimes(1);
  });

  test('skips when the customer already has a completed visit (not their first)', async () => {
    mockFirstServiceVisit.mockResolvedValue(false);
    const r = await RecurringAppIntro.maybeSendOnEnRoute(recurringSvc);
    expect(r).toMatchObject({ sent: false, reason: 'not_first_visit' });
    expect(AccountMembershipEmail.sendAppIntro).not.toHaveBeenCalled();
  });

  test('sends for a recurring member on their first visit', async () => {
    const r = await RecurringAppIntro.maybeSendOnEnRoute(recurringSvc);
    expect(AccountMembershipEmail.sendAppIntro).toHaveBeenCalledTimes(1);
    expect(AccountMembershipEmail.sendAppIntro).toHaveBeenCalledWith({ customerId: 'c1', sourceId: 's1', trackToken: 'a'.repeat(64), trackTokenExpiresAt: recurringSvc.track_token_expires_at });
    expect(mockFirstServiceVisit).toHaveBeenCalledWith('c1', recurringSvc.scheduled_date);
    expect(r).toMatchObject({ ok: true });
  });

  test('a send error is swallowed, never thrown into the transition', async () => {
    AccountMembershipEmail.sendAppIntro.mockRejectedValueOnce(new Error('smtp down'));
    const r = await RecurringAppIntro.maybeSendOnEnRoute(recurringSvc);
    expect(r).toMatchObject({ sent: false, error: 'smtp down' });
  });
});
