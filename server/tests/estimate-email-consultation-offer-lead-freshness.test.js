/**
 * Integration coverage for the gone-quiet email offer's two steps over the
 * REAL shared eligibility chain (estimate-consultation-offer.js's
 * estimateConsultationLead + finalEligibility) — the sibling unit suite
 * mocks that chain entirely and so cannot observe freshness.
 *
 * Reads, in order: probeGoneQuietConsultation reads the estimate, the lead
 * (pre-probe), runs the slot probe, then re-reads the estimate and lead
 * (post-probe, Codex #4918 r5). After the engine's claim the link is minted
 * and goneQuietConsultationStillValid re-reads both once more, together with
 * the engine's own final reads (Codex #4918 r9–r16). A change in either
 * window drops the link.
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

const {
  probeGoneQuietConsultation,
  mintGoneQuietConsultationUrl,
  goneQuietConsultationStillValid,
} = require('../services/estimate-email-consultation-offer');

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

// Builders whose .first() walks a per-call sequence (the last entry
// repeats) — a DB edit landing between two reads of the SAME table is one
// sequence step apart. Lead reads: [pre-probe, post-probe, final re-judge].
// Estimate reads: [probe step's own read, post-probe, final re-judge].
function sequence(rows) {
  let calls = 0;
  return () => rows[Math.min(calls++, rows.length - 1)];
}

function leadsBuilder({ rows, pointing = [] } = {}) {
  const next = sequence(rows);
  const b = {};
  b.where = jest.fn(() => b);
  b.whereNull = jest.fn(() => b);
  b.limit = jest.fn(() => b);
  b.pluck = jest.fn(async () => pointing);
  b.first = jest.fn(async () => next());
  return b;
}

function estimatesBuilder(rows) {
  const next = sequence(rows);
  const b = {};
  b.where = jest.fn(() => b);
  b.first = jest.fn(async () => next());
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
    leads: leadsBuilder({ rows: [leadRow()] }),
    estimates: estimatesBuilder([estimateRow()]),
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

// The engine's sequence: probe, then (after its claim) mint, then the final
// check — the URL rides the email only if that check still passes.
async function offerFor(recipientEmail = 'original@example.com') {
  const context = await probeGoneQuietConsultation(ESTIMATE_ID);
  const minted = await mintGoneQuietConsultationUrl(context);
  const url = minted && (await goneQuietConsultationStillValid(context, recipientEmail)) ? minted : '';
  return { context, url };
}

describe('unchanged state — the offer goes through', () => {
  test('eligible, the recipient is the lead\'s own inbox → one short URL, minted once in the final step', async () => {
    const { context, url } = await offerFor();
    expect(context).toEqual(expect.objectContaining({ estimateId: ESTIMATE_ID, leadId: LEAD_ID }));
    expect(url).toMatch(/^https:\/\/portal\.wavespestcontrol\.com\/l\//);
    expect(mockShortWrap).toHaveBeenCalledTimes(1);
  });
});

describe('a change DURING the slot probe (Codex #4918 r5)', () => {
  test("the lead's email changes during the probe → the link is dropped, judged on fresh state at the send", async () => {
    mockBuilders.leads = leadsBuilder({
      rows: [leadRow({ email: 'original@example.com' }), leadRow({ email: 'changed-mid-probe@example.com' })],
    });
    const { url } = await offerFor();
    expect(url).toBe('');
  });

  test('the estimate email AND the lead email are both corrected during the probe → the offer survives (no pre-probe recipient snapshot)', async () => {
    mockBuilders.leads = leadsBuilder({
      rows: [leadRow({ email: 'orignal@example.com' }), leadRow({ email: 'original@example.com' })],
    });
    mockBuilders.estimates = estimatesBuilder([estimateRow({ customer_email: 'orignal@example.com' }), estimateRow()]);
    // The engine's own post-probe read carries the corrected recipient.
    const { url } = await offerFor('original@example.com');
    expect(url).toMatch(/^https:\/\/portal\.wavespestcontrol\.com\/l\//);
  });

  test("the lead's email changes during the probe TO the recipient → eligible (fresh state governs, not a frozen refusal)", async () => {
    mockBuilders.leads = leadsBuilder({
      rows: [leadRow({ email: 'someone-else@example.com' }), leadRow({ email: 'original@example.com' })],
    });
    const { url } = await offerFor();
    expect(url).toMatch(/^https:\/\/portal\.wavespestcontrol\.com\/l\//);
  });

  test('the estimate turns accepted/off-surface during the probe → no context', async () => {
    mockIsEstimateAcceptActive.mockReturnValueOnce(true).mockReturnValue(false);
    const { context, url } = await offerFor();
    expect(context).toBeNull();
    expect(url).toBe('');
  });

  test('the estimate gains a quote-first disqualifier or becomes grouped during the probe → no context', async () => {
    mockBuilders.estimates = estimatesBuilder([
      estimateRow(), estimateRow({ estimate_data: JSON.stringify({ lead_id: LEAD_ID, lead_linkage: 'sid', scheduled_service_id: 'svc-mid-probe' }) }),
    ]);
    expect((await offerFor()).context).toBeNull();
    mockBuilders.estimates = estimatesBuilder([estimateRow(), estimateRow({ estimate_group_id: 'grp-mid-probe' })]);
    expect((await offerFor()).context).toBeNull();
  });
});

describe('a change AFTER the probe, before the send (Codex #4918 r9/r12) — the final step drops only the link', () => {
  test("the lead's email changes between the probe and the send → \"\"", async () => {
    mockBuilders.leads = leadsBuilder({
      rows: [leadRow(), leadRow(), leadRow({ email: 'changed-before-send@example.com' })],
    });
    const { context, url } = await offerFor();
    expect(context).not.toBeNull();
    expect(url).toBe('');
  });

  test('the estimate gets a hold (off-surface) between the probe and the send → ""', async () => {
    mockIsEstimateAcceptActive.mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false);
    const { context, url } = await offerFor();
    expect(context).not.toBeNull();
    expect(url).toBe('');
  });

  test('the estimate is re-linked to a different lead between the probe and the send → ""', async () => {
    mockBuilders.estimates = estimatesBuilder([
      estimateRow(), estimateRow(), estimateRow({ estimate_data: JSON.stringify({ lead_id: 'another-lead', lead_linkage: 'sid' }) }),
    ]);
    const { context, url } = await offerFor();
    expect(context).not.toBeNull();
    expect(url).toBe('');
  });

  test("the send's recipient (read by the engine after the probe) is no longer the lead's inbox → \"\"", async () => {
    const { context, url } = await offerFor('new-owner@example.com');
    expect(context).not.toBeNull();
    expect(url).toBe('');
  });
});
