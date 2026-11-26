/**
 * The unanswered-text lane's facts fingerprint (sms-unanswered-reply.factsFingerprintFor) hashes the facts block the drafter wrote from.
 * The open estimate's per-application price, the prepaid visits left and the booked visit's PREP GUIDE (owner 2026-11-25, includeSmsStaffFacts) are
 * part of that block, so a change to it between the draft and the send must change the hash and keep the text with staff.
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

test('the context is read WITH the staff facts, as the drafter does: only while real answers are on', async () => {
  await hashWith({});
  expect(ContextAggregator.getContextForCustomer).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), expect.objectContaining({ includeSmsStaffFacts: true }));
  delete process.env[GATE];
  await hashWith({});
  expect(ContextAggregator.getContextForCustomer.mock.calls.at(-1)[1]).not.toHaveProperty('includeSmsStaffFacts');
});

test('a change to the prepaid visits left or to the open estimate\'s price changes the hash', async () => {
  const base = await hashWith({});
  const plans = (remaining) => ({ prepaidPlans: [{ label: 'Quarterly Pest Control', remaining, paid: 4 }] });
  const estimate = (cents) => ({ estimateFacts: { perApplication: [{ label: 'Pest Control', cents, applications: 4 }] } });
  expect(await hashWith(estimate(12500))).not.toBe(base);
  expect(await hashWith(estimate(13000))).not.toBe(await hashWith(estimate(12500)));
  expect(await hashWith(plans(3))).not.toBe(base);
  expect(await hashWith(plans(3))).toBe(await hashWith(plans(3)));
  expect(await hashWith(plans(2))).not.toBe(await hashWith(plans(3)));
});

// PREP GUIDE (step 2C): the guide text in the draft's facts is part of the send-time fingerprint. The fake context carries what
// sms-staff-facts.loadPrepGuideFacts returns: the guide's own sentences under their headings, its key and label (which guide the booked visit's page shows).
describe('the PREP GUIDE is part of the send-time fingerprint', () => {
  const section = (sentences, heading = null) => ({ heading, sentences });
  const guide = (over = {}) => ({ prepGuide: { source: 'booked', key: 'prep.interior_pest', label: 'Interior Pest Treatment', sections: [section(['Please clear the area under the sinks.', 'Pick up toys and pet bowls from the floor.'])], ...over } });

  test('a guide edited, unpublished or switched to another guide (the visit\'s assigned guide changed) between the draft and the send changes the hash', async () => {
    const drafted = await hashWith(guide());
    expect(await hashWith(guide())).toBe(drafted); // the same guide at send: the draft stands
    expect(await hashWith(guide({ sections: [section(['Please clear the area under the sinks.', 'Pick up toys and pet bowls from the floor and move the pet dishes.'])] }))).not.toBe(drafted); // edited
    expect(await hashWith(guide({ sections: [section(['Please clear the area under the sinks.'])] }))).not.toBe(drafted); // a step removed
    expect(await hashWith({ prepGuide: { sections: [] } })).not.toBe(drafted); // unpublished, or the guide no longer covers the visit
    expect(await hashWith(guide({ key: 'prep.flea', label: 'Flea Treatment' }))).not.toBe(drafted); // the visit's assigned guide changed, same words
    expect(await hashWith(guide({ sections: [section(['Please clear the area under the sinks.', 'Pick up toys and pet bowls from the floor.'], 'Prep for palmetto bugs')] }))).not.toBe(drafted); // the same steps under another case
    expect(await hashWith(guide({ source: 'last' }))).not.toBe(drafted); // the booked visit was cancelled: the last service's guide instead
  });

  test('a draft written with no guide stands only while there is still none', async () => {
    const none = await hashWith({ prepGuide: { sections: [] } });
    expect(await hashWith({ prepGuide: { sections: [] } })).toBe(none);
    expect(await hashWith(guide())).not.toBe(none); // a guide published since the draft
  });

  test('a guide read that fails refuses the fingerprint, at draft time and at send time (the drafter alone writes without the section)', async () => {
    await expect(hashWith({ prepGuide: null })).rejects.toThrow('prep guide could not be read');
    const { draftFactsFingerprint } = require('../services/sms-unanswered-reply');
    require('../models/db').mockImplementation(dbh);
    ContextAggregator.getContextForCustomer.mockResolvedValue({ summary: 'X', billing, prepGuide: null });
    process.env.GATE_SMS_UNANSWERED_REPLY = 'true';
    try {
      expect(await draftFactsFingerprint({ id: 'c1' })).toBeNull(); // no fingerprint: this lane never sends the draft
      ContextAggregator.getContextForCustomer.mockResolvedValue({ summary: 'X', billing, prepGuide: { sections: [] } });
      expect(await draftFactsFingerprint({ id: 'c1' })).toMatchObject({ hash: expect.any(String) }); // (the same call with a successful read of nothing does fingerprint)
    } finally { delete process.env.GATE_SMS_UNANSWERED_REPLY; }
  });

  test('at the send: the stored hash retires the draft ("facts_changed") when the guide changed, and a failed guide read propagates instead of passing', async () => {
    const { factsFingerprintRefusal } = require('../services/sms-unanswered-reply');
    const stamp = { facts_fingerprint: await hashWith(guide()), facts_fingerprint_at: AT.toISOString() };
    const refusal = async (extra) => { ContextAggregator.getContextForCustomer.mockResolvedValue({ summary: 'X', billing, ...extra }); return factsFingerprintRefusal(dbh, { customerId: 'c1', stamp }); };
    expect(await refusal(guide())).toBeNull();
    expect(await refusal(guide({ sections: [section(['Please clear the area under the sinks.'])] }))).toBe('facts_changed');
    expect(await refusal({ prepGuide: { sections: [] } })).toBe('facts_changed');
    expect(await refusal(guide({ key: 'prep.flea', label: 'Flea Treatment' }))).toBe('facts_changed');
    await expect(refusal({ prepGuide: null })).rejects.toThrow('prep guide could not be read');
  });

  test('gate off: the guide is neither asked for nor part of the hash, and a null key refuses nothing', async () => {
    delete process.env[GATE];
    const base = await hashWith({});
    expect(await hashWith(guide())).toBe(base);
    expect(await hashWith({ prepGuide: null })).toBe(base);
  });
});
