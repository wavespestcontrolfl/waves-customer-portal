/**
 * Integration coverage for the post-probe fresh-read recheck
 * (server/services/estimate-consultation-offer.js's finalEligibility,
 * Codex #4918 r5 P2) as it actually changes buildGoneQuietConsultationUrl's
 * OUTCOME — estimate-email-consultation-offer.test.js mocks
 * estimateConsultationLead entirely and so cannot observe this; this file
 * exercises the real estimateConsultationLead chain underneath it.
 *
 * Finding 3 (Codex #4918 r5): estimateConsultationLead returned the lead
 * snapshot loaded BEFORE the up-to-3s slot probe, so a lead whose email
 * changed DURING the probe still had its OLD (pre-probe) email compared
 * against the send's recipient — approving a mailbox that is no longer the
 * lead's own. finalEligibility re-reads the lead fresh after the probe and
 * the email builder's recipientIsLead check now runs against that fresh
 * lead, single-sourced.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: () => 'https://portal.wavespestcontrol.com' }));

let mockBuilders = {};
const mockDb = jest.fn((table) => mockBuilders[table]);
jest.mock('../models/db', () => mockDb);

const mockComputeConsultationSlotsForLead = jest.fn();
jest.mock('../routes/inspection-public', () => ({
  _internals: {
    computeConsultationSlotsForLead: (...args) => mockComputeConsultationSlotsForLead(...args),
  },
}));

// The post-probe recheck reuses the public page's own accept-active
// predicate (isEstimateAcceptActive) — mocked here like the sibling unit
// suite so this stays a fast, isolated test with no real route loaded.
const mockIsEstimateAcceptActive = jest.fn(() => true);
jest.mock('../routes/estimate-public', () => ({
  isEstimateAcceptActive: (...args) => mockIsEstimateAcceptActive(...args),
}));

// shortWrap is the only piece of lead-consultation-email-block.js this file
// stubs — recipientIsLead (the rule under test) runs for REAL.
const mockShortWrap = jest.fn();
jest.mock('../services/lead-consultation-email-block', () => {
  const actual = jest.requireActual('../services/lead-consultation-email-block');
  return { ...actual, shortWrap: (...args) => mockShortWrap(...args) };
});

const { buildGoneQuietConsultationUrl } = require('../services/estimate-email-consultation-offer');

const LEAD_ID = 'lead-fresh-1';
const ESTIMATE_ID = 'est-fresh-1';

const originalOfferGate = process.env.GATE_ESTIMATE_EMAIL_CONSULTATION_OFFER;
const originalInspectionGate = process.env.GATE_LEAD_INSPECTION_LINK;
const originalSecret = process.env.LEAD_PREFILL_SECRET;

function leadRow(overrides = {}) {
  return {
    id: LEAD_ID,
    phone: '9415551234',
    email: 'original@example.com',
    service_interest: 'Recurring Pest Control',
    status: 'new',
    converted_at: null,
    customer_id: null,
    ...overrides,
  };
}

function estimateRow(overrides = {}) {
  return {
    id: ESTIMATE_ID,
    address: '123 Palm St, Bradenton, FL 34205',
    estimate_group_id: null,
    archived_at: null,
    status: 'viewed',
    expires_at: null,
    estimate_data: JSON.stringify({ lead_id: LEAD_ID, lead_linkage: 'sid' }),
    customer_id: null,
    customer_phone: '(941) 555-1234',
    customer_email: 'original@example.com',
    ...overrides,
  };
}

// A `leads` builder whose .first() returns `first` on its OWN first call and
// `second` (the "changed during the probe" row) on every call after — models
// the lead row being edited underneath the in-flight slot probe. Both the
// pre-probe read and finalEligibility's post-probe re-read go through this
// SAME table key, so a real DB update landing between them is exactly one
// extra .first() call apart.
function leadsBuilder({ first, second = first, pointing = [] } = {}) {
  const b = {};
  let calls = 0;
  b.where = jest.fn(() => b);
  b.whereNull = jest.fn(() => b);
  b.limit = jest.fn(() => b);
  b.pluck = jest.fn(async () => pointing);
  b.first = jest.fn(async () => {
    calls += 1;
    return calls === 1 ? first : second;
  });
  return b;
}

function estimatesBuilder(row) {
  const b = {};
  b.where = jest.fn(() => b);
  b.first = jest.fn(async () => row);
  return b;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockShortWrap.mockImplementation(async (url) => `https://portal.wavespestcontrol.com/l/short-${url.slice(-8)}`);
  mockIsEstimateAcceptActive.mockReturnValue(true);
  process.env.GATE_ESTIMATE_EMAIL_CONSULTATION_OFFER = 'true';
  process.env.GATE_LEAD_INSPECTION_LINK = 'true';
  process.env.LEAD_PREFILL_SECRET = 'test-prefill-secret';
  mockBuilders = {
    leads: leadsBuilder({ first: leadRow() }),
    estimates: estimatesBuilder(estimateRow()),
  };
  mockComputeConsultationSlotsForLead.mockResolvedValue({
    ok: true,
    slots: [{ date: '2026-10-01', start_time: '09:00' }],
    needsAddress: false,
    address: { line1: '123 Palm Street', line2: null, city: 'Bradenton', state: 'FL', zip: '34205' },
  });
});

afterEach(() => {
  if (originalOfferGate === undefined) delete process.env.GATE_ESTIMATE_EMAIL_CONSULTATION_OFFER;
  else process.env.GATE_ESTIMATE_EMAIL_CONSULTATION_OFFER = originalOfferGate;
  if (originalInspectionGate === undefined) delete process.env.GATE_LEAD_INSPECTION_LINK;
  else process.env.GATE_LEAD_INSPECTION_LINK = originalInspectionGate;
  if (originalSecret === undefined) delete process.env.LEAD_PREFILL_SECRET;
  else process.env.LEAD_PREFILL_SECRET = originalSecret;
});

function callArgs(overrides = {}) {
  return {
    estimate: estimateRow(),
    estimateData: { lead_id: LEAD_ID, lead_linkage: 'sid' },
    acceptActive: true,
    recipientEmail: 'original@example.com',
    ...overrides,
  };
}

describe('buildGoneQuietConsultationUrl — post-probe lead freshness (Codex #4918 r5 P2 finding 3)', () => {
  test('the lead keeps the same email through the probe — recipient still matches, URL minted', async () => {
    const result = await buildGoneQuietConsultationUrl(callArgs());
    expect(result).toMatch(/^https:\/\/portal\.wavespestcontrol\.com\/l\//);
    expect(mockShortWrap).toHaveBeenCalledTimes(1);
  });

  test("the lead's email changes DURING the probe — the stale-match recipient is rejected, \"\" returned, nothing minted", async () => {
    mockBuilders.leads = leadsBuilder({
      first: leadRow({ email: 'original@example.com' }),
      second: leadRow({ email: 'changed-mid-probe@example.com' }),
    });
    const result = await buildGoneQuietConsultationUrl(callArgs());
    expect(result).toBe('');
    expect(mockShortWrap).not.toHaveBeenCalled();
  });

  test("the lead's email changes DURING the probe to the recipient itself — now eligible again (fresh state governs, not a frozen refusal)", async () => {
    mockBuilders.leads = leadsBuilder({
      first: leadRow({ email: 'someone-else@example.com' }),
      second: leadRow({ email: 'original@example.com' }),
    });
    const result = await buildGoneQuietConsultationUrl(callArgs());
    expect(result).toMatch(/^https:\/\/portal\.wavespestcontrol\.com\/l\//);
  });
});

describe('estimateConsultationLead (shared helper) — post-probe estimate freshness (Codex #4918 r5 P2 finding 1)', () => {
  test('the estimate is accepted/off-surface by the time the probe returns → no lead returned, no mint, no send-bearing offer', async () => {
    // The pre-probe acceptActive the caller computed was true (still true at
    // the top of estimateConsultationLead); isEstimateAcceptActive is the
    // POST-probe recheck and now says the fresh row is no longer active.
    mockIsEstimateAcceptActive.mockReturnValue(false);
    const result = await buildGoneQuietConsultationUrl(callArgs());
    expect(result).toBe('');
    expect(mockShortWrap).not.toHaveBeenCalled();
  });

  test('the estimate gains a quote-first disqualifier (scheduled_service_id) during the probe → null', async () => {
    mockBuilders.estimates = estimatesBuilder(estimateRow({
      estimate_data: JSON.stringify({ scheduled_service_id: 'svc-mid-probe' }),
    }));
    const result = await buildGoneQuietConsultationUrl(callArgs());
    expect(result).toBe('');
    expect(mockShortWrap).not.toHaveBeenCalled();
  });

  test('the estimate becomes grouped during the probe → null', async () => {
    mockBuilders.estimates = estimatesBuilder(estimateRow({ estimate_group_id: 'grp-mid-probe' }));
    const result = await buildGoneQuietConsultationUrl(callArgs());
    expect(result).toBe('');
    expect(mockShortWrap).not.toHaveBeenCalled();
  });

  test('nothing changes during the probe → still eligible, one clean mint', async () => {
    const result = await buildGoneQuietConsultationUrl(callArgs());
    expect(result).toMatch(/^https:\/\/portal\.wavespestcontrol\.com\/l\//);
    expect(mockShortWrap).toHaveBeenCalledTimes(1);
  });
});
