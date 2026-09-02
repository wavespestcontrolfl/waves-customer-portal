/**
 * Referral card on the estimate's accepted / just-accepted screens
 * (GATE_ESTIMATE_SUCCESS_REFERRAL): render payloads carry the static card
 * only for an ACCEPTED estimate with a linked customer while the live
 * program is active — and never enroll anyone.
 */
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));
const mockEngine = { getLiveSettings: jest.fn(), enrollPromoter: jest.fn(), getPromoterReferralLink: jest.fn() };
jest.mock('../services/referral-engine', () => mockEngine);

const { isEnabled } = require('../config/feature-gates');
const { estimateReferralCardFor } = require('../routes/estimate-public');
const { REFERRAL_CARD_COPY } = require('../services/referral-share');

const accepted = { id: 'est-1', status: 'accepted', customer_id: 'cust-1' };

beforeEach(() => {
  jest.clearAllMocks();
  mockEngine.getLiveSettings.mockResolvedValue({ program_active: true, referee_discount_cents: 2500 });
});

test('dark gate → no card, no settings read', async () => {
  isEnabled.mockReturnValue(false);
  expect(await estimateReferralCardFor(accepted)).toBeNull();
  expect(mockEngine.getLiveSettings).not.toHaveBeenCalled();
});

test('accepted + linked customer + active program → the static card, nothing enrolled', async () => {
  isEnabled.mockImplementation((k) => k === 'estimateSuccessReferral');
  expect(await estimateReferralCardFor(accepted)).toEqual(REFERRAL_CARD_COPY);
  expect(mockEngine.enrollPromoter).not.toHaveBeenCalled();
});

test('not accepted, no customer, inactive program, or a settings failure → no card', async () => {
  isEnabled.mockImplementation((k) => k === 'estimateSuccessReferral');
  expect(await estimateReferralCardFor({ ...accepted, status: 'viewed' })).toBeNull();
  expect(await estimateReferralCardFor({ ...accepted, customer_id: null })).toBeNull();
  mockEngine.getLiveSettings.mockResolvedValue({ program_active: false });
  expect(await estimateReferralCardFor(accepted)).toBeNull();
  mockEngine.getLiveSettings.mockRejectedValue(new Error('db down'));
  expect(await estimateReferralCardFor(accepted)).toBeNull();
});
