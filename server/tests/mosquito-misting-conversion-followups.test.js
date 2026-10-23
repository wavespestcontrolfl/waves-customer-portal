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
    const database = jest.fn(() => {
      const q = {
        cond: {},
        where(cond) { q.cond = { ...q.cond, ...cond }; return q; },
        orderBy() { return q; },
        limit() { return q; },
        first: async () => estimates.find((e) => String(e.id) === String(q.cond.id)),
        select: async () => estimates
          .filter((e) => Object.entries(q.cond).every(([k, v]) => e[k] === undefined || String(e[k]) === String(v)))
          // newest accepted first, as the real query orders (accepted_at desc, id desc)
          .sort((x, y) => String(y.accepted_at || '').localeCompare(String(x.accepted_at || '')) || Number(y.id) - Number(x.id)),
      };
      return q;
    });
    return database;
  };

  test('mistingRefillSolutionForVisit: source_estimate_id first (unchanged); an unreadable lookup leaves the price to staff (null)', async () => {
    const natural = estimateData({ tier: 'essential', nozzles: 40, risers: 12, solution: 'natural' });
    const premium = estimateData({ tier: 'essential', nozzles: 40, risers: 12, solution: 'premium' });
    const database = dbReturning([
      { id: 11, customer_id: 'c1', status: 'draft', estimate_data: JSON.stringify(natural) },
      { id: 12, customer_id: 'c2', status: 'declined', estimate_data: premium },
    ]);
    // the explicit link is trusted whatever the estimate status is
    expect(await refillPricing.mistingRefillSolutionForVisit({ source_estimate_id: 11 }, database)).toBe('natural');
    expect(await refillPricing.mistingRefillSolutionForVisit({ source_estimate_id: 12 }, database)).toBe('premium');
    expect(await refillPricing.mistingRefillSolutionForVisit({}, database)).toBeNull();
    expect(await refillPricing.mistingRefillSolutionForVisit(null, database)).toBeNull();
    const broken = jest.fn(() => { throw new Error('db down'); });
    expect(await refillPricing.mistingRefillSolutionForVisit({ source_estimate_id: 11 }, broken)).toBeNull();
    expect(await refillPricing.mistingRefillSolutionForVisit({ customer_id: 'c1' }, broken)).toBeNull();
  });

  test('no source link: the ACCEPTED plan decides, not the newest quote (accepted Natural + a newer draft Standard -> Natural / 219)', async () => {
    const natural = estimateData({ tier: 'essential', nozzles: 40, risers: 12, solution: 'natural' });
    const standard = estimateData({ tier: 'essential', nozzles: 40, risers: 12, solution: 'standard' });
    const database = dbReturning([
      { id: 20, customer_id: 'c1', status: 'accepted', accepted_at: '2027-01-05', property_id: 'p1', estimate_data: natural },
      { id: 21, customer_id: 'c1', status: 'draft', accepted_at: null, property_id: 'p1', estimate_data: standard },
      { id: 22, customer_id: 'c1', status: 'sent', accepted_at: null, property_id: 'p1', estimate_data: standard },
    ]);
    expect(await refillPricing.mistingRefillSolutionForVisit({ customer_id: 'c1' }, database)).toBe('natural');
    expect(await refillPricing.resolveAddonUnitPrice({ serviceKey: 'mosquito_misting_refill', price: 129, catalogBasePrice: 129 }, { customer_id: 'c1' }, database)).toBe(219);
  });

  test('declined / unaccepted quotes only: nothing is established (null) and the price is left untouched', async () => {
    const standard = estimateData({ tier: 'essential', nozzles: 40, risers: 12, solution: 'premium' });
    const database = dbReturning([
      { id: 30, customer_id: 'c1', status: 'declined', estimate_data: standard },
      { id: 31, customer_id: 'c1', status: 'expired', estimate_data: standard },
      { id: 32, customer_id: 'c1', status: 'draft', estimate_data: standard },
    ]);
    expect(await refillPricing.mistingRefillSolutionForVisit({ customer_id: 'c1' }, database)).toBeNull();
    const refill = (price) => ({ serviceKey: 'mosquito_misting_refill', price, catalogBasePrice: 129 });
    expect(await refillPricing.resolveAddonUnitPrice(refill(129), { customer_id: 'c1' }, database)).toBe(129);
    expect(await refillPricing.resolveAddonUnitPrice(refill(null), { customer_id: 'c1' }, database)).toBeNull();
    // an accepted estimate with no misting plan establishes nothing either
    const pest = { result: mapper.mapV1ToLegacyShape(generateEstimate({ ...PROPERTY, services: { pest: { frequency: 'quarterly' } } })) };
    const noMisting = dbReturning([{ id: 33, customer_id: 'c1', status: 'accepted', estimate_data: pest }]);
    expect(await refillPricing.mistingRefillSolutionForVisit({ customer_id: 'c1' }, noMisting)).toBeNull();
  });

  test('two properties: the visit property decides (an accepted quote for another property never prices this visit)', async () => {
    const natural = estimateData({ tier: 'essential', nozzles: 40, risers: 12, solution: 'natural' });
    const premium = estimateData({ tier: 'essential', nozzles: 40, risers: 12, solution: 'premium' });
    const database = dbReturning([
      { id: 40, customer_id: 'c1', status: 'accepted', accepted_at: '2027-01-05', property_id: 'home', estimate_data: natural },
      { id: 41, customer_id: 'c1', status: 'accepted', accepted_at: '2027-02-05', property_id: 'rental', estimate_data: premium },
    ]);
    expect(await refillPricing.mistingRefillSolutionForVisit({ customer_id: 'c1', property_id: 'home' }, database)).toBe('natural');
    expect(await refillPricing.mistingRefillSolutionForVisit({ customer_id: 'c1', property_id: 'rental' }, database)).toBe('premium');
    // a property with no accepted misting plan establishes nothing
    expect(await refillPricing.mistingRefillSolutionForVisit({ customer_id: 'c1', property_id: 'cabin' }, database)).toBeNull();
    // no property on the visit: the newest accepted plan
    expect(await refillPricing.mistingRefillSolutionForVisit({ customer_id: 'c1' }, database)).toBe('premium');
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
    expect(src).toContain('parentVisit: { source_estimate_id: linkedEstimateId, customer_id: customer?.id, property_id: bookingProperty?.property_id || null },');
    // the visit edit passes the visit's own link and property (only the columns that exist)
    expect(src).toContain("first(...['source_estimate_id', 'customer_id', 'property_id'].filter((column) => cols[column]))");
    // the add-on reads of stored rows (restack, rebase, copy to child visits) keep the price the booking resolved
    expect((src.match(/resolveAddonUnitPrice\(/g) || [])).toHaveLength(2);
  });
});

