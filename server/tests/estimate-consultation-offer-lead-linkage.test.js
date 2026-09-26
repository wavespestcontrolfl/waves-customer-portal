/**
 * Additional edge-case coverage for server/services/estimate-consultation-offer.js
 * on top of estimate-consultation-offer.test.js (the main contract suite for
 * buildEstimateConsultationOffer). This file targets the specific seams that
 * suite doesn't isolate:
 *   - linkedLeadIdFor's OWN pointer-lookup call throwing, in isolation from
 *     the later `leads` row fetch (proving the failure is caught at the
 *     builder regardless of which DB call inside the chain blows up first);
 *   - estimateConsultationLead (the shared eligibility a future email caller
 *     will also call) is documented to THROW rather than swallow errors —
 *     unlike buildEstimateConsultationOffer, which wraps it in try/catch.
 *     A future caller that forgets its own try/catch would crash;
 *   - estimateConsultationLead does NOT read GATE_ESTIMATE_CONSULTATION_OFFER
 *     at all — that gate belongs to the page builder only;
 *   - the cheap short-circuits (acceptActive false / scheduled_service_id /
 *     estimate_group_id / a missing estimate) never touch the DB, whichever
 *     entry point is called directly;
 *   - a pointer and a stamp that name the SAME lead id but in different
 *     letter case are two distinct Set members today (String() only changes
 *     type, never case) — documents current fail-safe (ambiguous → no
 *     offer) behavior rather than asserting it's the intended outcome.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: () => 'https://portal.wavespestcontrol.com' }));

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

// A builder that lets pluck() and first() fail independently, unlike the
// combined chainBuilder in estimate-consultation-offer.test.js.
function splitBuilder({ pluckThrows = false, pluckResult = [], firstRow = null, firstThrows = false } = {}) {
  const b = {};
  b.where = jest.fn(() => b);
  b.whereNull = jest.fn(() => b);
  b.limit = jest.fn(() => b);
  b.pluck = jest.fn(async () => {
    if (pluckThrows) throw new Error('leads.estimate_id pointer lookup exploded');
    return pluckResult;
  });
  b.first = jest.fn(async () => {
    if (firstThrows) throw new Error('leads row fetch exploded');
    return firstRow;
  });
  return b;
}

const {
  buildEstimateConsultationOffer,
  estimateConsultationLead,
  _test: { linkedLeadIdFor },
} = require('../services/estimate-consultation-offer');

const LEAD_ID = '3f2f7b9c-2222-4222-8333-abcdefabcdef';
const ESTIMATE_ID = '7a1d2c3b-4444-4555-8666-abcdefabcdef';

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

function baseEstimate(overrides = {}) {
  return { id: ESTIMATE_ID, address: '123 Palm St, Bradenton, FL 34205', estimate_group_id: null, ...overrides };
}

function baseEstimateData(overrides = {}) {
  return { lead_id: LEAD_ID, lead_linkage: 'sid', ...overrides };
}

beforeEach(() => {
  mockCreateShortCode.mockClear();
  jest.clearAllMocks();
  mockBuilders = { leads: splitBuilder({ firstRow: OPEN_RECURRING_LEAD }) };
  process.env.GATE_ESTIMATE_CONSULTATION_OFFER = 'true';
  process.env.GATE_LEAD_INSPECTION_LINK = 'true';
  process.env.LEAD_PREFILL_SECRET = 'test-prefill-secret';
  mockComputeConsultationSlotsForLead.mockResolvedValue({
    ok: true, slots: [{ date: '2026-10-01', start_time: '09:00' }], needsAddress: false, address: PAGE_ADDRESS,
  });
});

afterEach(() => {
  if (originalOfferGate === undefined) delete process.env.GATE_ESTIMATE_CONSULTATION_OFFER;
  else process.env.GATE_ESTIMATE_CONSULTATION_OFFER = originalOfferGate;
  if (originalInspectionGate === undefined) delete process.env.GATE_LEAD_INSPECTION_LINK;
  else process.env.GATE_LEAD_INSPECTION_LINK = originalInspectionGate;
  if (originalSecret === undefined) delete process.env.LEAD_PREFILL_SECRET;
  else process.env.LEAD_PREFILL_SECRET = originalSecret;
});

describe('linkedLeadIdFor — pointer lookup failure isolated from the lead-row fetch', () => {
  test('the leads.estimate_id pointer pluck() throwing propagates out of linkedLeadIdFor', async () => {
    mockBuilders.leads = splitBuilder({ pluckThrows: true, firstRow: OPEN_RECURRING_LEAD });
    await expect(linkedLeadIdFor(ESTIMATE_ID, baseEstimateData())).rejects.toThrow('pointer lookup exploded');
    // The lead row fetch is never reached because the pointer lookup blew up first.
    expect(mockBuilders.leads.first).not.toHaveBeenCalled();
  });

  test('buildEstimateConsultationOffer still returns null (not a throw, not a 500) when only the pointer lookup blows up', async () => {
    mockBuilders.leads = splitBuilder({ pluckThrows: true, firstRow: OPEN_RECURRING_LEAD });
    const result = await buildEstimateConsultationOffer({
      estimate: baseEstimate(), estimateData: baseEstimateData(), acceptActive: true,
    });
    expect(result).toBeNull();
  });
});

describe('estimateConsultationLead — throws rather than swallowing (callers must fail soft themselves)', () => {
  test('a DB blow-up during eligibility propagates as a rejection, not a null', async () => {
    mockBuilders.leads = splitBuilder({ pluckThrows: true, firstRow: OPEN_RECURRING_LEAD });
    await expect(estimateConsultationLead({
      estimate: baseEstimate(), estimateData: baseEstimateData(), acceptActive: true,
    })).rejects.toThrow('pointer lookup exploded');
  });

  test('computeConsultationSlotsForLead rejecting also propagates out of estimateConsultationLead', async () => {
    mockComputeConsultationSlotsForLead.mockRejectedValue(new Error('inspection-public blew up'));
    await expect(estimateConsultationLead({
      estimate: baseEstimate(), estimateData: baseEstimateData(), acceptActive: true,
    })).rejects.toThrow('inspection-public blew up');
  });

  test('the SAME failure is fully absorbed one layer up by buildEstimateConsultationOffer', async () => {
    mockComputeConsultationSlotsForLead.mockRejectedValue(new Error('inspection-public blew up'));
    const result = await buildEstimateConsultationOffer({
      estimate: baseEstimate(), estimateData: baseEstimateData(), acceptActive: true,
    });
    expect(result).toBeNull();
  });
});

describe('estimateConsultationLead — GATE_ESTIMATE_CONSULTATION_OFFER is not this function\'s gate', () => {
  test('offer gate off, inspection gate on → estimateConsultationLead still resolves the lead (the page builder is what stops the OFFER, not eligibility itself)', async () => {
    process.env.GATE_ESTIMATE_CONSULTATION_OFFER = 'false';
    const lead = await estimateConsultationLead({
      estimate: baseEstimate(), estimateData: baseEstimateData(), acceptActive: true,
    });
    expect(lead).toEqual(OPEN_RECURRING_LEAD);
  });

  test('...but buildEstimateConsultationOffer with the same inputs returns null while its own gate is off', async () => {
    process.env.GATE_ESTIMATE_CONSULTATION_OFFER = 'false';
    const result = await buildEstimateConsultationOffer({
      estimate: baseEstimate(), estimateData: baseEstimateData(), acceptActive: true,
    });
    expect(result).toBeNull();
  });

  test('inspection gate off → estimateConsultationLead returns null with no DB call regardless of the offer gate', async () => {
    process.env.GATE_LEAD_INSPECTION_LINK = 'false';
    const lead = await estimateConsultationLead({
      estimate: baseEstimate(), estimateData: baseEstimateData(), acceptActive: true,
    });
    expect(lead).toBeNull();
    expect(mockDb).not.toHaveBeenCalled();
  });
});

describe('estimateConsultationLead — cheap short-circuits never touch the DB', () => {
  test('acceptActive false → null, no DB call', async () => {
    const lead = await estimateConsultationLead({
      estimate: baseEstimate(), estimateData: baseEstimateData(), acceptActive: false,
    });
    expect(lead).toBeNull();
    expect(mockDb).not.toHaveBeenCalled();
  });

  test('estimateData.scheduled_service_id set (drafted from a visit) → null, no DB call', async () => {
    const lead = await estimateConsultationLead({
      estimate: baseEstimate(),
      estimateData: baseEstimateData({ scheduled_service_id: 'svc-1' }),
      acceptActive: true,
    });
    expect(lead).toBeNull();
    expect(mockDb).not.toHaveBeenCalled();
  });

  test('estimate.estimate_group_id set (grouped, multi-property) → null, no DB call', async () => {
    const lead = await estimateConsultationLead({
      estimate: baseEstimate({ estimate_group_id: 'grp-1' }),
      estimateData: baseEstimateData(),
      acceptActive: true,
    });
    expect(lead).toBeNull();
    expect(mockDb).not.toHaveBeenCalled();
  });

  test('estimate missing entirely → null, no DB call, no throw', async () => {
    const lead = await estimateConsultationLead({
      estimate: undefined, estimateData: baseEstimateData(), acceptActive: true,
    });
    expect(lead).toBeNull();
    expect(mockDb).not.toHaveBeenCalled();
  });

  test('called with no arguments at all → null, no throw', async () => {
    await expect(estimateConsultationLead()).resolves.toBeNull();
    expect(mockDb).not.toHaveBeenCalled();
  });

  test('buildEstimateConsultationOffer with a missing estimate → null (never reaches the DB, never throws past the try/catch)', async () => {
    const result = await buildEstimateConsultationOffer({ estimate: undefined, estimateData: baseEstimateData(), acceptActive: true });
    expect(result).toBeNull();
    expect(mockDb).not.toHaveBeenCalled();
  });

  test('buildEstimateConsultationOffer called with no arguments at all → null, never throws', async () => {
    await expect(buildEstimateConsultationOffer()).resolves.toBeNull();
  });
});

describe('linkedLeadIdFor — same lead id as pointer AND stamp but different letter case', () => {
  test('is treated as TWO distinct candidates today (String() changes type, not case) → ambiguous, null', async () => {
    const upper = LEAD_ID.toUpperCase();
    mockBuilders.leads = splitBuilder({ pluckResult: [LEAD_ID], firstRow: OPEN_RECURRING_LEAD });
    // Pointer resolves to the lowercase id; the stamp names the same lead in
    // upper case. This documents CURRENT behavior — the two are not folded
    // into one candidate, so the estimate is (safely, but perhaps
    // surprisingly) treated as ambiguous rather than confirmed. Worth an
    // explicit owner/engineering call on whether case-insensitive UUID
    // comparison should be added; not changed here since it's unclear
    // whether a real stamped lead_id can ever diverge in case from the
    // canonical id Postgres returns (uuid columns normalize to lowercase on
    // read, and every writer we found copies the id verbatim rather than
    // retyping it).
    const result = await linkedLeadIdFor(ESTIMATE_ID, baseEstimateData({ lead_id: upper }));
    expect(result).toBeNull();
  });

  test('same id, same case, from both sources → ONE candidate, resolved', async () => {
    mockBuilders.leads = splitBuilder({ pluckResult: [LEAD_ID], firstRow: OPEN_RECURRING_LEAD });
    const result = await linkedLeadIdFor(ESTIMATE_ID, baseEstimateData({ lead_id: LEAD_ID }));
    expect(result).toBe(LEAD_ID);
  });
});
