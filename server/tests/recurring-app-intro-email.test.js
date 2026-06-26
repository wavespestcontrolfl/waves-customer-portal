// Gating for the first-visit app-intro email. The send itself is idempotent
// (app_intro:<customerId>); these tests cover the upstream guards that decide
// whether sendAppIntro is even called from the en-route hook.
let mockServiceRecordCount = 0;
jest.mock('../models/db', () => jest.fn(() => ({
  where: () => ({ count: () => ({ first: async () => ({ count: mockServiceRecordCount }) }) }),
})));
jest.mock('../services/account-membership-email', () => ({
  sendAppIntro: jest.fn(async () => ({ ok: true, messageId: 'm1' })),
}));
jest.mock('../services/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));

const AccountMembershipEmail = require('../services/account-membership-email');
const RecurringAppIntro = require('../services/recurring-app-intro-email');

const recurringSvc = { id: 's1', customer_id: 'c1', is_recurring: true, waveguard_tier: 'Bronze' };

describe('recurring-app-intro-email gating', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockServiceRecordCount = 0;
    process.env.GATE_APP_INTRO_EMAIL = 'true';
  });
  afterAll(() => { delete process.env.GATE_APP_INTRO_EMAIL; });

  test('skips when the gate is off', async () => {
    process.env.GATE_APP_INTRO_EMAIL = 'false';
    const r = await RecurringAppIntro.maybeSendOnEnRoute(recurringSvc);
    expect(r).toMatchObject({ sent: false, reason: 'gate_off' });
    expect(AccountMembershipEmail.sendAppIntro).not.toHaveBeenCalled();
  });

  test('skips a non-recurring or non-member service', async () => {
    const r = await RecurringAppIntro.maybeSendOnEnRoute({ ...recurringSvc, is_recurring: false });
    expect(r).toMatchObject({ sent: false, reason: 'not_recurring_member' });
    const r2 = await RecurringAppIntro.maybeSendOnEnRoute({ ...recurringSvc, waveguard_tier: null });
    expect(r2).toMatchObject({ sent: false, reason: 'not_recurring_member' });
    expect(AccountMembershipEmail.sendAppIntro).not.toHaveBeenCalled();
  });

  test('skips when the customer already has a completed visit (not their first)', async () => {
    mockServiceRecordCount = 2;
    const r = await RecurringAppIntro.maybeSendOnEnRoute(recurringSvc);
    expect(r).toMatchObject({ sent: false, reason: 'not_first_visit' });
    expect(AccountMembershipEmail.sendAppIntro).not.toHaveBeenCalled();
  });

  test('sends for a recurring member on their first visit', async () => {
    const r = await RecurringAppIntro.maybeSendOnEnRoute(recurringSvc);
    expect(AccountMembershipEmail.sendAppIntro).toHaveBeenCalledTimes(1);
    expect(AccountMembershipEmail.sendAppIntro).toHaveBeenCalledWith({ customerId: 'c1', sourceId: 's1' });
    expect(r).toMatchObject({ ok: true });
  });

  test('a send error is swallowed, never thrown into the transition', async () => {
    AccountMembershipEmail.sendAppIntro.mockRejectedValueOnce(new Error('smtp down'));
    const r = await RecurringAppIntro.maybeSendOnEnRoute(recurringSvc);
    expect(r).toMatchObject({ sent: false, error: 'smtp down' });
  });
});