describe('P0 (audit 3): invoice-mode acceptance bills the marked install line', () => {
  // estimate-public pulls a very large module graph; load the pure draft builder lazily with the db mocked above.
  const { buildEstimateInvoiceModeDraft } = require('../routes/estimate-public');
  const base = {
    estimate: { id: 77, monthly_total: 59 },
    recurringSvcList: [{ name: 'Mosquito Misting Service Plan' }],
    recurringFirstVisitAmount: 59,
    effectiveBillingCadence: { frequencyLabel: 'Monthly' },
    selectedFrequency: { label: 'Monthly' },
  };

  test('an install adds one marked line beside the first application and its amount to the total and title', () => {
    const install = { amount: INSTALL, description: 'Essential system (drum) Installation' };
    const draft = buildEstimateInvoiceModeDraft({ ...base, mistingInstall: install });
    const lines = draft.lineItems;
    expect(lines).toHaveLength(2);
    expect(lines[1]).toEqual(misting.mistingInstallLine({ description: install.description, amount: INSTALL }));
    expect(misting.mistingInstallLinesTotal(lines)).toBe(INSTALL);
    expect(draft.amount).toBe(Math.round((59 + INSTALL) * 100) / 100);
    expect(draft.title).toContain('misting system installation');
  });

  test('no misting: byte-identical to before (no extra line, same amount and title)', () => {
    const plain = buildEstimateInvoiceModeDraft({ ...base });
    const withNull = buildEstimateInvoiceModeDraft({ ...base, mistingInstall: null });
    expect(withNull).toEqual(plain);
    expect(plain.lineItems).toHaveLength(1);
    expect(plain.amount).toBe(59);
    expect(plain.title).not.toContain('installation');
  });

  test('the rodent setup line and the install line can coexist; a one-time acceptance never carries the install', () => {
    const draft = buildEstimateInvoiceModeDraft({ ...base, rodentSetupAmount: 150, mistingInstall: { amount: INSTALL, description: 'X Installation' } });
    expect(draft.lineItems).toHaveLength(3);
    expect(draft.amount).toBe(Math.round((59 + 150 + INSTALL) * 100) / 100);
    const oneTime = buildEstimateInvoiceModeDraft({
      estimate: { id: 78 }, treatAsOneTime: true, effectiveOneTimeTotal: 200, oneTimeList: [], mistingInstall: { amount: INSTALL, description: 'X' },
    });
    expect(oneTime.lineItems.some(misting.isMistingInstallLine)).toBe(false);
  });

  test('the accept handler passes the frozen install into the draft (not for a one-time acceptance)', () => {
    const src = read('routes/estimate-public.js');
    expect(src).toContain("mistingInstall: treatAsOneTime\n            ? null\n            : require('../services/estimate-converter').frozenMistingInstall(acceptedEstDataForPricing),");
  });
});

