/**
 * Voice-relay Phase B request_booking — the ONE write, double-gated
 * (VOICE_RELAY_CONTEXT_ENABLED + GATE_VOICE_AI_BOOKING), fail-closed.
 *
 * Matrix:
 *   - booking gate off (even with context gate on) → tool not registered AND
 *     the body refuses; zero DB touch
 *   - both gates on → creates a PENDING scheduled_services row with
 *     source_action 'voice_agent' (the outbound-review lifecycle), never a
 *     confirmed appointment
 *   - NO customer comms at create: no SMS, no email, no reminder
 *     registration, no confirm-hook side effects (comms spies asserted)
 *   - stale/invented slot → refused via the SAME availability engine
 *     find_slots uses (buildBookingAvailability re-check)
 *   - pre-8am start → refused before the engine is consulted (house rule)
 *   - unknown service ask → falls back to the "Waves Assessment" catalog row
 *   - source_action allowlist membership (REAL module, not a mock):
 *     dispatch-owned + office-review-pending both include 'voice_agent'
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn();
  return fn;
});
jest.mock('../services/lead-from-extraction', () => ({ createLeadFromExtraction: jest.fn() }));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/call-recording-processor', () => ({
  CONTACT_MATCH_PHONE_COLS: ['phone'],
  summarizePriorCall: jest.fn(),
}));
jest.mock('../routes/booking', () => ({
  _internals: {
    loadBookingConfig: jest.fn(),
    resolveBookingCoords: jest.fn(),
    buildBookingAvailability: jest.fn(),
    MAX_BOOKING_HORIZON_DAYS: 90,
  },
}));
jest.mock('../services/call-booking-catalog', () => ({
  loadBookableCallServices: jest.fn(),
  resolveCallBookingCatalogService: jest.fn(),
  resolveCallBookingPrice: jest.fn(),
  callBookingInvoiceOnComplete: jest.fn(),
}));
jest.mock('../services/call-routing-gates', () => ({
  buildTriageItem: jest.fn((args) => ({
    call_log_id: args.callLogId,
    category: 'time_ambiguous',
    severity: args.severity,
    reason_code: args.flag,
    status: 'open',
    payload: JSON.stringify(args.extraPayload || {}),
  })),
}));
// Comms spies — NONE of these may fire at create time (house rule: the
// office/owner sends all customer communications; reminders arm at office
// confirm via the shared hook, never here).
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn(), sendCustomerMessage: jest.fn() }));
jest.mock('../services/email', () => ({ sendEmail: jest.fn() }));
jest.mock('../services/appointment-reminders', () => ({ registerAppointment: jest.fn(), handleReschedule: jest.fn() }));
jest.mock('../services/outbound-review-confirm', () => ({ runOutboundReviewConfirmHook: jest.fn() }));

const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const booking = require('../routes/booking')._internals;
const catalog = require('../services/call-booking-catalog');
const TwilioService = require('../services/twilio');
const EmailService = require('../services/email');
const AppointmentReminders = require('../services/appointment-reminders');
const { runOutboundReviewConfirmHook } = require('../services/outbound-review-confirm');

const relayBooking = require('../services/voice-agent/relay-booking');
const { activeTools, executeTool, BOOKING_TOOLS } = require('../services/voice-agent/relay-tools');
const sourceActions = require('../services/call-booking-source-actions'); // REAL module on purpose

const CUSTOMER = { id: 'c-1111', first_name: 'Pat', address_line1: '12 Shore Dr', city: 'Bradenton', zip: '34209' };
const PEST_ROW = { id: 'svc-pest', service_key: 'general_pest', name: 'General Pest Control', billing_type: 'one_time', pricing_type: 'fixed', base_price: 150, default_duration_minutes: 45 };
const ASSESSMENT_ROW = { id: 'ba1c3b87', service_key: 'waves_assessment', name: 'Waves Assessment', billing_type: 'one_time', pricing_type: 'fixed', base_price: 0, default_duration_minutes: 30 };
const SLOT = {
  date: '2026-08-20', start_time: '09:00', end_time: '10:00',
  start_label: '9:00 AM', end_label: '10:00 AM', startTime24: '09:00', endTime24: '10:00',
  technician_id: 't-1',
};
const CONFIG = { advance_days_min: 1, advance_days_max: 14, slot_duration_minutes: 60 };

// ── knex-ish harness ───────────────────────────────────────────────────────
function makeBuilder(rows) {
  const b = {};
  const chain = ['where', 'whereNull', 'whereIn', 'orderBy', 'select', 'limit', 'whereRaw', 'orWhereRaw'];
  for (const m of chain) b[m] = jest.fn(() => b);
  b.first = jest.fn(() => Promise.resolve(rows[0] || null));
  b.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  b.insert = jest.fn(() => { throw new Error('WRITE ATTEMPTED OUTSIDE TRANSACTION'); });
  b.update = jest.fn(() => { throw new Error('WRITE ATTEMPTED'); });
  b.del = jest.fn(() => { throw new Error('WRITE ATTEMPTED'); });
  return b;
}

let builders;
let trxBuilders;
let trx;
function primeDb({ customers = [CUSTOMER], scheduled = [], callLog = [{ id: 'cl-77' }] } = {}) {
  builders = {
    customers: makeBuilder(customers),
    scheduled_services: makeBuilder(scheduled),
    call_log: makeBuilder(callLog),
  };
  db.mockImplementation((table) => {
    if (!builders[table]) builders[table] = makeBuilder([]);
    return builders[table];
  });

  // Transaction-side builders: the ONLY place writes are allowed.
  const created = { id: 'ss-501', customer_id: CUSTOMER.id };
  const ssTrx = {
    insert: jest.fn(() => ssTrx),
    returning: jest.fn(() => Promise.resolve([created])),
  };
  const triageTrx = {
    insert: jest.fn(() => triageTrx),
    onConflict: jest.fn(() => triageTrx),
    ignore: jest.fn(() => Promise.resolve()),
  };
  trxBuilders = { scheduled_services: ssTrx, triage_items: triageTrx };
  trx = (table) => trxBuilders[table];
  trx.raw = jest.fn((sql) => sql);
  db.transaction.mockImplementation(async (cb) => cb(trx));
}

function assertNoCreateWrites() {
  expect(db.transaction).not.toHaveBeenCalled();
  if (trxBuilders) {
    expect(trxBuilders.scheduled_services.insert).not.toHaveBeenCalled();
    expect(trxBuilders.triage_items.insert).not.toHaveBeenCalled();
  }
}

function assertNoComms() {
  expect(TwilioService.sendSMS).not.toHaveBeenCalled();
  expect(TwilioService.sendCustomerMessage).not.toHaveBeenCalled();
  expect(EmailService.sendEmail).not.toHaveBeenCalled();
  expect(AppointmentReminders.registerAppointment).not.toHaveBeenCalled();
  expect(AppointmentReminders.handleReschedule).not.toHaveBeenCalled();
  expect(runOutboundReviewConfirmHook).not.toHaveBeenCalled();
}

const savedContext = process.env.VOICE_RELAY_CONTEXT_ENABLED;
const savedBooking = process.env.GATE_VOICE_AI_BOOKING;
afterAll(() => {
  if (savedContext === undefined) delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
  else process.env.VOICE_RELAY_CONTEXT_ENABLED = savedContext;
  if (savedBooking === undefined) delete process.env.GATE_VOICE_AI_BOOKING;
  else process.env.GATE_VOICE_AI_BOOKING = savedBooking;
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
  delete process.env.GATE_VOICE_AI_BOOKING;
  primeDb();
  isEnabled.mockReturnValue(true);
  booking.loadBookingConfig.mockResolvedValue(CONFIG);
  booking.resolveBookingCoords.mockResolvedValue({ lat: 27.4, lng: -82.5 });
  booking.buildBookingAvailability.mockResolvedValue({ slots: [SLOT], days: [{ slots: [SLOT] }] });
  catalog.loadBookableCallServices.mockResolvedValue([PEST_ROW, ASSESSMENT_ROW]);
  catalog.resolveCallBookingCatalogService.mockReturnValue(PEST_ROW);
  catalog.resolveCallBookingPrice.mockReturnValue({ price: 150, source: 'catalog' });
  catalog.callBookingInvoiceOnComplete.mockReturnValue(true);
});

const GOOD_INPUT = { date: '2026-08-20', time: '9:00 AM', service: 'pest control for ants' };
const CTX = { customerId: CUSTOMER.id, callSid: 'CA-relay-1' };

describe('source_action allowlist membership (REAL call-booking-source-actions)', () => {
  test('voice_agent is dispatch-owned pending AND office-review pending, and fits varchar(30)', () => {
    expect(sourceActions.VOICE_AGENT_BOOKING_SOURCE_ACTION).toBe('voice_agent');
    expect(sourceActions.VOICE_AGENT_BOOKING_SOURCE_ACTION.length).toBeLessThanOrEqual(30);
    expect(sourceActions.DISPATCH_OWNED_PENDING_SOURCE_ACTIONS).toContain('voice_agent');
    expect(sourceActions.OFFICE_REVIEW_PENDING_SOURCE_ACTIONS).toContain('voice_agent');
  });

  test('isPendingOutboundReviewBooking covers a pending voice_agent row, releases once confirmed', () => {
    expect(sourceActions.isPendingOutboundReviewBooking({
      source_action: 'voice_agent', status: 'pending', customer_confirmed: false,
    })).toBe(true);
    expect(sourceActions.isPendingOutboundReviewBooking({
      source_action: 'voice_agent', status: 'confirmed', customer_confirmed: true,
    })).toBe(false);
    // The original outbound-review shape still classifies (no drift).
    expect(sourceActions.isPendingOutboundReviewBooking({
      source_action: 'ai_call_outbound_review', status: 'pending', customer_confirmed: false,
    })).toBe(true);
  });
});

describe('GATES — both required, fail closed', () => {
  test('booking gate OFF (context gate ON) → tool not registered, body refuses, zero DB touch', async () => {
    process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true';
    expect(relayBooking.isBookingEnabled()).toBe(false);
    expect(activeTools().map((t) => t.name)).not.toContain('request_booking');
    const out = await executeTool('request_booking', GOOD_INPUT, CTX);
    expect(out).toMatch(/not available/i);
    expect(out).toMatch(/Do NOT tell the caller anything is booked/i);
    expect(db).not.toHaveBeenCalled();
    assertNoCreateWrites();
    assertNoComms();
  });

  test('context gate OFF (booking gate ON alone) → still dark', async () => {
    process.env.GATE_VOICE_AI_BOOKING = 'true';
    expect(relayBooking.isBookingEnabled()).toBe(false);
    expect(activeTools().map((t) => t.name)).not.toContain('request_booking');
    const out = await executeTool('request_booking', GOOD_INPUT, CTX);
    expect(out).toMatch(/not available/i);
    expect(db).not.toHaveBeenCalled();
    assertNoCreateWrites();
  });

  test('gate values other than the literal "true" stay dark', () => {
    process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true';
    for (const v of ['1', 'on', 'TRUE ', 'yes']) {
      process.env.GATE_VOICE_AI_BOOKING = v;
      expect(relayBooking.isBookingEnabled()).toBe(false);
    }
  });

  test('both gates on → request_booking registers alongside the context tools', () => {
    process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true';
    process.env.GATE_VOICE_AI_BOOKING = 'true';
    const names = activeTools().map((t) => t.name);
    expect(names).toContain('request_booking');
    expect(BOOKING_TOOLS.find((t) => t.name === 'request_booking').input_schema.required).toEqual(['date', 'time']);
  });
});

describe('BOTH GATES ON — request_booking behavior', () => {
  beforeEach(() => {
    process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true';
    process.env.GATE_VOICE_AI_BOOKING = 'true';
  });

  test('creates a PENDING voice_agent row — never confirmed, no comms, no confirm-hook side effects', async () => {
    const out = await executeTool('request_booking', GOOD_INPUT, CTX);

    const insert = trxBuilders.scheduled_services.insert;
    expect(insert).toHaveBeenCalledTimes(1);
    const row = insert.mock.calls[0][0];
    expect(row).toMatchObject({
      customer_id: CUSTOMER.id,
      scheduled_date: '2026-08-20',
      window_start: '09:00',
      window_end: '10:00',
      service_type: 'General Pest Control',
      service_id: 'svc-pest',
      status: 'pending',
      customer_confirmed: false,
      booking_source: 'phone_call',
      source_call_log_id: 'cl-77',
      source_action: 'voice_agent',
      estimated_price: 150,
    });
    expect(row.confirmed_at).toBeUndefined(); // never pre-confirmed
    expect(row.technician_id).toBe('t-1'); // from the re-validated engine slot

    // The pending request surfaces in the EXISTING admin confirm queue.
    const triageInsert = trxBuilders.triage_items.insert;
    expect(triageInsert).toHaveBeenCalledTimes(1);
    expect(triageInsert.mock.calls[0][0]).toMatchObject({ reason_code: 'outbound_booking_review', status: 'open' });
    expect(JSON.parse(triageInsert.mock.calls[0][0].payload)).toMatchObject({ origin: 'voice_agent' });

    // Slot was re-validated through the live engine, pinned to the requested day.
    expect(booking.buildBookingAvailability).toHaveBeenCalledWith(expect.objectContaining({
      rangeFrom: '2026-08-20', rangeTo: '2026-08-20',
    }));

    // NOTHING customer-facing fired at create.
    assertNoComms();

    // The script never promises a locked time.
    expect(out).toMatch(/NOT a confirmed appointment/i);
    expect(out).toMatch(/text or call/i);
    expect(out).toMatch(/Do NOT say the time is locked in/i);
  });

  test('invalid/stale slot (engine no longer offers it) → refused, nothing written', async () => {
    booking.buildBookingAvailability.mockResolvedValue({ slots: [{ ...SLOT, start_time: '13:00', startTime24: '13:00' }], days: [] });
    const out = await executeTool('request_booking', GOOD_INPUT, CTX);
    expect(out).toMatch(/no longer open/i);
    expect(out).toMatch(/nothing was booked/i);
    assertNoCreateWrites();
    assertNoComms();
  });

  test('pre-8am slot → refused BEFORE the availability engine is consulted (house rule)', async () => {
    const out = await executeTool('request_booking', { ...GOOD_INPUT, time: '7:00 AM' }, CTX);
    expect(out).toMatch(/never start before 8:00 AM/i);
    expect(booking.buildBookingAvailability).not.toHaveBeenCalled();
    assertNoCreateWrites();
  });

  test('parseTimeToMinutes handles spoken + 24h forms; 8am boundary is exact', () => {
    expect(relayBooking.parseTimeToMinutes('9:00 AM')).toBe(540);
    expect(relayBooking.parseTimeToMinutes('9 AM')).toBe(540);
    expect(relayBooking.parseTimeToMinutes('13:30')).toBe(810);
    expect(relayBooking.parseTimeToMinutes('12:00 PM')).toBe(720);
    expect(relayBooking.parseTimeToMinutes('12:15 AM')).toBe(15);
    expect(relayBooking.parseTimeToMinutes('gibberish')).toBeNull();
    expect(relayBooking.EARLIEST_START_MINUTES).toBe(480);
  });

  test('unknown/unclear service ask → falls back to the Waves Assessment catalog row, never invents', async () => {
    catalog.resolveCallBookingCatalogService.mockReturnValue(null);
    catalog.resolveCallBookingPrice.mockReturnValue({ price: null, source: null });
    catalog.callBookingInvoiceOnComplete.mockReturnValue(false);
    await executeTool('request_booking', { ...GOOD_INPUT, service: 'something weird with the roof maybe' }, CTX);
    const row = trxBuilders.scheduled_services.insert.mock.calls[0][0];
    expect(row.service_type).toBe('Waves Assessment');
    expect(row.service_id).toBe('ba1c3b87');
    expect(row.estimated_price).toBeNull();
  });

  test('no bookable catalog at all → refused, nothing written', async () => {
    catalog.loadBookableCallServices.mockResolvedValue([]);
    const out = await executeTool('request_booking', GOOD_INPUT, CTX);
    expect(out).toMatch(/no booking request was\s+placed/i);
    assertNoCreateWrites();
  });

  test('no customer (unmatched caller, no ref) → refused, capture-lead guidance, nothing written', async () => {
    const out = await executeTool('request_booking', GOOD_INPUT, { customerId: null });
    expect(out).toMatch(/capture the lead/i);
    expect(out).toMatch(/Do NOT tell the caller anything is booked/i);
    assertNoCreateWrites();
  });

  test('booking for a looked-up account via customer_ref works; invented ref refused', async () => {
    const ctx = {
      customerId: null,
      callSid: 'CA-relay-2',
      resolveLookupRef: (ref) => (ref === 'C1' ? CUSTOMER.id : null),
    };
    await executeTool('request_booking', { ...GOOD_INPUT, customer_ref: 'C1' }, ctx);
    expect(trxBuilders.scheduled_services.insert).toHaveBeenCalledTimes(1);

    jest.clearAllMocks();
    primeDb();
    const out = await executeTool('request_booking', { ...GOOD_INPUT, customer_ref: 'C9' }, ctx);
    expect(out).toMatch(/not from a lookup_customer result/i);
    assertNoCreateWrites();
  });

  test('duplicate pending request for the same customer/day → refused (idempotent double tool-call)', async () => {
    primeDb({ scheduled: [{ id: 'ss-existing', window_start: '09:00' }] });
    const out = await executeTool('request_booking', GOOD_INPUT, CTX);
    expect(out).toMatch(/already in/i);
    assertNoCreateWrites();
  });

  test('selfBooking engine gate off → refused (no slot can be validated), nothing written', async () => {
    isEnabled.mockReturnValue(false);
    const out = await executeTool('request_booking', GOOD_INPUT, CTX);
    expect(out).toMatch(/not available right now/i);
    assertNoCreateWrites();
  });

  test('missing call_log row (sandbox path) → booking still lands, just without a triage card', async () => {
    primeDb({ callLog: [] });
    await executeTool('request_booking', GOOD_INPUT, CTX);
    const row = trxBuilders.scheduled_services.insert.mock.calls[0][0];
    expect(row.source_call_log_id).toBeNull();
    expect(trxBuilders.triage_items.insert).not.toHaveBeenCalled();
  });

  test('gate-on prompt gains the booking addendum; context-only prompt does not', () => {
    const { buildBasePrompt } = require('../services/voice-agent/relay-conversation');
    const withBooking = buildBasePrompt(true);
    expect(withBooking).toContain('BOOKING REQUESTS');
    expect(withBooking).toContain('NEVER say the time is locked in');
    delete process.env.GATE_VOICE_AI_BOOKING;
    const contextOnly = buildBasePrompt(true);
    expect(contextOnly).not.toContain('BOOKING REQUESTS');
  });
});
