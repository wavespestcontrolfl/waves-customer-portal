/**
 * Booking-triggered estimate pre-drafts (GATE_ESTIMATOR_BOOKING_PREDRAFTS).
 *
 * Pins: the double gate (booking gate AND engine gate, fail-closed), the
 * assessment filter (service_type name match + service_id → service_key
 * fallback; everything else skipped), the estimate-born skip, terminal-status
 * skip, the call-context delegation (source_call_log_id → full engine with
 * quotePromised asserted), the shell insert shape (source
 * 'booking_assessment', price fields ABSENT — NULL never 0, notes ABSENT —
 * customer-visible column, estimate_data.bookingPreDraft context), the
 * per-booking idempotency recheck, the shared phone duplicate guard, and
 * fail-soft on error.
 */

let mockState;
jest.mock('../models/db', () => {
  const makeBuilder = (table) => {
    const builder = {
      where() { return builder; },
      whereIn() { return builder; },
      whereNull() { return builder; },
      whereNot() { return builder; },
      whereRaw() { return builder; },
      orderBy() { return builder; },
      select() { return builder; },
      first: async () => {
        if (mockState.firstError) { const e = mockState.firstError; mockState.firstError = null; throw e; }
        return mockState.firstQueue.length ? mockState.firstQueue.shift() : null;
      },
      insert: (payload) => ({
        returning: async () => {
          mockState.inserts.push({ table, payload });
          return [{ id: 'est-1', ...payload }];
        },
      }),
      update: async (payload) => {
        mockState.updates.push({ table, payload });
        return 1;
      },
    };
    return builder;
  };
  const dbMock = jest.fn((table) => makeBuilder(table));
  const trx = Object.assign((table) => makeBuilder(table), {
    raw: async (...args) => { mockState.raws.push(args); return {}; },
  });
  dbMock.transaction = async (callback) => callback(trx);
  dbMock.raw = async () => ({});
  return dbMock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockMaybeDraftEstimateForCall = jest.fn();
const mockEstimatorEngineEnabled = jest.fn();
jest.mock('../services/estimator-engine/index', () => ({
  estimatorEngineEnabled: () => mockEstimatorEngineEnabled(),
  maybeDraftEstimateForCall: (...args) => mockMaybeDraftEstimateForCall(...args),
}));

const mockBlockDuplicate = jest.fn();
jest.mock('../services/estimate-automation-duplicates', () => ({
  withAutomatedEstimatePhoneLock: async (_phone, callback) => {
    const db = require('../models/db');
    return callback(db);
  },
  blockIfAutomatedEstimateDuplicate: (...args) => mockBlockDuplicate(...args),
}));

const {
  bookingPreDraftsEnabled,
  maybePreDraftForBooking,
  _private,
} = require('../services/estimator-engine/booking-predraft');

const BOOKING = (overrides = {}) => ({
  id: 'svc-1',
  customer_id: 'cust-1',
  status: 'pending',
  service_type: 'Waves Assessment',
  service_id: 'catalog-1',
  source_call_log_id: null,
  source_estimate_id: null,
  scheduled_date: '2026-07-25',
  booking_source: null,
  source_action: 'admin_manual',
  service_address_line1: null,
  service_address_city: null,
  ...overrides,
});

const CUSTOMER = {
  id: 'cust-1',
  first_name: 'Pat',
  last_name: 'Lawn',
  phone: '+19415550142',
  email: 'pat@example.com',
  address_line1: '123 Main St',
  lead_source: 'google',
  lead_source_detail: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockState = { firstQueue: [], inserts: [], updates: [], raws: [], firstError: null };
  process.env.GATE_ESTIMATOR_BOOKING_PREDRAFTS = 'true';
  mockEstimatorEngineEnabled.mockReturnValue(true);
  mockBlockDuplicate.mockResolvedValue(null);
});

afterAll(() => {
  delete process.env.GATE_ESTIMATOR_BOOKING_PREDRAFTS;
});

describe('bookingPreDraftsEnabled', () => {
  test('requires BOTH the booking gate and the engine gate', () => {
    expect(bookingPreDraftsEnabled()).toBe(true);
    mockEstimatorEngineEnabled.mockReturnValue(false);
    expect(bookingPreDraftsEnabled()).toBe(false);
    mockEstimatorEngineEnabled.mockReturnValue(true);
    process.env.GATE_ESTIMATOR_BOOKING_PREDRAFTS = 'false';
    expect(bookingPreDraftsEnabled()).toBe(false);
    delete process.env.GATE_ESTIMATOR_BOOKING_PREDRAFTS;
    expect(bookingPreDraftsEnabled()).toBe(false);
  });
});

describe('maybePreDraftForBooking — filters', () => {
  test('gate off drafts nothing', async () => {
    process.env.GATE_ESTIMATOR_BOOKING_PREDRAFTS = 'false';
    const result = await maybePreDraftForBooking('svc-1');
    expect(result).toEqual({ drafted: false, skipped: 'gate_off' });
    expect(mockState.inserts).toHaveLength(0);
  });

  test('a non-assessment booking is skipped — by name AND by catalog key', async () => {
    // Name mismatch, service_id resolves to a normal catalog row.
    mockState.firstQueue = [
      BOOKING({ service_type: 'Quarterly Pest Control' }),
      { id: 'catalog-1', service_key: 'pest_quarterly', name: 'Quarterly Pest Control' },
    ];
    const result = await maybePreDraftForBooking('svc-1');
    expect(result).toEqual({ drafted: false, skipped: 'not_assessment' });
    expect(mockState.inserts).toHaveLength(0);
  });

  test('a legacy row with no service_id still matches by denormalized name', async () => {
    mockState.firstQueue = [
      BOOKING({ service_id: null }),
      CUSTOMER,
      null, // per-booking idempotency probe
    ];
    const result = await maybePreDraftForBooking('svc-1');
    expect(result.drafted).toBe(true);
  });

  test('a catalog-linked assessment matches by service_key even under a renamed service_type', async () => {
    mockState.firstQueue = [
      BOOKING({ service_type: 'Consultation (legacy)' }),
      { id: 'catalog-1', service_key: 'lawn_inspection', name: 'Waves Assessment' },
      CUSTOMER,
      null,
    ];
    const result = await maybePreDraftForBooking('svc-1');
    expect(result.drafted).toBe(true);
  });

  test('a booking born from an estimate never re-drafts', async () => {
    mockState.firstQueue = [BOOKING({ source_estimate_id: 'est-9' })];
    const result = await maybePreDraftForBooking('svc-1');
    expect(result).toEqual({ drafted: false, skipped: 'estimate_born' });
  });

  test('a terminal booking never seeds a draft', async () => {
    mockState.firstQueue = [BOOKING({ status: 'cancelled' })];
    const result = await maybePreDraftForBooking('svc-1');
    expect(result).toEqual({ drafted: false, skipped: 'booking_terminal' });
  });
});

describe('maybePreDraftForBooking — call delegation', () => {
  test('a phone-booked assessment rides the FULL engine call context and gets the booking linkage merged', async () => {
    mockState.firstQueue = [
      BOOKING({ source_call_log_id: 'call-7' }),
      // linkEstimateToBooking's read of the engine-created estimate.
      { id: 'est-5', estimate_data: JSON.stringify({ estimatorEngine: { callLogId: 'call-7' } }) },
    ];
    mockMaybeDraftEstimateForCall.mockResolvedValue({ created: true, lane: 'green', estimateId: 'est-5' });
    const result = await maybePreDraftForBooking('svc-1');
    expect(mockMaybeDraftEstimateForCall).toHaveBeenCalledWith({
      callLogId: 'call-7',
      quotePromised: true,
    });
    expect(result).toEqual({ drafted: true, delegated: 'call_engine', lane: 'green', estimateId: 'est-5' });
    expect(mockState.inserts).toHaveLength(0); // the engine owns the insert
    // The booking linkage merges into the engine draft (schedule badge +
    // collision guard), preserving the engine's own estimate_data.
    expect(mockState.updates).toHaveLength(1);
    const merged = JSON.parse(mockState.updates[0].payload.estimate_data);
    expect(merged.scheduled_service_id).toBe('svc-1');
    expect(merged.estimatorEngine.callLogId).toBe('call-7');
  });

  test('an existing stitched linkage is never clobbered', async () => {
    mockState.firstQueue = [
      BOOKING({ source_call_log_id: 'call-7' }),
      { id: 'est-5', estimate_data: JSON.stringify({ scheduled_service_id: 'svc-other' }) },
    ];
    mockMaybeDraftEstimateForCall.mockResolvedValue({ created: false, lane: 'green', estimateId: 'est-5' });
    await maybePreDraftForBooking('svc-1');
    expect(mockState.updates).toHaveLength(0);
  });
});

describe('maybePreDraftForBooking — shell path', () => {
  test('shell insert shape: unpriced, note-less, booking context in estimate_data', async () => {
    mockState.firstQueue = [
      BOOKING({ service_address_line1: '456 Palm Ave', service_address_city: 'Sarasota' }),
      CUSTOMER,
      null, // idempotency probe
    ];
    const result = await maybePreDraftForBooking('svc-1');
    expect(result.drafted).toBe(true);
    expect(mockState.inserts).toHaveLength(1);
    const row = mockState.inserts[0].payload;
    expect(row.source).toBe('booking_assessment');
    expect(row.status).toBe('draft');
    expect(row.customer_id).toBe('cust-1');
    expect(row.customer_name).toBe('Pat Lawn');
    expect(row.address).toBe('456 Palm Ave, Sarasota');
    expect(row.service_interest).toBe('Waves Assessment');
    // Price fields ABSENT (NULL in the db) — a 0 here hits the $0-fallback
    // trap downstream.
    expect(row.monthly_total).toBeUndefined();
    expect(row.onetime_total).toBeUndefined();
    expect(row.annual_total).toBeUndefined();
    // estimates.notes is CUSTOMER-VISIBLE — the shell must not write it.
    expect(row.notes).toBeUndefined();
    // Customer-visible bearer token: full 128-bit entropy, no guessable
    // name slug, safely inside varchar(64).
    expect(row.token).toMatch(/^[0-9a-f]{32}$/);
    const data = JSON.parse(row.estimate_data);
    // Durable linkage key — the one reviseAdminEstimate preserves across
    // wholesale estimate_data rewrites; the idempotency probe keys on it.
    expect(data.scheduled_service_id).toBe('svc-1');
    expect(data.bookingPreDraft.scheduledServiceId).toBe('svc-1');
    expect(data.bookingPreDraft.serviceType).toBe('Waves Assessment');
    // Expiry outlives the visit: ET-derived from the ET business date —
    // never the naive UTC-midnight parse that lands the prior ET evening.
    const expiresMs = row.expires_at.getTime();
    const etNoon = new Date('2026-07-25T16:00:00Z').getTime(); // noon ET (EDT) on the visit date
    expect(expiresMs).toBe(etNoon + 14 * 86400000);
  });

  test('falls back to the customer address when the booking has none', async () => {
    mockState.firstQueue = [BOOKING(), CUSTOMER, null];
    await maybePreDraftForBooking('svc-1');
    expect(mockState.inserts[0].payload.address).toBe('123 Main St');
  });

  test('replayed hook (regenerate-brief) is idempotent per booking', async () => {
    mockState.firstQueue = [
      BOOKING(),
      CUSTOMER,
      { id: 'est-existing' }, // idempotency probe finds the prior pre-draft
    ];
    const result = await maybePreDraftForBooking('svc-1');
    expect(result).toEqual({ drafted: false, skipped: 'already_drafted', estimateId: 'est-existing' });
    expect(mockState.inserts).toHaveLength(0);
  });

  test('an open estimate on the phone blocks the shell — shared duplicate guard', async () => {
    mockState.firstQueue = [BOOKING(), CUSTOMER, null];
    mockBlockDuplicate.mockResolvedValue({ existingEstimateId: 'est-open', existingStatus: 'sent' });
    const result = await maybePreDraftForBooking('svc-1');
    expect(result).toEqual({ drafted: false, skipped: 'duplicate_open_estimate', estimateId: 'est-open' });
    expect(mockState.inserts).toHaveLength(0);
  });

  test('a phone-less customer serializes on a per-booking advisory lock instead of running bare', async () => {
    mockState.firstQueue = [
      BOOKING(),
      { ...CUSTOMER, phone: null },
      null, // idempotency probe
    ];
    const result = await maybePreDraftForBooking('svc-1');
    expect(result.drafted).toBe(true);
    // The fallback lock keys on the booking id — concurrent hook replays
    // cannot both pass the idempotency probe.
    expect(mockState.raws).toHaveLength(1);
    expect(mockState.raws[0][1]).toEqual(['booking_predraft', 'svc-1']);
  });

  test('a missing customer skips cleanly', async () => {
    mockState.firstQueue = [BOOKING(), null];
    const result = await maybePreDraftForBooking('svc-1');
    expect(result).toEqual({ drafted: false, skipped: 'no_customer' });
  });

  test('db failure is fail-soft — never throws to the booking path', async () => {
    mockState.firstError = new Error('connection lost');
    const result = await maybePreDraftForBooking('svc-1');
    expect(result).toEqual({ drafted: false, skipped: 'error' });
  });
});

describe('_private.isAssessmentBooking', () => {
  test('name match is case-insensitive and trimmed', async () => {
    expect(await _private.isAssessmentBooking({ service_type: '  waves assessment ', service_id: null })).toBe(true);
    expect(await _private.isAssessmentBooking({ service_type: 'Waves Assessment Plus', service_id: null })).toBe(false);
  });
});
