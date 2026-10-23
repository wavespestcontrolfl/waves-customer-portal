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

describe('the install: a named line on the acceptance invoice and one office bell', () => {
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

  describe('the office bell (no install visit row)', () => {
    const NotificationService = require('../services/notification-service');
    const customer = { first_name: 'Test', last_name: 'Customer' };
    const makeDb = (failActivity = false) => {
      const inserts = [];
      const database = jest.fn((table) => ({
        insert: async (row) => {
          inserts.push({ table, row });
          if (failActivity) throw new Error('activity down');
          return [1];
        },
      }));
      database.inserts = inserts;
      return database;
    };
    const fx = () => ({ run: jest.fn((meta, fn) => fn()) });
    let notifySpy;
    beforeEach(() => { notifySpy = jest.spyOn(NotificationService, 'notifyAdmin').mockResolvedValue({ id: 1 }); });
    afterEach(() => notifySpy.mockRestore());

    test('the payload carries the amount, the customer link, needs-you, a bell and the per-estimate dedupe key', () => {
      const payload = converter.mistingInstallSchedulePayload({ estimateId: 9, customerId: 'c1', customerName: 'Test Customer', amount: INSTALL, firstPlanDate: '2027-03-10' });
      expect(payload.title).toBe("Schedule \u2014 Book Test Customer's misting install");
      expect(payload.title.length).toBeLessThanOrEqual(60);
      expect(payload.body).toContain(`$${INSTALL.toFixed(2)}`);
      expect(payload.body).toContain('before the first plan application on 2027-03-10');
      expect(payload.body).toContain('No install visit was created');
      expect(payload.options).toMatchObject({
        bell: true, link: '/admin/customers?customerId=c1', dedupeKey: 'misting_install_schedule:9',
        metadata: expect.objectContaining({ estimateId: 9, amount: INSTALL, severity: 'needs-you', area: 'Schedule' }),
      });
      const open = converter.mistingInstallSchedulePayload({ estimateId: 9, customerId: 'c1', amount: INSTALL });
      expect(open.body).toContain('on the first plan visit');
    });

    test('an in-transaction accept gets the payload back to send after commit; nothing is posted yet; the activity note says no visit was created', async () => {
      const database = makeDb();
      const out = await converter.raiseMistingInstallBell(database, fx(), { deferCommercialScheduleNotification: true }, {
        estimateId: 9, customerId: 'c1', customer, estimateData: estimateData(), firstPlanDate: '2027-03-10',
      });
      expect(out).toMatchObject({ options: { dedupeKey: 'misting_install_schedule:9', bell: true } });
      expect(notifySpy).not.toHaveBeenCalled();
      const note = database.inserts.filter((i) => i.table === 'activity_log');
      expect(note).toHaveLength(1);
      expect(note[0].row).toMatchObject({ customer_id: 'c1', action: 'misting_install_schedule_needed' });
      expect(note[0].row.description).toBe(`Estimate #9: the $${INSTALL.toFixed(2)} misting installation is on the acceptance invoice. No install visit was created; the office books the install day.`);
      // no scheduled_services insert for the install
      expect(database.inserts.some((i) => i.table === 'scheduled_services')).toBe(false);
    });

    test('a direct caller posts the bell once, with the dedupe key, and gets null back', async () => {
      const database = makeDb();
      const out = await converter.raiseMistingInstallBell(database, fx(), {}, {
        estimateId: 9, customerId: 'c1', customer, estimateData: estimateData(),
      });
      expect(out).toBeNull();
      expect(notifySpy).toHaveBeenCalledTimes(1);
      expect(notifySpy.mock.calls[0][3]).toMatchObject({ bell: true, dedupeKey: 'misting_install_schedule:9' });
      expect(notifySpy.mock.calls[0][2]).toContain(`$${INSTALL.toFixed(2)}`);
    });

    test('no priced install (no misting, or an oversize layout): no bell, no note', async () => {
      for (const data of [estimateData({ pest: { frequency: 'quarterly' } }), estimateData({ mosquitoMisting: { nozzles: 120 } })]) {
        const database = makeDb();
        expect(await converter.raiseMistingInstallBell(database, fx(), {}, { estimateId: 9, customerId: 'c1', customer, estimateData: data })).toBeNull();
        expect(notifySpy).not.toHaveBeenCalled();
        expect(database.inserts).toHaveLength(0);
      }
    });

    test('a failure in the bell or the note is swallowed (never blocks the accept)', async () => {
      notifySpy.mockRejectedValue(new Error('bell down'));
      await expect(converter.raiseMistingInstallBell(makeDb(true), fx(), {}, {
        estimateId: 9, customerId: 'c1', customer, estimateData: estimateData(),
      })).resolves.toBeNull();
      const throwingFx = { run: () => { throw new Error('fx down'); } };
      await expect(converter.raiseMistingInstallBell(makeDb(), throwingFx, {}, {
        estimateId: 9, customerId: 'c1', customer, estimateData: estimateData(),
      })).resolves.toBeNull();
    });
  });

  test('the converter has no install-visit writer; the hook skips manual Mark Won and suppressed recurring conversion; the accept routes post the deferred bell', () => {
    const src = read('services/estimate-converter.js');
    expect(src).not.toContain('scheduleMistingInstallVisit');
    expect(src).not.toContain('estimate_accept_misting_install');
    expect(src).not.toContain("prepaid_method: 'acceptance_invoice'");
    expect(src).toContain('const mistingInstallNotification = (!skipAutoSchedule && !suppressRecurringConversion)');
    expect(src).toMatch(/\n      mistingInstallNotification,\n/);
    expect(read('routes/estimate-public.js')).toContain(".sendAcceptBell(acceptConversion.mistingInstallNotification");
    expect(read('services/one-tap-purchase.js')).toContain("'mistingInstallNotification'");
    expect(read('services/termite-annual-activation.js')).toContain("'mistingInstallNotification'");
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
