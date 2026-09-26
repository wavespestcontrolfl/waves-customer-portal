/**
 * buildEstimateConsultationOffer (services/estimate-consultation-offer.js) —
 * the public estimate page's "Want us to come look first?" section. Contract:
 * null for every ineligible/error case, `{ url }` (consultationUrlForLead
 * with NO channel, no short-code/DB write) for an eligible strongly-linked
 * recurring lead whose /inspection/:token eligibility reports ok.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: () => 'https://portal.wavespestcontrol.com' }));

// No write should ever happen from this builder — record any call so tests
// can assert it never fires.
const mockCreateShortCode = jest.fn(async () => {
  throw new Error('createShortCode must never be called by the estimate consultation offer (public GET stays read-only)');
});
jest.mock('../services/short-url', () => ({ createShortCode: (...args) => mockCreateShortCode(...args) }));

let mockBuilders = {};
const mockDb = jest.fn((table) => mockBuilders[table]);
jest.mock('../models/db', () => mockDb);

const mockComputeConsultationSlotsForLead = jest.fn();
jest.mock('../routes/inspection-public', () => ({
  _internals: {
    computeConsultationSlotsForLead: (...args) => mockComputeConsultationSlotsForLead(...args),
  },
}));

// `pointing` = ids of live leads whose leads.estimate_id names the estimate.
function chainBuilder({ firstRow = null, throwOn = false, pointing = [] } = {}) {
  const b = {};
  b.where = jest.fn(() => b);
  b.whereNull = jest.fn(() => b);
  b.limit = jest.fn(() => b);
  b.pluck = jest.fn(async () => {
    if (throwOn) throw new Error('db exploded');
    return pointing;
  });
  b.first = jest.fn(async () => {
    if (throwOn) throw new Error('db exploded');
    return firstRow;
  });
  return b;
}

const { buildEstimateConsultationOffer } = require('../services/estimate-consultation-offer');

const LEAD_ID = '3f2f7b9c-2222-4222-8333-abcdefabcdef';
const originalOfferGate = process.env.GATE_ESTIMATE_CONSULTATION_OFFER;
const originalInspectionGate = process.env.GATE_LEAD_INSPECTION_LINK;
const originalSecret = process.env.LEAD_PREFILL_SECRET;

const OPEN_RECURRING_LEAD = {
  id: LEAD_ID,
  phone: '9415551234',
  service_interest: 'Recurring Pest Control',
  status: 'new',
  converted_at: null,
  customer_id: null,
};

const PAGE_ADDRESS = { line1: '123 Palm Street', line2: null, city: 'Bradenton', state: 'FL', zip: '34205' };

const ESTIMATE_ID = '7a1d2c3b-4444-4555-8666-abcdefabcdef';

// Flat overrides → the builder's { estimate, estimateData, acceptActive }.
// Defaults: a stamped strong link (lead_id + 'sid'), no leads.estimate_id
// pointer (set via mockBuilders.leads = chainBuilder({ pointing })).
function baseArgs(overrides = {}) {
  const o = {
    leadId: LEAD_ID, leadLinkage: 'sid', acceptActive: true,
    estimateAddress: '123 Palm St, Bradenton, FL 34205', fromVisit: false, grouped: false, ...overrides,
  };
  return {
    acceptActive: o.acceptActive,
    estimate: {
      id: ESTIMATE_ID, address: o.estimateAddress, estimate_group_id: o.grouped ? 'grp-1' : null,
      customer_id: null, customer_phone: o.customerPhone === undefined ? '(941) 555-1234' : o.customerPhone, customer_email: null,
    },
    estimateData: {
      ...(o.leadId ? { lead_id: o.leadId } : {}),
      ...(o.leadLinkage ? { lead_linkage: o.leadLinkage } : {}),
      ...(o.fromVisit ? { scheduled_service_id: 'svc-1' } : {}),
    },
  };
}

beforeEach(() => {
  mockCreateShortCode.mockClear();
  jest.clearAllMocks();
  mockBuilders = { leads: chainBuilder({ firstRow: OPEN_RECURRING_LEAD }) };
  process.env.GATE_ESTIMATE_CONSULTATION_OFFER = 'true';
  process.env.GATE_LEAD_INSPECTION_LINK = 'true';
  process.env.LEAD_PREFILL_SECRET = 'test-prefill-secret';
  mockComputeConsultationSlotsForLead.mockResolvedValue({ ok: true, slots: [{ date: '2026-10-01', start_time: '09:00' }], needsAddress: false, address: PAGE_ADDRESS });
});

afterEach(() => {
  if (originalOfferGate === undefined) delete process.env.GATE_ESTIMATE_CONSULTATION_OFFER;
  else process.env.GATE_ESTIMATE_CONSULTATION_OFFER = originalOfferGate;
  if (originalInspectionGate === undefined) delete process.env.GATE_LEAD_INSPECTION_LINK;
  else process.env.GATE_LEAD_INSPECTION_LINK = originalInspectionGate;
  if (originalSecret === undefined) delete process.env.LEAD_PREFILL_SECRET;
  else process.env.LEAD_PREFILL_SECRET = originalSecret;
});

describe('buildEstimateConsultationOffer — hidden cases', () => {
  test('GATE_ESTIMATE_CONSULTATION_OFFER off → null, never touches the DB', async () => {
    process.env.GATE_ESTIMATE_CONSULTATION_OFFER = 'false';
    const result = await buildEstimateConsultationOffer(baseArgs());
    expect(result).toBeNull();
    expect(mockDb).not.toHaveBeenCalled();
  });

  test('GATE_LEAD_INSPECTION_LINK off → null, never touches the DB', async () => {
    process.env.GATE_LEAD_INSPECTION_LINK = 'false';
    const result = await buildEstimateConsultationOffer(baseArgs());
    expect(result).toBeNull();
    expect(mockDb).not.toHaveBeenCalled();
  });

  test('both gates must be exactly "true" — any other spelling is off', async () => {
    process.env.GATE_ESTIMATE_CONSULTATION_OFFER = '1';
    const result = await buildEstimateConsultationOffer(baseArgs());
    expect(result).toBeNull();
  });

  test('estimate not accept-active (accepted/declined/expired/staff preview) → null', async () => {
    const result = await buildEstimateConsultationOffer(baseArgs({ acceptActive: false }));
    expect(result).toBeNull();
    expect(mockDb).not.toHaveBeenCalled();
  });

  test('no stamped lead and no leads.estimate_id pointer → null, no probe', async () => {
    const result = await buildEstimateConsultationOffer(baseArgs({ leadId: null }));
    expect(result).toBeNull();
    expect(mockComputeConsultationSlotsForLead).not.toHaveBeenCalled();
  });

  test('weak stamped linkage (not sid/stamp) and no pointer → null, no probe', async () => {
    const result = await buildEstimateConsultationOffer(baseArgs({ leadLinkage: 'phone_fallback' }));
    expect(result).toBeNull();
    expect(mockComputeConsultationSlotsForLead).not.toHaveBeenCalled();
  });

  test('stamped lead id without any linkage and no pointer → null', async () => {
    const result = await buildEstimateConsultationOffer(baseArgs({ leadLinkage: null }));
    expect(result).toBeNull();
  });

  test('the linked lead is no longer the estimate\'s contact (edited pointer, another person) → null, no probe', async () => {
    mockBuilders.leads = chainBuilder({ firstRow: OPEN_RECURRING_LEAD, pointing: [LEAD_ID] });
    expect(await buildEstimateConsultationOffer(baseArgs({ leadId: null, customerPhone: '(941) 555-9999' }))).toBeNull();
    expect(mockComputeConsultationSlotsForLead).not.toHaveBeenCalled();
  });

  test('two live leads pointing at the estimate → ambiguous, null', async () => {
    mockBuilders.leads = chainBuilder({ firstRow: OPEN_RECURRING_LEAD, pointing: [LEAD_ID, 'other-lead'] });
    expect(await buildEstimateConsultationOffer(baseArgs({ leadId: null }))).toBeNull();
    expect(mockComputeConsultationSlotsForLead).not.toHaveBeenCalled();
  });

  test('a pointer and a stamp naming different leads → ambiguous, null', async () => {
    mockBuilders.leads = chainBuilder({ firstRow: OPEN_RECURRING_LEAD, pointing: ['other-lead'] });
    expect(await buildEstimateConsultationOffer(baseArgs())).toBeNull();
  });

  test('"stamp" linkage is accepted (both strong values)', async () => {
    const result = await buildEstimateConsultationOffer(baseArgs({ leadLinkage: 'stamp' }));
    expect(result).toEqual({ url: expect.stringContaining('/inspection/') });
  });

  test('lead not found → null', async () => {
    mockBuilders.leads = chainBuilder({ firstRow: null });
    const result = await buildEstimateConsultationOffer(baseArgs());
    expect(result).toBeNull();
  });

  test('leadLinkRefusal: closed/converted lead → null', async () => {
    mockBuilders.leads = chainBuilder({ firstRow: { ...OPEN_RECURRING_LEAD, status: 'converted', converted_at: new Date() } });
    const result = await buildEstimateConsultationOffer(baseArgs());
    expect(result).toBeNull();
    expect(mockComputeConsultationSlotsForLead).not.toHaveBeenCalled();
  });

  test('leadLinkRefusal: no phone → null', async () => {
    mockBuilders.leads = chainBuilder({ firstRow: { ...OPEN_RECURRING_LEAD, phone: null } });
    const result = await buildEstimateConsultationOffer(baseArgs());
    expect(result).toBeNull();
  });

  test('non-recurring lead → null', async () => {
    mockBuilders.leads = chainBuilder({ firstRow: { ...OPEN_RECURRING_LEAD, service_interest: 'One-Time Pest Control' } });
    const result = await buildEstimateConsultationOffer(baseArgs());
    expect(result).toBeNull();
    expect(mockComputeConsultationSlotsForLead).not.toHaveBeenCalled();
  });

  test('inspection-page eligibility says not ok (already booked / converted / gone) → null', async () => {
    mockComputeConsultationSlotsForLead.mockResolvedValue({ ok: false });
    const result = await buildEstimateConsultationOffer(baseArgs());
    expect(result).toBeNull();
  });

  test('a thrown error anywhere (e.g. a DB blow-up) → null, never propagates', async () => {
    mockBuilders.leads = chainBuilder({ throwOn: true });
    const result = await buildEstimateConsultationOffer(baseArgs());
    expect(result).toBeNull();
  });

  test('computeConsultationSlotsForLead throwing → null', async () => {
    mockComputeConsultationSlotsForLead.mockRejectedValue(new Error('boom'));
    const result = await buildEstimateConsultationOffer(baseArgs());
    expect(result).toBeNull();
  });
});

describe('buildEstimateConsultationOffer — happy path', () => {
  test('the leads.estimate_id pointer alone links the lead (the link the admin estimate tool writes)', async () => {
    mockBuilders.leads = chainBuilder({ firstRow: OPEN_RECURRING_LEAD, pointing: [LEAD_ID] });
    const result = await buildEstimateConsultationOffer(baseArgs({ leadId: null, leadLinkage: null }));
    expect(result?.url).toContain('/inspection/');
    expect(mockComputeConsultationSlotsForLead).toHaveBeenCalledWith(LEAD_ID, { count: 1 });
  });

  test('a pointer and a stamp naming the same lead agree', async () => {
    mockBuilders.leads = chainBuilder({ firstRow: OPEN_RECURRING_LEAD, pointing: [LEAD_ID] });
    expect((await buildEstimateConsultationOffer(baseArgs()))?.url).toContain('/inspection/');
  });

  test('eligible strongly-linked recurring lead gets the long URL with NO channel and no write', async () => {
    const result = await buildEstimateConsultationOffer(baseArgs());
    expect(result).not.toBeNull();
    expect(result.url).toMatch(/^https:\/\/portal\.wavespestcontrol\.com\/inspection\//);
    const token = result.url.split('/inspection/')[1];
    // Exact contract: same builder every consultation link shares, no
    // channel claim (unverified delivery — an estimate page view is
    // neither an SMS nor an email send) — 3 segments, never a 4th channel one.
    expect(token.split('.')).toHaveLength(3);
    expect(mockCreateShortCode).not.toHaveBeenCalled();
    expect(mockComputeConsultationSlotsForLead).toHaveBeenCalledWith(LEAD_ID, { count: 1 });
  });

  test('a lead with no address on file → null (nothing to match the estimate property against)', async () => {
    mockComputeConsultationSlotsForLead.mockResolvedValue({ ok: true, slots: [], needsAddress: true });
    expect(await buildEstimateConsultationOffer(baseArgs())).toBeNull();
  });

  test('an estimate drafted from a visit (quote-first only) → null, no probe', async () => {
    expect(await buildEstimateConsultationOffer(baseArgs({ fromVisit: true }))).toBeNull();
    expect(mockComputeConsultationSlotsForLead).not.toHaveBeenCalled();
  });

  test('a grouped (multi-property) estimate → null, no probe', async () => {
    expect(await buildEstimateConsultationOffer(baseArgs({ grouped: true }))).toBeNull();
    expect(mockComputeConsultationSlotsForLead).not.toHaveBeenCalled();
  });

  test.each([
    ['another street', '456 Oak Ave, Bradenton, FL 34205'],
    ['same street, another unit', '123 Palm St Apt 4, Bradenton, FL 34205'],
    ['same street, another zip', '123 Palm St, Sarasota, FL 34236'],
    ['no estimate address', null],
  ])('the page would book at a different property (%s) → null', async (_label, estimateAddress) => {
    expect(await buildEstimateConsultationOffer(baseArgs({ estimateAddress }))).toBeNull();
  });

  test('the same property written differently (St vs Street, case) still matches', async () => {
    const result = await buildEstimateConsultationOffer(baseArgs({ estimateAddress: '123 palm street, Bradenton, FL 34205' }));
    expect(result?.url).toContain('/inspection/');
  });

  test('no locality evidence (a zip missing on either side) → null — the same street exists in other towns', async () => {
    expect(await buildEstimateConsultationOffer(baseArgs({ estimateAddress: '123 Palm St, Sarasota, FL' }))).toBeNull();
    mockComputeConsultationSlotsForLead.mockResolvedValue({
      ok: true, slots: [{ date: '2026-10-01', start_time: '09:00' }], needsAddress: false,
      address: { ...PAGE_ADDRESS, zip: null },
    });
    expect(await buildEstimateConsultationOffer(baseArgs())).toBeNull();
  });

  test('a slot probe that outlives its budget (slow geocoder) → null at the budget, never a hung page or send (Codex #4918 r1 P2)', async () => {
    const { _test: { PROBE_BUDGET_MS } } = require('../services/estimate-consultation-offer');
    jest.useFakeTimers();
    try {
      mockComputeConsultationSlotsForLead.mockReturnValue(new Promise(() => {})); // never settles
      const pending = buildEstimateConsultationOffer(baseArgs());
      await jest.advanceTimersByTimeAsync(PROBE_BUDGET_MS);
      await expect(pending).resolves.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test('eligible but nothing to pick (out of area, retired catalog, no open times) → null', async () => {
    mockComputeConsultationSlotsForLead.mockResolvedValue({ ok: true, slots: [], needsAddress: false });
    expect(await buildEstimateConsultationOffer(baseArgs())).toBeNull();
  });
});
