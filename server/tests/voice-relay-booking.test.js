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
    // Commit-time gates the web path enforces and the voice path did not.
    validateBookingSlotDate: jest.fn(() => null),
    bookingSlotWindow: jest.fn(() => ({ maxPerDay: 3 })),
    MAX_BOOKING_HORIZON_DAYS: 90,
  },
}));
// The ORDERING CONTRACT rungs (services/scheduling/occupancy.js) + the global
// tech-blind conflict probe every rung-1 holder owes.
jest.mock('../services/scheduling/occupancy', () => ({
  acquireOccupancyLock: jest.fn(() => Promise.resolve()),
  findConflictingVisits: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../services/availability', () => ({
  acquireSelfBookingDayCapLock: jest.fn(() => Promise.resolve()),
  countActiveSelfBookingsForDay: jest.fn(() => Promise.resolve(0)),
}));
jest.mock('../utils/customer-comms-lock', () => ({ lockCustomerComms: jest.fn(() => Promise.resolve()) }));
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
const occupancy = require('../services/scheduling/occupancy');
const availability = require('../services/availability');
const { lockCustomerComms } = require('../utils/customer-comms-lock');
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
// ⭐ THE FIXTURE BUG THAT HID THE CURATED-LIST BUG. `availability.slots` is
// curateSlots() output: max 4 picks, AT MOST ONE PER DATE. `days[].slots` is the
// full per-day list. The old fixture set them equal, so re-validating against
// the curated list looked correct. They are deliberately DIFFERENT here: the
// 2 PM slot exists on the day but is NOT the day's curated pick.
const SLOT_2PM = {
  date: '2026-08-20', start_time: '14:00', end_time: '15:00',
  start_label: '2:00 PM', end_label: '3:00 PM', startTime24: '14:00', endTime24: '15:00',
  technician_id: 't-2',
};
const AVAILABILITY = { slots: [SLOT], days: [{ date: '2026-08-20', slots: [SLOT, SLOT_2PM] }] };
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
    // The commit-time dedupe now runs INSIDE the transaction, under the
    // per-customer/date rung-2 lock that makes read-then-insert safe.
    whereNotIn: jest.fn(() => ssTrx),
    orWhere: jest.fn(() => ssTrx),
    first: jest.fn(() => Promise.resolve(scheduled[0] || null)),
  };
  ssTrx.where = jest.fn((arg) => { if (typeof arg === 'function') arg(ssTrx); return ssTrx; });
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
  booking.buildBookingAvailability.mockResolvedValue(AVAILABILITY);
  booking.validateBookingSlotDate.mockReturnValue(null);
  booking.bookingSlotWindow.mockReturnValue({ maxPerDay: 3 });
  catalog.loadBookableCallServices.mockResolvedValue([PEST_ROW, ASSESSMENT_ROW]);
  catalog.resolveCallBookingCatalogService.mockReturnValue(PEST_ROW);
  catalog.resolveCallBookingPrice.mockReturnValue({ price: 150, source: 'catalog' });
  catalog.callBookingInvoiceOnComplete.mockReturnValue(true);
  // jest.clearAllMocks() clears CALLS, not implementations — a mockResolvedValue
  // set by one test would otherwise leak into every later one.
  occupancy.findConflictingVisits.mockResolvedValue([]);
  occupancy.acquireOccupancyLock.mockResolvedValue(undefined);
  availability.countActiveSelfBookingsForDay.mockResolvedValue(0);
  availability.acquireSelfBookingDayCapLock.mockResolvedValue(undefined);
  lockCustomerComms.mockResolvedValue(undefined);
  CTX = slotCtx();
});

