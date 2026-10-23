/**
 * Misting PR 2a: an accepted priced misting estimate (GATE_MOSQUITO_MISTING on) converts. The accept-pending refusal is gone while
 * the code-owned constant is true (and stays reachable through it), the plan seeds a monthly series under the catalog row, the
 * install is a named invoice line and a covered one-time install visit, protocols and the job card route by catalog key, and the
 * refill price helper reads the live table.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const fs = require('fs');
const path = require('path');
const constants = require('../services/pricing-engine/constants');
const { generateEstimate } = require('../services/pricing-engine/estimate-engine');
const mapper = require('../services/pricing-engine/v1-legacy-mapper');
const converter = require('../services/estimate-converter');
const seeder = require('../services/recurring-appointment-seeder');
const { matchServiceProtocol } = require('../services/protocol-matcher');
const protocols = require('../config/protocols.json');
const { mistingRefillPriceFor, applyMosquitoMistingPricingConfig, defaultMosquitoMistingPricingData } = require('../services/pricing-engine/mosquito-misting-config');

const PROPERTY = { homeSqFt: 2200, stories: 1, lotSqFt: 12000, propertyType: 'single_family' };
const OPTS = { tier: 'essential', nozzles: 40, risers: 12, solution: 'natural' };
const INSTALL = 3795 + 5 * 75 + 2 * 45;
const saved = process.env.GATE_MOSQUITO_MISTING;
beforeEach(() => { process.env.GATE_MOSQUITO_MISTING = 'true'; });
afterEach(() => {
  if (saved === undefined) delete process.env.GATE_MOSQUITO_MISTING; else process.env.GATE_MOSQUITO_MISTING = saved;
});

const estimateData = (services = { mosquitoMisting: OPTS }) => {
  const input = { ...PROPERTY, services };
  return { result: mapper.mapV1ToLegacyShape(generateEstimate(input)), engineInputs: input };
};
const mistingRow = (data) => data.result.recurring.services.find((s) => s.service === 'mosquito_misting');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('the switch', () => {
  test('MOSQUITO_MISTING_CONVERSION_READY is true, plain code-owned boolean', () => {
    expect(constants.MOSQUITO_MISTING_CONVERSION_READY).toBe(true);
  });

  test('gate ON + priced misting: no accept-pending refusal, for the customer or staff, and nothing is blocked', () => {
    const data = estimateData();
    expect(mapper.estimateMistingAcceptBlocked(data)).toBe(false);
    expect(mapper.gatedAddOnCustomerRefusal(data)).toBeNull();
    expect(mapper.gatedAddOnStaffRefusal(data, 'accepting')).toBeNull();
    expect(mapper.gatedAddOnStaffRefusal(data, 'sending', { allowAcceptPending: true })).toBeNull();
  });

  test('gate OFF: the existing gated refusal still wins', () => {
    const data = estimateData();
    delete process.env.GATE_MOSQUITO_MISTING;
    expect(mapper.gatedAddOnCustomerRefusal(data)).toMatchObject({ code: 'MOSQUITO_MISTING_GATED', reason: 'mosquito_misting_disabled' });
    expect(mapper.gatedAddOnStaffRefusal(data, 'accepting')).toMatchObject({ code: 'MOSQUITO_MISTING_GATED' });
  });

  test('the refusal stays reachable through the constant (not deleted)', () => {
    const data = estimateData();
    constants.MOSQUITO_MISTING_CONVERSION_READY = false;
    try {
      expect(mapper.gatedAddOnCustomerRefusal(data)).toMatchObject({ code: 'MOSQUITO_MISTING_ACCEPT_PENDING' });
    } finally { constants.MOSQUITO_MISTING_CONVERSION_READY = true; }
  });

  test('no misting on the estimate: unchanged', () => {
    const plain = { result: mapper.mapV1ToLegacyShape(generateEstimate({ ...PROPERTY, services: { pest: { frequency: 'quarterly' } } })) };
    expect(mapper.gatedAddOnCustomerRefusal(plain)).toBeNull();
  });
});

describe('the plan converts to a monthly series under the catalog row', () => {
  test('the mapped row seeds monthly (12 applications) even beside a quarterly fallback cadence, under mosquito_misting_service', () => {
    const row = mistingRow(estimateData());
    expect(row).toMatchObject({ name: 'Mosquito Misting Service Plan', visitsPerYear: 12, perTreatment: 59 });
    for (const fallback of ['monthly', 'quarterly', undefined, null]) {
      expect(converter.converterFollowUpSeedingPattern(row, { service_type: row.name }, fallback)).toBe('monthly');
    }
    expect(converter.remainingUnitCatalogKey(row)).toBe('mosquito_misting_service');
    expect(converter.seedingFamilyKey(row)).toBe('mosquito_misting');
    expect(seeder.serviceKeyFor({ service_type: 'Mosquito Misting Service Plan' })).toBe('mosquito_misting');
  });

  test('any other count or cadence keeps office scheduling (nothing seeds)', () => {
    const row = mistingRow(estimateData());
    for (const bad of [{ visitsPerYear: 4 }, { visitsPerYear: 6 }, { visitsPerYear: 9 }, { visitsPerYear: 12, visits: 4 }]) {
      expect(converter.converterFollowUpSeedingPattern({ ...row, ...bad }, { service_type: row.name }, 'monthly')).toBeNull();
    }
    expect(converter.supportsConverterFollowUpSeeding({ ...row, visitsPerYear: 4 }, { service_type: row.name }, 'quarterly')).toBe(false);
    expect(converter.supportsConverterFollowUpSeeding(row, { service_type: row.name }, 'monthly')).toBe(true);
  });

  test('the barrier mosquito program is untouched: monthly 12 and seasonal 9 seed as before, under their own catalog keys', () => {
    const barrier = { name: 'Mosquito', service: 'mosquito', visitsPerYear: 12 };
    expect(converter.converterFollowUpSeedingPattern(barrier, { service_type: 'Mosquito' }, 'monthly')).toBe('monthly');
    expect(converter.remainingUnitCatalogKey(barrier)).not.toBe('mosquito_misting_service');
    expect(converter.converterFollowUpSeedingPattern({ ...barrier, visitsPerYear: 9 }, { service_type: 'Mosquito' }, 'monthly')).toBe(seeder.SEASONAL_FEB_OCT);
  });

  test('no WaveGuard setup fee on a misting-only plan; pest + misting is a two-plan bundle (fee waived); solo pest keeps it', () => {
    const row = mistingRow(estimateData());
    expect(converter.shouldIncludeWaveGuardSetupFeeForRecurring({ recurringServices: [row], estimateData: estimateData() })).toBe(false);
    const both = estimateData({ pest: { frequency: 'quarterly' }, mosquitoMisting: OPTS });
    const rows = both.result.recurring.services;
    expect(rows.length).toBeGreaterThan(1);
    expect(converter.shouldIncludeWaveGuardSetupFeeForRecurring({ recurringServices: rows, estimateData: both })).toBe(false);
    const solo = estimateData({ pest: { frequency: 'quarterly' } });
    expect(converter.shouldIncludeWaveGuardSetupFeeForRecurring({ recurringServices: solo.result.recurring.services, estimateData: solo })).toBe(true);
  });

  test('annual prepay: the misting plan is not discounted (non-discountable), so the prepay invoice is the plain annual', () => {
    const data = estimateData();
    const row = mistingRow(data);
    const out = converter.resolveAnnualPrepayInvoiceTotal({ baseAnnual: row.annual, recurringServices: [row], estimateData: data });
    expect(out).toEqual({ amount: 708, discount: 0, rate: 0 });
  });
});

describe('the install: a named line on the acceptance invoice and a covered install visit', () => {
  test('frozenMistingInstall reads the STORED one-time row (the quote figure), named by the tier label', () => {
    const data = estimateData();
    expect(converter.frozenMistingInstall(data)).toEqual({ amount: INSTALL, description: 'Essential system (drum) Installation' });
    expect(converter.frozenMistingInstall(JSON.stringify(data))).toEqual({ amount: INSTALL, description: 'Essential system (drum) Installation' });
    // a later price edit never moves a sent quote: the figure is the stored row
    const edited = JSON.parse(JSON.stringify(data));
    edited.result.oneTime.items.find((i) => i.service === 'mosquito_misting_installation').price = 4000;
    expect(converter.frozenMistingInstall(edited).amount).toBe(4000);
  });

  test('no install: an estimate without misting, an oversize (unpriced) layout, and a zero row bill nothing', () => {
    expect(converter.frozenMistingInstall(estimateData({ pest: { frequency: 'quarterly' } }))).toBeNull();
    expect(converter.frozenMistingInstall(estimateData({ mosquitoMisting: { nozzles: 120 } }))).toBeNull();
    expect(converter.frozenMistingInstall({ result: { oneTime: { items: [{ service: 'mosquito_misting_installation', price: 0 }] } } })).toBeNull();
    expect(converter.frozenMistingInstall(null)).toBeNull();
  });

  test('the converter bills it on BOTH invoices (standard and annual prepay) and the public accept bills it on its standard invoice', () => {
    const src = read('services/estimate-converter.js');
    expect(src).toContain('const mistingInstall = frozenMistingInstall(estimateData);');
    expect(src).toMatch(/\.\.\.\(mistingInstall \? \[\{\s*description: mistingInstall\.description,\s*quantity: 1,\s*unit_price: mistingInstall\.amount,\s*\}\] : \[\]\)/);
    expect(src).toMatch(/if \(mistingInstall\) \{\s*lineItems\.push\(\{\s*description: mistingInstall\.description,/);
    const route = read('routes/estimate-public.js');
    expect(route).toContain('const acceptedMistingInstall = treatAsOneTime ? null : EstimateConverter.frozenMistingInstall(conversionEstData);');
    expect(route).toContain('acceptedRodentSetupAmount > 0 || acceptedMistingInstallAmount > 0)) {');
  });

  test('the public accept never defers an install-bearing invoice to the first visit, and a one-time selection owes no install', () => {
    const route = read('routes/estimate-public.js');
    expect(route).toContain('&& !(acceptedMistingInstallAmount > 0)\n            && require(\'../config/feature-gates\').pafSetupFeeLive()');
    expect(route).toContain('treatAsOneTime ? null : EstimateConverter.frozenMistingInstall');
  });

  function fakeDb({ withCatalog = true, existing = [], planDate = '2027-03-10' } = {}) {
    const tables = {
      services: withCatalog
        ? [{ id: 'svc-install', service_key: 'mosquito_misting_install', name: 'Mosquito Misting System Installation', default_duration_minutes: 480 },
          { id: 'svc-plan', service_key: 'mosquito_misting_service', name: 'Mosquito Misting Service Plan' }]
        : [],
      scheduled_services: [
        ...existing,
        { id: 'plan-1', customer_id: 'c1', source_estimate_id: 9, service_id: 'svc-plan', service_type: 'Mosquito Misting Service Plan', status: 'pending', scheduled_date: planDate },
        { id: 'plan-2', customer_id: 'c1', source_estimate_id: 9, service_id: 'svc-plan', service_type: 'Mosquito Misting Service Plan', status: 'pending', scheduled_date: '2027-04-10' },
      ],
      activity_log: [],
    };
    const columns = {
      scheduled_services: ['id', 'customer_id', 'scheduled_date', 'service_type', 'status', 'notes', 'source_estimate_id', 'estimated_price', 'estimated_duration_minutes', 'prepaid_amount', 'prepaid_method', 'service_id', 'source_action', 'booking_source'],
    };
    const db = (table) => {
      let filters = [];
      let notIn = null;
      const rows = () => tables[table] || [];
      const match = (r) => filters.every((f) => Object.entries(f).every(([k, v]) => r[k] === v)) && (!notIn || !notIn.values.includes(r[notIn.col]));
      const q = {
        where(c) { filters.push(c); return q; },
        whereNotIn(col, values) { notIn = { col, values }; return q; },
        first: async () => { const hit = rows().find(match); return hit ? { ...hit } : undefined; },
        select: async () => rows().filter(match).map((r) => ({ ...r })),
        columnInfo: async () => Object.fromEntries((columns[table] || []).map((c) => [c, {}])),
        insert: (row) => {
          const stored = { id: `${table}-${rows().length + 1}`, ...row };
          (tables[table] = rows()).push(stored);
          const p = Promise.resolve([1]);
          p.returning = async () => [stored];
          return p;
        },
      };
      return q;
    };
    db.tables = tables;
    return db;
  }

  test('the install visit lands on the first plan visit date as a covered one-time job under the catalog row, once per estimate', async () => {
    const db = fakeDb();
    const id = await converter.scheduleMistingInstallVisit(db, { estimateId: 9, customerId: 'c1', estimateData: estimateData() });
    const visit = db.tables.scheduled_services.find((r) => r.id === id);
    expect(visit).toMatchObject({
      customer_id: 'c1', scheduled_date: '2027-03-10', service_type: 'Mosquito Misting System Installation', status: 'pending',
      service_id: 'svc-install', source_estimate_id: 9, estimated_duration_minutes: 480,
      estimated_price: INSTALL, prepaid_amount: INSTALL, prepaid_method: 'acceptance_invoice',
      source_action: 'estimate_accept_misting_install',
    });
    expect(visit.notes).toMatch(/already on the acceptance invoice/);
    expect(db.tables.activity_log[0]).toMatchObject({ action: 'misting_install_visit_created' });
    // a retried accept never doubles it
    const again = await converter.scheduleMistingInstallVisit(db, { estimateId: 9, customerId: 'c1', estimateData: estimateData() });
    expect(again).toBe(id);
    expect(db.tables.scheduled_services.filter((r) => r.service_type === 'Mosquito Misting System Installation')).toHaveLength(1);
  });

  test('no priced install: no visit; an absent catalog row still schedules by name; no plan visit falls back to the given date', async () => {
    const none = fakeDb();
    expect(await converter.scheduleMistingInstallVisit(none, { estimateId: 9, customerId: 'c1', estimateData: estimateData({ pest: { frequency: 'quarterly' } }) })).toBeNull();
    const noCatalog = fakeDb({ withCatalog: false });
    const id = await converter.scheduleMistingInstallVisit(noCatalog, { estimateId: 9, customerId: 'c1', estimateData: estimateData(), fallbackDate: '2027-05-01' });
    const visit = noCatalog.tables.scheduled_services.find((r) => r.id === id);
    expect(visit).toMatchObject({ service_type: 'Mosquito Misting System Installation', estimated_duration_minutes: 480 });
    expect(visit).not.toHaveProperty('service_id');
    const noPlan = fakeDb();
    noPlan.tables.scheduled_services.length = 0;
    const id2 = await converter.scheduleMistingInstallVisit(noPlan, { estimateId: 9, customerId: 'c1', estimateData: estimateData(), fallbackDate: '2027-05-01' });
    expect(noPlan.tables.scheduled_services.find((r) => r.id === id2).scheduled_date).toBe('2027-05-01');
  });

  test('the converter creates it after scheduling, never on a manual Mark Won, and a failure never blocks the accept', () => {
    const src = read('services/estimate-converter.js');
    expect(src).toContain('if (!skipAutoSchedule && !suppressRecurringConversion && frozenMistingInstall(estimateData)) {');
    expect(src).toMatch(/catch \(installErr\) \{\s*logger\.error\(`\[estimate-converter\] Failed to create the misting install visit/);
  });
});

describe('protocols and the job card route by catalog key', () => {
  test.each([
    ['mosquito_misting_service', 'Mosquito Misting Service Plan', 'misting_system_service', 'Service plan visit (monthly)'],
    ['mosquito_misting_install', 'Mosquito Misting System Installation', 'misting_system_install', 'Installation (one-time)'],
    ['mosquito_misting_refill', 'Mosquito Misting System Refill', 'misting_system_refill', 'Refill (billed per refill application)'],
  ])('%s gets the misting program visit, never the barrier chemical program', (serviceKey, name, reason, visitType) => {
    const result = matchServiceProtocol(protocols, name, { serviceKey });
    expect(result).toMatchObject({ programKey: 'mosquito_misting', matched: true, reason });
    expect(result.matchedVisit.visit_type).toBe(visitType);
    expect(result.programKey).not.toBe('mosquito');
  });

  test('the program carries the install checklist and the refill steps from the wiki protocol, with no ml amounts', () => {
    const program = protocols.mosquito_misting;
    const text = JSON.stringify(program);
    expect(text).toMatch(/Call 811/);
    expect(text).toMatch(/Calibrate before enabling the schedule/);
    expect(text).toMatch(/EPA registration number/);
    expect(text).not.toMatch(/\d\s*(?:ml|cc)\b/i);
    expect(program.visits.map((v) => v.visit)).toEqual([1, 2, 3]);
  });

  test('a keyless plan phrase routes to the misting program; the barrier cycle wording and the design visit are unchanged', () => {
    expect(matchServiceProtocol(protocols, 'Mosquito Misting Service Plan').programKey).toBe('mosquito_misting');
    expect(matchServiceProtocol(protocols, '21-day mosquito misting')).toMatchObject({ programKey: 'mosquito', reason: 'mosquito_barrier' });
    expect(matchServiceProtocol(protocols, 'Mosquito Misting System Service', { serviceKey: 'mosquito_misting_system' })).toMatchObject({ program: null, reason: 'misting_system_consultation' });
  });

  test('the job card resolves the misting program for the plan visit and the install visit (not the barrier steps)', async () => {
    const { resolveVisitProducts } = require('../services/job-card');
    const visitFor = (serviceKey, serviceType) => resolveVisitProducts({
      facts: { serviceCategory: 'mosquito', serviceType, serviceKey, scheduledDate: '2027-03-10', isLawn: false },
      protocols, catalog: [], dbh: null, deps: {},
    });
    const plan = await visitFor('mosquito_misting_service', 'Mosquito Misting Service Plan');
    expect(plan.procedure.name).toBe('Mosquito Misting System Protocol');
    expect(plan.procedure.title).toBe('Service plan visit (monthly)');
    expect(plan.procedure.steps.join(' ')).toMatch(/Check the solution level/);
    const install = await visitFor('mosquito_misting_install', 'Mosquito Misting System Installation');
    expect(install.procedure.title).toBe('Installation (one-time)');
    const refill = await visitFor('mosquito_misting_refill', 'Mosquito Misting System Refill');
    expect(refill.procedure.steps.join(' ')).toMatch(/Refill the locked reservoir/);
    const barrier = await visitFor(null, '21-day mosquito misting');
    expect(barrier.procedure.name).toBe('Mosquito Control Protocol');
  });
});

describe('report and trace lanes', () => {
  test('the plan and install keep a generic report writer; no spray trace is offered for any of the three keys', () => {
    const { selectReportCopyPrompt } = require('../services/service-report/lawn-report-copy-prompt');
    const { resolveTraceEligibility } = require('../services/service-report/trace-eligibility');
    const shared = '## HARD CONSTRAINTS\nKeep provenance.\n## ANTI-TEMPLATE RULES\nx';
    for (const serviceKey of ['mosquito_misting_service', 'mosquito_misting_install']) {
      expect(selectReportCopyPrompt(shared, 'Old label', { serviceKey, findingsType: null })).not.toBeNull();
    }
    for (const serviceKey of ['mosquito_misting_service', 'mosquito_misting_install', 'mosquito_misting_refill']) {
      expect(resolveTraceEligibility({ serviceKey })).toMatchObject({ eligible: false, reason: 'misting_system_lane' });
    }
  });
});

describe('refills', () => {
  afterEach(() => { applyMosquitoMistingPricingConfig(null, constants.MOSQUITO_MISTING); });

  test('the per-refill-application price is read from the live table by solution; unknown reads Standard', () => {
    expect(mistingRefillPriceFor('standard')).toBe(129);
    expect(mistingRefillPriceFor('Natural')).toBe(219);
    expect(mistingRefillPriceFor('premium')).toBe(319);
    expect(mistingRefillPriceFor('bleach')).toBe(129);
    expect(mistingRefillPriceFor(undefined)).toBe(129);
  });

  test('it follows a pricing_config edit (DB-authoritative)', () => {
    const row = defaultMosquitoMistingPricingData();
    row.refills.premium.price = 349;
    expect(applyMosquitoMistingPricingConfig(row, constants.MOSQUITO_MISTING).applied).toBe(true);
    expect(mistingRefillPriceFor('premium')).toBe(349);
  });

  test('the catalog refill base_price is the Standard price (migration pinned to the table)', () => {
    const migration = require('../models/migrations/20261023100000_mosquito_misting_catalog_rows');
    const refill = migration.SERVICES.find((s) => s.service_key === 'mosquito_misting_refill');
    expect(refill.base_price).toBe(mistingRefillPriceFor('standard'));
  });
});
