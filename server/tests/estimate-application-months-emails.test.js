jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
}));
jest.mock('../services/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/estimate-delivery-options', () => ({
  estimateDataHasQuoteRequirement: jest.fn((estimateData) => {
    const data = typeof estimateData === 'string' ? JSON.parse(estimateData) : estimateData;
    return data?.result?.quoteRequired === true ||
      data?.quoteRequired === true ||
      data?.result?.specItems?.some((item) => item.quoteRequired === true);
  }),
  estimateDataHasUnresolvedManagerApproval: jest.fn((estimateData) => {
    const data = typeof estimateData === 'string' ? JSON.parse(estimateData) : estimateData;
    const inputsApproved = data?.inputs?.dethatchingManagerApproved === true &&
      data?.inputs?.dethatchingManagerApprovalTrusted === true &&
      String(data?.inputs?.dethatchingManagerApprovalReason || '').trim().length > 0;
    return !inputsApproved && data?.result?.oneTime?.items?.some((item) => (
      item.requiresManagerApproval === true &&
      item.managerApprovalReason === 'st_augustine_dethatching' &&
      item.managerApprovalSatisfied !== true
    ));
  }),
  commercialRiskTypeReviewNeeded: jest.fn(() => false),
  validateEstimateDeliveryOptions: jest.fn(),
}));
jest.mock('../services/estimate-pricing-audit', () => ({
  buildEstimatePricingAudit: jest.fn(),
  buildEstimatePricingRiskBatch: jest.fn(),
  getLatestEstimatePricingAuditSnapshot: jest.fn(),
  saveEstimatePricingAuditSnapshot: jest.fn(),
}));
jest.mock('../services/lead-estimate-link', () => ({ markLinkedLeadEstimateSent: jest.fn() }));
jest.mock('../services/estimate-manual-acceptance', () => ({ markEstimateManuallyAccepted: jest.fn() }));
jest.mock('../services/admin-estimate-persistence', () => ({
  createOrReuseAdminEstimate: jest.fn(),
  estimateViewUrl: jest.fn(),
}));
jest.mock('../routes/estimate-public', () => ({
  acceptanceServiceLists: jest.fn(),
  bookingServiceFor: jest.fn(),
}));
jest.mock('../services/email-template-library', () => ({ sendTemplate: jest.fn() }));
const mockGate = { on: true };
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return { ...actual, isEnabled: jest.fn((gate) => (gate === 'estimateMonthlyAverage' ? mockGate.on : actual.isEnabled(gate))) };
});
const mockBilling = { ctx: { billsPerApplication: true, livePricing: null } };
jest.mock('../services/estimate-proposal-billing', () => ({
  resolveProposalBillingContext: jest.fn(async () => mockBilling.ctx),
}));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(),
  isDefiniteRejection: jest.requireActual('../services/sendgrid-mail').isDefiniteRejection,
}));

const router = require('../routes/admin-estimates');
const db = require('../models/db');
const EmailTemplateLibrary = require('../services/email-template-library');
const sendgrid = require('../services/sendgrid-mail');

const { moneySummary, estimateEmailPayload } = router._internals;
const { emailAverageParts } = require('../services/estimate-monthly-average');

const shared = require('../../shared/estimate-monthly-average.cjs');
const { averageText } = require('../services/estimate-monthly-average');

const DEFAULT_NEXT = 'When you are ready, open the estimate and accept it online. We will collect the final setup details after that.';

const pestEstimate = {
  id: 'e-pest', category: 'RESIDENTIAL', status: 'sent', address: '1 Sample St', service_interest: 'Pest Control',
  monthly_total: '31.33', annual_total: '376.00', onetime_total: '0',
  estimate_data: { sendSnapshot: { pricingBundle: {
    frequencies: [{ key: 'quarterly', perTreatment: 94, visitsPerYear: 4, monthly: 31.33, annual: 376 }],
  } } },
};

const bundleEstimate = {
  id: 'e-bundle', category: 'RESIDENTIAL', status: 'sent', address: '1 Sample St', service_interest: 'Lawn + Pest',
  monthly_total: '72.30', annual_total: '867.60', onetime_total: '99',
  estimate_data: { sendSnapshot: { pricingBundle: {
    combinedRecurring: { waveGuardDiscountPct: 0.1 },
    frequencies: [{
      key: 'quarterly', monthly: 72.3, annual: 867.6,
      perServiceTreatments: [
        { label: 'Lawn Care', service: 'lawn_care', displayPrice: 56.4, visitsPerYear: 9, monthly: 42.3 },
        { label: 'Pest Control', service: 'pest_control', displayPrice: 90, visitsPerYear: 4, monthly: 30 },
      ],
    }],
    oneTimeBreakdown: { items: [{ kind: 'charge', service: 'waveguard_setup', amount: 99, label: 'WaveGuard setup' }] },
  } } },
};


