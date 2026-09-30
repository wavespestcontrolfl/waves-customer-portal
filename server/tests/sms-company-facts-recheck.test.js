/**
 * Send-time recheck of the referral credit: outgoingAmountsStale re-reads the
 * LIVE referral settings (like billing), so the allowed amount follows the
 * program and an inactive/failed read authorizes nothing.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/context-aggregator', () => ({
  getContextForCustomer: jest.fn(),
  authorizedDuesCents: jest.fn(() => []),
}));
jest.mock('../services/referral-engine', () => ({ getLiveSettings: jest.fn() }));
const ContextAggregator = require('../services/context-aggregator');
const referralEngine = require('../services/referral-engine');
const { outgoingAmountsStale } = require('../services/sms-amount-recheck');

const dbh = () => ({ where: () => ({ first: async () => ({ id: 'c1' }) }) });
const LIVE = { program_active: true, referrer_reward_cents: 2500, referee_discount_cents: 2500 };
const V = 'house_voice_v12_real_answers_cf';
const stale = (body, promptVersion = V) => outgoingAmountsStale({ customerId: 'c1', body, promptVersion, dbh });

beforeEach(() => {
  ContextAggregator.getContextForCustomer.mockReset().mockResolvedValue({ billing: { outstandingBalance: 0, recentPayments: [] } });
  referralEngine.getLiveSettings.mockReset().mockResolvedValue(LIVE);
});

test('live $25 referral credit passes at send time', async () => {
  await expect(stale('You each get a $25 referral credit.')).resolves.toEqual({ stale: false });
});

test('a changed program amount invalidates a stale draft; a matching new amount passes', async () => {
  referralEngine.getLiveSettings.mockResolvedValue({ ...LIVE, referrer_reward_cents: 3000, referee_discount_cents: 3000 });
  await expect(stale('You each get a $25 referral credit.')).resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' });
  await expect(stale('You each get a $30 referral credit.')).resolves.toEqual({ stale: false });
});

test('program inactive or settings read failing authorizes nothing', async () => {
  referralEngine.getLiveSettings.mockResolvedValue({ ...LIVE, program_active: false });
  await expect(stale('You each get a $25 referral credit.')).resolves.toMatchObject({ stale: true });
  referralEngine.getLiveSettings.mockRejectedValue(new Error('db down'));
  await expect(stale('You each get a $25 referral credit.')).resolves.toMatchObject({ stale: true });
});

test('without the literal term the credit is held even with a live program; settings are not read', async () => {
  await expect(stale('The wildlife referral comes with a $25 credit')).resolves.toMatchObject({ stale: true });
  expect(referralEngine.getLiveSettings).not.toHaveBeenCalled();
});
