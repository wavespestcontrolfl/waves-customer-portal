// Layered spam classifier — the asymmetric-cost rules are structural:
// content + >=1 independent signal + no history override, or no discard.
// Fixtures fictitious; 555-01xx numbers.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const { classifyCall } = require('../services/call-spam-classifier');

function mockHistory({ customer = null, lead = null, throwErr = null } = {}) {
  db.mockImplementation((table) => {
    const builder = {
      where: () => builder, whereRaw: () => builder, whereIn: () => builder, whereNull: () => builder,
      first: async () => {
        if (throwErr) throw new Error(throwErr);
        if (table === 'customers') return customer;
        if (table === 'leads') return lead;
        return null;
      },
    };
    return builder;
  });
}

const CALL = (addons) => ({
  id: 'call-1', from_phone: '+15555550142',
  metadata: JSON.stringify({ addons, stir_verstat: null }),
});
const NOMO_SPAM = { results: { nomorobo_spamscore: { status: 'successful', result: { score: 1 } } } };
const NOMO_CLEAN = { results: { nomorobo_spamscore: { status: 'successful', result: { score: 0 } } } };

beforeEach(() => jest.clearAllMocks());

test('content + vendor risk = spam', async () => {
  mockHistory();
  const { verdict, signals } = await classifyCall({
    call: CALL(NOMO_SPAM), legacy: { is_spam: true },
  });
  expect(verdict).toBe('spam');
  expect(signals.risk.vendor_risk).toBe(true);
});

test('content alone NEVER discards (insufficient_signals)', async () => {
  mockHistory();
  const { verdict } = await classifyCall({ call: CALL(NOMO_CLEAN), legacy: { is_spam: true } });
  expect(verdict).toBe('insufficient_signals');
});

test('risk score alone never discards', async () => {
  mockHistory();
  const { verdict } = await classifyCall({ call: CALL(NOMO_SPAM), legacy: { is_spam: false } });
  expect(verdict).toBe('not_spam');
});

test('no content signal at all = insufficient_signals', async () => {
  mockHistory();
  const { verdict } = await classifyCall({ call: CALL(NOMO_SPAM) });
  expect(verdict).toBe('insufficient_signals');
});

test('caller history overrides everything toward not_spam', async () => {
  mockHistory({ customer: { id: 'cust-1' } });
  const { verdict, signals } = await classifyCall({
    call: CALL(NOMO_SPAM), legacy: { is_spam: true },
  });
  expect(verdict).toBe('not_spam');
  expect(signals.history.override).toBe(true);
});

test('a history-lookup DB failure fails SAFE (override → not_spam)', async () => {
  mockHistory({ throwErr: 'connection reset' });
  const { verdict } = await classifyCall({ call: CALL(NOMO_SPAM), legacy: { is_spam: true } });
  expect(verdict).toBe('not_spam');
});

test('schema-1.5.0 spam_verdict outranks V1 is_spam as the content source', async () => {
  mockHistory();
  const { verdict, signals } = await classifyCall({
    call: CALL(NOMO_SPAM),
    extraction: { spam_verdict: { is_spam_content: false } }, // 1.5.0 says prospect
    legacy: { is_spam: true },                                 // stale V1 disagrees
  });
  expect(signals.content.source).toBe('v2_spam_verdict');
  expect(verdict).toBe('not_spam');
});

test('line-type risk counts as the independent second signal', async () => {
  mockHistory();
  const { verdict } = await classifyCall({
    call: CALL(NOMO_CLEAN), legacy: { is_spam: true },
    lineType: { type: 'nonFixedVoip', caller_name: null },
  });
  expect(verdict).toBe('spam');
});

test('voip WITH a caller name is not line-risk', async () => {
  mockHistory();
  const { verdict } = await classifyCall({
    call: CALL(NOMO_CLEAN), legacy: { is_spam: true },
    lineType: { type: 'nonFixedVoip', caller_name: 'REAL PERSON' },
  });
  expect(verdict).toBe('insufficient_signals');
});

test('voip with NO CNAM source at all is NOT line-risk (unknown ≠ known-nameless)', async () => {
  mockHistory();
  const { verdict, signals } = await classifyCall({
    call: CALL(NOMO_CLEAN), legacy: { is_spam: true },
    lineType: { type: 'nonFixedVoip' }, // no caller_name key, no AddOns CNAM
  });
  expect(signals.line.line_risk).toBe(false);
  expect(verdict).toBe('insufficient_signals');
});

test('live path: CNAM from the AddOns envelope rescues a named VoIP caller', async () => {
  mockHistory();
  const addons = { results: {
    nomorobo_spamscore: { status: 'successful', result: { score: 0 } },
    twilio_caller_name: { status: 'successful', result: { caller_name: { caller_name: 'JANE EXAMPLE' } } },
  } };
  const { verdict, signals } = await classifyCall({
    call: CALL(addons), legacy: { is_spam: true },
    lineType: { type: 'nonFixedVoip' }, // cache has type only, like production
  });
  expect(signals.line.cnam).toBe('JANE EXAMPLE');
  expect(signals.line.line_risk).toBe(false);
  expect(verdict).toBe('insufficient_signals');
});

test('live path: AddOns CNAM ran and found nothing → known-nameless voip IS line-risk', async () => {
  mockHistory();
  const addons = { results: {
    nomorobo_spamscore: { status: 'successful', result: { score: 0 } },
    twilio_caller_name: { status: 'successful', result: { caller_name: { caller_name: null } } },
  } };
  const { verdict } = await classifyCall({
    call: CALL(addons), legacy: { is_spam: true },
    lineType: { type: 'nonFixedVoip' },
  });
  expect(verdict).toBe('spam');
});
