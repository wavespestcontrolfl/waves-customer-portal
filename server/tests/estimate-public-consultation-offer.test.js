/**
 * "Want us to come look first?" consultation offer, exercised through the
 * REAL /:token/data payload composition (server/routes/estimate-public.js)
 * — proves the wiring, not just the builder in isolation (which
 * estimate-consultation-offer.test.js already covers unit-by-unit):
 *   - both gates off / on, eligible → field absent / present;
 *   - a terminal (accepted) estimate → absent (acceptActive false);
 *   - weak/missing lead linkage on the estimate → absent;
 *   - the builder's own dependency chain blowing up (a `leads` table lookup
 *     throwing) → the page still answers 200 with no `consultationOffer` key,
 *     never a 500 — the try/catch inside buildEstimateConsultationOffer must
 *     never leak past it into the /data response.
 *
 * Staff draft-preview / verified-staff-preview / PDF-render-pass are proven
 * directly against `composeEstimateDataPayload` (exported, and documented as
 * "pure — reads only estimate and the four render-mode flags", no req/res) —
 * driving those three through the full route would require faking a signed
 * staff JWT bearer and a signed PDF render pin, which is disproportionate
 * machinery for what is a one-line `acceptActive` AND-clause already pinned
 * at the unit level in estimate-consultation-offer.test.js
 * ("estimate not accept-active ... -> null"); this test instead pins that
 * the ROUTE actually threads adminDraftPreview/verifiedStaffPreview/
 * isPdfRenderPass into that AND-clause, which is the part the unit test
 * alone cannot see.
 *
 * `../routes/inspection-public` is mocked at the same seam
 * estimate-consultation-offer.test.js already uses
 * (`_internals.computeConsultationSlotsForLead`) — its own eligibility logic is
 * exhaustively covered by inspection-public.test.js and is not re-tested
 * here.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.LEAD_PREFILL_SECRET = process.env.LEAD_PREFILL_SECRET || 'test-prefill-secret';

const originalOfferGate = process.env.GATE_ESTIMATE_CONSULTATION_OFFER;
const originalInspectionGate = process.env.GATE_LEAD_INSPECTION_LINK;

jest.mock('express-rate-limit', () => () => (req, res, next) => next());
jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => sql);
  return mock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/estimate-group-navigation', () => ({
  refreshExpiredGroupNavigation: jest.fn().mockResolvedValue(null),
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
// Every OTHER gate stays false (matching estimate-public-group-link-data.test.js's
// established harness pattern) so this file only ever exercises the
// consultation-offer wiring; the two consultation gates are read the SAME
// way the real module reads them (strict `=== 'true'`, at call time) so a
// test can flip process.env mid-test with no re-require.
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
  gateEnvValue: jest.fn(() => false),
  gates: {},
  estimateConsultationOfferLive: () => process.env.GATE_ESTIMATE_CONSULTATION_OFFER === 'true',
  leadInspectionLinkLive: () => process.env.GATE_LEAD_INSPECTION_LINK === 'true',
}));

const mockComputeConsultationSlotsForLead = jest.fn();
jest.mock('../routes/inspection-public', () => ({
  _internals: {
    computeConsultationSlotsForLead: (...args) => mockComputeConsultationSlotsForLead(...args),
  },
}));

const express = require('express');
const db = require('../models/db');
const estimatePublicRouter = require('../routes/estimate-public');
const { composeEstimateDataPayload } = estimatePublicRouter;

const LEAD_ID = 'lead-consult-offer-1';

let dbRows = {};
let dbThrows = {};
function chainFor(table) {
  const chain = {};
  const self = () => chain;
  chain.where = jest.fn(self);
  chain.whereIn = jest.fn(self);
  chain.whereNull = jest.fn(self);
  chain.whereRaw = jest.fn(self);
  chain.andWhere = jest.fn(self);
  chain.orWhere = jest.fn(self);
  chain.orWhereRaw = jest.fn(self);
  chain.leftJoin = jest.fn(self);
  chain.select = jest.fn(self);
  chain.orderBy = jest.fn(self);
  chain.limit = jest.fn(self);
  // leads.estimate_id pointer lookup (estimate-consultation-offer.js
  // linkedLeadIdFor): dbRows.leads_pointing = ids of leads pointing here.
  chain.pluck = jest.fn(async () => {
    if (dbThrows[table]) throw new Error(`${table} lookup exploded (simulated)`);
    return dbRows[`${table}_pointing`] || [];
  });
  chain.then = (resolve, reject) => Promise.resolve(dbRows.siblings || []).then(resolve, reject);
  chain.first = jest.fn(async () => {
    if (dbThrows[table]) throw new Error(`${table} lookup exploded (simulated)`);
    return dbRows[table];
  });
  chain.update = jest.fn().mockResolvedValue(1);
  chain.insert = jest.fn().mockResolvedValue([1]);
  return chain;
}
db.mockImplementation((table) => chainFor(table));

function estimateRow(overrides = {}) {
  return {
    id: 'est-consult-1',
    token: 'consulttokenabc',
    status: 'sent',
    sent_at: new Date(Date.now() - 3600000).toISOString(),
    viewed_at: null,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    archived_at: null,
    customer_id: null,
    customer_name: 'Pat Consult',
    // The linked lead's own phone — the offer requires the lead to still be
    // the estimate's contact (leadMatchesEstimateContact).
    customer_phone: '9415551234',
    customer_email: null,
    address: '123 Consult Ln, Bradenton, FL 34203',
    satellite_url: null,
    waveguard_tier: null,
    bill_by_invoice: false,
    monthly_total: 60,
    annual_total: 720,
    onetime_total: 0,
    estimate_data: {
      lead_id: LEAD_ID,
      lead_linkage: 'sid',
      sendSnapshot: {
        pricingBundle: {
          frequencies: [{ key: 'quarterly', label: 'Quarterly', monthly: 60, annual: 720 }],
          source: 'send_snapshot_fixture',
        },
      },
      result: {
        recurring: { discount: 0, services: [{ name: 'Pest Control', mo: 60 }] },
        oneTime: { items: [], membershipFee: 0 },
      },
    },
    ...overrides,
  };
}

// The address the /inspection page resolved — the estimate fixture's property.
const PAGE_ADDRESS = { line1: '123 Consult Ln', line2: null, city: 'Bradenton', state: 'FL', zip: '34203' };

const OPEN_RECURRING_LEAD = {
  id: LEAD_ID,
  phone: '9415551234',
  service_interest: 'Recurring Pest Control',
  status: 'new',
  converted_at: null,
  customer_id: null,
};

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/estimates', estimatePublicRouter);
  app.use((err, _req, res, _next) => { res.status(err.status || 500).json({ error: err.message }); });
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

beforeEach(() => {
  dbRows = {};
  dbThrows = {};
  mockComputeConsultationSlotsForLead.mockReset().mockResolvedValue({ ok: true, slots: [{ date: '2026-10-01', start_time: '09:00' }], needsAddress: false, address: PAGE_ADDRESS });
  process.env.GATE_ESTIMATE_CONSULTATION_OFFER = 'true';
  process.env.GATE_LEAD_INSPECTION_LINK = 'true';
});

afterAll(() => {
  if (originalOfferGate === undefined) delete process.env.GATE_ESTIMATE_CONSULTATION_OFFER;
  else process.env.GATE_ESTIMATE_CONSULTATION_OFFER = originalOfferGate;
  if (originalInspectionGate === undefined) delete process.env.GATE_LEAD_INSPECTION_LINK;
  else process.env.GATE_LEAD_INSPECTION_LINK = originalInspectionGate;
});

describe('GET /:token/data — consultationOffer wiring', () => {
  test('both gates on, strongly-linked recurring lead, eligible → field present with a /inspection/ url', async () => {
    const row = estimateRow();
    dbRows = { estimates: row, leads: OPEN_RECURRING_LEAD };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/${row.token}/data?refresh=1`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.consultationOffer).toEqual({ url: expect.stringContaining('/inspection/') });
    });
  });

  test('both gates OFF → response has no consultationOffer key at all (byte-identical to before this lane)', async () => {
    process.env.GATE_ESTIMATE_CONSULTATION_OFFER = 'false';
    process.env.GATE_LEAD_INSPECTION_LINK = 'false';
    const row = estimateRow();
    dbRows = { estimates: row, leads: OPEN_RECURRING_LEAD };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/${row.token}/data?refresh=1`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(Object.prototype.hasOwnProperty.call(body, 'consultationOffer')).toBe(false);
      // The `leads` table must never even be touched while dark.
      expect(mockComputeConsultationSlotsForLead).not.toHaveBeenCalled();
    });
  });

  test('offer gate on, inspection-link gate off → absent (both must be live)', async () => {
    process.env.GATE_LEAD_INSPECTION_LINK = 'false';
    const row = estimateRow();
    dbRows = { estimates: row, leads: OPEN_RECURRING_LEAD };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/${row.token}/data?refresh=1`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(Object.prototype.hasOwnProperty.call(body, 'consultationOffer')).toBe(false);
    });
  });

  test('a terminal (accepted) estimate → absent — acceptActive is false regardless of eligibility', async () => {
    const row = estimateRow({ status: 'accepted' });
    dbRows = { estimates: row, leads: OPEN_RECURRING_LEAD };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/${row.token}/data?refresh=1`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(Object.prototype.hasOwnProperty.call(body, 'consultationOffer')).toBe(false);
      expect(mockComputeConsultationSlotsForLead).not.toHaveBeenCalled();
    });
  });

  test('a declined estimate → absent', async () => {
    const row = estimateRow({ status: 'declined' });
    dbRows = { estimates: row, leads: OPEN_RECURRING_LEAD };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/${row.token}/data?refresh=1`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(Object.prototype.hasOwnProperty.call(body, 'consultationOffer')).toBe(false);
    });
  });

  test('an expired estimate (real past expires_at) → the viewability gate 404s before any payload is composed, so no consultationOffer can ever leak', async () => {
    const row = estimateRow({ expires_at: new Date(Date.now() - 86400000).toISOString() });
    dbRows = { estimates: row, leads: OPEN_RECURRING_LEAD };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/${row.token}/data?refresh=1`);
      const body = await res.json();
      expect(res.status).toBe(404);
      expect(Object.prototype.hasOwnProperty.call(body, 'consultationOffer')).toBe(false);
      expect(mockComputeConsultationSlotsForLead).not.toHaveBeenCalled();
    });
  });

  test('weak lead linkage (phone-fallback) on the estimate → absent, never checks eligibility', async () => {
    const row = estimateRow({ estimate_data: { ...estimateRow().estimate_data, lead_linkage: 'phone' } });
    dbRows = { estimates: row, leads: OPEN_RECURRING_LEAD };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/${row.token}/data?refresh=1`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(Object.prototype.hasOwnProperty.call(body, 'consultationOffer')).toBe(false);
      expect(mockComputeConsultationSlotsForLead).not.toHaveBeenCalled();
    });
  });

  test('missing lead linkage entirely on the estimate → absent', async () => {
    const base = estimateRow();
    const { lead_linkage: _leadLinkage, ...rest } = base.estimate_data;
    const row = estimateRow({ estimate_data: rest });
    dbRows = { estimates: row, leads: OPEN_RECURRING_LEAD };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/${row.token}/data?refresh=1`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(Object.prototype.hasOwnProperty.call(body, 'consultationOffer')).toBe(false);
    });
  });

  test('no lead_id on the estimate at all → absent', async () => {
    const base = estimateRow();
    const { lead_id: _leadId, ...rest } = base.estimate_data;
    const row = estimateRow({ estimate_data: rest });
    dbRows = { estimates: row, leads: OPEN_RECURRING_LEAD };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/${row.token}/data?refresh=1`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(Object.prototype.hasOwnProperty.call(body, 'consultationOffer')).toBe(false);
    });
  });

  test('the /inspection page reports the lead ineligible (already booked / converted / gone) → absent', async () => {
    mockComputeConsultationSlotsForLead.mockResolvedValue({ ok: false });
    const row = estimateRow();
    dbRows = { estimates: row, leads: OPEN_RECURRING_LEAD };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/${row.token}/data?refresh=1`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(Object.prototype.hasOwnProperty.call(body, 'consultationOffer')).toBe(false);
    });
  });

  test('the leads table lookup throwing does not 500 the page — the field is simply absent', async () => {
    const row = estimateRow();
    dbRows = { estimates: row };
    dbThrows = { leads: true };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/${row.token}/data?refresh=1`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(Object.prototype.hasOwnProperty.call(body, 'consultationOffer')).toBe(false);
      // The rest of the page still composed normally around the failure.
      expect(body.estimate).toBeTruthy();
    });
  });

  test('computeConsultationSlotsForLead rejecting does not 500 the page — the field is simply absent', async () => {
    mockComputeConsultationSlotsForLead.mockRejectedValue(new Error('inspection-public blew up'));
    const row = estimateRow();
    dbRows = { estimates: row, leads: OPEN_RECURRING_LEAD };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/${row.token}/data?refresh=1`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(Object.prototype.hasOwnProperty.call(body, 'consultationOffer')).toBe(false);
    });
  });
});

describe('composeEstimateDataPayload — acceptActive threading for the three preview/render modes', () => {
  // These three flags are only ever produced by the route after verifying a
  // staff JWT bearer (verifiedStaffPreview) or a signed PDF render pin
  // (isPdfRenderPass) — driving them through the full HTTP route would mean
  // faking that verification. composeEstimateDataPayload is exported and
  // documented as pure over its flags, so calling it directly is the
  // narrowest way to pin that the route's own
  // `!adminDraftPreview && !verifiedStaffPreview && !isPdfRenderPass && isEstimateAcceptActive(estimate)`
  // line actually reaches the builder — the ONLY thing not already covered
  // by the unit test's own `acceptActive: false` case.
  test('adminDraftPreview (staff Customer View of a draft) → absent even though the estimate would otherwise be eligible', async () => {
    const row = estimateRow({ status: 'draft' });
    dbRows = { estimates: row, leads: OPEN_RECURRING_LEAD };
    const payload = await composeEstimateDataPayload(row, { ...{ adminDraftPreview: true }, includeConsultationOffer: true });
    expect(Object.prototype.hasOwnProperty.call(payload, 'consultationOffer')).toBe(false);
    expect(mockComputeConsultationSlotsForLead).not.toHaveBeenCalled();
  });

  test('verifiedStaffPreview (staff Customer View of a published estimate) → absent', async () => {
    const row = estimateRow();
    dbRows = { estimates: row, leads: OPEN_RECURRING_LEAD };
    const payload = await composeEstimateDataPayload(row, { ...{ verifiedStaffPreview: true }, includeConsultationOffer: true });
    expect(Object.prototype.hasOwnProperty.call(payload, 'consultationOffer')).toBe(false);
    expect(mockComputeConsultationSlotsForLead).not.toHaveBeenCalled();
  });

  test('isPdfRenderPass (headless document render) → absent', async () => {
    const row = estimateRow();
    dbRows = { estimates: row, leads: OPEN_RECURRING_LEAD };
    const payload = await composeEstimateDataPayload(row, { ...{ isPdfRenderPass: true }, includeConsultationOffer: true });
    expect(Object.prototype.hasOwnProperty.call(payload, 'consultationOffer')).toBe(false);
    expect(mockComputeConsultationSlotsForLead).not.toHaveBeenCalled();
  });

  test('none of the three flags set, otherwise eligible → present (control case for the three above)', async () => {
    const row = estimateRow();
    dbRows = { estimates: row, leads: OPEN_RECURRING_LEAD };
    const payload = await composeEstimateDataPayload(row, { includeConsultationOffer: true });
    expect(payload.consultationOffer).toEqual({ url: expect.stringContaining('/inspection/') });
  });

  test('a caller that does not opt in (the Intelligence Bar projection) never runs the probe', async () => {
    const row = estimateRow();
    dbRows = { estimates: row, leads: OPEN_RECURRING_LEAD };
    const payload = await composeEstimateDataPayload(row, {});
    expect(Object.prototype.hasOwnProperty.call(payload, 'consultationOffer')).toBe(false);
    expect(mockComputeConsultationSlotsForLead).not.toHaveBeenCalled();
  });
});

describe('GET /:token/data — quote-first, first-load-only rules (Codex #4853 r2)', () => {
  test('an estimate linked only by leads.estimate_id (the admin estimate tool\'s link, no stamp) gets the offer', async () => {
    const base = estimateRow();
    const { lead_id: _lid, lead_linkage: _ll, ...unstamped } = base.estimate_data;
    const row = estimateRow({ estimate_data: unstamped });
    dbRows = { estimates: row, leads: OPEN_RECURRING_LEAD, leads_pointing: [LEAD_ID] };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/${row.token}/data?refresh=1`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.consultationOffer).toEqual({ url: expect.stringContaining('/inspection/') });
    });
  });

  test('an internal ?refresh=1 of a viewed estimate never runs the probe (the client carries the first load\'s offer)', async () => {
    const row = estimateRow({ viewed_at: new Date(Date.now() - 60000).toISOString() });
    dbRows = { estimates: row, leads: OPEN_RECURRING_LEAD };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/${row.token}/data?refresh=1`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(Object.prototype.hasOwnProperty.call(body, 'consultationOffer')).toBe(false);
      expect(mockComputeConsultationSlotsForLead).not.toHaveBeenCalled();
    });
  });

  test('a fresh open of a viewed estimate still gets the offer', async () => {
    const row = estimateRow({ viewed_at: new Date(Date.now() - 60000).toISOString() });
    dbRows = { estimates: row, leads: OPEN_RECURRING_LEAD };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/${row.token}/data`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.consultationOffer).toEqual({ url: expect.stringContaining('/inspection/') });
    });
  });

  test('an estimate drafted from a visit (estimate_data.scheduled_service_id) → absent, no probe', async () => {
    const base = estimateRow();
    const row = estimateRow({ estimate_data: { ...base.estimate_data, scheduled_service_id: 'svc-assessment-1' } });
    dbRows = { estimates: row, leads: OPEN_RECURRING_LEAD };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/${row.token}/data?refresh=1`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(Object.prototype.hasOwnProperty.call(body, 'consultationOffer')).toBe(false);
      expect(mockComputeConsultationSlotsForLead).not.toHaveBeenCalled();
    });
  });

  test('the page would book at another property than the estimate → absent', async () => {
    mockComputeConsultationSlotsForLead.mockResolvedValue({
      ok: true, slots: [{ date: '2026-10-01', start_time: '09:00' }], needsAddress: false,
      address: { line1: '900 Other Rd', line2: null, city: 'Bradenton', state: 'FL', zip: '34203' },
    });
    const row = estimateRow();
    dbRows = { estimates: row, leads: OPEN_RECURRING_LEAD };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/${row.token}/data?refresh=1`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(Object.prototype.hasOwnProperty.call(body, 'consultationOffer')).toBe(false);
    });
  });
});
