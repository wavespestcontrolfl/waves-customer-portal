/**
 * check_existing_estimates hands the lead agent ONLY rows the customer can
 * open (#3750, uncapped codex P1 r33): expired / send-failed / unpublished /
 * invalidated rows are refused by the public page, so their price, bearer
 * token, and URL never reach the agent. Viewability is applied BEFORE the
 * five-row limit by paging the candidates, so newer hidden rows cannot mask
 * an older estimate the customer still holds.
 */

const mockGate = { applies: false, deliverable: true };
jest.mock('../services/pricing-authority-gate', () => ({
  gatedSendAuthorityPredicateApplies: () => mockGate.applies,
  estimateDeliverableUnderGate: jest.fn(async () => mockGate.deliverable),
}));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: async (url) => url }));
const mockCallSide = { block: null, throws: false };
jest.mock('../utils/estimate-claim-sql', () => ({
  callSideBlockForEstimateData: jest.fn(async () => {
    if (mockCallSide.throws) throw new Error('call_log unavailable');
    return mockCallSide.block;
  }),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/estimate-automation-duplicates', () => ({
  blockIfAutomatedEstimateDuplicate: jest.fn(),
  withAutomatedEstimatePhoneLock: jest.fn(),
}));
jest.mock('../routes/estimate-public', () => ({
  isEstimateCustomerViewable: (row, now = new Date()) => {
    if (!row || row.archived_at) return false;
    if (['accepted', 'declined'].includes(row.status)) return true;
    if (['draft', 'scheduled', 'expired', 'send_failed'].includes(row.status)) return false;
    if (row.expires_at && new Date(row.expires_at) < now) return false;
    return true;
  },
}));

const pages = [];
let explicitEstimateRow = null;
const builder = {
  where: jest.fn(() => builder),
  orWhere: jest.fn(() => builder),
  orderBy: jest.fn(() => builder),
  offset: jest.fn(() => builder),
  first: jest.fn(async () => explicitEstimateRow),
  limit: jest.fn(async () => pages.shift() || []),
};
const context = { leadId: 'l1', customerId: 'c1' };
const mockLead = { id: 'l1', customer_id: 'c1', phone: '+19415550100', estimate_id: null, property_id: null };
const mockCustomer = { id: 'c1', customer_id: 'c1', phone: '+19415550100' };
const leadSubjectBuilder = { where: jest.fn(() => leadSubjectBuilder), whereNull: jest.fn(() => leadSubjectBuilder), first: jest.fn(async () => ({ ...mockLead })) };
const customerSubjectBuilder = { where: jest.fn(() => customerSubjectBuilder), whereNull: jest.fn(() => customerSubjectBuilder), first: jest.fn(async () => ({ ...mockCustomer })) };
const mockDb = jest.fn((table) => {
  if (table === 'leads') return leadSubjectBuilder;
  if (table === 'customers') return customerSubjectBuilder;
  return builder;
});
jest.mock('../models/db', () => mockDb);

const mockPricing = {
  perApplicationAverage: null,
  perApplicationError: null,
  livePricing: null,
  livePricingError: null,
  billsPerApplication: true,
  billsPerApplicationError: null,
  soldAsAnnualPrepay: false,
  priceLocked: false,
};
const mockPerApplicationAverageFor = jest.fn(async () => {
  if (mockPricing.perApplicationError) throw mockPricing.perApplicationError;
  return mockPricing.perApplicationAverage;
});
const mockEstimateBillsPerApplication = jest.fn(async () => {
  if (mockPricing.billsPerApplicationError) throw mockPricing.billsPerApplicationError;
  return mockPricing.billsPerApplication;
});
const mockEstimateSoldAsAnnualPrepay = jest.fn(async () => mockPricing.soldAsAnnualPrepay);
const mockResolveLivePricing = jest.fn(async () => {
  if (mockPricing.livePricingError) throw mockPricing.livePricingError;
  return mockPricing.livePricing;
});
jest.mock('../services/estimate-monthly-average', () => ({
  perApplicationAverageFor: mockPerApplicationAverageFor,
}));
jest.mock('../services/estimate-proposal-billing', () => ({
  estimateBillsPerApplication: mockEstimateBillsPerApplication,
  estimateSoldAsAnnualPrepay: mockEstimateSoldAsAnnualPrepay,
  estimateIsPriceLocked: jest.fn((estimate) => mockPricing.priceLocked || ['accepted', 'declined'].includes(estimate?.status) || !!estimate?.price_locked_at),
  resolveLivePricing: mockResolveLivePricing,
}));

