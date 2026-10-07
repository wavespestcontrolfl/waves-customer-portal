// GATE_LAWN_V13 bahia review applies to estimates that were never issued. A draft saved before the
// gate went live (stored flags absent) is reviewed on its send snapshot and at the send guard; a
// sent estimate replayed as sold is honored; the add rail still reviews a newly added line.
jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
}));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));

const { estimateNeverIssued, estimateHasBahiaLawn, UNISSUED_ESTIMATE } = require('../services/estimate-bahia-review');
const { buildPricingBundle, extractEngineInputs } = require('../routes/estimate-public');
const router = require('../routes/admin-estimates');
const { generateEstimate } = require('../services/pricing-engine');

const BASE = { homeSqFt: 1800, lotSqFt: 8783, stories: 1, estimatedTurfSf: 4500 };
const inputs = (track = 'bahia') => ({ engineInputs: { ...BASE, services: { lawn: { track, tier: 'enhanced' } } } });
const NEVER = { status: 'draft', sent_at: null, viewed_at: null };
const SENT = { status: 'sent', sent_at: new Date('2026-09-01T12:00:00Z'), viewed_at: null };

beforeEach(() => { process.env.GATE_LAWN_V13 = 'true'; });
afterEach(() => { delete process.env.GATE_LAWN_V13; });

describe('never issued, by the repo definition (sent_at / viewed_at)', () => {
  test.each([
    [{ status: 'draft', sent_at: null, viewed_at: null }, true],
    [{ status: 'scheduled', sent_at: null, viewed_at: null }, true],
    [{ status: 'sending', sent_at: null, viewed_at: null }, true],
    [{ status: 'send_failed', sent_at: null, viewed_at: null }, true],
    // a resend of a sent estimate is claimed as 'sending' but has sent_at
    [{ status: 'sending', sent_at: new Date(), viewed_at: null }, false],
    [{ status: 'sent', sent_at: new Date(), viewed_at: null }, false],
    [{ status: 'viewed', sent_at: null, viewed_at: new Date() }, false],
    [{ status: 'accepted', sent_at: null, viewed_at: null }, false],
    [{ status: 'expired', sent_at: null, viewed_at: null }, false],
    // no way to tell: a partial object reads as issued
    [{ status: 'draft' }, false],
  ])('%j -> %s', (row, expected) => {
    expect(estimateNeverIssued(row)).toBe(expected);
  });

  test('recognizes a stored bahia lawn plan, in inputs or in a request, and nothing else', () => {
    expect(estimateHasBahiaLawn(inputs('bahia'))).toBe(true);
    expect(estimateHasBahiaLawn(inputs('D'))).toBe(true);
    expect(estimateHasBahiaLawn(inputs('bermuda'))).toBe(false);
    expect(estimateHasBahiaLawn({ engineRequest: { selectedServices: ['LAWN'], options: { grassType: 'bahia' } } })).toBe(true);
    expect(estimateHasBahiaLawn({ engineRequest: { selectedServices: ['PEST'], options: { grassType: 'bahia' } } })).toBe(false);
    expect(estimateHasBahiaLawn({})).toBe(false);
  });
});

// Every stored estimate shape the send path and the pricing bundle accept.
const V1_RESULT = (grass) => ({
  recurring: {
    services: [{ name: 'Lawn Care', service: 'lawn_care', mo: 66.75, ann: 801, perTreatment: 89, visitsPerYear: 9 }],
    monthlyTotal: 66.75, annualAfterDiscount: 801, discount: 0,
  },
  results: { lawnMeta: { grassType: grass, grassName: grass === 'bahia' ? 'Bahia' : 'Bermuda' }, lawn: [{ name: 'Enhanced', v: 9, mo: 66.75, ann: 801, pa: 89, recommended: true }] },
});
const SHAPES = {
  'engine inputs (engineInputs)': (grass) => ({ engineInputs: { ...BASE, services: { lawn: { track: grass } } } }),
  'engine inputs (inputs)': (grass) => ({ inputs: { ...BASE, services: { lawn: { track: grass } } } }),
  'wizard engineInput': (grass) => ({ engineInput: { ...BASE, services: { lawn: { track: grass } } } }),
  'V1 form inputs + result': (grass) => ({ inputs: { svcLawn: true, grassType: grass, lawnFreq: '9' }, result: V1_RESULT(grass) }),
  'V1 form inputs nested in result': (grass) => ({ result: { ...V1_RESULT(grass), inputs: { svcLawn: true, grassType: grass } } }),
  'V1 stored result only (lawnMeta)': (grass) => ({ result: V1_RESULT(grass) }),
  'saved request': (grass) => ({ engineRequest: { profile: BASE, selectedServices: ['LAWN'], options: { grassType: grass } } }),
  'raw engine result': (grass) => ({ engineResult: { lineItems: [{ service: 'lawn_care', track: grass }] } }),
};

