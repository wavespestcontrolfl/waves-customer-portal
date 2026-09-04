/**
 * customer-card.referralShareUrl — the card payload and the Wallet pass share
 * one referral destination. A multi-property sibling has no promoter row of
 * its own: the destination is the household promoter the Refer tab resolves
 * for it (referral-engine.findHouseholdPromoter), never the generic refer
 * tab (GH codex #3850 r1 P2).
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/referral-engine', () => ({
  findHouseholdPromoter: jest.fn(async () => null),
  getSettings: jest.fn(async () => ({ base_url: 'https://portal.wavespestcontrol.com/r/' })),
  getPromoterReferralLink: jest.fn((p) => (p?.referral_code ? `https://portal.wavespestcontrol.com/r/${p.referral_code}` : null)),
}));

const db = require('../models/db');
const engine = require('../services/referral-engine');
const { referralShareUrl } = require('../services/customer-card');

function ownRow(row) {
  db.mockImplementation((table) => {
    if (table !== 'referral_promoters') throw new Error(`unexpected table ${table}`);
    return { where: () => ({ first: async () => row }) };
  });
}

beforeEach(() => jest.clearAllMocks());

test('an own promoter row wins and the household read never runs', async () => {
  ownRow({ referral_link: 'https://portal.wavespestcontrol.com/r/WAVES-OWN00001' });
  expect(await referralShareUrl({ id: 'cust-1', referral_code: null })).toBe('https://portal.wavespestcontrol.com/r/WAVES-OWN00001');
  expect(engine.findHouseholdPromoter).not.toHaveBeenCalled();
});

test('a sibling with no own row shares the household promoter link', async () => {
  ownRow(null);
  engine.findHouseholdPromoter.mockResolvedValueOnce({ id: 'promo-h', referral_link: 'https://portal.wavespestcontrol.com/r/WAVES-HOUSE01' });
  expect(await referralShareUrl({ id: 'cust-2', referral_code: null })).toBe('https://portal.wavespestcontrol.com/r/WAVES-HOUSE01');
  expect(engine.findHouseholdPromoter).toHaveBeenCalledWith('cust-2');
});

test('a legacy household row with a code but no link is rebuilt from the code, never the generic tab', async () => {
  ownRow(null);
  engine.findHouseholdPromoter.mockResolvedValueOnce({ id: 'promo-h', referral_code: 'WAVES-HOUSE01', referral_link: null });
  expect(await referralShareUrl({ id: 'cust-2', referral_code: null })).toBe('https://portal.wavespestcontrol.com/r/WAVES-HOUSE01');
});

test('an own legacy row with a code but no link is rebuilt the same way', async () => {
  ownRow({ referral_link: null, referral_code: 'WAVES-OWN00001' });
  expect(await referralShareUrl({ id: 'cust-1', referral_code: null })).toBe('https://portal.wavespestcontrol.com/r/WAVES-OWN00001');
  expect(engine.findHouseholdPromoter).not.toHaveBeenCalled();
});

test('no own row and no household promoter → customers.referral_code, then the generic refer tab', async () => {
  ownRow(null);
  expect(await referralShareUrl({ id: 'cust-3', referral_code: 'WAVES-LEGACY1' })).toBe('https://portal.wavespestcontrol.com/r/WAVES-LEGACY1');
  ownRow(null);
  expect(await referralShareUrl({ id: 'cust-4', referral_code: null })).toMatch(/\/\?tab=refer$/);
});
