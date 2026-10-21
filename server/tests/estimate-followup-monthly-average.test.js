/**
 * GATE_ESTIMATE_FOLLOWUP_MONTHLY_AVERAGE (owner 2026-10-21, "follow-ups too"):
 * the unviewed, viewed, final and expiring follow-up emails show the same
 * monthly average the delivery email does, built by the same resolver
 * (emailAverageParts) from a row read at send time. Gate off = the payload is
 * the very same object the sender built before.
 */
const mockGates = { followup: true, base: true };
const NOTE_BLOCKS = [
  { type: 'details', rows: [{ label: 'Estimate', value: '{{price_summary}}' }] },
  { type: 'paragraph', content: '{{estimate_average_note}}' },
];
const mockTemplate = { activeVersion: { blocks: NOTE_BLOCKS, text_body: null } };
jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.raw = jest.fn((expr) => expr);
  mockDb.fn = { now: jest.fn(() => 'NOW()') };
  return mockDb;
});
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn((gate) => (gate === 'estimateFollowupMonthlyAverage' ? mockGates.followup
    : gate === 'estimateMonthlyAverage' ? mockGates.base : false)),
}));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn(async () => ({ sent: true })) }));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async () => ({ sent: true })),
  loadTemplateByKey: jest.fn(async () => ({ template: { status: 'active' }, activeVersion: mockTemplate.activeVersion })),
}));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(async (url, opts = {}) => `https://short.test/${opts.channel}`) }));
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: jest.fn(async () => 'SMS body'), isTemplateActive: jest.fn(async () => true) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/estimate-conversion-guard', () => ({ customerConvertedSince: jest.fn(async () => ({ converted: false })) }));
jest.mock('../services/estimate-lead-linkage', () => ({ leadIdForEstimate: jest.fn(async () => 'lead-9') }));
jest.mock('../services/estimate-deposits', () => ({
  assessDepositFollowUpEligibility: jest.fn(async () => ({ eligible: false })),
  DEPOSIT_FOLLOWUP_WINDOW: { minAgeHours: 2, maxAgeHours: 72 },
}));
const mockBilling = { ctx: { billsPerApplication: true, livePricing: null } };
jest.mock('../services/estimate-proposal-billing', () => ({
  resolveProposalBillingContext: jest.fn(async () => mockBilling.ctx),
}));

const db = require('../models/db');
const EmailTemplates = require('../services/email-template-library');
const EstimateFollowUp = require('../services/estimate-follow-up');
const { _private } = EstimateFollowUp;

const NOW = new Date('2026-06-10T15:00:00Z');
const H = 3600000;
const DAY = 24 * H;

const pestBundle = { frequencies: [{ key: 'quarterly', perTreatment: 94, visitsPerYear: 4, monthly: 31.33, annual: 376 }] };
const multiBundle = {
  combinedRecurring: { waveGuardDiscountPct: 0.1 },
  frequencies: [{
    key: 'quarterly', monthly: 72.3, annual: 867.6,
    perServiceTreatments: [
      { label: 'Lawn Care', service: 'lawn_care', displayPrice: 56.4, visitsPerYear: 9, monthly: 42.3 },
      { label: 'Pest Control', service: 'pest_control', displayPrice: 90, visitsPerYear: 4, monthly: 30 },
    ],
  }],
  oneTimeBreakdown: { items: [{ kind: 'charge', service: 'waveguard_setup', amount: 99, label: 'WaveGuard setup' }] },
};
const row = (overrides = {}) => ({
  id: 'est-1', status: 'sent', category: 'RESIDENTIAL', customer_id: 'cust-1', customer_name: 'Taylor Doe',
  customer_phone: '+19415550100', customer_email: 'taylor@example.com', token: 'tok-xyz', service_interest: 'Pest Control',
  address: '1 Main St', monthly_total: '31.33', annual_total: '376.00', onetime_total: '0',
  sent_at: new Date(NOW.getTime() - 30 * H), viewed_at: null, created_at: new Date(NOW.getTime() - 31 * H),
  expires_at: new Date(NOW.getTime() + 2 * DAY),
  estimate_data: { sendSnapshot: { pricingBundle: pestBundle } },
  ...overrides,
});
const multiRow = (overrides = {}) => row({
  service_interest: 'Lawn + Pest', monthly_total: '72.30', annual_total: '867.60', onetime_total: '99',
  estimate_data: { sendSnapshot: { pricingBundle: multiBundle } }, ...overrides,
});

let candidate; // the row the stage query returns, and the fresh read returns
let freshOverride;
let stageWanted;