// EST-2026-1185: quarterly pest $115.20 + monthly mosquito $74.70, Silver 10%.
const pestMosquito = {
  id: 'e-1185', category: 'RESIDENTIAL', status: 'sent', address: '1 Sample St', service_interest: 'Pest + Mosquito',
  monthly_total: '113.10', annual_total: '1357.20', onetime_total: '0',
  estimate_data: { sendSnapshot: { pricingBundle: {
    combinedRecurring: { waveGuardDiscountPct: 0.1 },
    frequencies: [{
      key: 'quarterly', monthly: 113.1, annual: 1357.2,
      perServiceTreatments: [
        { label: 'Pest Control', service: 'pest_control', displayPrice: 115.2, visitsPerYear: 4, monthly: 38.4 },
        { label: 'Mosquito', service: 'mosquito', displayPrice: 74.7, visitsPerYear: 12, monthly: 74.7 },
      ],
    }],
  } } },
};

const BREAKDOWN = 'Months with Pest Control (4 a year): $189.90. Other months (8 a year): $74.70, Mosquito only.';

// The function #6399 shipped in client/src/lib/estimateMonthlyAverage.js, frozen here so the move
// into the shared module is proved to change nothing.
const CADENCE = { 1: 'once a year', 2: 'every 6 months', 3: 'every 4 months', 4: 'every 3 months', 6: 'every 2 months', 12: 'every month' };
function referenceBreakdown(model) {
  if (!model || !model.multi || model.credit) return null;
  const services = Array.isArray(model.services) ? model.services : [];
  if (services.length < 2 || services.some((s) => !CADENCE[s.visits])) return null;
  const spaced = services.filter((s) => s.visits !== 12);
  const monthly = services.filter((s) => s.visits === 12);
  if (spaced.length !== 1 || monthly.length === 0) return null;
  const anchor = spaced[0];
  const cents = (n) => Math.round(Number(n) * 100);
  const monthlyCents = monthly.reduce((sum, s) => sum + cents(s.perApplication), 0);
  const applicationCents = monthlyCents + cents(anchor.perApplication);
  const appliedMonths = anchor.visits;
  const otherMonths = 12 - appliedMonths;
  const averageCents = (applicationCents * appliedMonths + monthlyCents * otherMonths) / 12;
  if (Math.abs(averageCents - cents(model.planMonthly)) > 5) return null;
  return {
    services: services.map((s) => ({ key: s.key, label: s.label, perApplication: s.perApplication, cadence: CADENCE[s.visits] })),
    applicationMonths: { label: `Months with ${anchor.label}`, count: appliedMonths, amount: applicationCents / 100, detail: services.map((s) => s.label).join(' + ') },
    otherMonths: { label: 'Other months', count: otherMonths, amount: monthlyCents / 100, detail: `${monthly.map((s) => s.label).join(' + ')} only` },
    planMonthly: model.planMonthly,
  };
}