const { executeLeadTool } = require('../services/lead-response-tools');

const FUTURE = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
const PAST = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
const row = (over = {}) => ({
  id: over.id || 'e1', token: 'tk-' + (over.id || 'e1'), status: 'sent', customer_id: 'c1',
  sent_at: PAST, viewed_at: null, expires_at: FUTURE, monthly_total: 149, total_amount: 149,
  service_interest: 'Pest', archived_at: null, ...over,
});

beforeEach(() => {
  pages.length = 0;
  explicitEstimateRow = null;
  builder.offset.mockClear();
  builder.limit.mockClear();
  builder.first.mockClear();
  mockGate.applies = false;
  mockGate.deliverable = true;
  mockCallSide.block = null;
  mockCallSide.throws = false;
  mockPricing.perApplicationAverage = null;
  mockPricing.perApplicationError = null;
  mockPricing.livePricing = null;
  mockPricing.livePricingError = null;
  mockPricing.billsPerApplication = true;
  mockPricing.billsPerApplicationError = null;
  mockPricing.soldAsAnnualPrepay = false;
  mockPricing.priceLocked = false;
  mockLead.estimate_id = null;
  mockLead.property_id = null;
  mockPerApplicationAverageFor.mockClear();
  mockEstimateBillsPerApplication.mockClear();
  mockEstimateSoldAsAnnualPrepay.mockClear();
  mockResolveLivePricing.mockClear();
});

describe('check_existing_estimates viewability', () => {
  test('an expired newest row is hidden; the older open estimate still links', async () => {
    pages.push([row({ id: 'e-new', status: 'expired' }), row({ id: 'e-old' })]);
    const out = await executeLeadTool('check_existing_estimates', { customer_id: 'c1' }, context);
    expect(out.hasEstimates).toBe(true);
    expect(out.estimates.map((e) => e.id)).toEqual(['e-old']);
    expect(out.estimates[0].viewUrl).toBe('https://portal.wavespestcontrol.com/estimate/tk-e-old');
    expect(out.estimates[0].token).toBe('tk-e-old');
    expect(out.unviewableEstimates).toBe(1);
  });

  test('a past expires_at, a draft, a sending, an undelivered self-serve, and a send-failed row never surface a price, token, or URL', async () => {
    pages.push([
      row({ id: 'e-stale', expires_at: PAST }),
      row({ id: 'e-draft', status: 'draft', sent_at: null }),
      row({ id: 'e-sending', status: 'sending', sent_at: PAST }),
      row({ id: 'e-selfserve', status: 'sent', source: 'plan_start', sent_at: PAST, estimate_data: {} }),
      row({ id: 'e-failed', status: 'send_failed' }),
    ]);
    const out = await executeLeadTool('check_existing_estimates', { customer_id: 'c1' }, context);
    expect(out).toEqual({ hasEstimates: false, estimates: [], unviewableEstimates: 5 });
    expect(JSON.stringify(out)).not.toMatch(/tk-|149/);
  });

  test('a self-serve estimate with deliveryState.firstDeliveredAt is treated as delivered', async () => {
    pages.push([
      row({
        id: 'e-selfserve-delivered',
        status: 'sent',
        source: 'plan_start',
        sent_at: PAST,
        estimate_data: { deliveryState: { firstDeliveredAt: PAST } },
      }),
    ]);
    const out = await executeLeadTool('check_existing_estimates', { customer_id: 'c1' }, context);
    expect(out.hasEstimates).toBe(true);
    expect(out.estimates[0].id).toBe('e-selfserve-delivered');
    expect(out.estimates[0].viewUrl).toBe('https://portal.wavespestcontrol.com/estimate/tk-e-selfserve-delivered');
  });

  test('pages past a full page of hidden rows so they cannot mask an older open estimate', async () => {
    const hidden = Array.from({ length: 15 }, (_, i) => row({ id: `h${i}`, status: 'expired' }));
    pages.push(hidden, [row({ id: 'e-old' })]);
    const out = await executeLeadTool('check_existing_estimates', { phone: '(941) 555-0100' }, context);
    expect(out.estimates.map((e) => e.id)).toEqual(['e-old']);
    expect(builder.offset).toHaveBeenNthCalledWith(1, 0);
    expect(builder.offset).toHaveBeenNthCalledWith(2, 15);
    expect(out.unviewableEstimates).toBe(15);
  });

  test('stops at five viewable rows; valid rows beyond the cap are never counted as hidden', async () => {
    pages.push(Array.from({ length: 15 }, (_, i) => row({ id: `v${i}` })));
    const out = await executeLeadTool('check_existing_estimates', { customer_id: 'c1' }, context);
    expect(out.estimates).toHaveLength(5);
    expect(out.unviewableEstimates).toBeUndefined();
    expect(builder.limit).toHaveBeenCalledTimes(1);
  });

  test('the hidden count reports only rows evaluated as not openable', async () => {
    pages.push([row({ id: 'e-expired', status: 'expired' }), ...Array.from({ length: 14 }, (_, i) => row({ id: `v${i}` }))]);
    const out = await executeLeadTool('check_existing_estimates', { customer_id: 'c1' }, context);
    expect(out.estimates.map((e) => e.id)).toEqual(['v0', 'v1', 'v2', 'v3', 'v4']);
    expect(out.unviewableEstimates).toBe(1);
  });

  test('gate on: a viewable row the verdict refuses lists without price, token, or URL', async () => {
    mockGate.applies = true;
    mockGate.deliverable = false;
    pages.push([row({ id: 'e-fallback' })]);
    const out = await executeLeadTool('check_existing_estimates', { customer_id: 'c1' }, context);
    expect(out.estimates[0]).toMatchObject({
      id: 'e-fallback', token: null, viewUrl: null,
      totalWithheld: 'pricing-authority-not-server', viewUrlWithheld: 'pricing-authority-not-server',
    });
    expect(out.estimates[0].total).toBeUndefined();
  });

  test('a durable call-side block hides an otherwise open row (public data route parity)', async () => {
    mockCallSide.block = 'call_missing';
    pages.push([row({ id: 'e-blocked', estimate_data: JSON.stringify({ estimatorEngine: { callLogId: 'call-1' } }) })]);
    const out = await executeLeadTool('check_existing_estimates', { customer_id: 'c1' }, context);
    expect(out).toEqual({ hasEstimates: false, estimates: [], unviewableEstimates: 1 });
    expect(JSON.stringify(out)).not.toMatch(/tk-|149/);
  });

  test('an unreadable call-side verdict fails closed', async () => {
    mockCallSide.throws = true;
    pages.push([row({ id: 'e-unknown' })]);
    const out = await executeLeadTool('check_existing_estimates', { customer_id: 'c1' }, context);
    expect(out.hasEstimates).toBe(false);
    expect(out.unviewableEstimates).toBe(1);
  });

  test('no candidates at all', async () => {
    const out = await executeLeadTool('check_existing_estimates', { customer_id: 'c1' }, context);
    expect(out).toEqual({ hasEstimates: false, estimates: [] });
  });
});