function stageOf(calls) {
  const where = calls.filter((c) => c[0] === 'where');
  if (calls.some((c) => c[0] === 'whereBetween')) return 'expiring';
  const status = where.find((c) => c[1] && typeof c[1] === 'object' && c[1].status)?.[1].status;
  if (status === 'sent') return 'unviewed';
  if (status === 'viewed') {
    const lt = where.find((c) => c[1] === 'viewed_at' && c[2] === '<');
    const age = lt ? NOW.getTime() - new Date(lt[3]).getTime() : 0;
    return age > 4 * DAY ? 'final' : 'viewed';
  }
  return null;
}

function makeBuilder(table) {
  const calls = [];
  const b = {};
  for (const m of ['join', 'whereIn', 'whereNotIn', 'whereNotNull', 'whereNull', 'whereNot', 'where', 'whereBetween', 'select', 'groupBy', 'max', 'as', 'orderBy', 'orWhereNull', 'andWhere', 'whereNotExists', 'whereRaw']) {
    b[m] = jest.fn((...args) => { calls.push([m, ...args]); return b; });
  }
  b.first = jest.fn(() => { b._mode = 'first'; return b; });
  b.update = jest.fn(() => { b._mode = 'update'; return b; });
  b.then = (resolve, reject) => {
    let value;
    if (table !== 'estimates') value = b._mode === 'first' ? undefined : (b._mode === 'update' ? 1 : []);
    else if (b._mode === 'update') value = 1;
    else if (b._mode === 'first') value = freshOverride === undefined ? candidate : freshOverride;
    else value = stageOf(calls) === stageWanted ? [candidate] : [];
    return Promise.resolve(value).then(resolve, reject);
  };
  b.catch = (onRejected) => b.then(undefined, onRejected);
  return b;
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }).setSystemTime(NOW);
  jest.clearAllMocks();
  mockGates.followup = true;
  mockGates.base = true;
  mockBilling.ctx = { billsPerApplication: true, livePricing: null };
  mockTemplate.activeVersion = { blocks: NOTE_BLOCKS, text_body: null };
  candidate = row();
  freshOverride = undefined;
  stageWanted = 'unviewed';
  db.mockImplementation((table) => makeBuilder(table));
});
afterEach(() => { jest.useRealTimers(); });

const STAGES = [
  ['unviewed', 'estimate.unviewed_followup', (r) => r],
  ['viewed', 'estimate.viewed_followup', (r) => ({ ...r, status: 'viewed', viewed_at: new Date(NOW.getTime() - 50 * H) })],
  ['final', 'estimate.followup_final', (r) => ({ ...r, status: 'viewed', viewed_at: new Date(NOW.getTime() - 5.5 * DAY) })],
  ['expiring', 'estimate.expiring_notice', (r) => r],
];

async function runStage(stage, mutate, makeRow = row) {
  stageWanted = stage;
  candidate = mutate(makeRow());
  EmailTemplates.sendTemplate.mockClear();
  await EstimateFollowUp.checkAll();
  return EmailTemplates.sendTemplate.mock.calls.map((c) => c[0]).find((a) => a.templateKey);
}

describe.each(STAGES)('%s stage (%s)', (stage, templateKey, mutate) => {
  test('single service: the price row carries the average and the context sentence rides in the note variable', async () => {
    const sent = await runStage(stage, mutate);
    expect(sent.templateKey).toBe(templateKey);
    expect(sent.payload.price_summary).toBe('$94.00 per application · $31.33 a month');
    expect(sent.payload.estimate_average_note).toBe('Averaged over the year. You pay after each application.');
  });

  test('multi service: plan average, bundle savings and the one-time setup wording', async () => {
    const sent = await runStage(stage, mutate, multiRow);
    expect(sent.payload.price_summary).toBe('Priced per application · plan averages $72.30 a month');
    expect(sent.payload.estimate_average_note).toBe('Averaged over the year, bundle savings included. You pay after each application. One-time setup $99.00, not in the average.');
  });

  test('gate off: the payload is the sender\'s own, with no average key and today\'s price line', async () => {
    mockGates.followup = false;
    const sent = await runStage(stage, mutate);
    expect(sent.payload.price_summary).toBe('Priced per application — full breakdown inside');
    expect(sent.payload).not.toHaveProperty('estimate_average_note');
  });

  test('the base average gate off also withholds it', async () => {
    mockGates.base = false;
    const sent = await runStage(stage, mutate);
    expect(sent.payload.price_summary).toBe('Priced per application — full breakdown inside');
    expect(sent.payload).not.toHaveProperty('estimate_average_note');
  });
});