describe('P1 (audit 3): a refill newly added on a visit edit takes the plan solution price', () => {
  const adminSchedule = require('../routes/admin-schedule');
  const natural = estimateData({ tier: 'essential', nozzles: 40, risers: 12, solution: 'natural' });

  function editDb({ addonRows = [] } = {}) {
    const tables = {
      services: [
        { id: 'svc-refill', service_key: 'mosquito_misting_refill', category: 'mosquito', name: 'Mosquito Misting Refill', base_price: 129, is_active: true },
        { id: 'svc-other', service_key: 'mosquito_one_time', category: 'mosquito', name: 'Mosquito One Time', base_price: 129, is_active: true },
      ],
      scheduled_services: [{ id: 'visit-1', customer_id: 'c1', source_estimate_id: 5 }],
      scheduled_service_addons: addonRows,
      estimates: [{ id: 5, customer_id: 'c1', estimate_data: natural }],
    };
    const database = (table) => {
      const conds = [];
      let inCol = null;
      const rows = () => (tables[table] || []).filter((r) => conds.every((c) => Object.entries(c).every(([k, v]) => r[k] === undefined || r[k] === v))
        && (!inCol || inCol.values.includes(r[inCol.col])));
      const q = {
        where(c) { conds.push(c); return q; },
        whereIn(col, values) { inCol = { col, values }; return q; },
        orderBy() { return q; },
        limit() { return q; },
        select: async () => rows().map((r) => ({ ...r })),
        first: async () => { const hit = rows()[0]; return hit ? { ...hit } : undefined; },
        columnInfo: async () => ({}),
      };
      return q;
    };
    return database;
  }
  const run = (addons, addonRows) => adminSchedule.normalizeUpdateDetailsAddons({
    db: editDb({ addonRows }), id: 'visit-1', addons, updates: {}, isRecurring: false, serviceType: 'Mosquito Misting Service Plan', scheduledDate: '2027-03-10',
  });

  test('a NEW refill line posted at the catalog Standard price is repriced to the Natural plan price (219)', async () => {
    const out = await run([{ serviceId: 'svc-refill', serviceName: 'Mosquito Misting Refill', basePrice: 129 }], []);
    expect(out.normalizedAddons).toHaveLength(1);
    expect(out.normalizedAddons[0]).toMatchObject({ serviceKey: 'mosquito_misting_refill', base: 219, price: 219 });
  });

  test('a refill that already exists on the visit keeps its stored (override) price', async () => {
    const out = await run(
      [{ id: 'row-1', serviceId: 'svc-refill', serviceName: 'Mosquito Misting Refill', basePrice: 150 }],
      [{ id: 'row-1', scheduled_service_id: 'visit-1', service_id: 'svc-refill', base_price: 150, estimated_price: 150 }],
    );
    expect(out.normalizedAddons[0]).toMatchObject({ base: 150, price: 150 });
  });

  test('a new refill whose price staff changed from the catalog price keeps that price', async () => {
    const out = await run([{ serviceId: 'svc-refill', serviceName: 'Mosquito Misting Refill', basePrice: 175 }], []);
    expect(out.normalizedAddons[0]).toMatchObject({ base: 175, price: 175 });
  });

  test('a non-misting add-on is unchanged', async () => {
    const out = await run([{ serviceId: 'svc-other', serviceName: 'Mosquito One Time', basePrice: 129 }], []);
    expect(out.normalizedAddons[0]).toMatchObject({ serviceKey: 'mosquito_one_time', base: 129, price: 129 });
  });

  test('both add-on pricing sites go through the one helper', () => {
    const src = read('routes/admin-schedule.js');
    expect(src).toContain("gross = await resolveAddonUnitPrice({ serviceKey: catalogService.service_key, price: gross, catalogBasePrice: catalogService.base_price }, visitPricingLink || {}, db);");
    expect(src).toContain("if (catalogService?.service_key === 'mosquito_misting_refill' && !(a.id && existingAddonDiscountById.has(a.id))) {");
    expect((src.match(/resolveAddonUnitPrice\(/g) || [])).toHaveLength(2);
  });
});

describe('audit 4: engine-origin install, one prepay total helper, install bell eligibility', () => {
  const engineOnly = (opts = { tier: 'essential', nozzles: 40, risers: 12, solution: 'natural' }) => {
    const input = { ...PROPERTY, services: { mosquitoMisting: opts } };
    return { engineResult: generateEstimate(input), engineInputs: input };
  };

  test('frozenMistingInstall: mapped item, raw engine line (engineResult.lineItems), and an itemized proposal line all resolve; same shape', () => {
    const mapped = converter.frozenMistingInstall(estimateData());
    expect(mapped).toEqual({ amount: INSTALL, description: 'Essential system (drum) Installation' });
    const raw = converter.frozenMistingInstall(engineOnly());
    expect(raw).toEqual({ amount: INSTALL, description: 'Essential system (drum) Installation' });
    expect(converter.frozenMistingInstall(JSON.stringify(engineOnly()))).toEqual(raw);
    const proposal = converter.frozenMistingInstall({
      proposal: {
        enabled: true,
        buildings: [{ lineItems: [
          { service: 'mosquito_misting', description: 'Mosquito Misting Service Plan', unitPrice: 59, quantity: 1, amount: 59 },
          { service: 'mosquito_misting_installation', description: 'Smart system Installation', unitPrice: 5200, quantity: 1, amount: 5200 },
        ] }],
      },
      result: estimateData().result,
    });
    expect(proposal).toEqual({ amount: 5200, description: 'Smart system Installation' });
  });

  test('frozenMistingInstall: an unpriced / oversize raw line, a quote-required item and an unpriced proposal install bill nothing', () => {
    expect(converter.frozenMistingInstall(engineOnly({ nozzles: 120 }))).toBeNull();
    const rawLine = engineOnly().engineResult.lineItems.find((l) => l.service === 'mosquito_misting');
    const quoteRequired = { engineResult: { lineItems: [{ ...rawLine, quoteRequired: true }] } };
    expect(converter.frozenMistingInstall(quoteRequired)).toBeNull();
    const zeroInstall = { engineResult: { lineItems: [{ ...rawLine, installation: { price: 0 } }] } };
    expect(converter.frozenMistingInstall(zeroInstall)).toBeNull();
    expect(converter.frozenMistingInstall({ proposal: { enabled: true, buildings: [{ lineItems: [{ service: 'mosquito_misting_installation', description: 'X', unitPrice: 0, quantity: 1, amount: 0 }] }] } })).toBeNull();
    expect(converter.frozenMistingInstall({ engineResult: { lineItems: [{ service: 'pest_control' }] } })).toBeNull();
    expect(converter.frozenMistingInstall(null)).toBeNull();
  });

  test('an engine-origin estimate carries its install through the acceptance invoice builders', () => {
    const data = engineOnly();
    const install = converter.frozenMistingInstall(data);
    const { buildEstimateInvoiceModeDraft } = require('../routes/estimate-public');
    const draft = buildEstimateInvoiceModeDraft({
      estimate: { id: 90, monthly_total: 59 }, recurringSvcList: [{ name: 'Mosquito Misting Service Plan' }], recurringFirstVisitAmount: 59,
      effectiveBillingCadence: { frequencyLabel: 'Monthly' }, selectedFrequency: { label: 'Monthly' }, mistingInstall: install,
    });
    expect(draft.lineItems.some(misting.isMistingInstallLine)).toBe(true);
    expect(draft.amount).toBe(Math.round((59 + INSTALL) * 100) / 100);
    expect(converter.frozenPrepayOneTimeLines(data)).toEqual({ rodentSetup: 0, mistingInstall: INSTALL, mistingInstallDescription: 'Essential system (drum) Installation', total: INSTALL });
  });

  test('frozenPrepayOneTimeLines: misting + pest prepay quote total equals the minted invoice total; no misting is unchanged', () => {
    const data = estimateData(undefined, { pest: { frequency: 'quarterly' } });
    const recurring = data.result.recurring.services;
    const baseAnnual = recurring.reduce((sum, row) => sum + (Number(row.annual) || 0), 0);
    const resolved = converter.resolveAnnualPrepayInvoiceTotal({ baseAnnual, recurringServices: recurring, estimateData: data });
    const lines = converter.frozenPrepayOneTimeLines(data);
    const quote = Math.round((resolved.amount + lines.total) * 100) / 100;
    // the minted invoice: prepay line + marked install line (residential, untaxed)
    const install = converter.frozenMistingInstall(data);
    const invoiceTotal = Math.round((resolved.amount + misting.mistingInstallLinesTotal([misting.mistingInstallLine({ description: install.description, amount: install.amount })])) * 100) / 100;
    expect(quote).toBe(invoiceTotal);
    expect(lines.mistingInstall).toBe(INSTALL);
    const plain = estimateData(undefined, { pest: { frequency: 'quarterly' } });
    const noMisting = { result: mapper.mapV1ToLegacyShape(generateEstimate({ ...PROPERTY, services: { pest: { frequency: 'quarterly' } } })) };
    expect(converter.frozenPrepayOneTimeLines(noMisting)).toEqual({ rodentSetup: 0, mistingInstall: 0, mistingInstallDescription: null, total: 0 });
    expect(plain.result).toBeDefined();
  });

  test('both prepay totals (the accept quote and the operator preview) build from the one helper', () => {
    expect(read('routes/estimate-public.js')).toContain('const acknowledgedOneTime = converter.frozenPrepayOneTimeLines(estData);');
    expect(read('routes/estimate-public.js')).toContain('(resolved.amount + acknowledgedOneTime.total)');
    expect(read('services/estimate-manual-acceptance.js')).toContain('EstimateConverter.frozenPrepayOneTimeLines(data)');
  });

  test('install bell eligibility is an explicit caller flag: public standard and prepay accepts and a manual prepay accept pass it; Mark Won and one-tap do not', () => {
    const conv = read('services/estimate-converter.js');
    expect(conv).toContain('opts.mistingInstallBilled === true && !suppressRecurringConversion');
    const route = read('routes/estimate-public.js');
    expect(route).toContain('mistingInstallBilled: true,');
    expect(route).toContain('mistingInstallBilled: !isCommercialAccept && !holdFirstInvoiceForSiteConfirmation,');
    const manual = read('services/estimate-manual-acceptance.js');
    expect(manual).toContain('...(ctx.annualPrepaySelected ? { mistingInstallBilled: true } : {}),');
    expect(read('services/one-tap-purchase.js')).not.toContain('mistingInstallBilled');
    // the manual-accept post-commit plan dispatches the deferred bell
    expect(read('services/estimate-accept-effects.js')).toContain("['misting_install_schedule', 'mistingInstallNotification'],");
  });

  test('annual-prepay accept: the bell payload is returned deferred; a Mark Won passes no flag so the converter raises none', async () => {
    const NotificationService = require('../services/notification-service');
    const spy = jest.spyOn(NotificationService, 'notifyAdmin').mockResolvedValue({ id: 1 });
    try {
      const database = jest.fn(() => ({ insert: async () => [1] }));
      const fx = { run: jest.fn((meta, fn) => fn()) };
      const out = await converter.raiseMistingInstallBell(database, fx, { deferCommercialScheduleNotification: true }, {
        estimateId: 91, customerId: 'c1', customer: { first_name: 'A', last_name: 'B' }, estimateData: engineOnly(), firstPlanDate: null,
      });
      expect(out).toMatchObject({ options: { dedupeKey: 'misting_install_schedule:91', bell: true } });
      expect(out.body).toContain('before the first plan application on the first plan visit');
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
});

describe('audit 5: the customer previews carry the install line the invoices bill', () => {
  test('standard, invoice-mode and prepay previews equal the invoice builders (one helper, one amount)', () => {
    const data = estimateData(undefined, { pest: { frequency: 'quarterly' } });
    const lines = converter.frozenPrepayOneTimeLines(data);
    const { buildEstimateInvoiceModeDraft } = require('../routes/estimate-public');
    const firstApplication = 59;
    // standard: the invoice the accept mints = install + first application
    const standardInvoice = Math.round((lines.mistingInstall + firstApplication) * 100) / 100;
    const standardPreview = Math.round((lines.total + firstApplication) * 100) / 100;
    expect(standardPreview).toBe(standardInvoice);
    // invoice-mode: the draft bills the same install
    const install = converter.frozenMistingInstall(data);
    const draft = buildEstimateInvoiceModeDraft({
      estimate: { id: 5, monthly_total: 59 }, recurringSvcList: [{ name: 'Mosquito Misting Service Plan' }], recurringFirstVisitAmount: firstApplication,
      effectiveBillingCadence: { frequencyLabel: 'Monthly' }, selectedFrequency: { label: 'Monthly' }, mistingInstall: install,
    });
    expect(draft.amount).toBe(standardPreview);
    // prepay: the quote adds the same amount to the coverage total, as the minted invoice does
    const recurring = data.result.recurring.services;
    const baseAnnual = recurring.reduce((sum, row) => sum + (Number(row.annual) || 0), 0);
    const resolved = converter.resolveAnnualPrepayInvoiceTotal({ baseAnnual, recurringServices: recurring, estimateData: data });
    expect(Math.round((resolved.amount + lines.total) * 100) / 100).toBe(Math.round((resolved.amount + install.amount) * 100) / 100);
    expect(lines.mistingInstallDescription).toBe(install.description);
  });

  test('the payload field is built from the helper, labeled by the tier, and omitted when there is no install', () => {
    const src = read('routes/estimate-public.js');
    expect(src).toContain('const previewOneTimeLines = require(\'../services/estimate-converter\').frozenPrepayOneTimeLines(estData);');
    expect(src).toContain("const mistingInstallFeeField = previewOneTimeLines.mistingInstall > 0");
    expect(src).toContain("service: 'mosquito_misting_installation',\n        amount: previewOneTimeLines.mistingInstall,");
    expect(src).toContain("label: previewOneTimeLines.mistingInstallDescription || 'Mosquito Misting System Installation',");
    expect((src.match(/\.\.\.mistingInstallFeeField,/g) || [])).toHaveLength(4); // the three fresh bundle shapes + the snapshot return path
    // no misting: the helper reports zero, the conditional yields {} and the payload is unchanged
    const none = { result: mapper.mapV1ToLegacyShape(generateEstimate({ ...PROPERTY, services: { pest: { frequency: 'quarterly' } } })) };
    expect(converter.frozenPrepayOneTimeLines(none).mistingInstall).toBe(0);
  });

  test('the due-today cards, the legacy prepay total and the prepay refresh attribute all carry the install', () => {
    const src = read('routes/estimate-public.js');
    expect(src).toContain('const dueTodayOneTimeLines = !locked');
    expect(src).toContain('const standardSetupDue = Math.round((setupDueToday + rodentSetupDueToday + mistingInstallDueToday) * 100) / 100;');
    expect(src).toContain('Math.round((Math.max(0, prepayResolved.amount) + rodentSetupDueToday + mistingInstallDueToday) * 100) / 100');
    expect(src).toContain('Math.round((annualTotal + rodentSetupDueToday + mistingInstallDueToday) * 100) / 100');
    expect(src).toContain('data-prepay-setup-due="${Math.round((Number(rodentSetupDueToday) + Number(mistingInstallDueToday)) * 100) / 100}"');
    expect(src).toContain('data-misting-install-due="${Number(mistingInstallDueToday)}"');
    // the commercial tax blend still takes only the rodent setup, as the converter does
    expect(src).toContain('taxableOneTimeAmount: rodentSetupDueToday,');
    // the install is not deferred to the first visit
    expect(src).toContain('&& !(mistingInstallDueToday > 0)');
  });

  test('the client previews the install via the same extraInvoiceRows seam and keeps it out of the after-completion extras', () => {
    const client = fs.readFileSync(path.join(__dirname, '..', '..', 'client/src/pages/EstimateViewPage.jsx'), 'utf8');
    expect(client).toContain('pricing?.mistingInstallFee?.amount');
    expect(client).toContain('isMistingInstallBreakdownRow(row)');
  });
});

describe('audit 6: a pre-change send snapshot serves the install preview too', () => {
  const { buildPricingBundle } = require('../routes/estimate-public');
  const snapshotEstimate = (id, data, { withSnapshotFee = false } = {}) => {
    const row = data.result.recurring.services.find((s) => s.service === 'mosquito_misting');
    const oneTimeItems = (data.result.oneTime && data.result.oneTime.items) || [];
    const frequency = {
      key: 'monthly', label: 'Monthly', monthly: 59, annual: 708,
      perServiceTreatments: [{ service: 'mosquito_misting', label: row ? row.name : 'Mosquito Misting Service Plan', perTreatment: 59, displayPrice: 59, visitsPerYear: 12 }],
    };
    return {
      id,
      status: 'sent',
      monthly_total: 59,
      annual_total: 708,
      onetime_total: oneTimeItems.reduce((sum, item) => sum + (Number(item.price) || 0), 0),
      waveguard_tier: 'none',
      estimate_data: {
        ...data,
        sendSnapshot: {
          pricingBundle: {
            frequencies: [frequency],
            source: 'send_snapshot',
            oneTimeBreakdown: { items: oneTimeItems.map((item) => ({ service: item.service, label: item.name, name: item.name, price: item.price, amount: item.price })), total: oneTimeItems.reduce((sum, item) => sum + (Number(item.price) || 0), 0) },
            ...(withSnapshotFee ? { mistingInstallFee: { service: 'mosquito_misting_installation', amount: INSTALL, label: 'stale', waivedWithPrepay: false } } : {}),
          },
        },
      },
    };
  };

  test('a pre-change snapshot (no mistingInstallFee key) for a misting estimate gets the field, and the payment-choice total equals the invoice', async () => {
    const data = estimateData();
    const bundle = await buildPricingBundle(snapshotEstimate('est-snap-misting-1', data));
    expect(bundle.snapshotHit).toBe(true);
    const install = converter.frozenMistingInstall(data);
    expect(bundle.mistingInstallFee).toEqual({
      service: 'mosquito_misting_installation', amount: INSTALL, label: install.description, waivedWithPrepay: false,
    });
    // the up-front rows the client previews (install + first application) equal the invoice the accept mints
    const firstApplication = 59;
    const preview = Math.round((bundle.mistingInstallFee.amount + firstApplication) * 100) / 100;
    expect(preview).toBe(Math.round((install.amount + firstApplication) * 100) / 100);
  });

  test('a snapshot that already carries the field is corrected to the frozen estimate figure', async () => {
    const data = estimateData();
    const bundle = await buildPricingBundle(snapshotEstimate('est-snap-misting-2', data, { withSnapshotFee: true }));
    expect(bundle.mistingInstallFee.label).not.toBe('stale');
    expect(bundle.mistingInstallFee.amount).toBe(INSTALL);
  });

  test('a non-misting snapshot returns no mistingInstallFee and its stored fields untouched', async () => {
    const input = { ...PROPERTY, services: { pest: { frequency: 'quarterly' } } };
    const data = { result: mapper.mapV1ToLegacyShape(generateEstimate(input)), engineInputs: input };
    const estimate = snapshotEstimate('est-snap-pest-1', data);
    estimate.estimate_data.sendSnapshot.pricingBundle.frequencies[0].perServiceTreatments = [{ service: 'pest_control', label: 'Pest Control', perTreatment: 59, displayPrice: 59, visitsPerYear: 12 }];
    const stored = JSON.parse(JSON.stringify(estimate.estimate_data.sendSnapshot.pricingBundle));
    const bundle = await buildPricingBundle(estimate);
    expect(Object.prototype.hasOwnProperty.call(bundle, 'mistingInstallFee')).toBe(false);
    if (bundle.snapshotHit) expect(bundle.frequencies[0].key).toBe(stored.frequencies[0].key);
    // the stored snapshot itself is never written back
    expect(estimate.estimate_data.sendSnapshot.pricingBundle).toEqual(stored);
  });

  test('the snapshot return path attaches the field from the same constant as the fresh path', () => {
    const src = read('routes/estimate-public.js');
    expect(src).toMatch(/\.\.\.snapshotBundle,\s*\/\/ A snapshot frozen before the misting install[\s\S]{0,260}\.\.\.mistingInstallFeeField,\s*source: snapshotBundle\.source/);
  });
});
