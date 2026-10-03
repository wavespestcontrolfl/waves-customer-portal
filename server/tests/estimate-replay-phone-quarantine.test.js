// B18: a follow-up / extension text QUEUED before a contradicted accept must not replay to the disputed
// number afterwards. Both deferred-replay handlers (estimate_follow_up_deferred, estimate_extension_deferred)
// judge the ACTUAL queued destination (the row's to_phone), not the estimate's current phone.

jest.mock('../models/db', () => {
  // Generic lazy chain: every builder method returns the chain; awaiting it resolves the table's fixture.
  const mockDb = jest.fn((table) => {
    const q = {};
    ['where', 'join', 'andWhere', 'orWhere', 'whereIn', 'whereNull', 'whereNot', 'whereRaw', 'first', 'select'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.then = (resolve, reject) => Promise.resolve(table === 'estimates' ? mockDb._estimate : null).then(resolve, reject);
    return q;
  });
  mockDb.raw = jest.fn((expr) => expr);
  mockDb.fn = { now: jest.fn(() => 'NOW()') };
  mockDb._estimate = null;
  return mockDb;
});
jest.mock('../services/estimate-conversion-guard', () => ({ customerConvertedSince: jest.fn(async () => ({ converted: false })) }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const { recheckDeferredReplay } = require('../services/messaging/deferred-replay-registry');

const STAMP = { key: '9415550123', rejectedCustomerId: 'cust-bob', acceptedEstimateId: 'est-accepted' };
const sibling = (over = {}) => ({
  id: 'est-sib', status: 'sent', customer_id: null, customer_phone: '(941) 555-0123', customer_email: 'pat@example.com',
  estimate_data: { acceptPhoneDispute: STAMP }, created_at: '2026-10-01T00:00:00Z', ...over,
});

beforeEach(() => { jest.clearAllMocks(); db._estimate = sibling(); });

describe.each(['estimate_follow_up_deferred', 'estimate_extension_deferred'])('%s replay', (entryPoint) => {
  const recheck = (meta) => recheckDeferredReplay(entryPoint, { estimate_id: 'est-sib', ...meta });

  test('a text queued BEFORE the contradicted accept is suppressed at replay for the stamped, still-sent sibling', async () => {
    const res = await recheck({ to_phone: '+19415550123' });
    expect(res).toMatchObject({ eligible: false, reason: 'phone-quarantined' });
    expect(res.retryable).not.toBe(true);
  });

  test('destination-side: an estimate whose phone was since corrected still does not deliver the queued item to the disputed number', async () => {
    db._estimate = sibling({ customer_phone: '(941) 555-0188' });
    expect(await recheck({ to_phone: '+19415550123' })).toMatchObject({ eligible: false, reason: 'phone-quarantined' });
    // ...while an item queued to the corrected number replays.
    expect(await recheck({ to_phone: '+19415550188' })).toEqual({ eligible: true });
  });

  test('a legacy queued row with no stored destination falls back to the estimate\'s phone', async () => {
    expect(await recheck({})).toMatchObject({ eligible: false, reason: 'phone-quarantined' });
  });

  test('control: an unstamped estimate still replays', async () => {
    db._estimate = sibling({ estimate_data: {} });
    expect(await recheck({ to_phone: '+19415550123' })).toEqual({ eligible: true });
  });
});