describe('withMonthlyAverage: plans the delivery email leaves alone are left alone here', () => {
  const unchanged = async (est) => {
    const payload = _private.estimateEmailPayload(est, 'Taylor', 'https://x.test');
    freshOverride = est;
    const out = await _private.withMonthlyAverage(payload, est, 'estimate.unviewed_followup');
    expect(out).toBe(payload); // the very same object: byte-identical
  };

  test('commercial (category and the data marker on a residential-labelled draft), quote-required, closed rows', async () => {
    await unchanged(row({ category: 'COMMERCIAL' }));
    await unchanged(row({ estimate_data: { commercialEstimatedPricing: true, sendSnapshot: { pricingBundle: pestBundle } } }));
    await unchanged(row({ status: 'quote_required' }));
    await unchanged(row({ status: 'accepted' }));
    await unchanged(row({ status: 'declined' }));
  });

  test('annual prepay / monthly-billed (billing lane says not per application), one-time only, stale total', async () => {
    mockBilling.ctx = { billsPerApplication: false, livePricing: null };
    await unchanged(row());
    mockBilling.ctx = { billsPerApplication: true, livePricing: null };
    await unchanged(row({ monthly_total: '0', annual_total: '0', onetime_total: '250', estimate_data: {} }));
    await unchanged(row({ monthly_total: '40.00' }));
  });

  test('a failure resolving the average never blocks the follow-up: the payload is returned as built', async () => {
    const payload = _private.estimateEmailPayload(row(), 'Taylor', 'https://x.test');
    db.mockImplementationOnce(() => { throw new Error('db down'); });
    expect(await _private.withMonthlyAverage(payload, row(), 'estimate.unviewed_followup')).toBe(payload);
  });

  test('it reads the row now, not the candidate it was handed (a price edit since the stage query)', async () => {
    const payload = _private.estimateEmailPayload(row(), 'Taylor', 'https://x.test');
    freshOverride = row({ monthly_total: '40.00' }); // no longer matches the lines
    expect(await _private.withMonthlyAverage(payload, row(), 'estimate.unviewed_followup')).toBe(payload);
  });
});

describe('withMonthlyAverage: only a template whose active version can show the note gets the average', () => {
  const KEY = 'estimate.unviewed_followup';
  const apply = async () => {
    const payload = _private.estimateEmailPayload(row(), 'Taylor', 'https://x.test');
    freshOverride = row();
    return { payload, out: await _private.withMonthlyAverage(payload, row(), KEY) };
  };

  test('a template the migration skipped (no note block) keeps the original payload', async () => {
    mockTemplate.activeVersion = { blocks: [NOTE_BLOCKS[0]], text_body: null };
    const { payload, out } = await apply();
    expect(out).toBe(payload);
    expect(out.price_summary).toBe('Priced per application — full breakdown inside');
  });

  test('a custom plain-text body that lacks the variable keeps the original payload', async () => {
    mockTemplate.activeVersion = { blocks: NOTE_BLOCKS, text_body: 'Custom text. {{price_summary}}' };
    const { payload, out } = await apply();
    expect(out).toBe(payload);
  });

  test('a custom plain-text body that also carries the variable gets the average', async () => {
    mockTemplate.activeVersion = { blocks: NOTE_BLOCKS, text_body: 'Custom text. {{price_summary}} {{estimate_average_note}}' };
    const { out } = await apply();
    expect(out.estimate_average_note).toBe('Averaged over the year. You pay after each application.');
  });

  test('a blank text body and blocks stored as a JSON string still count as supported', async () => {
    mockTemplate.activeVersion = { blocks: JSON.stringify(NOTE_BLOCKS), text_body: '  ' };
    const { out } = await apply();
    expect(out.price_summary).toBe('$94.00 per application · $31.33 a month');
  });

  test('no active version, a missing template or a loader failure keeps the original payload', async () => {
    const EmailTemplatesMock = require('../services/email-template-library');
    const payload = _private.estimateEmailPayload(row(), 'Taylor', 'https://x.test');
    freshOverride = row();
    mockTemplate.activeVersion = null;
    expect(await _private.withMonthlyAverage(payload, row(), KEY)).toBe(payload);
    EmailTemplatesMock.loadTemplateByKey.mockResolvedValueOnce(null);
    expect(await _private.withMonthlyAverage(payload, row(), KEY)).toBe(payload);
    EmailTemplatesMock.loadTemplateByKey.mockRejectedValueOnce(new Error('library down'));
    expect(await _private.withMonthlyAverage(payload, row(), KEY)).toBe(payload);
  });

  test('through checkAll: a skipped expiring template sends the original price row', async () => {
    mockTemplate.activeVersion = { blocks: [NOTE_BLOCKS[0]], text_body: null };
    const sent = await runStage('expiring', (r) => r);
    expect(sent.payload.price_summary).toBe('Priced per application — full breakdown inside');
    expect(sent.payload).not.toHaveProperty('estimate_average_note');
  });
});