describe('check_existing_estimates customer-facing pricing units', () => {
  test('quarterly recurring estimate returns per-application amount and unit, never unlabeled monthly_total', async () => {
    mockPricing.perApplicationAverage = {
      model: {
        planMonthly: 49.67,
        services: [{ label: 'General Pest Control — 4 applications/yr', perApplication: 149, visits: 4, monthly: 49.67 }],
        credit: null,
      },
      inputs: { oneTime: { amount: 99, setup: true } },
    };
    pages.push([row({ id: 'e-quarterly', monthly_total: '49.67', onetime_total: '99.00' })]);
    const out = await executeLeadTool('check_existing_estimates', { customer_id: 'c1' }, context);
    expect(out.estimates[0].total).toBeUndefined();
    expect(out.estimates[0].pricing).toEqual({
      unit: 'per_application',
      lines: [{
        label: 'General Pest Control',
        amount: 149,
        unit: 'per_application',
        applicationsPerYear: 4,
        display: '$149 per application (4 applications/yr)',
      }],
      oneTimeCharge: {
        amount: 99,
        unit: 'one_time',
        label: 'one-time setup fee',
        display: '$99 one-time setup fee',
      },
      display: 'General Pest Control: $149 per application (4 applications/yr); plus $99 one-time setup fee',
    });
    expect(JSON.stringify(out.estimates[0])).not.toContain('49.67');
  });

  test('one-time estimate parses "0.00" monthly_total as zero and returns verified one_time pricing', async () => {
    mockPricing.livePricing = {
      bundle: {
        defaultServiceMode: 'one_time',
        anchorOneTimePrice: 295,
        frequencies: [],
        quoteRequired: false,
      },
      snapshotHit: true,
    };
    pages.push([row({ id: 'e-onetime', monthly_total: '0.00', annual_total: '0.00', onetime_total: '295.00', total_amount: null })]);
    const out = await executeLeadTool('check_existing_estimates', { customer_id: 'c1' }, context);
    expect(out.estimates[0].total).toBeUndefined();
    expect(out.estimates[0].pricing).toEqual({
      unit: 'one_time',
      amount: 295,
      serviceLabels: ['Pest'],
      display: '$295 one-time',
    });
  });

  test('one-time estimate falls back to viewUrl when live pricing cannot verify it', async () => {
    mockPricing.livePricing = { unresolved: true };
    pages.push([row({ id: 'e-onetime-unverified', monthly_total: '0.00', annual_total: '0.00', onetime_total: '295.00' })]);
    const out = await executeLeadTool('check_existing_estimates', { customer_id: 'c1' }, context);
    expect(out.estimates[0].pricing).toBeUndefined();
    expect(out.estimates[0].total).toBeUndefined();
    expect(out.estimates[0].pricingUnavailable).toBe('use_estimate_link');
    expect(out.estimates[0].viewUrl).toBe('https://portal.wavespestcontrol.com/estimate/tk-e-onetime-unverified');
  });

  test('preserved monthly membership returns per_month only when verified and snapshot-matched', async () => {
    mockPricing.billsPerApplication = false;
    mockPricing.soldAsAnnualPrepay = false;
    mockPricing.livePricing = { bundle: { quoteRequired: false, firstVisitFees: [] }, snapshotHit: true };
    pages.push([row({ id: 'e-monthly', monthly_total: '59.00', onetime_total: '0.00' })]);
    const out = await executeLeadTool('check_existing_estimates', { customer_id: 'c1' }, context);
    expect(out.estimates[0].pricing).toEqual({
      unit: 'per_month',
      amount: 59,
      serviceLabels: ['Pest'],
      display: '$59 per month',
    });
  });

  test('recurring estimate with unresolved per-application pricing withholds raw monthly_total and points to viewUrl', async () => {
    mockPricing.billsPerApplication = true;
    mockPricing.perApplicationAverage = null;
    pages.push([row({ id: 'e-recurring-unresolved', monthly_total: '49.67', onetime_total: '0.00' })]);
    const out = await executeLeadTool('check_existing_estimates', { customer_id: 'c1' }, context);
    expect(out.estimates[0].pricing).toBeUndefined();
    expect(out.estimates[0].total).toBeUndefined();
    expect(out.estimates[0].pricingUnavailable).toBe('use_estimate_link');
    expect(out.estimates[0].viewUrl).toBe('https://portal.wavespestcontrol.com/estimate/tk-e-recurring-unresolved');
    expect(JSON.stringify(out.estimates[0])).not.toContain('49.67');
  });

  test('commercial and quote-required estimates never expose raw numbers', async () => {
    pages.push([row({ id: 'e-comm', category: 'COMMERCIAL', monthly_total: '450.00', onetime_total: '0.00' })]);
    const commOut = await executeLeadTool('check_existing_estimates', { customer_id: 'c1' }, context);
    expect(commOut.estimates[0]).toMatchObject({ id: 'e-comm', pricingUnavailable: 'use_estimate_link' });
    expect(commOut.estimates[0].pricing).toBeUndefined();

    pages.push([row({ id: 'e-qr', quote_required: true, monthly_total: '0.00', onetime_total: '500.00' })]);
    const qrOut = await executeLeadTool('check_existing_estimates', { customer_id: 'c1' }, context);
    expect(qrOut.estimates[0]).toMatchObject({ id: 'e-qr', pricingUnavailable: 'quote_required' });
    expect(qrOut.estimates[0].pricing).toBeUndefined();
  });

  test('failed billing lookup or membership verification fails closed and never quotes monthly_total', async () => {
    mockPricing.billsPerApplicationError = new Error('db connection reset');
    pages.push([row({ id: 'e-db-fail', monthly_total: '49.67', onetime_total: '0.00' })]);
    const out = await executeLeadTool('check_existing_estimates', { customer_id: 'c1' }, context);
    expect(out.estimates[0].pricing).toBeUndefined();
    expect(out.estimates[0].pricingUnavailable).toBe('use_estimate_link');
    expect(mockPerApplicationAverageFor).toHaveBeenCalledWith(expect.objectContaining({ id: 'e-db-fail' }), { rethrow: true });
    expect(mockEstimateBillsPerApplication).toHaveBeenCalledWith(expect.objectContaining({ id: 'e-db-fail' }), { rethrow: true });
    expect(JSON.stringify(out.estimates[0])).not.toContain('49.67');

    mockPricing.billsPerApplicationError = null;
    mockPricing.livePricingError = new Error('membership snapshot unverified');
    pages.push([row({ id: 'e-member-fail', monthly_total: '0.00', annual_total: '0.00', onetime_total: '295.00' })]);
    const oneTimeOut = await executeLeadTool('check_existing_estimates', { customer_id: 'c1' }, context);
    expect(oneTimeOut.estimates[0].pricing).toBeUndefined();
    expect(oneTimeOut.estimates[0].pricingUnavailable).toBe('use_estimate_link');
    expect(mockResolveLivePricing).toHaveBeenCalledWith(expect.objectContaining({ id: 'e-member-fail' }), { rethrow: true });
  });

  test('area add-on preserves per_application unit and mixed-unit totals are withheld', async () => {
    mockPricing.livePricing = {
      bundle: {
        defaultServiceMode: 'one_time',
        anchorOneTimePrice: 125,
        oneTimeBreakdown: {
          total: 125,
          items: [{ kind: 'charge', service: 'area_addon', addOnKey: 'web_sweep', priceUnit: 'application', amount: 125 }],
        },
        frequencies: [],
        quoteRequired: false,
      },
      snapshotHit: true,
    };
    pages.push([row({ id: 'e-addon', monthly_total: '0.00', annual_total: '0.00', onetime_total: '125.00' })]);
    const addonOut = await executeLeadTool('check_existing_estimates', { customer_id: 'c1' }, context);
    expect(addonOut.estimates[0].pricing).toEqual({
      unit: 'per_application',
      amount: 125,
      serviceLabels: ['web_sweep'],
      display: '$125 per application',
    });

    mockPricing.livePricing = {
      bundle: {
        defaultServiceMode: 'one_time',
        anchorOneTimePrice: 320,
        oneTimeBreakdown: {
          total: 320,
          items: [
            { kind: 'charge', service: 'area_addon', priceUnit: 'application', amount: 125 },
            { kind: 'charge', service: 'fire_ant', amount: 195 },
          ],
        },
        frequencies: [],
        quoteRequired: false,
      },
      snapshotHit: true,
    };
    pages.push([row({ id: 'e-mixed', monthly_total: '0.00', annual_total: '0.00', onetime_total: '320.00' })]);
    const mixedOut = await executeLeadTool('check_existing_estimates', { customer_id: 'c1' }, context);
    expect(mixedOut.estimates[0].pricing).toBeUndefined();
    expect(mixedOut.estimates[0].pricingUnavailable).toBe('use_estimate_link');

    // Non-setup additive charges beside a recurring plan are also withheld instead of flattened to one-time charges.
    mockPricing.perApplicationAverage = {
      model: { planMonthly: 49.67, services: [{ label: 'Pest', perApplication: 149, visits: 4, monthly: 49.67 }], credit: null },
      inputs: { oneTime: { amount: 125, setup: false } },
    };
    pages.push([row({ id: 'e-rec-addon', monthly_total: '49.67', onetime_total: '125.00' })]);
    const recAddonOut = await executeLeadTool('check_existing_estimates', { customer_id: 'c1' }, context);
    expect(recAddonOut.estimates[0].pricing).toBeUndefined();
    expect(recAddonOut.estimates[0].pricingUnavailable).toBe('use_estimate_link');
  });

  test('mixed legacy bundle without defaultServiceMode that carries canonical monthly/annual frequencies is not quoted as one-time', async () => {
    mockPricing.livePricing = {
      bundle: {
        anchorOneTimePrice: 195,
        frequencies: [{ key: 'quarterly', monthly: 49, annual: 588 }],
        quoteRequired: false,
      },
      snapshotHit: true,
    };
    pages.push([row({ id: 'e-legacy-mixed', monthly_total: '0.00', annual_total: '0.00', onetime_total: '195.00' })]);
    const out = await executeLeadTool('check_existing_estimates', { customer_id: 'c1' }, context);
    expect(out.estimates[0].pricing).toBeUndefined();
    expect(out.estimates[0].pricingUnavailable).toBe('use_estimate_link');
  });

  test('lead binding withholds BOTH pricing and viewUrl/token when ambiguous or bound to another lead', async () => {
    mockPricing.perApplicationAverage = {
      model: { planMonthly: 49.67, services: [{ label: 'Pest', perApplication: 149, visits: 4, monthly: 49.67 }], credit: null },
      inputs: { oneTime: null },
    };
    // No lead.estimate_id and 2 viewable estimates -> ambiguous, withhold pricing AND link on both.
    pages.push([
      row({ id: 'e-prop-1', monthly_total: '49.67', onetime_total: '0.00' }),
      row({ id: 'e-prop-2', monthly_total: '59.67', onetime_total: '0.00' }),
    ]);
    const ambigOut = await executeLeadTool('check_existing_estimates', { customer_id: 'c1' }, context);
    expect(ambigOut.estimates[0]).toMatchObject({
      id: 'e-prop-1', pricingUnavailable: 'ambiguous_multiple_estimates', token: null, viewUrl: null, viewUrlWithheld: 'ambiguous_multiple_estimates',
    });
    expect(ambigOut.estimates[0].pricing).toBeUndefined();
    expect(ambigOut.estimates[1]).toMatchObject({
      id: 'e-prop-2', pricingUnavailable: 'ambiguous_multiple_estimates', token: null, viewUrl: null, viewUrlWithheld: 'ambiguous_multiple_estimates',
    });
    expect(ambigOut.estimates[1].pricing).toBeUndefined();

    // Sole viewable estimate whose estimate_data.lead_id belongs to another lead -> withhold pricing AND link.
    pages.push([
      row({ id: 'e-other-lead', monthly_total: '49.67', onetime_total: '0.00', estimate_data: { lead_id: 'l-other' } }),
    ]);
    const otherLeadOut = await executeLeadTool('check_existing_estimates', { customer_id: 'c1' }, context);
    expect(otherLeadOut.estimates[0]).toMatchObject({
      id: 'e-other-lead', pricingUnavailable: 'different_lead_estimate', token: null, viewUrl: null, viewUrlWithheld: 'different_lead_estimate',
    });
    expect(otherLeadOut.estimates[0].pricing).toBeUndefined();

    // lead.estimate_id points to e-prop-1 (even if 6th newest) -> fetched first and only e-prop-1 exposes pricing AND link.
    mockLead.estimate_id = 'e-prop-1';
    explicitEstimateRow = row({ id: 'e-prop-1', monthly_total: '49.67', onetime_total: '0.00' });
    pages.push([
      row({ id: 'e-prop-1', monthly_total: '49.67', onetime_total: '0.00' }),
      row({ id: 'e-prop-2', monthly_total: '59.67', onetime_total: '0.00' }),
    ]);
    const boundOut = await executeLeadTool('check_existing_estimates', { customer_id: 'c1' }, context);
    expect(boundOut.estimates[0].pricing).toMatchObject({ unit: 'per_application' });
    expect(boundOut.estimates[0].viewUrl).toBe('https://portal.wavespestcontrol.com/estimate/tk-e-prop-1');
    expect(boundOut.estimates[1]).toMatchObject({
      id: 'e-prop-2', pricingUnavailable: 'different_lead_estimate', token: null, viewUrl: null, viewUrlWithheld: 'different_lead_estimate',
    });
    expect(boundOut.estimates[1].pricing).toBeUndefined();

    // Without lead.estimate_id, 2 customer estimates where ONLY ONE records this lead_id -> that one resolves cleanly.
    mockLead.estimate_id = null;
    explicitEstimateRow = null;
    pages.push([
      row({ id: 'e-mine', monthly_total: '49.67', onetime_total: '0.00', estimate_data: { lead_id: 'l1' } }),
      row({ id: 'e-theirs', monthly_total: '59.67', onetime_total: '0.00', estimate_data: { lead_id: 'l2' } }),
    ]);
    const recLeadOut = await executeLeadTool('check_existing_estimates', { customer_id: 'c1' }, context);
    expect(recLeadOut.estimates[0].pricing).toMatchObject({ unit: 'per_application' });
    expect(recLeadOut.estimates[0].viewUrl).toBe('https://portal.wavespestcontrol.com/estimate/tk-e-mine');
    expect(recLeadOut.estimates[1]).toMatchObject({
      id: 'e-theirs', pricingUnavailable: 'different_lead_estimate', token: null, viewUrl: null, viewUrlWithheld: 'different_lead_estimate',
    });

    // Malformed estimate_data JSON fails closed and hides the row.
    pages.push([row({ id: 'e-bad-json', estimate_data: '{bad json' })]);
    const badJsonOut = await executeLeadTool('check_existing_estimates', { customer_id: 'c1' }, context);
    expect(badJsonOut).toEqual({ hasEstimates: false, estimates: [], unviewableEstimates: 1 });
  });

  test('gate-withheld row exposes neither total nor pricing', async () => {
    mockGate.applies = true;
    mockGate.deliverable = false;
    mockPricing.perApplicationAverage = {
      model: { planMonthly: 49.67, services: [{ label: 'Pest', perApplication: 149, visits: 4, monthly: 49.67 }], credit: null },
      inputs: { oneTime: null },
    };
    pages.push([row({ id: 'e-withheld', monthly_total: '49.67' })]);
    const out = await executeLeadTool('check_existing_estimates', { customer_id: 'c1' }, context);
    expect(out.estimates[0].totalWithheld).toBe('pricing-authority-not-server');
    expect(out.estimates[0].pricing).toBeUndefined();
    expect(out.estimates[0].total).toBeUndefined();
  });
});