describe.each(Object.entries(SHAPES))('shape: %s', (_name, make) => {
  test('a bahia lawn plan is recognized, other grass is not', () => {
    expect(estimateHasBahiaLawn(make('bahia'))).toBe(true);
    expect(estimateHasBahiaLawn(make('bermuda'))).toBe(false);
  });

  test('the send guard blocks a never-issued estimate and lets a sent one resend', () => {
    const send = (row, grass) => router._internals.assertEstimateSendable({ id: 'e1', token: 'tok', monthly_total: 80, onetime_total: 0, ...row, estimate_data: make(grass) });
    expect(() => send(NEVER, 'bahia')).toThrow(/Bahia lawn plans need manual review/);
    expect(() => send(SENT, 'bahia')).not.toThrow();
    expect(() => send(NEVER, 'bermuda')).not.toThrow();
  });
});

describe('V1 blobs: the bundle is served from stored rows, so the review is the quote requirement', () => {
  let bundleSeq = 0;
  const bundle = (row, grass) => buildPricingBundle({ id: `v1-${bundleSeq += 1}`, token: 't', ...row, estimate_data: SHAPES['V1 form inputs + result'](grass) });

  test('a never-issued bahia V1 draft is quote-required with the bahia reason', async () => {
    const out = await bundle(NEVER, 'bahia');
    expect(out.quoteRequired).toBe(true);
    expect(out.quoteRequiredReason).toBe('lawn_v13_bahia_no_program');
  });

  test('a sent bahia V1 estimate is honored, and so is a never-issued bermuda one', async () => {
    expect((await bundle(SENT, 'bahia')).quoteRequired).toBeFalsy();
    expect((await bundle(NEVER, 'bermuda')).quoteRequired).toBeFalsy();
  });

  test('gate off: no review', async () => {
    delete process.env.GATE_LAWN_V13;
    expect((await bundle(NEVER, 'bahia')).quoteRequired).toBeFalsy();
  });
});

describe('the send snapshot bundle', () => {
  const bundleText = async (row) => JSON.stringify(await buildPricingBundle({ id: `e-${row.status}`, token: 't', ...row, estimate_data: inputs() }));

  test('a pre-deploy draft with a bahia lawn is reviewed', async () => {
    expect(await bundleText(NEVER)).toContain('lawn_v13_bahia_no_program');
  });

  test('an estimate that was sent is replayed as sold and honored', async () => {
    const text = await bundleText(SENT);
    expect(text).toContain('"serviceCategory":"lawn_care"');
    expect(text).not.toContain('lawn_v13_bahia_no_program');
  });

  test('a resend (claimed as sending, sent_at present) is honored', async () => {
    const text = await bundleText({ ...SENT, status: 'sending' });
    expect(text).toContain('"serviceCategory":"lawn_care"');
    expect(text).not.toContain('lawn_v13_bahia_no_program');
  });
});

describe('extractEngineInputs', () => {
  test('marks a replay as sold unless the estimate data is known to be never issued', () => {
    expect(extractEngineInputs(inputs()).savedEstimateReplay).toBe(true);
    const marked = inputs();
    marked[UNISSUED_ESTIMATE] = true;
    expect(extractEngineInputs(marked).savedEstimateReplay).toBe(false);
  });

  test('add mode stays reviewed even on a sold replay', () => {
    const replay = extractEngineInputs(inputs('bermuda'));
    const added = generateEstimate({ ...replay, services: { lawn: { track: 'bahia', tier: 'enhanced' } }, addedServiceKeys: ['lawn_care'] });
    expect(added.lineItems.find((l) => l.service === 'lawn_care').manualReviewReasons).toContain('lawn_v13_bahia_no_program');
  });
});

describe('the send guard', () => {
  const send = (row, data = inputs()) => router._internals.assertEstimateSendable({
    id: 'e1', token: 'tok', monthly_total: 80, onetime_total: 0, ...row, estimate_data: data,
  });

  test('a pre-deploy draft with a bahia lawn is blocked for review', () => {
    expect(() => send(NEVER)).toThrow(/Bahia lawn plans need manual review/);
    try { send(NEVER); } catch (err) { expect(err.code).toBe('LAWN_V13_BAHIA_REVIEW_REQUIRED'); expect(err.statusCode).toBe(400); }
  });

  test('a scheduled draft and a first-send claim are blocked too', () => {
    expect(() => send({ ...NEVER, status: 'scheduled' })).toThrow(/Bahia lawn plans/);
    expect(() => send({ ...NEVER, status: 'sending' })).toThrow(/Bahia lawn plans/);
  });

  test('an estimate already sent can be resent', () => {
    expect(() => send(SENT)).not.toThrow();
    expect(() => send({ ...SENT, status: 'sending' })).not.toThrow();
  });

  test('other grass, an authored proposal and gate off are not blocked', () => {
    expect(() => send(NEVER, inputs('bermuda'))).not.toThrow();
    expect(() => send(NEVER, { ...inputs(), proposal: { enabled: true } })).not.toThrow(/Bahia lawn plans/);
    delete process.env.GATE_LAWN_V13;
    expect(() => send(NEVER)).not.toThrow();
  });
});
