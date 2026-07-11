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

// ─── Robocall script signature (layered-v2) ─────────────────────────────────

const { detectRobocallScriptSignature } = require('../services/call-spam-classifier');

// Verbatim from the 2026-04-01 straggler voicemail (+19412053987) — the
// Google-listing family script this signature exists to catch.
const OBSERVED_SCRIPT = '...your business... visible... notifications press 9 at any time. '
  + 'You may also call our toll-free number at 877-922-4011 to be removed from our call list. '
  + 'Again, please press 0 to speak with a support specialist.';

describe('detectRobocallScriptSignature', () => {
  test('the observed live script matches with multiple marker categories', () => {
    const res = detectRobocallScriptSignature(OBSERVED_SCRIPT);
    expect(res.match).toBe(true);
    expect(res.markers).toEqual(expect.arrayContaining(['ivr_prompt', 'call_list_removal', 'tollfree_callback']));
  });

  test('one marker category alone NEVER matches (precision-first)', () => {
    // A realtor mentioning a listing…
    expect(detectRobocallScriptSignature('I saw your Google listing and wanted a quote for my house.').match).toBe(false);
    // …an agent reading back a toll-free number…
    expect(detectRobocallScriptSignature('You can reach our office at 855-926-0203 any time.').match).toBe(false);
    // …or an IVR mention in passing.
    expect(detectRobocallScriptSignature('Their phone tree said press 1 for sales, so I hung up.').match).toBe(false);
  });

  test('real customer transcripts do not match', () => {
    const kathy = 'Caller: Hi, do you do WDO inspection reports for real estate residential? '
      + 'I need one for a home I just sold this weekend. 4471 McIntosh Lake Avenue, Sarasota. '
      + 'I am the realtor, the buyer\'s agent. Her email is lferraro@hotmail.com and her phone number is 978-501-0169.';
    expect(detectRobocallScriptSignature(kathy).match).toBe(false);
    expect(detectRobocallScriptSignature(null).match).toBe(false);
    expect(detectRobocallScriptSignature('').match).toBe(false);
  });
});

describe('classifyCall — script signature as the independent second signal', () => {
  test('content + script signature = spam (rotating local number, no vendor/line risk)', async () => {
    mockHistory();
    const { verdict, signals } = await classifyCall({
      call: CALL(NOMO_CLEAN),
      legacy: { is_spam: true },
      transcript: OBSERVED_SCRIPT,
    });
    expect(signals.script.match).toBe(true);
    expect(verdict).toBe('spam');
  });

  test('script signature WITHOUT the content signal never discards', async () => {
    mockHistory();
    const { verdict } = await classifyCall({
      call: CALL(NOMO_CLEAN),
      legacy: { is_spam: false },
      transcript: OBSERVED_SCRIPT,
    });
    expect(verdict).toBe('not_spam');
  });

  test('history override still beats content + signature', async () => {
    mockHistory({ customer: { id: 'cust-1' } });
    const { verdict } = await classifyCall({
      call: CALL(NOMO_CLEAN),
      legacy: { is_spam: true },
      transcript: OBSERVED_SCRIPT,
    });
    expect(verdict).toBe('not_spam');
  });

  test('no transcript → script signal absent, prior behavior unchanged', async () => {
    mockHistory();
    const { verdict, signals } = await classifyCall({
      call: CALL(NOMO_CLEAN),
      legacy: { is_spam: true },
    });
    expect(signals.script).toEqual({ match: false, markers: [] });
    expect(verdict).toBe('insufficient_signals');
  });
});
