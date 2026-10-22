/**
 * Pipeline > Estimates card view (owner-approved scope "A", 2026-10-22):
 *  - GET /admin/estimates rows carry `perApplication` (recurring per-application
 *    lines from the same normalizeProposal authority the PDF reads) and
 *    `hasAcceptanceRecord` (one batched estimate_acceptances query).
 *  - GET /admin/estimates/:id/acceptance serves the recorded acceptance to the
 *    owner only, 404 when there is none.
 * Synthetic data only.
 */
jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.raw = jest.fn((expr) => expr);
  mockDb.fn = { now: jest.fn(() => 'NOW()') };
  mockDb.schema = { hasTable: jest.fn(async () => true), hasColumn: jest.fn(async () => true) };
  return mockDb;
});
const mockAuth = { role: 'admin' };
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
  requireAdmin: (req, res, next) => (mockAuth.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(async (url) => url) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: jest.fn() }));
jest.mock('../services/estimate-lead-linkage', () => ({ leadIdForEstimate: jest.fn(async () => null) }));
jest.mock('../services/estimate-delivery-options', () => ({
  estimateDataHasQuoteRequirement: jest.fn(() => false),
  estimateDataHasUnresolvedManagerApproval: jest.fn(() => false),
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
  estimateExpiresAt: jest.fn(),
  estimateViewUrl: jest.fn(),
}));
jest.mock('../routes/estimate-public', () => ({
  acceptanceServiceLists: jest.fn(),
  buildPricingBundle: jest.fn(async () => ({})),
  bookingServiceFor: jest.fn(),
}));
jest.mock('../services/email-template-library', () => ({ sendTemplate: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: jest.fn(() => true) }));
jest.mock('../services/automation-runner', () => ({ enrollCustomer: jest.fn() }));
jest.mock('../services/slot-reservation', () => ({ releaseReservation: jest.fn() }));
const mockBilling = { lane: new Map() };
jest.mock('../services/estimate-proposal-billing', () => ({
  estimateBillsPerApplication: jest.fn(async (row) => (mockBilling.lane.has(row.id) ? mockBilling.lane.get(row.id) : true)),
  resolveProposalBillingContext: jest.fn(async () => ({ billsPerApplication: true, livePricing: null })),
}));

const express = require('express');
const db = require('../models/db');
const router = require('../routes/admin-estimates');

const pestBundle = {
  frequencies: [{ key: 'quarterly', perTreatment: 94, visitsPerYear: 4, monthly: 31.33, annual: 376 }],
};
const comboBundle = {
  combinedRecurring: { waveGuardDiscountPct: 0.1 },
  frequencies: [{
    key: 'quarterly', monthly: 72.3, annual: 867.6,
    perServiceTreatments: [
      { label: 'Lawn Care', service: 'lawn_care', displayPrice: 56.4, visitsPerYear: 9, monthly: 42.3 },
      { label: 'Pest Control', service: 'pest_control', displayPrice: 90, visitsPerYear: 4, monthly: 30 },
    ],
  }],
};
const base = (id, over = {}) => ({
  id, category: 'RESIDENTIAL', status: 'sent', address: '1 Sample St', service_interest: 'Pest Control',
  monthly_total: '31.33', annual_total: '376.00', onetime_total: '0', token: `tok-${id}`,
  created_at: '2026-10-01T00:00:00Z', sent_at: '2026-10-01T00:00:00Z',
  estimate_data: { sendSnapshot: { pricingBundle: pestBundle } },
  ...over,
});

function tableDb({ estimates, acceptances = [], single = {}, prepaid = [] }) {
  const queries = [];
  const builderFor = (table) => {
    const b = {};
    const chain = ['where', 'whereIn', 'whereNot', 'whereNull', 'whereNotNull', 'whereNotIn', 'whereILike', 'orWhereIn', 'orWhere',
      'select', 'orderBy', 'limit', 'offset', 'leftJoin', 'groupBy', 'sum', 'max', 'distinct'];
    for (const m of chain) {
      b[m] = jest.fn((...args) => {
        queries.push({ table, m, args });
        if (typeof args[0] === 'function') args[0].call(b, b);
        return b;
      });
    }
    b.first = jest.fn(async () => single[table]);
    const rows = { estimates, estimate_acceptances: acceptances, annual_prepay_terms: prepaid }[table] || [];
    b.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
    return b;
  };
  db.mockImplementation((table) => builderFor(table));
  return queries;
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/estimates', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((r) => server.close(r)); }
}

