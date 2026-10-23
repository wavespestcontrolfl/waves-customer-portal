/**
 * Misting PR 2a follow-ups from the pre-push audit:
 *  P0: the install line carries a durable marker in invoices.line_items and prepay coverage readers exclude it;
 *  P1: a refill add-on is priced from the plan's solution through ONE helper at the booking pricing site.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const fs = require('fs');
const path = require('path');
const { generateEstimate } = require('../services/pricing-engine/estimate-engine');
const mapper = require('../services/pricing-engine/v1-legacy-mapper');
const converter = require('../services/estimate-converter');
const renewals = require('../services/annual-prepay-renewals');
const misting = require('../utils/mosquito-misting-system');
const refillPricing = require('../services/misting-refill-pricing');
const constants = require('../services/pricing-engine/constants');
const { applyMosquitoMistingPricingConfig, defaultMosquitoMistingPricingData } = require('../services/pricing-engine/mosquito-misting-config');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const PROPERTY = { homeSqFt: 2200, stories: 1, lotSqFt: 12000, propertyType: 'single_family' };
const INSTALL = 3795 + 5 * 75 + 2 * 45;
const saved = process.env.GATE_MOSQUITO_MISTING;
beforeEach(() => { process.env.GATE_MOSQUITO_MISTING = 'true'; });
afterEach(() => {
  if (saved === undefined) delete process.env.GATE_MOSQUITO_MISTING; else process.env.GATE_MOSQUITO_MISTING = saved;
});

const estimateData = (misting_ = { tier: 'essential', nozzles: 40, risers: 12, solution: 'natural' }, extra = {}) => {
  const input = { ...PROPERTY, services: { ...extra, mosquitoMisting: misting_ } };
  return { result: mapper.mapV1ToLegacyShape(generateEstimate(input)), engineInputs: input };
};

describe('P0: the install line has a durable identity and prepay coverage excludes it', () => {
  test('the line carries kind and service next to description, quantity and unit_price', () => {
    const line = misting.mistingInstallLine({ description: 'Essential system (drum) Installation', amount: INSTALL });
    expect(line).toEqual({
      description: 'Essential system (drum) Installation', quantity: 1, unit_price: INSTALL,
      kind: 'misting_installation', service: 'mosquito_misting_installation',
    });
    expect(misting.isMistingInstallLine(line)).toBe(true);
    expect(misting.isMistingInstallLine({ description: 'Bait Station Setup', quantity: 1, unit_price: 99 })).toBe(false);
    expect(misting.mistingInstallLinesTotal([line, { description: 'x', quantity: 2, unit_price: 10 }])).toBe(INSTALL);
    expect(misting.mistingInstallLinesTotal(JSON.stringify([line]))).toBe(INSTALL);
    expect(misting.mistingInstallLinesTotal('not json')).toBe(0);
    expect(misting.mistingInstallLinesTotal(null)).toBe(0);
  });

  test('every invoice the install enters builds the line through the marker helper, and create() keeps unknown line keys', () => {
    const conv = read('services/estimate-converter.js');
    expect(conv).toContain("mistingInstallLine({ description: mistingInstall.description, amount: mistingInstall.amount })");
    expect((conv.match(/mistingInstallLine\(\{ description: mistingInstall\.description/g) || [])).toHaveLength(2); // prepay + standard
    expect(read('routes/estimate-public.js')).toContain(".mistingInstallLine({ description: acceptedMistingInstall.description, amount: acceptedMistingInstallAmount })");
    // the invoice writer spreads the whole line (no field whitelist), so kind and service reach line_items
    expect(read('services/invoice.js')).toMatch(/const items = \(lineItems \|\| \[\]\)\.map\(\(item\) => \{[\s\S]{0,200}return \{\s*\.\.\.item,/);
  });

  test('the term coverage basis leaves the install out, like the setup line', () => {
    const conv = read('services/estimate-converter.js');
    expect(conv).toContain('- (prepayRodentSetupAmount + annualPlanSetupFeeAmount + (mistingInstall ? mistingInstall.amount : 0))');
  });

  function fakeConn({ subtotal, lines, claimAmount = null }) {
    return (table) => ({
      where: () => ({
        first: async () => {
          if (table === 'invoices') return { subtotal, total: subtotal, line_items: lines };
          if (table === 'setup_fee_claims') return claimAmount == null ? undefined : { amount: claimAmount };
          return undefined;
        },
      }),
    });
  }
  const term = { prepay_invoice_id: 'inv-1' };

  test('seededVisitPriceForTerm: a misting+pest prepay invoice gap-fills at the plain per-application price (no install share)', async () => {
    const data = estimateData(undefined, { pest: { frequency: 'quarterly' } });
    const install = converter.frozenMistingInstall(data);
    const planAnnual = 708;
    const pestAnnual = 480;
    const lines = [
      { description: 'Annual prepay — Pest Control + Mosquito Misting', quantity: 1, unit_price: planAnnual + pestAnnual },
      misting.mistingInstallLine({ description: install.description, amount: install.amount }),
    ];
    const subtotal = planAnnual + pestAnnual + install.amount;
    const price = await renewals.seededVisitPriceForTerm(term, fakeConn({ subtotal, lines }), 16);
    expect(price).toBe(Math.round(((planAnnual + pestAnnual) / 16) * 100) / 100);
    // without the marker the install share would leak into every visit
    const leaked = await renewals.seededVisitPriceForTerm(term, fakeConn({ subtotal, lines: lines.map(({ kind, service, ...rest }) => rest) }), 16);
    expect(leaked).toBeGreaterThan(price);
  });

  test('seededVisitPriceForTerm: misting-only prepay reads $59 per application; the stored line_items may be a JSON string', async () => {
    const lines = JSON.stringify([
      { description: 'Annual prepay — Mosquito Misting Service Plan', quantity: 1, unit_price: 708 },
      misting.mistingInstallLine({ description: 'Essential system (drum) Installation', amount: INSTALL }),
    ]);
    expect(await renewals.seededVisitPriceForTerm(term, fakeConn({ subtotal: 708 + INSTALL, lines }), 12)).toBe(59);
  });

  test('seededVisitPriceForTerm: the setup subtraction still works beside the install; a setup claim ledger row wins as before', async () => {
    const lines = [
      { description: 'Annual prepay', quantity: 1, unit_price: 1200 },
      { description: 'WaveGuard Membership — one-time setup fee', quantity: 1, unit_price: 99 },
      misting.mistingInstallLine({ description: 'Essential system (drum) Installation', amount: INSTALL }),
    ];
    const subtotal = 1200 + 99 + INSTALL;
    expect(await renewals.seededVisitPriceForTerm(term, fakeConn({ subtotal, lines }), 12)).toBe(100);
    expect(await renewals.seededVisitPriceForTerm(term, fakeConn({ subtotal, lines, claimAmount: 99 }), 12)).toBe(100);
  });

  test('seededVisitPriceForTerm: a non-misting prepay invoice is byte-identical (subtotal, or subtotal minus the setup line)', async () => {
    const plain = [{ description: 'Annual prepay — Pest Control', quantity: 1, unit_price: 480 }];
    expect(await renewals.seededVisitPriceForTerm(term, fakeConn({ subtotal: 480, lines: plain }), 4)).toBe(120);
    const withSetup = [...plain, { description: 'Bait Station Setup — one-time setup fee', quantity: 1, unit_price: 150 }];
    expect(await renewals.seededVisitPriceForTerm(term, fakeConn({ subtotal: 630, lines: withSetup }), 4)).toBe(120);
    expect(await renewals.seededVisitPriceForTerm({}, fakeConn({ subtotal: 480, lines: plain }), 4)).toBeNull();
    expect(await renewals.seededVisitPriceForTerm(term, fakeConn({ subtotal: 480, lines: plain }), 0)).toBeNull();
  });
});

describe('P1: a refill add-on takes the plan solution price through one helper', () => {
  afterEach(() => { applyMosquitoMistingPricingConfig(null, constants.MOSQUITO_MISTING); });

  test('the solution is read from a mapped row, from a raw engine line, and from the chosen input; unknown reads standard', () => {
    for (const solution of ['standard', 'natural', 'premium']) {
      const data = estimateData({ tier: 'essential', nozzles: 40, risers: 12, solution });
      expect(refillPricing.mistingRefillSolutionFromEstimateData(data)).toBe(solution);
      expect(refillPricing.mistingRefillSolutionFromEstimateData(JSON.stringify(data))).toBe(solution);
    }
    const mappedOnly = { result: { recurring: { services: [{ service: 'mosquito_misting', pricingKnobs: { refillSolution: 'premium' } }] } } };
    expect(refillPricing.mistingRefillSolutionFromEstimateData(mappedOnly)).toBe('premium');
    const rawLine = { engineResult: { lineItems: [{ service: 'mosquito_misting', refill: { solution: 'natural' } }] } };
    expect(refillPricing.mistingRefillSolutionFromEstimateData(rawLine)).toBe('natural');
    const inputOnly = { engineInputs: { services: { mosquitoMisting: { solution: 'premium' } } } };
    expect(refillPricing.mistingRefillSolutionFromEstimateData(inputOnly)).toBe('premium');
    expect(refillPricing.mistingRefillSolutionFromEstimateData({ result: { recurring: { services: [{ service: 'mosquito_misting', solution: 'bleach' }] } } })).toBe('standard');
    expect(refillPricing.mistingRefillSolutionFromEstimateData(null)).toBe('standard');
    expect(refillPricing.mistingRefillSolutionFromEstimateData({ result: {} })).toBe('standard');
  });

  const dbReturning = (estimates) => {
    const database = jest.fn((table) => {
      const q = {
        where: (cond) => { q.cond = cond; return q; },
        orderBy: () => q,
        limit: () => q,
        first: async () => estimates.find((e) => String(e.id) === String(q.cond.id)),
        select: async () => estimates.filter((e) => String(e.customer_id) === String(q.cond.customer_id)),
      };
      return table === 'estimates' ? q : q;
    });
    return database;
  };

  test('mistingRefillSolutionForVisit: source_estimate_id first, else the customer newest misting estimate, else standard', async () => {
    const natural = estimateData({ tier: 'essential', nozzles: 40, risers: 12, solution: 'natural' });
    const premium = estimateData({ tier: 'essential', nozzles: 40, risers: 12, solution: 'premium' });
    const database = dbReturning([
      { id: 11, customer_id: 'c1', estimate_data: JSON.stringify(natural) },
      { id: 12, customer_id: 'c2', estimate_data: premium },
      { id: 13, customer_id: 'c3', estimate_data: { result: {} } },
    ]);
    expect(await refillPricing.mistingRefillSolutionForVisit({ source_estimate_id: 11 }, database)).toBe('natural');
    expect(await refillPricing.mistingRefillSolutionForVisit({ source_estimate_id: 12 }, database)).toBe('premium');
    expect(await refillPricing.mistingRefillSolutionForVisit({ customer_id: 'c2' }, database)).toBe('premium');
    expect(await refillPricing.mistingRefillSolutionForVisit({ customer_id: 'c3' }, database)).toBe('standard');
    expect(await refillPricing.mistingRefillSolutionForVisit({}, database)).toBe('standard');
    expect(await refillPricing.mistingRefillSolutionForVisit(null, database)).toBe('standard');
    const broken = jest.fn(() => { throw new Error('db down'); });
    expect(await refillPricing.mistingRefillSolutionForVisit({ source_estimate_id: 11 }, broken)).toBe('standard');
  });

  test('resolveAddonUnitPrice: natural 219 / premium 319 / standard 129 for a refill at the catalog price or no price; typed prices stay', async () => {
    const mk = (solution) => dbReturning([{ id: 1, customer_id: 'c1', estimate_data: estimateData({ tier: 'essential', nozzles: 40, risers: 12, solution }) }]);
    const refill = (price) => ({ serviceKey: 'mosquito_misting_refill', price, catalogBasePrice: 129 });
    expect(await refillPricing.resolveAddonUnitPrice(refill(129), { source_estimate_id: 1 }, mk('natural'))).toBe(219);
    expect(await refillPricing.resolveAddonUnitPrice(refill(null), { source_estimate_id: 1 }, mk('premium'))).toBe(319);
    expect(await refillPricing.resolveAddonUnitPrice(refill(129), { source_estimate_id: 1 }, mk('standard'))).toBe(129);
    expect(await refillPricing.resolveAddonUnitPrice(refill(150), { source_estimate_id: 1 }, mk('premium'))).toBe(150);
  });

  test('resolveAddonUnitPrice follows a pricing_config edit', async () => {
    const database = dbReturning([{ id: 1, customer_id: 'c1', estimate_data: estimateData({ tier: 'essential', nozzles: 40, risers: 12, solution: 'premium' }) }]);
    const row = defaultMosquitoMistingPricingData();
    row.refills.premium.price = 349;
    expect(applyMosquitoMistingPricingConfig(row, constants.MOSQUITO_MISTING).applied).toBe(true);
    expect(await refillPricing.resolveAddonUnitPrice({ serviceKey: 'mosquito_misting_refill', price: 129, catalogBasePrice: 129 }, { source_estimate_id: 1 }, database)).toBe(349);
  });

  test('a non-misting add-on is returned exactly as given (and never touches the database)', async () => {
    const database = jest.fn(() => { throw new Error('must not be called'); });
    for (const price of [null, 0, 45, 129, '129.00']) {
      expect(await refillPricing.resolveAddonUnitPrice({ serviceKey: 'mosquito_one_time', price, catalogBasePrice: 129 }, { source_estimate_id: 1 }, database)).toBe(price);
    }
    expect(await refillPricing.resolveAddonUnitPrice({ price: 45 }, null, database)).toBe(45);
    expect(await refillPricing.resolveAddonUnitPrice(null, null, database)).toBeNull();
  });

  test('the add-on pricing site in admin-schedule goes through the helper, with the booking link passed in', () => {
    const src = read('routes/admin-schedule.js');
    expect(src).toContain("const { resolveAddonUnitPrice } = require('../services/misting-refill-pricing');");
    expect(src).toContain("if (addonService?.service_key === 'mosquito_misting_refill') {");
    expect(src).toContain('base = await resolveAddonUnitPrice({ serviceKey: addonService.service_key, price: base, catalogBasePrice: addonService.base_price }');
    expect(src).toContain('parentVisit: { source_estimate_id: linkedEstimateId, customer_id: customer?.id },');
    // the add-on reads of stored rows (restack, rebase, copy to child visits) keep the price the booking resolved
    expect((src.match(/resolveAddonUnitPrice\(/g) || [])).toHaveLength(1);
  });
});