// The session's OPAQUE SLOT REGISTRY (relay-conversation _buildToolCtx). The
// model never sees an ISO date, so it can only book a slot it was actually
// offered — and the ref carries the coords/duration/timeOfDay the offer was
// generated from, so the commit-time re-check re-runs the engine identically.
function slotCtx(extra = {}) {
  const slots = new Map([
    ['S1', { date: '2026-08-20', startMinutes: 540, lat: 27.4, lng: -82.5, duration: 60, timeOfDay: 'morning', expandOpenDays: true }],
    ['S2', { date: '2026-08-20', startMinutes: 840, lat: 27.4, lng: -82.5, duration: 60, timeOfDay: 'afternoon', expandOpenDays: true }],
    ['S3', { date: '2026-08-20', startMinutes: 420, lat: 27.4, lng: -82.5, duration: 60, timeOfDay: 'morning', expandOpenDays: true }],
  ]);
  let booked = false;
  return {
    customerId: CUSTOMER.id,
    callSid: 'CA-relay-1',
    from: '+19415550142',
    resolveSlotRef: (ref) => slots.get(String(ref || '').trim().toUpperCase()) || null,
    bookingRequested: () => booked,
    markBookingRequested: () => { booked = true; },
    leadId: () => null,
    ...extra,
  };
}
const GOOD_INPUT = { slot_ref: 'S1', service: 'pest control for ants' };
// Rebuilt per test — the one-booking-per-call latch lives on the session ctx.
let CTX = slotCtx();

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
      // ⭐ OPAQUE SLOT REF, not an echoed date. speakSlot says "Tuesday August 18
    // at 9 AM" with no ISO date anywhere, so demanding YYYY-MM-DD made the model
    // reconstruct a key it was never given.
    const schema = BOOKING_TOOLS.find((t) => t.name === 'request_booking').input_schema;
    expect(schema.required).toEqual(['slot_ref']);
    expect(Object.keys(schema.properties)).not.toContain('date');
    expect(Object.keys(schema.properties)).not.toContain('time');
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
    const out = await executeTool('request_booking', { slot_ref: 'S3' }, slotCtx());
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
    await executeTool('request_booking', { ...GOOD_INPUT, service: 'something weird with the roof maybe' }, slotCtx());
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
    const ctx = slotCtx({
      customerId: null,
      callSid: 'CA-relay-2',
      resolveLookupRef: (ref) => (ref === 'C1' ? CUSTOMER.id : null),
    });
    await executeTool('request_booking', { ...GOOD_INPUT, customer_ref: 'C1' }, ctx);
    expect(trxBuilders.scheduled_services.insert).toHaveBeenCalledTimes(1);

    // ⭐ AN UNVERIFIED THIRD-PARTY REQUESTER. lookup_customer can return a ref
    // for an account the caller's phone did NOT match, so a caller who knows a
    // name and a street could put a pending booking on a stranger's account —
    // and office confirm then arms reminders and the card-on-file funnel toward
    // that customer. Both the row and the review card must say so, loudly.
    const row = trxBuilders.scheduled_services.insert.mock.calls[0][0];
    expect(row.internal_notes).toMatch(/UNVERIFIED third-party requester/);
    expect(row.internal_notes).toMatch(/verify identity before confirming/i);
    expect(row.internal_notes).toContain('***0142'); // masked calling number, never the full one
    expect(row.internal_notes).not.toContain('9415550142');
    const payload = JSON.parse(trxBuilders.triage_items.insert.mock.calls[0][0].payload);
    expect(payload.unverified_requester).toBe(true);
    expect(payload.unverified_requester_note).toMatch(/UNVERIFIED third-party requester/);

    jest.clearAllMocks();
    primeDb();
    const out = await executeTool('request_booking', { ...GOOD_INPUT, customer_ref: 'C9' }, slotCtx({ customerId: null, resolveLookupRef: () => null }));
    expect(out).toMatch(/not from a lookup_customer result/i);
    assertNoCreateWrites();
  });

  test('the caller\'s OWN account carries no unverified warning', async () => {
    await executeTool('request_booking', GOOD_INPUT, slotCtx());
    const row = trxBuilders.scheduled_services.insert.mock.calls[0][0];
    expect(row.internal_notes).not.toMatch(/UNVERIFIED/);
    const payload = JSON.parse(trxBuilders.triage_items.insert.mock.calls[0][0].payload);
    expect(payload.unverified_requester).toBe(false);
  });

  test('duplicate row for the same customer/day → refused INSIDE the locked transaction', async () => {
    primeDb({ scheduled: [{ id: 'ss-existing', window_start: '09:00' }] });
    const out = await executeTool('request_booking', GOOD_INPUT, slotCtx());
    expect(out).toMatch(/already in/i);
    // The dedupe now runs under rung 2, so the transaction IS opened — what must
    // not happen is the INSERT.
    expect(trxBuilders.scheduled_services.insert).not.toHaveBeenCalled();
    expect(trxBuilders.triage_items.insert).not.toHaveBeenCalled();
    assertNoComms();
  });

  test('selfBooking engine gate off → refused (no slot can be validated), nothing written', async () => {
    isEnabled.mockReturnValue(false);
    const out = await executeTool('request_booking', GOOD_INPUT, CTX);
    expect(out).toMatch(/not available right now/i);
    assertNoCreateWrites();
  });

  test('missing call_log row (sandbox path) → booking still lands, just without a triage card', async () => {
    primeDb({ callLog: [] });
    await executeTool('request_booking', GOOD_INPUT, slotCtx());
    const row = trxBuilders.scheduled_services.insert.mock.calls[0][0];
    expect(row.source_call_log_id).toBeNull();
    expect(trxBuilders.triage_items.insert).not.toHaveBeenCalled();
  });

  // ⭐ THE CURATED-LIST BUG. buildBookingAvailability().slots is curateSlots()
  // output — max 4 picks, AT MOST ONE PER DATE. Re-validating against it meant a
  // caller offered "Wednesday 2 PM" got slot_gone whenever the day's top pick
  // was the 9 AM. The full per-day list is days[].slots.
  test('a NON-curated slot on the day still books (days[].slots, not the curated picks)', async () => {
    const out = await executeTool('request_booking', { slot_ref: 'S2', service: 'ants' }, slotCtx());
    expect(out).toMatch(/Booking REQUEST submitted/);
    const row = trxBuilders.scheduled_services.insert.mock.calls[0][0];
    expect(row.window_start).toBe('14:00');       // the 2 PM the caller picked
    expect(row.technician_id).toBe('t-2');
    // The curated list contains ONLY the 9 AM — proof the fix is reading days[].
    expect(AVAILABILITY.slots.map((x) => x.start_time)).toEqual(['09:00']);
  });

  // timeOfDay is not just a narrowing filter: dropping it lets morning
  // candidates push an offered afternoon slot out of the per-day cap.
  test('the re-check re-runs the engine with the OFFER\'s own inputs (timeOfDay, coords, duration)', async () => {
    await executeTool('request_booking', { slot_ref: 'S2', service: 'ants' }, slotCtx());
    expect(booking.buildBookingAvailability).toHaveBeenCalledWith(expect.objectContaining({
      rangeFrom: '2026-08-20', rangeTo: '2026-08-20',
      timeOfDay: 'afternoon', expandOpenDays: true,
      lat: 27.4, lng: -82.5, duration: 60,
    }));
  });

  test('an invented slot_ref resolves to nothing — no engine call, no write', async () => {
    const out = await executeTool('request_booking', { slot_ref: 'S99' }, slotCtx());
    expect(out).toMatch(/slot_ref/);
    expect(out).toMatch(/Never invent one/i);
    expect(booking.buildBookingAvailability).not.toHaveBeenCalled();
    assertNoCreateWrites();
  });

  // ⭐ THE COMMIT GATE. The builder is an OFFER surface, explicitly EXEMPT from
  // the lock contract BECAUSE "every offer is re-validated under lock at its own
  // commit gate". This writer had no gate at all.
  test('takes the ORDERING CONTRACT rungs, in order, before the insert', async () => {
    await executeTool('request_booking', GOOD_INPUT, slotCtx());
    // Rung 1 — date occupancy, the FIRST statement in the transaction.
    expect(occupancy.acquireOccupancyLock).toHaveBeenCalledWith(trx, '2026-08-20');
    // Rung 2 — per customer+date (this is what makes the dedupe read safe).
    expect(trx.raw).toHaveBeenCalledWith(expect.any(String), ['self-booking-confirm', `${CUSTOMER.id}:2026-08-20`]);
    // Rung 3 — technician, when the offer carries one.
    expect(trx.raw).toHaveBeenCalledWith(expect.any(String), ['slot-reserve', 't-1:2026-08-20']);
    // Rung 5 — the global self-booking day cap.
    expect(availability.acquireSelfBookingDayCapLock).toHaveBeenCalledWith(trx, '2026-08-20');
    // Rung 6 — owed by EVERY writer that commits a scheduled_services INSERT.
    expect(lockCustomerComms).toHaveBeenCalledWith(trx, CUSTOMER.id);
    // Second half of the contract: the GLOBAL tech-blind probe, under the lock.
    expect(occupancy.findConflictingVisits).toHaveBeenCalledWith(expect.objectContaining({
      db: trx, date: '2026-08-20', windowStart: '09:00', windowEnd: '10:00',
    }));
    // Rungs are coarsest-first — occupancy before the day cap, both before comms.
    const order = [
      occupancy.acquireOccupancyLock.mock.invocationCallOrder[0],
      availability.acquireSelfBookingDayCapLock.mock.invocationCallOrder[0],
      lockCustomerComms.mock.invocationCallOrder[0],
      trxBuilders.scheduled_services.insert.mock.invocationCallOrder[0],
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  test('a committed clash from ANOTHER customer aborts the write (double-booking)', async () => {
    occupancy.findConflictingVisits.mockResolvedValue([{ id: 'ss-other' }]);
    const out = await executeTool('request_booking', GOOD_INPUT, slotCtx());
    expect(out).toMatch(/just taken by someone else/i);
    expect(out).toMatch(/NOTHING was booked/);
    expect(trxBuilders.scheduled_services.insert).not.toHaveBeenCalled();
    assertNoComms();
  });

  test('max_self_books_per_day is re-checked at COMMIT, not just by the builder', async () => {
    availability.countActiveSelfBookingsForDay.mockResolvedValue(3);
    const out = await executeTool('request_booking', GOOD_INPUT, slotCtx());
    expect(out).toMatch(/just filled up/i);
    expect(trxBuilders.scheduled_services.insert).not.toHaveBeenCalled();
  });

  test('validateBookingSlotDate runs BEFORE the engine (advance_days_min floor, 90-day horizon)', async () => {
    booking.validateBookingSlotDate.mockReturnValue('That date is beyond our online booking window.');
    const out = await executeTool('request_booking', GOOD_INPUT, slotCtx());
    expect(out).toMatch(/not open for booking any more/i);
    expect(booking.buildBookingAvailability).not.toHaveBeenCalled();
    assertNoCreateWrites();
  });

  test('a slot in the PAST is refused before the engine (ET-anchored, no timestamptz window)', async () => {
    const past = slotCtx({ resolveSlotRef: () => ({ date: '2020-01-02', startMinutes: 540, lat: 27.4, lng: -82.5 }) });
    const out = await executeTool('request_booking', { slot_ref: 'S1' }, past);
    expect(out).toMatch(/not open for booking any more/i);
    expect(booking.buildBookingAvailability).not.toHaveBeenCalled();
    assertNoCreateWrites();
  });

  // ⭐ ONE PER CALL. The card's onConflict is (call_log_id, reason_code), so a
  // SECOND booking on one call gets NO review card and lands on the dispatch
  // calendar invisible to the office confirm queue.
  test('a second booking request on the same call is refused', async () => {
    const ctx = slotCtx();
    await executeTool('request_booking', { slot_ref: 'S1' }, ctx);
    expect(trxBuilders.scheduled_services.insert).toHaveBeenCalledTimes(1);
    const out = await executeTool('request_booking', { slot_ref: 'S2' }, ctx);
    expect(out).toMatch(/already been placed on this call/i);
    expect(trxBuilders.scheduled_services.insert).toHaveBeenCalledTimes(1);
  });

  // outbound-review-confirm.js falls back to "the customer's SINGLE active
  // lead" when payload.lead_id is null — which can convert an unrelated open
  // quote to WON on confirm.
  test('the review card carries the lead id when capture_lead already ran', async () => {
    await executeTool('request_booking', GOOD_INPUT, slotCtx({ leadId: () => 'lead-42' }));
    const payload = JSON.parse(trxBuilders.triage_items.insert.mock.calls[0][0].payload);
    expect(payload.lead_id).toBe('lead-42');
  });

  test('attachLeadToVoiceBookingCard back-fills the card when capture_lead runs AFTER booking', async () => {
    const card = { id: 'ti-9', payload: JSON.stringify({ origin: 'voice_agent', lead_id: null }) };
    const update = jest.fn(() => Promise.resolve(1));
    const triage = {
      where: jest.fn(() => triage),
      whereIn: jest.fn(() => triage),
      orderBy: jest.fn(() => triage),
      first: jest.fn(() => Promise.resolve(card)),
      update,
    };
    db.mockImplementation((table) => (table === 'triage_items' ? triage : builders[table] || makeBuilder([])));
    const ok = await relayBooking.attachLeadToVoiceBookingCard('CA-relay-1', 'lead-77');
    expect(ok).toBe(true);
    expect(JSON.parse(update.mock.calls[0][0].payload).lead_id).toBe('lead-77');
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