describe('perApplicationLinesForRow', () => {
  const { perApplicationLinesForRow } = router._internals;

  test('single service gives one line with price and visit count', () => {
    const row = base('e1');
    expect(perApplicationLinesForRow(row, row.estimate_data)).toEqual([
      { label: 'Pest Control', amount: 94, visitsPerYear: 4 },
    ]);
  });

  test('multi service gives one line per service, net of the bundle discount', () => {
    const row = base('e2', {
      monthly_total: '72.30', annual_total: '867.60',
      estimate_data: { sendSnapshot: { pricingBundle: comboBundle } },
    });
    const lines = perApplicationLinesForRow(row, row.estimate_data);
    expect(lines.map((l) => [l.label, l.amount, l.visitsPerYear])).toEqual([
      ['Lawn Care', 56.4, 9], ['Pest Control', 90, 4],
    ]);
  });

  test.each([
    ['no frozen snapshot', { estimate_data: {} }],
    ['commercial category', { category: 'COMMERCIAL' }],
    ['quote required', { quote_required: true }],
    ['no monthly total (one-time only)', { monthly_total: '0', onetime_total: '250' }],
    ['stored totals no longer match the snapshot', { monthly_total: '40.00', annual_total: '480.00' }],
  ])('returns null for %s', (_name, over) => {
    const row = base('e3', over);
    expect(perApplicationLinesForRow(row, row.estimate_data)).toBeNull();
  });

  test('a commercial proposal row gives null', () => {
    const data = { proposal: { enabled: true, buildings: [{ name: 'A', lineItems: [{ description: 'x', unitPrice: 10, frequency: 'monthly' }] }] } };
    const row = base('e4', { estimate_data: data });
    expect(perApplicationLinesForRow(row, data)).toBeNull();
  });

  test('never throws on a malformed row', () => {
    expect(perApplicationLinesForRow(null, null)).toBeNull();
    expect(perApplicationLinesForRow({ id: 'x', monthly_total: '5', estimate_data: { proposal: { buildings: 'bad' } } }, {})).toBeNull();
  });
});

describe('GET /admin/estimates list shape', () => {
  beforeEach(() => { jest.clearAllMocks(); mockAuth.role = 'admin'; mockBilling.lane = new Map(); });

  test('adds perApplication and hasAcceptanceRecord; isolates each row', async () => {
    const rows = [
      base('e-sent'),
      base('e-acc', { status: 'accepted', terms_version: 'v1' }),
      base('e-won', { status: 'accepted', terms_version: null }),
      base('e-prepay'),
      base('e-monthly'),
      base('e-bad', { estimate_data: '{not json' }),
    ];
    mockBilling.lane.set('e-monthly', false);
    const queries = tableDb({
      estimates: rows,
      acceptances: [{ estimate_id: 'e-acc' }],
      prepaid: [{ source_estimate_id: 'e-prepay' }],
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates?limit=all`);
      expect(res.status).toBe(200);
      const { estimates } = await res.json();
      const byId = Object.fromEntries(estimates.map((e) => [e.id, e]));
      expect(byId['e-sent'].perApplication).toEqual([{ label: 'Pest Control', amount: 94, visitsPerYear: 4 }]);
      expect(byId['e-sent'].monthlyTotal).toBe(31.33);
      expect(byId['e-sent'].hasAcceptanceRecord).toBe(false);
      expect(byId['e-acc'].perApplication).toHaveLength(1);
      expect(byId['e-acc'].hasAcceptanceRecord).toBe(true);
      // staff Mark Won: accepted but no terms_version, so no record
      expect(byId['e-won'].hasAcceptanceRecord).toBe(false);
      expect(byId['e-prepay'].perApplication).toBeNull();
      expect(byId['e-monthly'].perApplication).toBeNull();
      expect(byId['e-bad'].perApplication).toBeNull();
    });
    // one batched acceptance query, not one per row
    expect(queries.filter((q) => q.table === 'estimate_acceptances' && q.m === 'whereIn')).toHaveLength(1);
  });
});

describe('GET /admin/estimates/:id/acceptance', () => {
  beforeEach(() => { jest.clearAllMocks(); mockAuth.role = 'admin'; });

  test('serves the recorded acceptance', async () => {
    tableDb({
      estimates: [],
      single: {
        estimates: { id: 'e-acc', status: 'accepted', terms_version: 'v1' },
        estimate_acceptances: {
          id: 'abcdef12-0000', terms_version: 'v1', terms_text: 'Sample terms text.',
          accepted_at: '2026-10-02T15:00:00Z', ip: '203.0.113.9',
          user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 Version/17.0 Mobile Safari/604',
        },
      },
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/e-acc/acceptance`);
      expect(res.status).toBe(200);
      const { acceptance } = await res.json();
      expect(acceptance).toMatchObject({ termsVersion: 'v1', termsText: 'Sample terms text.', acceptedAt: '2026-10-02T15:00:00Z' });
      expect(acceptance.device).toMatch(/iPhone/);
    });
  });

  test('404 when the estimate has no acceptance record', async () => {
    tableDb({ estimates: [], single: { estimates: { id: 'e-won', status: 'accepted', terms_version: null } } });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/e-won/acceptance`);
      expect(res.status).toBe(404);
    });
  });

  test('404 for an unknown estimate', async () => {
    tableDb({ estimates: [], single: {} });
    await withServer(async (baseUrl) => {
      expect((await fetch(`${baseUrl}/estimates/nope/acceptance`)).status).toBe(404);
    });
  });

  test('a non-owner role is refused (403)', async () => {
    mockAuth.role = 'technician';
    tableDb({ estimates: [], single: { estimates: { id: 'e-acc', status: 'accepted', terms_version: 'v1' } } });
    await withServer(async (baseUrl) => {
      expect((await fetch(`${baseUrl}/estimates/e-acc/acceptance`)).status).toBe(403);
    });
  });
});
