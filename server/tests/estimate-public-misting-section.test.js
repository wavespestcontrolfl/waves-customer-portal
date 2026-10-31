process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.ESTIMATE_DOC_PIN_SECRET = 'test-doc-pin-secret';

// The mosquito misting SYSTEM plan on the customer estimate (GET /:token/data, GATE_MOSQUITO_MISTING): its own service section
// (never the barrier mosquito program), one monthly cadence, no WaveGuard tier, the customer-safe refill and system facts, no
// cost field, the plan counted in every recurring total, and a misting "Before you book" section only on a misting estimate.
// Estimates without the plan carry none of it. Estimates are built by the real engine and mapper, then served by the real route.
jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => sql);
  return mock;
});
jest.mock('../services/estimate-proposal-billing', () => {
  const actual = jest.requireActual('../services/estimate-proposal-billing');
  return {
    ...actual,
    resolveProposalBillingContext: jest.fn(async (estimate) => ({ billsPerApplication: true, livePricing: await actual.resolveLivePricing(estimate) })),
  };
});
jest.mock('../config/feature-gates', () => ({
  ...jest.requireActual('../config/feature-gates'),
  isEnabled: jest.fn((gate) => gate === 'estimateDocPdf'),
  mosquitoMistingLive: jest.fn(() => process.env.GATE_MOSQUITO_MISTING === 'true'),
  mistingLayoutDesignerLive: jest.fn(() => false),
  gateEnvValue: jest.fn(() => false),
  gates: {},
}));
jest.mock('../services/property-lookup/lookup-cache', () => ({
  getCachedLookup: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/estimate-membership-context', () => ({
  buildEstimateMembershipContext: jest.fn().mockResolvedValue(null),
  publicMembershipView: jest.fn((snapshot) => snapshot ?? null),
}));
jest.mock('../services/estimate-deposits', () => ({
  ensureDepositSatisfied: jest.fn(),
  resolveDepositPolicyForEstimate: jest.fn().mockResolvedValue({ enforced: false, required: false, slotRequired: false }),
  computeDepositAmount: jest.fn(() => 0),
  pendingDepositCredit: jest.fn(),
  consumeDepositCredit: jest.fn(),
  refundUnconsumedDeposits: jest.fn(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const express = require('express');
const db = require('../models/db');
const estimatePublicRouter = require('../routes/estimate-public');

let dbRows = {};
function chainFor(result) {
  const chain = {
    where: jest.fn(() => chain),
    whereIn: jest.fn(() => chain),
    whereNull: jest.fn(() => chain),
    whereNotIn: jest.fn(() => chain),
    whereNotNull: jest.fn(() => chain),
    whereRaw: jest.fn(() => chain),
    andWhere: jest.fn(() => chain),
    orWhere: jest.fn(() => chain),
    orWhereRaw: jest.fn(() => chain),
    leftJoin: jest.fn(() => chain),
    select: jest.fn(() => chain),
    orderBy: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    first: jest.fn().mockResolvedValue(Array.isArray(result) ? result[0] : result),
    update: jest.fn(async () => 1),
    insert: jest.fn().mockResolvedValue([1]),
    // Awaiting a builder yields the rows (customer_properties is read as a list).
    then: Array.isArray(result) ? (resolve, reject) => Promise.resolve(result).then(resolve, reject) : undefined,
  };
  return chain;
}
db.mockImplementation((table) => chainFor(dbRows[table]));


const { generateEstimate } = require('../services/pricing-engine/estimate-engine');
const mapper = require('../services/pricing-engine/v1-legacy-mapper');
const { recurringServiceKey } = estimatePublicRouter;

const PROPERTY = { homeSqFt: 2200, stories: 1, lotSqFt: 12000, propertyType: 'single_family' };
const MISTING = { tier: 'smart', nozzles: 21, risers: 2 };
const PROPERTIES = [{ id: 'prop-a', customer_id: 'cust-synthetic-1', active: true, is_primary: true }];

// A unique id per scenario: the route caches the pricing bundle by estimate id.
let seq = 0;
function estimateRowFor(services) {
  seq += 1;
  const input = { ...PROPERTY, services };
  const result = mapper.mapV1ToLegacyShape(generateEstimate(input));
  return {
    id: `est-misting-section-${seq}`, token: 'mistingsectiontoken', status: 'sent', sent_at: null, viewed_at: null,
    customer_id: 'cust-synthetic-1',
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    customer_name: 'Pat Tester', customer_phone: null, customer_email: null, category: 'RESIDENTIAL',
    address: '123 Trust Ln, Bradenton, FL 34203', satellite_url: null, waveguard_tier: result.recurring.waveGuardTier || 'Bronze', bill_by_invoice: false,
    service_interest: 'Mosquito',
    monthly_total: result.recurring.monthlyTotal, annual_total: result.recurring.annualTotal, onetime_total: result.oneTime.total,
    estimate_data: { result, engineInputs: input },
  };
}
async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/estimates', estimatePublicRouter);
  app.use((err, _req, res, _next) => { res.status(err.status || 500).json({ error: err.message }); });
  const server = app.listen(0);
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
const getData = (baseUrl, query = '') => fetch(`${baseUrl}/estimates/mistingsectiontoken/data${query}`).then((r) => r.json());

// The page load and the document render pass for one estimate, served by the real route.
async function serve(services) {
  dbRows = { estimates: estimateRowFor(services), customer_properties: PROPERTIES, customers: { lawn_type: null } };
  return withServer(async (baseUrl) => ({ page: await getData(baseUrl), pdf: await getData(baseUrl, '?mode=pdf') }));
}
const sectionOf = (pricing, key) => pricing.services.find((section) => section.key === key);
const lineDescriptions = (body) => body.proposal.buildings.flatMap((building) => building.lineItems.map((line) => line.description));
const bybKeys = (body) => body.beforeYouBook.sections.map((section) => section.key);

beforeEach(() => { process.env.GATE_MOSQUITO_MISTING = 'true'; });
afterEach(() => { delete process.env.GATE_MOSQUITO_MISTING; });

jest.setTimeout(180000);

describe('recurringServiceKey: the misting plan is its own service', () => {
  test.each([
    [{ service: 'mosquito_misting', name: 'Mosquito Misting Service Plan' }, 'mosquito_misting'],
    [{ name: 'Mosquito Misting Service Plan' }, 'mosquito_misting'],
    [{ service: 'mosquito_misting_installation' }, 'mosquito_misting'],
    [{ label: 'Mosquito Misting Service Plan — 12 applications/yr' }, 'mosquito_misting'],
  ])('%j -> %s', (row, key) => {
    expect(recurringServiceKey(row)).toBe(key);
  });

  test.each([
    [{ service: 'mosquito', name: 'Mosquito' }, 'mosquito'],
    [{ name: 'Monthly Mosquito Program (12 visits)' }, 'mosquito'],
    [{ name: 'Seasonal Mosquito, 21-day misting cycle' }, 'mosquito'],
    [{ service: 'commercial_mosquito' }, 'commercial_mosquito'],
    [{ service: 'pest_control' }, 'pest_control'],
    [{ service: 'lawn_care' }, 'lawn_care'],
    [{ service: 'tree_shrub' }, 'tree_shrub'],
    [{ service: 'termite_bait' }, 'termite_bait'],
  ])('other services keep their key: %j -> %s', (row, key) => {
    expect(recurringServiceKey(row)).toBe(key);
  });
});

describe('GET /:token/data: misting plan alone', () => {
  let served;
  beforeAll(async () => {
    process.env.GATE_MOSQUITO_MISTING = 'true';
    served = await serve({ mosquitoMisting: MISTING });
    delete process.env.GATE_MOSQUITO_MISTING;
  });

  test('is its own section, one monthly cadence of 12 applications at $59, nothing recommended', () => {
    const { pricing, estimate } = served.page;
    expect(estimate.serviceCategory).toBe('mosquito_misting');
    expect(pricing.services).toHaveLength(1);
    const section = pricing.services[0];
    expect(section).toMatchObject({ key: 'mosquito_misting', label: 'Mosquito Misting Service Plan', isRecurring: true, defaultFrequencyKey: 'monthly', waveGuardTierEligible: false, isWaveGuardQualifier: false });
    expect(section.frequencies).toHaveLength(1);
    expect(section.frequencies[0]).toMatchObject({ key: 'monthly', label: 'Monthly', monthly: 59, annual: 708, perTreatment: 59, visitsPerYear: 12 });
    expect(JSON.stringify(section.frequencies)).not.toMatch(/recommended|Quarterly|Bi-monthly/i);
    // The key accept receives is the plan's own: the top-level entry matches the section's.
    expect(pricing.frequencies.map((frequency) => frequency.key)).toEqual(['monthly']);
  });

  test('carries the customer-safe system and refill facts and the install detail', () => {
    const section = sectionOf(served.page.pricing, 'mosquito_misting');
    expect(section.system).toEqual({ tierLabel: 'Standard system (55-gallon)', nozzles: 21, risers: 2 });
    expect(section.refill).toEqual({ label: 'Standard solution', perFill: 129, refillsPerYear: 4 });
    expect(section.oneTimeContribution.items).toEqual([expect.objectContaining({ service: 'mosquito_misting_installation', amount: 4345, detail: '21 nozzles · 2 risers' })]);
    expect(section.frequencies[0].included[0]).toMatchObject({ label: 'Mosquito Misting Service Plan', detail: '21 nozzles · 12 applications/yr · $59 per application' });
  });

  test('shows no WaveGuard tier UI or perks, no setup fee, and no savings', () => {
    const { pricing } = served.page;
    expect(pricing.renderFlags).toMatchObject({ showWaveGuardTierUi: false, showWaveGuardPerks: false, showWaveGuardSetupFee: false });
    expect(pricing.combinedRecurring).toMatchObject({ monthlySubtotal: 59, annualSubtotal: 708, qualifyingCount: 0, discountableBase: 0, excludedBase: 59, savingsPerMonth: 0 });
    expect(pricing.setupFee).toBeNull();
    expect(sectionOf(pricing, 'mosquito_misting').setupFee).toBeNull();
  });

  test('the Waves AI card is the system layout: title, body and the System, Nozzles and Risers tiles', () => {
    expect(served.page.estimate.intelligence).toMatchObject({
      title: 'Priced from your system layout',
      body: 'Your price is set by your system size and your nozzle and riser count.',
      metrics: [
        { label: 'System', value: 'Standard system (55-gallon)' },
        { label: 'Nozzles', value: '21' },
        { label: 'Risers', value: '2' },
      ],
    });
    expect(served.pdf.estimate.intelligence.metrics.map((metric) => metric.label)).toEqual(['System', 'Nozzles', 'Risers']);
  });

  test('the section copy is the misting copy, never the barrier mosquito or pest copy', () => {
    const { copy, intelligence } = sectionOf(served.page.pricing, 'mosquito_misting');
    expect(copy.aiTitle).toBe('Priced from your system layout');
    expect(copy.askChips).not.toContain('When does the season start?');
    expect(JSON.stringify(copy)).not.toMatch(/barrier|resting zones|mosquito pressure|ants/i);
    expect(intelligence.chips).toEqual(copy.askChips);
  });

  test('the PDF lists the plan as its own line with 12 applications and the install, both counted', () => {
    expect(lineDescriptions(served.pdf)).toEqual([
      'Mosquito Misting Service Plan — 12 applications/yr',
      'Standard system (55-gallon) Installation',
    ]);
    expect(served.pdf.proposal.totals).toMatchObject({ annualRecurring: 708, monthlyEquivalent: 59, oneTime: 4345, firstYearTotal: 5053 });
  });

  test('the misting "Before you book" section prints, with the owner wording', () => {
    const section = served.pdf.beforeYouBook.sections.find((candidate) => candidate.key === 'misting');
    expect(section).toEqual({
      key: 'misting',
      heading: 'If your estimate includes a misting system',
      lines: ['The date you pick is your first monthly service visit.', 'We call you to book the install day.', 'The install charge is on your first invoice.'],
    });
  });

  test('no cost, margin, knob or product-name field reaches the customer payload', () => {
    const text = JSON.stringify(served);
    for (const field of [
      'productCost', 'hardwareCost', 'refillProductCost', 'pricingKnobs', 'laborCost', 'materialCost', 'totalCost', 'costAnnual',
      'margin', 'tierPrice', 'extraNozzleCost', 'extraRiserCost', 'laborMinutesPerVisit', 'partsReservePerMonth', 'laborRate', 'installTechs',
    ]) {
      expect(text).not.toContain(`"${field}"`);
    }
    expect(text).not.toMatch(/permethrin|Sector|Mist Ultra|Riptide|Troika|botanical|pyrethrin/i);
    expect(text).not.toContain('per refill application');
  });
});

describe('GET /:token/data: refill solutions', () => {
  test.each([
    [{ solution: 'natural', refillsPerYear: 2 }, { label: 'Natural solution', perFill: 219, refillsPerYear: 2 }],
    [{ solution: 'premium', refillsPerYear: 0 }, { label: 'Premium solution', perFill: 319, refillsPerYear: 0 }],
  ])('%j', async (options, refill) => {
    const { page } = await serve({ mosquitoMisting: { ...MISTING, ...options } });
    expect(sectionOf(page.pricing, 'mosquito_misting').refill).toEqual(refill);
  });
});

describe('GET /:token/data: misting beside other services', () => {
  test('pest control + misting: two sections, the misting one keeps its single monthly cadence, both counted', async () => {
    const { page, pdf } = await serve({ pest: { frequency: 'quarterly' }, mosquitoMisting: MISTING });
    expect(page.pricing.services.map((section) => section.key)).toEqual(['pest_control', 'mosquito_misting']);
    const pest = sectionOf(page.pricing, 'pest_control');
    const misting = sectionOf(page.pricing, 'mosquito_misting');
    expect(pest.frequencies.map((frequency) => frequency.key)).toEqual(['quarterly', 'bi_monthly', 'monthly']);
    expect(misting.frequencies).toHaveLength(1);
    expect(misting.frequencies[0]).toMatchObject({ key: 'monthly', monthly: 59, perTreatment: 59, visitsPerYear: 12 });
    expect(misting.waveGuardTierEligible).toBe(false);
    expect(pest.waveGuardTierEligible).toBe(true);
    // The combined monthly is the pest plan plus the $59 plan, with no savings invented.
    const quarterlyPest = pest.frequencies[0].monthly;
    expect(page.pricing.combinedRecurring.monthlySubtotal).toBeCloseTo(quarterlyPest + 59, 2);
    expect(page.pricing.combinedRecurring).toMatchObject({ excludedBase: 59, savingsPerMonth: 0 });
    expect(lineDescriptions(pdf)).toEqual(expect.arrayContaining(['Mosquito Misting Service Plan — 12 applications/yr']));
    expect(bybKeys(pdf)).toContain('misting');
  });

  test('barrier mosquito + misting: two sections, each with its own price; the combined monthly counts both; no fake savings', async () => {
    const { page, pdf } = await serve({ mosquito: { tier: 'monthly12' }, mosquitoMisting: MISTING });
    expect(page.pricing.services.map((section) => section.key)).toEqual(['mosquito', 'mosquito_misting']);
    const barrier = sectionOf(page.pricing, 'mosquito');
    const misting = sectionOf(page.pricing, 'mosquito_misting');
    expect(barrier.waveGuardTierEligible).toBe(true);
    expect(misting.waveGuardTierEligible).toBe(false);
    expect(misting.frequencies).toHaveLength(1);
    expect(misting.refill).toEqual({ label: 'Standard solution', perFill: 129, refillsPerYear: 4 });
    expect(barrier.refill).toBeUndefined();
    const barrierMonthly = barrier.frequencies[0].monthly;
    expect(page.pricing.combinedRecurring.monthlySubtotal).toBeCloseTo(barrierMonthly + 59, 2);
    expect(page.pricing.combinedRecurring.savingsPerMonth).toBe(0);
    expect(page.pricing.frequencies[0].monthly).toBeCloseTo(barrierMonthly + 59, 2);
    const lines = lineDescriptions(pdf);
    expect(lines).toEqual(expect.arrayContaining(['Mosquito Misting Service Plan — 12 applications/yr']));
    expect(lines.filter((line) => /applications\/yr/.test(line))).toHaveLength(2);
    expect(pdf.proposal.totals.monthlyEquivalent).toBeCloseTo(barrierMonthly + 59, 2);
  });
});

describe('GET /:token/data: estimates without the misting plan are untouched', () => {
  test.each([
    ['pest control', { pest: { frequency: 'quarterly' } }, 'pest_control'],
    ['barrier mosquito', { mosquito: { tier: 'monthly12' } }, 'mosquito'],
  ])('%s: no misting section, facts, copy or Before-you-book section', async (_name, services, key) => {
    const { page, pdf } = await serve(services);
    expect(page.estimate.serviceCategory).toBe(key);
    expect(page.pricing.services.map((section) => section.key)).toEqual([key]);
    for (const section of page.pricing.services) {
      expect(section).not.toHaveProperty('refill');
      expect(section).not.toHaveProperty('system');
    }
    expect(page.pricing).not.toHaveProperty('mistingInstallFee');
    const text = JSON.stringify({ page, pdf });
    // (Bare "misting" is existing barrier-program wording; the system's own names must be absent.)
    expect(text).not.toMatch(/mosquito[ _-]misting|misting[ _-](system|service[ _-]plan)|Standard solution|Natural solution|Premium solution/i);
    expect(bybKeys(pdf)).toEqual(['scheduling', 'pest', 'lawn', 'termite', 'rodent']);
  });
});
