/**
 * Pipeline > Estimates card view (owner-approved scope "A", 2026-10-22):
 *  - GET /admin/estimates rows carry `perApplication` (recurring per-application
 *    lines from the same normalizeProposal authority the PDF reads),
 *    `hasAcceptanceRecord` (one batched estimate_acceptances query) and
 *    `staffPreviewable` (whether the staff preview renders the row).
 *  - GET /admin/estimates/:id/acceptance serves the recorded acceptance to the
 *    owner only, 404 when there is none, 500 when the read fails.
 *  - The rows' outline summaries keep lawn, Tree & Shrub, Pest Control and
 *    Mosquito packets apart (GATE_TS_OUTLINE, GATE_PEST_OUTLINE,
 *    GATE_MOSQUITO_OUTLINE, owner 2026-10-26).
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
  // the real recursive check: the card must use the same one the send gate uses
  estimateDataHasQuoteRequirement: jest.requireActual('../services/estimate-delivery-options').estimateDataHasQuoteRequirement,
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
const mockPhone = { verdicts: new Map() };
const mockView = { draftPreview: new Set(), customerViewable: new Set(), snapshotRejected: new Set() };
jest.mock('../routes/estimate-public', () => ({
  // the batch phone matcher is tested against the real per-row matcher in estimate-public-accept-phone-match.test.js
  matchAcceptCustomersByPhoneBatch: jest.fn(async () => mockPhone.verdicts),
  // the /data gate's row verdicts (their rules: estimate-public-viewability.test.js)
  adminDraftPreviewEligible: jest.fn((row, param) => param === '1' && mockView.draftPreview.has(row.id)),
  isEstimateCustomerViewable: jest.fn((row) => mockView.customerViewable.has(row.id)),
  // stand-in for "can still be accepted" (the real rules: estimate-public-viewability.test.js)
  isEstimateAcceptActive: jest.fn((row) => ['sent', 'viewed'].includes(row.status) && !row.archived_at),
  // stand-in for the page's fast-path predicate (extracted from buildPricingBundleInner, unchanged)
  sentSnapshotServesAsIs: jest.fn((bundle, row) => !mockView.snapshotRejected.has(row.id)),
  acceptanceServiceLists: jest.fn(),
  buildPricingBundle: jest.fn(async () => ({})),
  bookingServiceFor: jest.fn(),
}));
const mockGroup = { owners: new Map() };
jest.mock('../services/recurring-card-on-file', () => ({
  // the batch owner pick is tested in estimate-public-accept-phone-match.test.js
  resolveGroupedEstimateOwnerIds: jest.fn(async () => mockGroup.owners),
}));
jest.mock('../services/email-template-library', () => ({ sendTemplate: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: jest.fn(() => true) }));
jest.mock('../services/automation-runner', () => ({ enrollCustomer: jest.fn() }));
jest.mock('../services/slot-reservation', () => ({ releaseReservation: jest.fn() }));
jest.mock('../services/estimate-proposal-billing', () => ({
  // the real send-time lane read (unit tests: estimate-proposal-billing.test.js)
  sentBundleBillsPerApplication: jest.requireActual('../services/estimate-proposal-billing').sentBundleBillsPerApplication,
  estimateIsPriceLocked: jest.requireActual('../services/estimate-proposal-billing').estimateIsPriceLocked,
  perApplicationBillingColumnsExist: jest.fn(async () => true),
  resolveFrozenBillingContext: jest.fn(async () => ({ billsPerApplication: true, livePricing: null })),
  estimateBillsPerApplication: jest.fn(async () => { throw new Error('per-row lane lookup must not run on the list'); }),
  resolveProposalBillingContext: jest.fn(async () => ({ billsPerApplication: true, livePricing: null })),
}));

const mockGeneratePdf = jest.fn((estimate, res) => res.status(200).end());
jest.mock('../services/pdf/estimate-pdf', () => ({ generateEstimateProposalPDF: (...a) => mockGeneratePdf(...a) }));
// no browser here: a viewable row's browser render fails and falls through to pdfkit, as the route allows
const mockRenderDocPdf = jest.fn(async () => { throw new Error('no browser in tests'); });
jest.mock('../services/pdf/estimate-doc-pdf', () => ({
  renderEstimateDocumentPdf: (...a) => mockRenderDocPdf(...a),
  sanitizeRenderError: (e) => e.message,
}));

const express = require('express');
const db = require('../models/db');
const router = require('../routes/admin-estimates');

// Sent in the per-application lane: the bundle keeps its billedPerApplication flags (a monthly-billed send strips them).
const pestBundle = {
  frequencies: [{ key: 'quarterly', perTreatment: 94, visitsPerYear: 4, monthly: 31.33, annual: 376, billedPerApplication: true }],
};
const comboBundle = {
  combinedRecurring: { waveGuardDiscountPct: 0.1 },
  frequencies: [{
    key: 'quarterly', monthly: 72.3, annual: 867.6, billedPerApplication: true,
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

function tableDb({ estimates, acceptances = [], single = {}, prepaid = [], customers = [], outlines = [] }) {
  const queries = [];
  const builderFor = (table) => {
    const b = {};
    const chain = ['where', 'whereIn', 'whereNot', 'whereNull', 'whereNotNull', 'whereNotIn', 'whereILike', 'orWhereIn', 'orWhere',
      'select', 'orderBy', 'limit', 'offset', 'leftJoin', 'groupBy', 'sum', 'max', 'count', 'distinct'];
    for (const m of chain) {
      b[m] = jest.fn((...args) => {
        queries.push({ table, m, args });
        if (typeof args[0] === 'function') args[0].call(b, b);
        return b;
      });
    }
    b.first = jest.fn(async () => single[table]);
    const rows = { estimates, estimate_acceptances: acceptances, annual_prepay_terms: prepaid, customers, service_outline_packets: outlines }[table] || [];
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
    ['quote required nested in the stored result', {
      estimate_data: {
        sendSnapshot: { pricingBundle: pestBundle },
        result: { recurring: { services: [{ name: 'Pest', quoteRequired: true }] } },
      },
    }],
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
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.role = 'admin';
    mockGroup.owners = new Map();
    mockView.draftPreview = new Set();
    mockView.customerViewable = new Set();
    mockView.snapshotRejected = new Set();
  });

  test('adds perApplication and hasAcceptanceRecord; isolates each row', async () => {
    const rows = [
      base('e-sent', { customer_id: 'c-plain' }),
      base('e-acc', { status: 'accepted', terms_version: 'v1', customer_id: 'c-plain' }),
      base('e-unlinked'),
      base('e-unlinked-member'),
      base('e-unlinked-unknown'),
      base('e-won', { status: 'accepted', terms_version: null }),
      base('e-prepay'),
      base('e-monthly', { customer_id: 'c-member' }),
      base('e-linked', { customer_id: 'c-plain' }),
      base('e-bad', { estimate_data: '{not json' }),
    ];
    mockPhone.verdicts = new Map([
      ['e-unlinked', { match: null, candidateCount: 0 }],
      ['e-unlinked-member', { match: { id: 'c-m', pipeline_stage: 'active_customer', monthly_rate: '50', billing_mode: null }, candidateCount: 1 }],
    ]);
    const queries = tableDb({
      customers: [
        { id: 'c-member', pipeline_stage: 'active_customer', monthly_rate: '50', billing_mode: null },
        { id: 'c-plain', pipeline_stage: 'lead', monthly_rate: '0', billing_mode: 'per_application' },
      ],
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
      expect(byId['e-linked'].perApplication).toHaveLength(1);
      // Unlinked, no phone match: the accept would bill per application, so the price shows.
      expect(byId['e-unlinked'].perApplication).toHaveLength(1);
      // Unlinked, phone-matches a monthly member: monthly billing, today's display.
      expect(byId['e-unlinked-member'].perApplication).toBeNull();
      // Unlinked and not judged by the batch matcher: unknown, today's display.
      expect(byId['e-unlinked-unknown'].perApplication).toBeNull();
      expect(byId['e-bad'].perApplication).toBeNull();
    });
    // one batch phone match for every unlinked row, not one call per row
    const phoneBatch = require('../routes/estimate-public').matchAcceptCustomersByPhoneBatch;
    expect(phoneBatch).toHaveBeenCalledTimes(1);
    // e-won is accepted: it shows the lane it was sent in and is not phone-matched
    expect(phoneBatch.mock.calls[0][0].map((r) => r.id).sort()).toEqual(['e-unlinked', 'e-unlinked-member', 'e-unlinked-unknown'].sort());
    // constant queries: one customers read for every linked row, no per-row lane lookup
    expect(queries.filter((q) => q.table === 'customers' && q.m === 'whereIn')).toHaveLength(1);
    expect(queries.filter((q) => q.table === 'customers')).toHaveLength(2); // whereIn + select
    expect(require('../services/estimate-proposal-billing').estimateBillsPerApplication).not.toHaveBeenCalled();
    // one batched acceptance query, not one per row
    expect(queries.filter((q) => q.table === 'estimate_acceptances' && q.m === 'whereIn')).toHaveLength(1);
  });

  test('an unlinked grouped row takes its sibling owner\'s lane before any phone match', async () => {
    // the accept resolves a grouped estimate through its linked sibling first (resolveProspectiveAcceptCustomer)
    mockGroup.owners = new Map([['e-group-member', 'c-member'], ['e-group-plain', 'c-plain']]);
    mockPhone.verdicts = new Map([['e-lone', { match: null, candidateCount: 0 }]]);
    tableDb({
      customers: [
        { id: 'c-member', pipeline_stage: 'active_customer', monthly_rate: '50', billing_mode: null },
        { id: 'c-plain', pipeline_stage: 'lead', monthly_rate: '0', billing_mode: 'per_application' },
      ],
      estimates: [
        base('e-group-member', { estimate_group_id: 'g1' }),
        base('e-group-plain', { estimate_group_id: 'g2' }),
        base('e-lone'),
      ],
    });
    await withServer(async (baseUrl) => {
      const { estimates } = await (await fetch(`${baseUrl}/estimates?limit=all`)).json();
      const byId = Object.fromEntries(estimates.map((e) => [e.id, e]));
      // the sibling's owner keeps monthly membership, so accepting keeps monthly billing
      expect(byId['e-group-member'].perApplication).toBeNull();
      expect(byId['e-group-plain'].perApplication).toHaveLength(1);
      expect(byId['e-lone'].perApplication).toHaveLength(1);
    });
    const ownerBatch = require('../services/recurring-card-on-file').resolveGroupedEstimateOwnerIds;
    expect(ownerBatch).toHaveBeenCalledTimes(1);
    // only the row without a sibling owner is phone-matched
    const phoneBatch = require('../routes/estimate-public').matchAcceptCustomersByPhoneBatch;
    expect(phoneBatch.mock.calls[0][0].map((r) => r.id)).toEqual(['e-lone']);
  });

  test('a quote that can no longer be accepted shows the lane it was sent in, not today\'s', async () => {
    const strippedBundle = { frequencies: [{ ...pestBundle.frequencies[0], billedPerApplication: undefined }] };
    const queries = tableDb({
      customers: [
        { id: 'c-member', pipeline_stage: 'active_customer', monthly_rate: '50', billing_mode: null },
        { id: 'c-plain', pipeline_stage: 'lead', monthly_rate: '0', billing_mode: 'per_application' },
      ],
      estimates: [
        // sent per application; the customer has since joined monthly membership
        base('e-acc-now-member', { status: 'accepted', customer_id: 'c-member' }),
        // sent while the customer was billed monthly (flags stripped); the customer is per-application today
        base('e-exp-sent-monthly', { status: 'expired', customer_id: 'c-plain', estimate_data: { sendSnapshot: { pricingBundle: strippedBundle } } }),
        base('e-archived', { archived_at: '2026-10-01T00:00:00Z', customer_id: 'c-member' }),
        // still open: today's lane decides
        base('e-open-member', { customer_id: 'c-member' }),
      ],
    });
    await withServer(async (baseUrl) => {
      const { estimates } = await (await fetch(`${baseUrl}/estimates?limit=all`)).json();
      const byId = Object.fromEntries(estimates.map((e) => [e.id, e]));
      expect(byId['e-acc-now-member'].perApplication).toHaveLength(1);
      expect(byId['e-exp-sent-monthly'].perApplication).toBeNull();
      expect(byId['e-archived'].perApplication).toHaveLength(1);
      expect(byId['e-open-member'].perApplication).toBeNull();
    });
    // only the open row's customer is read for today's lane
    const customerReads = queries.filter((q) => q.table === 'customers' && q.m === 'whereIn');
    expect(customerReads.map((q) => q.args[1])).toEqual([['c-member']]);
  });

  test('an open offer shows its price only while the page still sells that exact snapshot in that lane', async () => {
    const strippedBundle = { frequencies: [{ ...pestBundle.frequencies[0], billedPerApplication: undefined }] };
    mockView.snapshotRejected = new Set(['e-open-rejected']);
    // the call is gone, so the /data gate refuses this sent offer: it is closed, and shows its send-time lane
    mockView.customerViewable = new Set(['e-open-blocked']);
    tableDb({
      customers: [
        { id: 'c-member', pipeline_stage: 'active_customer', monthly_rate: '50', billing_mode: null },
        { id: 'c-plain', pipeline_stage: 'lead', monthly_rate: '0', billing_mode: 'per_application' },
      ],
      estimates: [
        base('e-open-ok', { customer_id: 'c-plain' }),
        // e.g. a retired lawn cadence: the page rebuilds this offer from live pricing
        base('e-open-rejected', { customer_id: 'c-plain' }),
        // sent while the customer was billed monthly; per-application today (the page reconciles it)
        base('e-open-lapsed', { customer_id: 'c-plain', estimate_data: { sendSnapshot: { pricingBundle: strippedBundle } } }),
        base('e-open-blocked', {
          customer_id: 'c-member',
          estimate_data: { sendSnapshot: { pricingBundle: pestBundle }, estimatorEngine: { callLogId: 'call-gone' } },
        }),
      ],
    });
    await withServer(async (baseUrl) => {
      const { estimates } = await (await fetch(`${baseUrl}/estimates?limit=all`)).json();
      const byId = Object.fromEntries(estimates.map((e) => [e.id, e]));
      expect(byId['e-open-ok'].perApplication).toHaveLength(1);
      expect(byId['e-open-rejected'].perApplication).toBeNull();
      expect(byId['e-open-lapsed'].perApplication).toBeNull();
      expect(byId['e-open-blocked'].perApplication).toHaveLength(1);
      expect(byId['e-open-blocked'].staffPreviewable).toBe(false);
    });
  });

  test('staffPreviewable is the /data gate verdict: the row verdicts, then the call-side verdict', async () => {
    mockView.draftPreview = new Set(['e-draft']);
    mockView.customerViewable = new Set(['e-open', 'e-call']);
    const queries = tableDb({
      estimates: [
        base('e-open'), base('e-held'), base('e-draft', { status: 'draft' }),
        // drafted from a call that is gone: the call-side verdict blocks it (call_missing)
        base('e-call', { estimate_data: { sendSnapshot: { pricingBundle: pestBundle }, estimatorEngine: { callLogId: 'call-gone' } } }),
      ],
    });
    await withServer(async (baseUrl) => {
      const { estimates } = await (await fetch(`${baseUrl}/estimates?limit=all`)).json();
      const byId = Object.fromEntries(estimates.map((e) => [e.id, e]));
      expect(byId['e-open'].staffPreviewable).toBe(true);
      // e.g. held for a re-price: the public page 404s it even for staff
      expect(byId['e-held'].staffPreviewable).toBe(false);
      expect(byId['e-draft'].staffPreviewable).toBe(true);
      expect(byId['e-call'].staffPreviewable).toBe(false);
    });
    // one batched call_log read for the page (callSideBlocksForEstimates), not one per row
    expect(queries.filter((q) => q.table === 'call_log' && q.m === 'whereIn')).toHaveLength(1);
  });

  test('bookingLinkEligible mirrors the send-booking-link route\'s row refusals', async () => {
    const lists = require('../routes/estimate-public').acceptanceServiceLists;
    const approval = require('../services/estimate-delivery-options').estimateDataHasUnresolvedManagerApproval;
    // Stand-ins keyed off the fixture: the one-time line the route pre-selects, and an open approval.
    lists.mockImplementation((data) => ({ oneTimeList: data?.qaOneTime ? [{ name: data.qaOneTime }] : [] }));
    approval.mockImplementation((data) => !!data?.qaNeedsApproval);
    const oneTime = { qaOneTime: 'Ant Treatment' };
    tableDb({
      estimates: [
        base('e-recurring'),
        base('e-bundle', { estimate_data: oneTime }),
        base('e-onetime', { monthly_total: '0', onetime_total: '400', estimate_data: oneTime }),
        base('e-accepted', { status: 'accepted', monthly_total: '0', onetime_total: '400', estimate_data: oneTime }),
        base('e-invoice', { monthly_total: '0', onetime_total: '400', bill_by_invoice: true, estimate_data: oneTime }),
        base('e-draft', { status: 'draft', monthly_total: '0', onetime_total: '400', estimate_data: oneTime }),
        base('e-expired', { status: 'expired', monthly_total: '0', onetime_total: '400', estimate_data: oneTime }),
        base('e-approval', { monthly_total: '0', onetime_total: '400', estimate_data: { ...oneTime, qaNeedsApproval: true } }),
      ],
    });
    try {
      await withServer(async (baseUrl) => {
        const { estimates } = await (await fetch(`${baseUrl}/estimates?limit=all`)).json();
        const eligible = Object.fromEntries(estimates.map((e) => [e.id, e.bookingLinkEligible]));
        expect(eligible).toEqual({
          // recurring-only offers route through onboarding, never /book
          'e-recurring': false,
          'e-bundle': true,
          'e-onetime': true,
          'e-accepted': true,
          'e-invoice': false,
          'e-draft': false,
          'e-expired': false,
          'e-approval': false,
        });
      });
    } finally {
      lists.mockReset();
      approval.mockImplementation(() => false);
    }
  });
});

describe('GET /admin/estimates outline summaries', () => {
  const saved = process.env.GATE_TS_OUTLINE;
  beforeEach(() => { jest.clearAllMocks(); mockAuth.role = 'admin'; });
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_TS_OUTLINE; else process.env.GATE_TS_OUTLINE = saved;
  });

  // Newest first, as the route orders them: the Tree & Shrub packet is newer than the lawn one.
  const outline = (id, serviceLine, createdAt, over = {}) => ({
    id, estimate_id: 'e-ts', service_line: serviceLine, status: 'sent', validation_status: 'passed', created_at: createdAt,
    summary_json: {}, content_json: {}, template_version: 'mvp-1', product_registry_version: 'public-facts-v1', ...over,
  });
  const rows = () => [
    base('e-ts', { service_interest: 'Lawn Care + Tree & Shrub' }),
    base('e-pest', { service_interest: 'Pest Control' }),
  ];
  const outlines = [
    outline('ts-packet', 'tree_shrub', '2026-10-26T12:00:00Z', { content_library_version: 'ts-v1-copy-1', protocol_version: 'old-ts-protocol' }),
    outline('lawn-packet', 'lawn_care', '2026-10-25T12:00:00Z'),
  ];

  test('off: a newer Tree & Shrub packet never stands in for the lawn outline, and no Tree & Shrub key is sent', async () => {
    delete process.env.GATE_TS_OUTLINE;
    tableDb({ estimates: rows(), outlines });
    await withServer(async (baseUrl) => {
      const { estimates } = await (await fetch(`${baseUrl}/estimates?limit=all`)).json();
      const byId = Object.fromEntries(estimates.map((e) => [e.id, e]));
      expect(byId['e-ts'].lawnServiceOutline.id).toBe('lawn-packet');
      expect(byId['e-ts']).not.toHaveProperty('treeShrubOutlineAvailable');
      expect(byId['e-ts']).not.toHaveProperty('treeShrubServiceOutline');
    });
  });

  test('on: a Tree & Shrub estimate offers its outline, with its own stale check', async () => {
    process.env.GATE_TS_OUTLINE = 'true';
    tableDb({ estimates: rows(), outlines });
    await withServer(async (baseUrl) => {
      const { estimates } = await (await fetch(`${baseUrl}/estimates?limit=all`)).json();
      const byId = Object.fromEntries(estimates.map((e) => [e.id, e]));
      expect(byId['e-ts'].lawnServiceOutline.id).toBe('lawn-packet');
      expect(byId['e-ts'].treeShrubOutlineAvailable).toBe(true);
      expect(byId['e-ts'].treeShrubServiceOutline).toEqual(expect.objectContaining({
        id: 'ts-packet',
        currentContentLibraryVersion: 'ts-v1-copy-1',
        staleReasons: ['protocol updated'],
      }));
      expect(byId['e-pest'].treeShrubOutlineAvailable).toBe(false);
      expect(byId['e-pest'].treeShrubServiceOutline).toBeNull();
    });
  });
});

describe('GET /admin/estimates Pest Control outline (GATE_PEST_OUTLINE)', () => {
  const saved = process.env.GATE_PEST_OUTLINE;
  beforeEach(() => { jest.clearAllMocks(); mockAuth.role = 'admin'; });
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_PEST_OUTLINE; else process.env.GATE_PEST_OUTLINE = saved;
  });

  test('on: a recurring pest plan offers the outline and keeps its packet apart; a one-time pest job is not offered', async () => {
    process.env.GATE_PEST_OUTLINE = 'true';
    tableDb({
      estimates: [
        base('e-recurring', { service_interest: 'Pest Control', monthly_total: '45.00' }),
        base('e-one-time', { service_interest: 'Pest Control', monthly_total: '0', onetime_total: '189.00' }),
      ],
      outlines: [
        { id: 'pest-packet', estimate_id: 'e-recurring', service_line: 'pest_control', status: 'sent', validation_status: 'passed', created_at: '2026-10-26T12:00:00Z', summary_json: {}, content_json: {}, content_library_version: 'pest-v1-copy-1', template_version: 'mvp-1', product_registry_version: 'public-facts-v1', protocol_version: null },
      ],
    });
    await withServer(async (baseUrl) => {
      const { estimates } = await (await fetch(`${baseUrl}/estimates?limit=all`)).json();
      const byId = Object.fromEntries(estimates.map((e) => [e.id, e]));
      expect(byId['e-recurring'].pestOutlineAvailable).toBe(true);
      expect(byId['e-recurring'].pestServiceOutline).toEqual(expect.objectContaining({ id: 'pest-packet', stale: false, staleReasons: [] }));
      expect(byId['e-recurring'].lawnServiceOutline).toBeNull();
      expect(byId['e-one-time'].pestOutlineAvailable).toBe(false);
    });
  });

  test('off: no Pest Control key is sent', async () => {
    delete process.env.GATE_PEST_OUTLINE;
    tableDb({ estimates: [base('e-recurring', { service_interest: 'Pest Control', monthly_total: '45.00' })] });
    await withServer(async (baseUrl) => {
      const { estimates } = await (await fetch(`${baseUrl}/estimates?limit=all`)).json();
      expect(estimates[0]).not.toHaveProperty('pestOutlineAvailable');
      expect(estimates[0]).not.toHaveProperty('pestServiceOutline');
    });
  });
});

describe('GET /admin/estimates Mosquito outline (GATE_MOSQUITO_OUTLINE)', () => {
  const saved = process.env.GATE_MOSQUITO_OUTLINE;
  beforeEach(() => { jest.clearAllMocks(); mockAuth.role = 'admin'; });
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_MOSQUITO_OUTLINE; else process.env.GATE_MOSQUITO_OUTLINE = saved;
  });
  const withRows = (services, oneTimeItems = []) => ({ result: { recurring: { services }, oneTime: { items: oneTimeItems } } });

  test('on: only an exact recurring mosquito row offers the outline, and its packet stays apart', async () => {
    process.env.GATE_MOSQUITO_OUTLINE = 'true';
    tableDb({
      estimates: [
        base('e-program', { service_interest: 'Mosquito', monthly_total: '55.00', estimate_data: withRows([{ service: 'mosquito', addOns: { dunkCount: 1, stationCount: 0 } }]) }),
        base('e-one-time', { service_interest: 'One-Time Mosquito', monthly_total: '0', onetime_total: '149.00', estimate_data: withRows([], [{ service: 'one_time_mosquito', price: 149 }]) }),
        base('e-misting', { service_interest: 'Mosquito misting', monthly_total: '90.00', estimate_data: withRows([{ service: 'mosquito_misting' }]) }),
        base('e-commercial', { service_interest: 'Commercial Mosquito', monthly_total: '300.00', estimate_data: withRows([{ service: 'commercial_mosquito' }]) }),
        base('e-pest-beside-one-time', { service_interest: 'Pest Control, Mosquito', monthly_total: '45.00', estimate_data: withRows([{ service: 'pest_control' }], [{ service: 'one_time_mosquito', price: 149 }]) }),
        // A server reprice removed every service: the empty result wins over the older priced engine result.
        base('e-server-repriced', { service_interest: 'Mosquito', monthly_total: '55.00', pricing_authority: 'SERVER', estimate_data: { result: { recurring: { services: [] } }, engineResult: { recurring: { services: [{ service: 'mosquito' }] } } } }),
      ],
      outlines: [
        { id: 'mosquito-packet', estimate_id: 'e-program', service_line: 'mosquito', status: 'sent', validation_status: 'passed', created_at: '2026-10-26T12:00:00Z', summary_json: {}, content_json: {}, content_library_version: 'mosquito-v1-copy-1', template_version: 'mvp-1', product_registry_version: 'public-facts-v1', protocol_version: null },
      ],
    });
    await withServer(async (baseUrl) => {
      const { estimates } = await (await fetch(`${baseUrl}/estimates?limit=all`)).json();
      const byId = Object.fromEntries(estimates.map((e) => [e.id, e]));
      expect(byId['e-program'].mosquitoOutlineAvailable).toBe(true);
      expect(byId['e-program'].mosquitoServiceOutline).toEqual(expect.objectContaining({ id: 'mosquito-packet', stale: false, staleReasons: [] }));
      expect(byId['e-program'].lawnServiceOutline).toBeNull();
      for (const id of ['e-one-time', 'e-misting', 'e-commercial', 'e-pest-beside-one-time', 'e-server-repriced']) expect({ id, offered: byId[id].mosquitoOutlineAvailable }).toEqual({ id, offered: false });
    });
  });

  test('off: no Mosquito key is sent', async () => {
    delete process.env.GATE_MOSQUITO_OUTLINE;
    tableDb({ estimates: [base('e-program', { service_interest: 'Mosquito', monthly_total: '55.00', estimate_data: withRows([{ service: 'mosquito' }]) })] });
    await withServer(async (baseUrl) => {
      const { estimates } = await (await fetch(`${baseUrl}/estimates?limit=all`)).json();
      expect(estimates[0]).not.toHaveProperty('mosquitoOutlineAvailable');
      expect(estimates[0]).not.toHaveProperty('mosquitoServiceOutline');
    });
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

  test('a failed record read is a server error, not a missing record', async () => {
    tableDb({ estimates: [], single: { estimates: { id: 'e-acc', status: 'accepted', terms_version: 'v1' } } });
    const tables = db.getMockImplementation();
    db.mockImplementation((table) => {
      const b = tables(table);
      if (table === 'estimate_acceptances') b.first = jest.fn(async () => { throw new Error('connection reset'); });
      return b;
    });
    await withServer(async (baseUrl) => {
      expect((await fetch(`${baseUrl}/estimates/e-acc/acceptance`)).status).toBe(500);
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

describe('GET /admin/estimates/:id/proposal.pdf billing context', () => {
  const billing = () => require('../services/estimate-proposal-billing');
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.role = 'admin';
    mockView.customerViewable = new Set();
  });

  test.each([
    ['expired', { status: 'expired' }],
    // a resend failed, but an earlier send delivered this bundle
    ['send_failed', { status: 'send_failed' }],
    ['archived', { status: 'sent', archived_at: '2026-10-01T00:00:00Z' }],
    // the expiry sweep has not run yet: still 'sent', but the public page refuses it
    ['date-expired', { status: 'sent', expires_at: '2026-01-01T00:00:00Z' }],
    // still 'sent', but held for a re-price (or invalidated): the public page refuses it too
    ['held', { status: 'sent' }],
  ])('a %s quote is rendered from the frozen send snapshot, never repriced live', async (_name, over) => {
    tableDb({ estimates: [], single: { estimates: base('e-old', over) } });
    await withServer(async (baseUrl) => {
      expect((await fetch(`${baseUrl}/estimates/e-old/proposal.pdf`)).status).toBe(200);
    });
    // judged by the public page's own predicate, so no browser render is tried for it
    expect(require('../routes/estimate-public').isEstimateCustomerViewable).toHaveBeenCalledWith(expect.objectContaining({ id: 'e-old' }));
    expect(mockRenderDocPdf).not.toHaveBeenCalled();
    expect(billing().resolveFrozenBillingContext).toHaveBeenCalledTimes(1);
    expect(billing().resolveProposalBillingContext).not.toHaveBeenCalled();
    expect(mockGeneratePdf.mock.calls[0][2]).toMatchObject({ billsPerApplication: true, livePricing: null });
  });

  test.each([
    ['draft', { status: 'draft' }],
    ['scheduled', { status: 'scheduled' }],
    ['archived draft', { status: 'draft', archived_at: '2026-10-01T00:00:00Z' }],
    // the first send failed on every channel, so no send bundle was written
    ['never-delivered send_failed', { status: 'send_failed', estimate_data: {} }],
  ])('a %s row keeps the live billing lane: no delivered offer to freeze to', async (_name, over) => {
    tableDb({ estimates: [], single: { estimates: base('e-draft', over) } });
    await withServer(async (baseUrl) => {
      expect((await fetch(`${baseUrl}/estimates/e-draft/proposal.pdf`)).status).toBe(200);
    });
    expect(billing().resolveProposalBillingContext).toHaveBeenCalledTimes(1);
    expect(billing().resolveFrozenBillingContext).not.toHaveBeenCalled();
  });

  test('a call-blocked quote the public page refuses is rendered frozen too', async () => {
    mockView.customerViewable = new Set(['e-call']);
    tableDb({
      estimates: [],
      // single.call_log is absent: the linked call is gone (call_missing)
      single: { estimates: base('e-call', { estimate_data: { sendSnapshot: { pricingBundle: pestBundle }, estimatorEngine: { callLogId: 'call-gone' } } }) },
    });
    await withServer(async (baseUrl) => {
      expect((await fetch(`${baseUrl}/estimates/e-call/proposal.pdf`)).status).toBe(200);
    });
    expect(mockRenderDocPdf).not.toHaveBeenCalled();
    expect(billing().resolveFrozenBillingContext).toHaveBeenCalledTimes(1);
    expect(billing().resolveProposalBillingContext).not.toHaveBeenCalled();
  });

  test('an accepted quote whose billing lane moved since it was sent renders the frozen document', async () => {
    mockView.customerViewable = new Set(['e-acc']);
    // today's lane is monthly; the quote was sent (and accepted) per application
    billing().resolveProposalBillingContext.mockResolvedValueOnce({ billsPerApplication: false, livePricing: null });
    tableDb({ estimates: [], single: { estimates: base('e-acc', { status: 'accepted' }) } });
    await withServer(async (baseUrl) => {
      expect((await fetch(`${baseUrl}/estimates/e-acc/proposal.pdf`)).status).toBe(200);
    });
    expect(mockRenderDocPdf).not.toHaveBeenCalled();
    expect(mockGeneratePdf.mock.calls[0][2]).toMatchObject({ billsPerApplication: true, livePricing: null });
  });

  test('an accepted quote still in the lane it was sent in is the customer\'s own document', async () => {
    mockView.customerViewable = new Set(['e-acc']);
    tableDb({ estimates: [], single: { estimates: base('e-acc', { status: 'accepted' }) } });
    await withServer(async (baseUrl) => {
      expect((await fetch(`${baseUrl}/estimates/e-acc/proposal.pdf`)).status).toBe(200);
    });
    expect(mockRenderDocPdf).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['draft', { status: 'draft' }],
    ['scheduled', { status: 'scheduled' }],
  ])('a %s proposal downloads the browser document the email will attach, via the staff-preview pin', async (_name, over) => {
    mockRenderDocPdf.mockResolvedValueOnce(Buffer.from('%PDF-synthetic'));
    tableDb({ estimates: [], single: { estimates: base('e-draft', { ...over, estimate_slug: 'EST-2026-0001' }) } });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/e-draft/proposal.pdf`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/pdf');
      expect(res.headers.get('content-disposition')).toBe('attachment; filename="Waves-Proposal-EST-2026-0001.pdf"');
      expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('%PDF-synthetic');
    });
    expect(mockRenderDocPdf).toHaveBeenCalledTimes(1);
    expect(mockRenderDocPdf).toHaveBeenCalledWith(expect.objectContaining({ id: 'e-draft' }), { staffPreview: true });
    expect(mockGeneratePdf).not.toHaveBeenCalled();
  });

  test('a draft without an estimate number downloads under a short id', async () => {
    mockRenderDocPdf.mockResolvedValueOnce(Buffer.from('%PDF-synthetic'));
    tableDb({ estimates: [], single: { estimates: base('abcd1234-ffff', { status: 'draft' }) } });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/abcd1234-ffff/proposal.pdf`);
      expect(res.headers.get('content-disposition')).toBe('attachment; filename="Waves-Proposal-abcd1234.pdf"');
    });
  });

  test('a draft whose browser render fails falls back to pdfkit on the live lane', async () => {
    // default mockRenderDocPdf rejects ("no browser in tests")
    tableDb({ estimates: [], single: { estimates: base('e-draft', { status: 'draft' }) } });
    await withServer(async (baseUrl) => {
      expect((await fetch(`${baseUrl}/estimates/e-draft/proposal.pdf`)).status).toBe(200);
    });
    expect(mockRenderDocPdf).toHaveBeenCalledTimes(1);
    expect(mockGeneratePdf).toHaveBeenCalledTimes(1);
    expect(billing().resolveProposalBillingContext).toHaveBeenCalledTimes(1);
  });

  test('an archived draft is never sent to the browser renderer', async () => {
    tableDb({ estimates: [], single: { estimates: base('e-draft', { status: 'draft', archived_at: '2026-10-01T00:00:00Z' }) } });
    await withServer(async (baseUrl) => {
      expect((await fetch(`${baseUrl}/estimates/e-draft/proposal.pdf`)).status).toBe(200);
    });
    expect(mockRenderDocPdf).not.toHaveBeenCalled();
    expect(mockGeneratePdf).toHaveBeenCalledTimes(1);
  });

  test('a quote the public page serves keeps the live lane (the customer\'s copy)', async () => {
    mockView.customerViewable = new Set(['e-live']);
    tableDb({ estimates: [], single: { estimates: base('e-live') } });
    await withServer(async (baseUrl) => {
      expect((await fetch(`${baseUrl}/estimates/e-live/proposal.pdf`)).status).toBe(200);
    });
    expect(mockRenderDocPdf).toHaveBeenCalledTimes(1);
    expect(billing().resolveProposalBillingContext).toHaveBeenCalledTimes(1);
    expect(billing().resolveFrozenBillingContext).not.toHaveBeenCalled();
  });

  test('an accepted quote is price-locked, so the live resolver never reprices it', async () => {
    // resolveLivePricing returns null for a price-locked row (estimateIsPriceLocked), so the document
    // describes the accepted plan; the acceptance record rides along.
    const { estimateIsPriceLocked } = jest.requireActual('../services/estimate-proposal-billing');
    expect(estimateIsPriceLocked({ status: 'accepted' })).toBe(true);
    expect(estimateIsPriceLocked({ status: 'expired' })).toBe(false);
  });
});
