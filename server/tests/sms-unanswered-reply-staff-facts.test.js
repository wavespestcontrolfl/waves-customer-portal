/**
 * The unanswered-text lane's facts fingerprint (sms-unanswered-reply.factsFingerprintFor) hashes the facts block the drafter wrote from.
 * The prepaid visits left and the booked visit's prep guide (owner 2026-11-25, includeSmsStaffFacts) are part of that block, so a change to
 * either between the draft and the send must change the hash and keep the text with staff.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/context-aggregator', () => ({ getContextForCustomer: jest.fn(), authorizedDuesCents: jest.fn(() => []) }));

const ContextAggregator = require('../services/context-aggregator');
const { factsFingerprintFor } = require('../services/sms-unanswered-reply');

const GATE = 'GATE_SMS_REAL_ANSWERS';
let priorGate;
beforeEach(() => { priorGate = process.env[GATE]; process.env[GATE] = 'true'; ContextAggregator.getContextForCustomer.mockReset(); });
afterEach(() => { if (priorGate === undefined) delete process.env[GATE]; else process.env[GATE] = priorGate; });

const billing = { outstandingBalance: 0, recentPayments: [], hasProcessingPayment: false, recentPaymentsTruncated: false, invoiceStatuses: [], hasDepositActivity: false };
const dbh = () => ({ where: () => ({ whereNull: () => ({ first: async () => ({ id: 'c1', active: true }) }) }) });
const AT = new Date('2026-11-25T15:00:00Z');
const hashWith = async (extra) => {
  ContextAggregator.getContextForCustomer.mockResolvedValue({ summary: 'X', billing, ...extra });
  return factsFingerprintFor({ id: 'c1' }, AT, dbh);
};

test('the context is read WITH the staff facts', async () => {
  await hashWith({});
  expect(ContextAggregator.getContextForCustomer).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), expect.objectContaining({ includeSmsStaffFacts: true }));
});

test('a change to the prepaid visits left or to the prep guide changes the hash', async () => {
  const base = await hashWith({});
  const plans = (remaining) => ({ prepaidPlans: [{ label: 'Quarterly Pest Control', remaining, paid: 4 }] });
  const guide = (text) => ({ prepGuide: { key: 'flea', label: 'Flea Treatment', sentences: [text] } });
  expect(await hashWith(plans(3))).not.toBe(base);
  expect(await hashWith(plans(3))).toBe(await hashWith(plans(3)));
  expect(await hashWith(plans(2))).not.toBe(await hashWith(plans(3)));
  expect(await hashWith(guide('Vacuum every carpet before we arrive.'))).not.toBe(base);
  expect(await hashWith(guide('Vacuum every carpet before we arrive.'))).not.toBe(await hashWith(guide('Wash all pet bedding on the hottest cycle.')));
});