describe('applicationMonthsBreakdown moved into the shared module', () => {
  const svc = (key, label, perApplication, visits) => ({ key, label, perApplication, visits });
  const modelOf = (services, planMonthly, extra = {}) => ({ multi: services.length > 1, credit: null, services, planMonthly, ...extra });

  test('EST-2026-1185 gives the same breakdown the page showed', () => {
    const model = modelOf([svc('p', 'Pest Control', 115.2, 4), svc('m', 'Mosquito', 74.7, 12)], 113.1);
    const result = shared.applicationMonthsBreakdown(model);
    expect(result).toEqual(referenceBreakdown(model));
    expect(result.applicationMonths).toMatchObject({ count: 4, amount: 189.9, detail: 'Pest Control + Mosquito' });
    expect(result.otherMonths).toMatchObject({ count: 8, amount: 74.7, detail: 'Mosquito only' });
  });

  test('parity with the page function over cadences, plan shapes and averages near the 5 cent band', () => {
    const cases = [];
    for (const visits of [1, 2, 3, 4, 6, 9, 12]) {
      for (const planMonthly of [113.1, 113.14, 113.16, 90, 189.9]) {
        cases.push(modelOf([svc('a', 'A', 115.2, visits), svc('b', 'B', 74.7, 12)], planMonthly));
        cases.push(modelOf([svc('a', 'A', 115.2, visits), svc('b', 'B', 74.7, 4)], planMonthly));
        cases.push(modelOf([svc('a', 'A', 115.2, visits), svc('b', 'B', 74.7, 12), svc('c', 'C', 20, 12)], planMonthly));
      }
    }
    cases.push(modelOf([svc('a', 'A', 10, 12), svc('b', 'B', 10, 12)], 20));
    cases.push(modelOf([svc('a', 'A', 10, 4)], 3.33, { multi: false }));
    cases.push(modelOf([svc('a', 'A', 115.2, 4), svc('b', 'B', 74.7, 12)], 113.1, { credit: { label: 'Referral Credit', monthly: 5 } }));
    cases.push(null);
    for (const model of cases) expect(shared.applicationMonthsBreakdown(model)).toEqual(referenceBreakdown(model));
    expect(cases.filter((m) => referenceBreakdown(m)).length).toBeGreaterThan(1);
  });
});

describe('service names from the proposal lines', () => {
  test('the \"— N applications/yr\" suffix is dropped from every name; plain names are untouched', () => {
    const model = {
      multi: true, credit: null, planMonthly: 113.1,
      services: [
        { key: '0', label: 'Pest Control — 4 applications/yr', perApplication: 115.2, visits: 4 },
        { key: '1', label: 'Mosquito (12 visits) — 12 applications/yr', perApplication: 74.7, visits: 12 },
      ],
    };
    const result = shared.applicationMonthsBreakdown(model);
    expect(result.services.map((s) => s.label)).toEqual(['Pest Control', 'Mosquito']);
    expect(result.applicationMonths).toMatchObject({ label: 'Months with Pest Control', detail: 'Pest Control + Mosquito' });
    expect(result.otherMonths.detail).toBe('Mosquito only');
    expect(shared.applicationMonthsSentence(result)).toBe(BREAKDOWN);
  });
});

describe('delivery email: application months', () => {
  beforeEach(() => {
    mockGate.on = true;
    mockBilling.ctx = { billsPerApplication: true, livePricing: null };
  });

  test('EST-2026-1185: the price row keeps the plan average and the note carries the two month amounts', async () => {
    const average = await emailAverageParts(pestMosquito);
    expect(average).toEqual({
      priceLine: 'Priced per application · plan averages $113.10 a month',
      note: `${BREAKDOWN} Averaged over the year, bundle savings included. You pay after each application.`,
    });
    const payload = estimateEmailPayload({ estimate: pestMosquito, firstName: 'Pat', viewUrl: 'u', priceLine: moneySummary(pestMosquito), average });
    expect(payload.price_summary).toBe('Priced per application · plan averages $113.10 a month');
    expect(payload.next_step_summary).toBe(`${average.note} ${DEFAULT_NEXT}`);
    expect(payload.next_step_summary).not.toMatch(/\/mo/);
  });

  test('one-time wording still follows the averaged sentence', () => {
    const model = shared.buildMonthlyAverage({
      services: [{ key: 'p', label: 'Pest Control', perApplication: 115.2, visits: 4 }, { key: 'm', label: 'Mosquito', perApplication: 74.7, visits: 12 }],
      planMonthly: 113.1,
      bundleDiscountPct: 0.1,
    });
    expect(shared.emailParts(model, { amount: 99, setup: true }).note)
      .toBe(`${BREAKDOWN} Averaged over the year, bundle savings included. You pay after each application. One-time setup $99.00, not in the average.`);
  });

  test('plans the breakdown does not cover carry no month sentences', async () => {
    for (const estimate of [pestEstimate, bundleEstimate]) {
      const average = await emailAverageParts(estimate);
      expect(average.note).not.toContain('Months with');
      expect(average.note).not.toContain('Other months');
    }
  });

  test('the monthly-average gate off still gives nothing', async () => {
    mockGate.on = false;
    expect(await emailAverageParts(pestMosquito)).toBeNull();
  });

  test('the reviewed-copy text includes the breakdown', async () => {
    expect(averageText(await emailAverageParts(pestMosquito))).toContain(BREAKDOWN);
  });
});
