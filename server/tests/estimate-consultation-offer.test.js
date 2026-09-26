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
const mockConsultationEligibleForLead = jest.fn();
jest.mock('../routes/inspection-public', () => ({
  _internals: {
    consultationEligibleForLead: (...args) => mockConsultationEligibleForLead(...args),
    computeConsultationSlotsForLead: (...args) => mockComputeConsultationSlotsForLead(...args),
  },
}));

function chainBuilder({ firstRow = null, throwOn = false } = {}) {
  const b = {};
  b.where = jest.fn(() => b);
  b.whereNull = jest.fn(() => b);
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

function baseArgs(overrides = {}) {
  return { leadId: LEAD_ID, leadLinkage: 'sid', acceptActive: true, ...overrides };
}

beforeEach(() => {
  mockCreateShortCode.mockClear();
  jest.clearAllMocks();
  mockBuilders = { leads: chainBuilder({ firstRow: OPEN_RECURRING_LEAD }) };
  process.env.GATE_ESTIMATE_CONSULTATION_OFFER = 'true';
  process.env.GATE_LEAD_INSPECTION_LINK = 'true';
  process.env.LEAD_PREFILL_SECRET = 'test-prefill-secret';
  mockConsultationEligibleForLead.mockResolvedValue(true);
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

  test('no lead id at all → null', async () => {
    const result = await buildEstimateConsultationOffer(baseArgs({ leadId: null }));
    expect(result).toBeNull();
    expect(mockDb).not.toHaveBeenCalled();
  });

  test('weak linkage (not sid/stamp) → null, never touches the DB', async () => {
    const result = await buildEstimateConsultationOffer(baseArgs({ leadLinkage: 'phone_fallback' }));
    expect(result).toBeNull();
    expect(mockDb).not.toHaveBeenCalled();
  });

  test('no linkage at all → null', async () => {
    const result = await buildEstimateConsultationOffer(baseArgs({ leadLinkage: null }));
    expect(result).toBeNull();
    expect(mockDb).not.toHaveBeenCalled();
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
    expect(mockConsultationEligibleForLead).not.toHaveBeenCalled();
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
    expect(mockConsultationEligibleForLead).not.toHaveBeenCalled();
  });

  test('inspection-page eligibility says not ok (already booked / converted / gone) → null', async () => {
    mockConsultationEligibleForLead.mockResolvedValue(false);
    const result = await buildEstimateConsultationOffer(baseArgs());
    expect(result).toBeNull();
  });

  test('a thrown error anywhere (e.g. a DB blow-up) → null, never propagates', async () => {
    mockBuilders.leads = chainBuilder({ throwOn: true });
    const result = await buildEstimateConsultationOffer(baseArgs());
    expect(result).toBeNull();
  });

  test('consultationEligibleForLead throwing → null', async () => {
    mockConsultationEligibleForLead.mockRejectedValue(new Error('boom'));
    const result = await buildEstimateConsultationOffer(baseArgs());
    expect(result).toBeNull();
  });
});

describe('buildEstimateConsultationOffer — happy path', () => {
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
    expect(mockConsultationEligibleForLead).toHaveBeenCalledWith(LEAD_ID);
  });

  test('never runs the slot search (geocoder + availability) on a public page view', async () => {
    const result = await buildEstimateConsultationOffer(baseArgs());
    expect(result).not.toBeNull();
    expect(mockComputeConsultationSlotsForLead).not.toHaveBeenCalled();
  });
});
