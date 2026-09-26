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
// What the page would do with the lead now — its lead-wide bookability and
// the inputs its booking address resolves from — re-read by the final check
// after the probe (Codex #4918 r17/r18); unchanged unless a test moves it.
const mockCurrentBookingState = jest.fn();
jest.mock('../routes/inspection-public', () => ({
  _internals: {
    computeConsultationSlotsForLead: (...args) => mockComputeConsultationSlotsForLead(...args),
    currentBookingState: (...args) => mockCurrentBookingState(...args),
  },
}));

// The post-probe recheck (Codex #4918 r5 P2) reuses the public page's own
// accept-active predicate — mocked here like every other DB-adjacent
// dependency so this stays a fast, isolated unit suite.
const mockIsEstimateAcceptActive = jest.fn(() => true);
jest.mock('../routes/estimate-public', () => ({
  isEstimateAcceptActive: (...args) => mockIsEstimateAcceptActive(...args),
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

// The post-probe recheck (finalEligibility, Codex #4918 r5 P2) re-reads
// `estimates` fresh. This is the "nothing changed" fresh row — open,
// unarchived, unexpired, no off-surface markers, quote-first, not grouped,
// and matching OPEN_RECURRING_LEAD's contact — so every test that doesn't
// deliberately simulate a mid-probe change reaches the same result it did
// before this recheck existed.
function freshOpenEstimate(overrides = {}) {
  return {
    id: ESTIMATE_ID,
    archived_at: null,
    status: 'viewed',
    expires_at: null,
    estimate_data: JSON.stringify({ lead_id: LEAD_ID, lead_linkage: 'sid' }),
    estimate_group_id: null,
    address: '123 Palm St, Bradenton, FL 34205',
    customer_id: null,
    customer_phone: '(941) 555-1234',
    customer_email: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockCreateShortCode.mockClear();
  jest.clearAllMocks();
  mockIsEstimateAcceptActive.mockReturnValue(true);
  mockBuilders = {
    leads: chainBuilder({ firstRow: OPEN_RECURRING_LEAD }),
    estimates: chainBuilder({ firstRow: freshOpenEstimate() }),
  };
  process.env.GATE_ESTIMATE_CONSULTATION_OFFER = 'true';
  process.env.GATE_LEAD_INSPECTION_LINK = 'true';
  process.env.LEAD_PREFILL_SECRET = 'test-prefill-secret';
  mockComputeConsultationSlotsForLead.mockResolvedValue({
    ok: true, slots: [{ date: '2026-10-01', start_time: '09:00' }], needsAddress: false, address: PAGE_ADDRESS, addressInputs: 'INPUTS-A',
  });
  // Mirrors the leads builder, so the judged lead fields agree with the final read.
  mockCurrentBookingState.mockImplementation(async () => ({
    lead: await mockBuilders.leads.first(), bookable: true, addressInputs: 'INPUTS-A',
  }));
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
    let settle;
    try {
      // Outlives the budget; settled in finally so this abandoned probe does
      // not hold one of the capped in-flight slots for later tests.
      mockComputeConsultationSlotsForLead.mockReturnValue(new Promise((resolve) => { settle = resolve; }));
      const pending = buildEstimateConsultationOffer(baseArgs());
      await jest.advanceTimersByTimeAsync(PROBE_BUDGET_MS);
      await expect(pending).resolves.toBeNull();
    } finally {
      settle?.({ ok: false, slots: [] });
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
      jest.useRealTimers();
    }
  });

  test('eligible but nothing to pick (out of area, retired catalog, no open times) → null', async () => {
    mockComputeConsultationSlotsForLead.mockResolvedValue({ ok: true, slots: [], needsAddress: false });
    expect(await buildEstimateConsultationOffer(baseArgs())).toBeNull();
  });
});

// Post-probe recheck (Codex #4918 r5 P2, finding 1): the probe above can
// take up to PROBE_BUDGET_MS, during which the estimate can turn
// accepted/declined/expired or gain an off-customer-surface marker.
// finalEligibility re-reads the estimate fresh and re-runs
// isEstimateAcceptActive AFTER the probe, before the page ever mints a URL.
describe('buildEstimateConsultationOffer — post-probe estimate freshness', () => {
  test('the estimate turns accept-inactive (accepted/declined/off-surface) by the time the probe returns → null, no mint', async () => {
    mockIsEstimateAcceptActive.mockReturnValue(false);
    const result = await buildEstimateConsultationOffer(baseArgs());
    expect(result).toBeNull();
    expect(mockComputeConsultationSlotsForLead).toHaveBeenCalledTimes(1); // the probe still ran; only the post-probe recheck failed
  });

  test('the estimate gains a quote-first disqualifier (scheduled_service_id) during the probe → null', async () => {
    mockBuilders.estimates = chainBuilder({
      firstRow: freshOpenEstimate({ estimate_data: JSON.stringify({ scheduled_service_id: 'svc-mid-probe' }) }),
    });
    expect(await buildEstimateConsultationOffer(baseArgs())).toBeNull();
  });

  test('the estimate becomes grouped during the probe → null', async () => {
    mockBuilders.estimates = chainBuilder({ firstRow: freshOpenEstimate({ estimate_group_id: 'grp-mid-probe' }) });
    expect(await buildEstimateConsultationOffer(baseArgs())).toBeNull();
  });

  test('the estimate address changes to a different property during the probe → null', async () => {
    mockBuilders.estimates = chainBuilder({ firstRow: freshOpenEstimate({ address: '9 Other Rd, Bradenton, FL 34205' }) });
    expect(await buildEstimateConsultationOffer(baseArgs())).toBeNull();
  });

  test('the stamped lead_id is replaced by another lead during the probe → null', async () => {
    mockBuilders.estimates = chainBuilder({
      firstRow: freshOpenEstimate({ estimate_data: JSON.stringify({ lead_id: 'other-lead', lead_linkage: 'sid' }) }),
    });
    expect(await buildEstimateConsultationOffer(baseArgs())).toBeNull();
  });

  test('the stamped link is removed during the probe (no pointer either) → null', async () => {
    mockBuilders.estimates = chainBuilder({ firstRow: freshOpenEstimate({ estimate_data: JSON.stringify({}) }) });
    expect(await buildEstimateConsultationOffer(baseArgs())).toBeNull();
  });

  test('the fresh estimate row is missing entirely (deleted mid-probe) → null', async () => {
    mockBuilders.estimates = chainBuilder({ firstRow: null });
    expect(await buildEstimateConsultationOffer(baseArgs())).toBeNull();
  });

  test('nothing changes during the probe → still eligible, same URL contract as before this recheck existed', async () => {
    const result = await buildEstimateConsultationOffer(baseArgs());
    expect(result?.url).toContain('/inspection/');
  });
});

// Codex #4918 r8 P2: the 3 s budget abandons a slow probe but cannot cancel
// it, so in-flight probes (abandoned ones included) are capped.
describe('estimateConsultationLead — bounded in-flight slot probes', () => {
  const { _test } = require('../services/estimate-consultation-offer');

  test('past MAX_PROBES_IN_FLIGHT hung probes, no new probe starts and no offer is built; a settled probe frees its slot', async () => {
    jest.useFakeTimers();
    try {
      const releases = [];
      mockComputeConsultationSlotsForLead.mockImplementation(() => new Promise((resolve) => { releases.push(resolve); }));
      const hung = [];
      for (let i = 0; i < _test.MAX_PROBES_IN_FLIGHT; i += 1) {
        const p = buildEstimateConsultationOffer(baseArgs());
        await jest.advanceTimersByTimeAsync(_test.PROBE_BUDGET_MS + 1);
        hung.push(await p);
      }
      expect(hung.every((r) => r === null)).toBe(true);
      expect(_test.probesInFlight()).toBe(_test.MAX_PROBES_IN_FLIGHT);
      const callsAtCap = mockComputeConsultationSlotsForLead.mock.calls.length;

      expect(await buildEstimateConsultationOffer(baseArgs())).toBeNull();
      expect(mockComputeConsultationSlotsForLead.mock.calls.length).toBe(callsAtCap); // nothing new started

      releases.forEach((r) => r({ ok: true, slots: [], needsAddress: false }));
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
      expect(_test.probesInFlight()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

// Codex #4918 r9 P2: estimateConsultationLead records what the post-claim
// reconfirm needs; reconfirmConsultationLead re-runs finalEligibility only.
describe('estimateConsultationLead context + reconfirmConsultationLead', () => {
  const { estimateConsultationLead, reconfirmConsultationLead } = require('../services/estimate-consultation-offer');

  test('an eligible result records estimateId, leadId and the probed address; the reconfirm re-runs without a new probe', async () => {
    const context = {};
    const args = baseArgs();
    const lead = await estimateConsultationLead({ ...args, context });
    expect(lead).toBeTruthy();
    expect(context).toEqual({ estimateId: ESTIMATE_ID, leadId: LEAD_ID, probedAddress: PAGE_ADDRESS, addressInputs: 'INPUTS-A' });
    const probes = mockComputeConsultationSlotsForLead.mock.calls.length;
    expect(await reconfirmConsultationLead(context)).toBeTruthy();
    expect(mockComputeConsultationSlotsForLead.mock.calls.length).toBe(probes);
  });

  test('an ineligible result leaves the context empty, and an empty context never reconfirms', async () => {
    const context = {};
    mockComputeConsultationSlotsForLead.mockResolvedValue({ ok: true, slots: [], needsAddress: false });
    expect(await estimateConsultationLead({ ...baseArgs(), context })).toBeNull();
    expect(context).toEqual({});
    expect(await reconfirmConsultationLead(context)).toBeNull();
  });

  test('the lead\'s booking address inputs moved after the build (lead or customer address edited, customer relinked) → the reconfirm returns null (Codex #4918 r17)', async () => {
    const context = {};
    await estimateConsultationLead({ ...baseArgs(), context });
    mockCurrentBookingState.mockResolvedValue({ lead: OPEN_RECURRING_LEAD, bookable: true, addressInputs: 'INPUTS-B' });
    expect(await reconfirmConsultationLead(context)).toBeNull();
    expect(mockCurrentBookingState).toHaveBeenLastCalledWith(LEAD_ID);
  });

  test('the estimate goes off-surface after the build → the reconfirm returns null', async () => {
    const context = {};
    await estimateConsultationLead({ ...baseArgs(), context });
    mockIsEstimateAcceptActive.mockReturnValue(false);
    expect(await reconfirmConsultationLead(context)).toBeNull();
  });
});

// Codex #4918 r17: the property the probe resolved must still be the one the
// /inspection page would book — its address inputs are re-read, never
// re-geocoded.
describe('buildEstimateConsultationOffer — the booking address inputs after the probe', () => {
  test('the lead\'s address (or its trusted customer\'s) moved during the probe → no offer, even though the estimate still matches the probed property', async () => {
    mockCurrentBookingState.mockResolvedValue({ lead: OPEN_RECURRING_LEAD, bookable: true, addressInputs: 'INPUTS-B' });
    expect(await buildEstimateConsultationOffer(baseArgs())).toBeNull();
  });

  test('a probe result without its address inputs fails closed → no offer', async () => {
    mockComputeConsultationSlotsForLead.mockResolvedValue({
      ok: true, slots: [{ date: '2026-10-01', start_time: '09:00' }], needsAddress: false, address: PAGE_ADDRESS,
    });
    expect(await buildEstimateConsultationOffer(baseArgs())).toBeNull();
  });

  test('unchanged inputs → the offer stands', async () => {
    expect((await buildEstimateConsultationOffer(baseArgs()))?.url).toContain('/inspection/');
  });
});

// Codex #4918 r18: the page's own lead-wide state is re-judged after the
// probe, and the contact-bearing lead read is the LAST one.
describe('buildEstimateConsultationOffer — lead-wide state and the final lead read', () => {
  const { estimateConsultationLead } = require('../services/estimate-consultation-offer');

  test('an assessment or visit booked for the lead during the probe (the page would answer already_booked/converted) → no offer', async () => {
    mockCurrentBookingState.mockResolvedValue({ lead: OPEN_RECURRING_LEAD, bookable: false, addressInputs: 'INPUTS-A' });
    expect(await buildEstimateConsultationOffer(baseArgs())).toBeNull();
  });

  test('the contact-bearing lead read comes AFTER the booking-state lookup, and its row is the one returned', async () => {
    const order = [];
    mockCurrentBookingState.mockImplementation(async () => {
      order.push('booking-state');
      return { lead: OPEN_RECURRING_LEAD, bookable: true, addressInputs: 'INPUTS-A' };
    });
    const leadFirst = mockBuilders.leads.first;
    mockBuilders.leads.first = jest.fn(async (...args) => { order.push('lead-read'); return leadFirst(...args); });
    const context = {};
    const lead = await estimateConsultationLead({ ...baseArgs(), context });
    expect(lead).toBeTruthy();
    expect(order[order.length - 1]).toBe('lead-read');
    expect(order.lastIndexOf('booking-state')).toBeLessThan(order.lastIndexOf('lead-read'));
  });

  test('a lead field the checks judged moved before the final read (here: the lead converted after the refusal check passed) → fails closed', async () => {
    mockCurrentBookingState.mockResolvedValue({ lead: OPEN_RECURRING_LEAD, bookable: true, addressInputs: 'INPUTS-A' });
    const converted = { ...OPEN_RECURRING_LEAD, status: 'converted', converted_at: new Date('2026-09-26T12:00:00Z') };
    let leadReads = 0;
    // Open for the pre-probe read, converted by the final contact read.
    mockBuilders.leads.first = jest.fn(async () => (++leadReads === 1 ? OPEN_RECURRING_LEAD : converted));
    expect(await buildEstimateConsultationOffer(baseArgs())).toBeNull();
    expect(leadReads).toBe(2);
  });
});