describe('send_lead_response dispatch-boundary price verification', () => {
  const { verifyLeadSmsQuotedPrices } = require('../services/lead-estimate-pricing');
  const { estimateDeliverableUnderGate } = require('../services/pricing-authority-gate');

  test('allows a draft matching current verified amount, unit, cadence, and service', async () => {
    mockPricing.perApplicationAverage = {
      model: { planMonthly: 49.67, services: [{ label: 'General Pest Control — 4 applications/yr', perApplication: 149, visits: 4, monthly: 49.67 }], credit: null },
      inputs: { oneTime: { amount: 99, setup: true } },
    };
    pages.push([row({ id: 'e-ok', monthly_total: '49.67', onetime_total: '99.00', service_interest: 'General Pest Control' })]);
    const res = await verifyLeadSmsQuotedPrices(
      'Hello Pat! Your General Pest Control estimate is $149 per application (4 applications/yr), plus a $99 one-time setup fee.',
      mockDb,
      { lead: { ...mockLead }, customer: { ...mockCustomer } },
      { estimateDeliverableUnderGate },
    );
    expect(res).toEqual({ ok: true, hasPrice: true });
  });

  test('rejects unit mismatch ($149 per month on a per-application estimate) and forbidden per-visit wording', async () => {
    mockPricing.perApplicationAverage = {
      model: { planMonthly: 49.67, services: [{ label: 'General Pest Control — 4 applications/yr', perApplication: 149, visits: 4, monthly: 49.67 }], credit: null },
      inputs: { oneTime: null },
    };
    pages.push([row({ id: 'e-u1', monthly_total: '49.67', onetime_total: '0.00', service_interest: 'General Pest Control' })]);
    const wrongUnit = await verifyLeadSmsQuotedPrices(
      'Hello Pat! Your General Pest Control estimate is $149 per month.',
      mockDb,
      { lead: { ...mockLead }, customer: { ...mockCustomer } },
      { estimateDeliverableUnderGate },
    );
    expect(wrongUnit).toEqual({ ok: false, hasPrice: true, reason: 'price_or_service_mismatch' });

    pages.push([row({ id: 'e-u2', monthly_total: '49.67', onetime_total: '0.00', service_interest: 'General Pest Control' })]);
    const perVisit = await verifyLeadSmsQuotedPrices(
      'Hello Pat! Your General Pest Control estimate is $149 per visit.',
      mockDb,
      { lead: { ...mockLead }, customer: { ...mockCustomer } },
      { estimateDeliverableUnderGate },
    );
    expect(perVisit).toEqual({ ok: false, hasPrice: true, reason: 'forbidden_per_visit_unit' });
  });

  test('rejects service mismatch, cadence mismatch, unlabeled amounts, and setup-fee mislabeling', async () => {
    mockPricing.perApplicationAverage = {
      model: { planMonthly: 49.67, services: [{ label: 'General Pest Control — 4 applications/yr', perApplication: 149, visits: 4, monthly: 49.67 }], credit: null },
      inputs: { oneTime: { amount: 99, setup: true } },
    };
    pages.push([row({ id: 'e-s1', monthly_total: '49.67', onetime_total: '99.00', service_interest: 'General Pest Control' })]);
    const wrongService = await verifyLeadSmsQuotedPrices(
      'Hello Pat! Your Lawn Care estimate is $149 per application.',
      mockDb,
      { lead: { ...mockLead }, customer: { ...mockCustomer } },
      { estimateDeliverableUnderGate },
    );
    expect(wrongService).toEqual({ ok: false, hasPrice: true, reason: 'price_or_service_mismatch' });

    pages.push([row({ id: 'e-s2', monthly_total: '49.67', onetime_total: '99.00', service_interest: 'General Pest Control' })]);
    const wrongCadence = await verifyLeadSmsQuotedPrices(
      'Hello Pat! Your Pest Control estimate is $149 per application (6 applications/yr).',
      mockDb,
      { lead: { ...mockLead }, customer: { ...mockCustomer } },
      { estimateDeliverableUnderGate },
    );
    expect(wrongCadence).toEqual({ ok: false, hasPrice: true, reason: 'price_or_service_mismatch' });

    pages.push([row({ id: 'e-s3', monthly_total: '49.67', onetime_total: '99.00', service_interest: 'General Pest Control' })]);
    const unlabeled = await verifyLeadSmsQuotedPrices(
      'Hello Pat! Your Pest Control estimate is $149.',
      mockDb,
      { lead: { ...mockLead }, customer: { ...mockCustomer } },
      { estimateDeliverableUnderGate },
    );
    expect(unlabeled).toEqual({ ok: false, hasPrice: true, reason: 'missing_price_unit' });

    pages.push([row({ id: 'e-s4', monthly_total: '49.67', onetime_total: '99.00', service_interest: 'General Pest Control' })]);
    const setupAsTreatment = await verifyLeadSmsQuotedPrices(
      'Hello Pat! Your one-time Pest Control treatment is $99 one-time.',
      mockDb,
      { lead: { ...mockLead }, customer: { ...mockCustomer } },
      { estimateDeliverableUnderGate },
    );
    expect(setupAsTreatment).toEqual({ ok: false, hasPrice: true, reason: 'price_or_service_mismatch' });

    // Contradictory named cadence ("every two months" vs 4 applications/yr) is rejected.
    pages.push([row({ id: 'e-s5', monthly_total: '49.67', onetime_total: '0.00', service_interest: 'General Pest Control' })]);
    const wrongNamedCadence = await verifyLeadSmsQuotedPrices(
      'Hello Pat! Your Pest Control is $149 per application every two months.',
      mockDb,
      { lead: { ...mockLead }, customer: { ...mockCustomer } },
      { estimateDeliverableUnderGate },
    );
    expect(wrongNamedCadence).toEqual({ ok: false, hasPrice: true, reason: 'price_or_service_mismatch' });
  });

  test('rejects unrecognized currency/price wording ("USD 199", "costs 199") and unidentified one-time services', async () => {
    const usdRes = await verifyLeadSmsQuotedPrices(
      'Hello Pat! Your treatment costs USD 199.',
      mockDb,
      { lead: { ...mockLead }, customer: { ...mockCustomer } },
      { estimateDeliverableUnderGate },
    );
    expect(usdRes.ok).toBe(false);
    expect(usdRes.hasPrice).toBe(true);

    const costsRes = await verifyLeadSmsQuotedPrices(
      'Hello Pat! Your treatment costs 199.',
      mockDb,
      { lead: { ...mockLead }, customer: { ...mockCustomer } },
      { estimateDeliverableUnderGate },
    );
    expect(costsRes).toEqual({ ok: false, hasPrice: true, reason: 'unrecognized_price_wording' });

    // Blank service_interest one-time estimate cannot authorize arbitrary service wording ("Termite").
    mockPricing.livePricing = {
      bundle: { defaultServiceMode: 'one_time', anchorOneTimePrice: 295, frequencies: [], quoteRequired: false },
      snapshotHit: true,
    };
    pages.push([row({ id: 'e-no-svc', monthly_total: '0.00', annual_total: '0.00', onetime_total: '295.00', service_interest: '' })]);
    const unidSvc = await verifyLeadSmsQuotedPrices(
      'Hello Pat! Your Termite treatment is $295 one-time.',
      mockDb,
      { lead: { ...mockLead }, customer: { ...mockCustomer } },
      { estimateDeliverableUnderGate },
    );
    expect(unidSvc).toEqual({ ok: false, hasPrice: true, reason: 'price_or_service_mismatch' });
  });

  test('passes texts without prices immediately without reading estimates', async () => {
    const res = await verifyLeadSmsQuotedPrices(
      'Hello Pat! Ants are active in Bradenton right now. Reply to this text and we will send an estimate.',
      mockDb,
      { lead: { ...mockLead }, customer: { ...mockCustomer } },
      { estimateDeliverableUnderGate },
    );
    expect(res).toEqual({ ok: true, hasPrice: false });
    expect(builder.limit).not.toHaveBeenCalled();
  });
});
