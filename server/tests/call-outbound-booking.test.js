// Outbound-callback booking legacy-row compatibility. The office-review hold
// was removed 2026-08-11 (owner directive): new outbound bookings land live
// via the normal ai_call_pipeline path. The distinct source_action marker,
// triage lane, and confirm hook remain so rows created PENDING before the
// removal still confirm cleanly (arm reminders, convert the lead, resolve
// their card). These verify that legacy machinery.
jest.mock('../models/db', () => jest.fn());
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/dispatch-alerts', () => ({ autoResolveOverdueAlertsForJob: jest.fn(async () => {}) }));
jest.mock('../services/appointment-reminders', () => ({ registerAppointment: jest.fn(async () => ({})) }));
jest.mock('../services/call-recording-processor', () => ({ convertCallLeadOnPhoneBooking: jest.fn(async () => true) }));
jest.mock('../services/inspection-credit', () => ({
  markBookingForInspectionCredit: jest.fn(async () => 1),
  redeemInspectionCreditForBooking: jest.fn(async () => ({})),
}));
jest.mock('../services/appointment-card-request', () => ({ requestCardForAppointment: jest.fn(async () => ({ requested: false })) }));

const { buildTriageItem } = require('../services/call-routing-gates');
const {
  CALL_OUTBOUND_REVIEW_SOURCE_ACTION,
  CALL_FOLLOWUP_SOURCE_ACTION,
  DISPATCH_OWNED_PENDING_SOURCE_ACTIONS,
  isPendingOutboundReviewBooking,
} = require('../services/call-booking-source-actions');
const {
  runOutboundReviewConfirmHook,
  activateLegacyOutboundReviewRowIfNeeded,
  sweepStrandedLegacyOutboundActivations,
} = require('../services/outbound-review-confirm');
const { transitionJobStatus } = require('../services/job-status');
const AppointmentReminders = require('../services/appointment-reminders');
const { parseETDateTime } = require('../utils/datetime-et');

// The persisted reminder row the shared post-registration verify reads —
// armed at exactly the composed service slot (r27 pre-push P1: a MISSING
// row now fails verification, so activation mocks must persist one).
const reminderRowFor = (row) => ({
  id: 'rem1',
  appointment_time: parseETDateTime(`${row.scheduled_date}T${row.window_start || '09:00'}`),
  windows_preclosed: !row.window_start,
});
const { convertCallLeadOnPhoneBooking } = require('../services/call-recording-processor');
const { requestCardForAppointment } = require('../services/appointment-card-request');

describe('outbound review booking — shared source-action markers', () => {
  test('the outbound-review marker is a distinct, stable string that fits source_action', () => {
    expect(CALL_OUTBOUND_REVIEW_SOURCE_ACTION).toBe('ai_call_outbound_review');
    expect(CALL_OUTBOUND_REVIEW_SOURCE_ACTION).not.toBe(CALL_FOLLOWUP_SOURCE_ACTION);
    // scheduled_services.source_action is varchar(30) — the marker MUST fit or
    // the pending-booking insert fails (value too long).
    expect(CALL_OUTBOUND_REVIEW_SOURCE_ACTION.length).toBeLessThanOrEqual(30);
    expect(CALL_FOLLOWUP_SOURCE_ACTION.length).toBeLessThanOrEqual(30);
  });

  test('dispatch-owned pending set covers BOTH the follow-up and outbound-review markers', () => {
    // The customer self-service routes (schedule.js) hide/refuse every marker in
    // this set until the office confirms — so both must be present.
    expect(DISPATCH_OWNED_PENDING_SOURCE_ACTIONS).toEqual(
      expect.arrayContaining([CALL_FOLLOWUP_SOURCE_ACTION, CALL_OUTBOUND_REVIEW_SOURCE_ACTION]),
    );
  });
});

describe('outbound review booking — triage lane', () => {
  test('outbound_booking_review maps to the time_ambiguous review lane', () => {
    const item = buildTriageItem({
      callLogId: 'c1',
      flag: 'outbound_booking_review',
      extraction: { meta: {} },
      severity: 'advisory',
    });
    expect(item.category).toBe('time_ambiguous');
    expect(item.reason_code).toBe('outbound_booking_review');
  });
});

describe('outbound review booking — originating lead carried on the card', () => {
  test('the review card payload carries lead_id + the booking-time quote flag', () => {
    // The booking can reuse an existing UNCLAIMED phone lead that never gets
    // customer_id stamped — the confirm hook's customer_id lookup alone would
    // miss it, so the insert path stashes the exact lead id on the card.
    const item = buildTriageItem({
      callLogId: 'c1',
      flag: 'outbound_booking_review',
      extraction: { meta: {} },
      severity: 'advisory',
      extraPayload: { lead_id: 'lead-9', keep_open_for_quote: true },
    });
    const payload = JSON.parse(item.payload);
    expect(payload.lead_id).toBe('lead-9');
    expect(payload.keep_open_for_quote).toBe(true);
  });
});

describe('transitionJobStatus — legacy pending review rows activate lazily', () => {
  test('pending outbound-review row → en_route stamps customer_confirmed and runs the confirm hook post-commit', async () => {
    // Rows created PENDING before the review-hold removal must not go
    // operational half-armed (Codex #3361 P0): the shared writer DETECTS
    // the legacy row in the transition trx and delegates activation to the
    // hook-first helper post-commit (Codex r4 P1 — stamp only after the
    // core legs succeed, so failures stay retryable). Reminder arming and
    // the customer_confirmed stamp are asserted as the observable legs.
    const legacyRow = {
      id: 'svc1',
      source_action: CALL_OUTBOUND_REVIEW_SOURCE_ACTION,
      status: 'pending',
      customer_confirmed: false,
      customer_id: 'cust1',
      scheduled_date: '2026-08-11',
      window_start: '09:00',
      service_type: 'pest_control',
      source_call_log_id: null,
      is_callback: false,
      estimated_price: 100,
    };
    const updates = [];
    const makeChain = (table) => {
      const q = {};
      ['where', 'whereNot', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'orWhere', 'whereRaw',
        'leftJoin', 'orderBy', 'limit', 'modify'].forEach((m) => { q[m] = jest.fn(() => q); });
      q.select = jest.fn(async () => []);
      q.first = jest.fn(async () => {
        if (table === 'scheduled_services') return { ...legacyRow };
        if (table === 'appointment_reminders') return reminderRowFor(legacyRow);
        if (table === 'scheduled_services as s') {
          return {
            job_id: 'svc1', customer_id: 'cust1', tech_id: null, service_type: 'pest_control',
            scheduled_date: '2026-08-11', window_start: '09:00', window_end: null,
            notes: null, internal_notes: null, updated_at: new Date(),
          };
        }
        return null;
      });
      q.update = jest.fn(async (vals) => { updates.push({ table, vals }); return 1; });
      q.insert = jest.fn(async () => 1);
      q.del = jest.fn(async () => 1);
      return q;
    };
    const trx = jest.fn((table) => makeChain(table));
    trx.transaction = async (cb) => cb(trx);
    trx.fn = { now: () => new Date() };
    trx.raw = jest.fn(() => ({}));
    trx.executionPromise = Promise.resolve();
    // The post-commit activation runs on the module-level db handle (not
    // the trx) — give it the same table-aware chain.
    const db = require('../models/db');
    db.mockImplementation((table) => makeChain(table));
    db.transaction = async (cb) => cb(db);
    db.fn = { now: () => new Date() };
    db.raw = jest.fn(() => ({}));

    await transitionJobStatus({
      jobId: 'svc1', fromStatus: 'pending', toStatus: 'en_route', transitionedBy: 'tech1', trx,
    });
    // The activation hook fires on executionPromise.then, fire-and-forget —
    // flush the microtask queue before asserting.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const confirmStamp = updates.find((u) => u.table === 'scheduled_services' && u.vals.customer_confirmed === true);
    expect(confirmStamp).toBeTruthy();
    expect(AppointmentReminders.registerAppointment).toHaveBeenCalledWith(
      'svc1', 'cust1', '2026-08-11T09:00', 'pest_control', 'admin_manual', { sendConfirmation: false, closeReminderWindows: false },
    );
  });

  test('CONFIRMED-but-unstamped marker row → completed still detects and activates (Codex r24 P1)', async () => {
    // A reschedule path commits the row 'confirmed' first and activates
    // fail-soft afterwards — a failed/crashed activation leaves a
    // confirmed row with customer_confirmed=false. Its later
    // confirmed → completed transition must still detect it (detection
    // keys on the ROW, not on fromStatus === 'pending').
    const legacyRow = {
      id: 'svc1',
      source_action: CALL_OUTBOUND_REVIEW_SOURCE_ACTION,
      status: 'confirmed',
      customer_confirmed: false,
      customer_id: 'cust1',
      scheduled_date: '2026-08-11',
      window_start: '09:00',
      service_type: 'pest_control',
      source_call_log_id: null,
      is_callback: false,
      estimated_price: 100,
    };
    const updates = [];
    const makeChain = (table) => {
      const q = {};
      ['where', 'whereNot', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'orWhere', 'whereRaw',
        'leftJoin', 'orderBy', 'limit', 'modify'].forEach((m) => { q[m] = jest.fn(() => q); });
      q.select = jest.fn(async () => []);
      q.first = jest.fn(async () => {
        if (table === 'scheduled_services') return { ...legacyRow };
        if (table === 'appointment_reminders') return reminderRowFor(legacyRow);
        if (table === 'scheduled_services as s') {
          return {
            job_id: 'svc1', customer_id: 'cust1', tech_id: null, service_type: 'pest_control',
            scheduled_date: '2026-08-11', window_start: '09:00', window_end: null,
            notes: null, internal_notes: null, updated_at: new Date(),
          };
        }
        return null;
      });
      q.update = jest.fn(async (vals) => { updates.push({ table, vals }); return 1; });
      q.insert = jest.fn(async () => 1);
      q.del = jest.fn(async () => 1);
      return q;
    };
    const trx = jest.fn((table) => makeChain(table));
    trx.transaction = async (cb) => cb(trx);
    trx.fn = { now: () => new Date() };
    trx.raw = jest.fn(() => ({}));
    trx.executionPromise = Promise.resolve();
    const db = require('../models/db');
    db.mockImplementation((table) => makeChain(table));
    db.transaction = async (cb) => cb(db);
    db.fn = { now: () => new Date() };
    db.raw = jest.fn(() => ({}));

    await transitionJobStatus({
      jobId: 'svc1', fromStatus: 'confirmed', toStatus: 'completed', transitionedBy: 'tech1', trx,
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const confirmStamp = updates.find((u) => u.table === 'scheduled_services' && u.vals.customer_confirmed === true);
    expect(confirmStamp).toBeTruthy();
    expect(AppointmentReminders.registerAppointment).toHaveBeenCalled();
  });
});

describe('replay repair — windowless reused rows register the placeholder (Codex r24 P1)', () => {
  const fs = require('fs');
  const path = require('path');

  test('the replay registration passes windowless state through instead of fabricating 09:00', () => {
    const callProc = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');
    // registerScheduleSideEffects forwards closeReminderWindows into
    // registerAppointment (the canonical pre-closed placeholder path)...
    expect(callProc).toContain('{ sendConfirmation: false, closeReminderWindows }');
    // ...and the same-key replay caller derives it from a FRESH slot
    // re-read (Codex r25 P2 — the reuse-trx snapshot can predate an office
    // edit that cleared the arrival time before this post-commit repair
    // ran), never fabricating a start for a cleared arrival time.
    expect(callProc).toContain('const freshReplaySlot = await db(\'scheduled_services\')');
    expect(callProc).toContain('closeReminderWindows: !replaySlotStart,');
    expect(callProc).not.toContain("String(svc.window_start).slice(0, 5) : '09:00'");
    // Confirmation repairs (sweep re-arm AND the email leg) are scoped to
    // visits that still have an arrival time per the fresh read, with a
    // write-time windows_preclosed belt on the re-arm.
    expect(callProc).toContain('if (replaySlotVerified && replaySlotStart && !v2SmsBlocked && !v2SmsClearedByImpliedConsent) {');
    expect(callProc).toContain('.where({ scheduled_service_id: svc.id, cancelled: false, windows_preclosed: false })');
  });

  test('the replay runs the shared post-registration slot verify (Codex r26 P2)', () => {
    // The fresh read still leaves a gap before the reminder insert — the
    // replay repairs it with the SAME verify the confirm hook uses
    // (windowless → canonical placeholder conversion; moved slot →
    // guarded resync), so the two rails cannot drift.
    const callProc = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');
    expect(callProc).toContain("const { verifyReminderSlotAfterRegistration } = require('./outbound-review-confirm');");
    expect(callProc).toContain("routeTag: 'call-proc-replay',");
    const hook = fs.readFileSync(path.join(__dirname, '../services/outbound-review-confirm.js'), 'utf8');
    expect(hook).toContain('async function verifyReminderSlotAfterRegistration(');
    expect(hook).toContain('verifyReminderSlotAfterRegistration,');
  });
});

describe('auto-secure — enrollment serialized with cancellation (Codex r26 P1)', () => {
  const fs = require('fs');
  const path = require('path');

  test('live check, enrollment, and the satisfied row commit in ONE transaction under a visit-row lock', () => {
    // The r9 read-only re-check was a TOCTOU: a cancel committing between
    // the read and enrollment enrolled Auto Pay + wrote a satisfied row
    // AFTER the cancellation follow-through had already looked for rows to
    // release. FOR UPDATE on the visit row serializes with the cancel's
    // status CAS; the enrollment rides the same transaction as a savepoint.
    const card = fs.readFileSync(path.join(__dirname, '../services/appointment-card-request.js'), 'utf8');
    const fnAt = card.indexOf('async function autoSecureFromSavedMethod');
    const fnSlice = card.slice(fnAt, fnAt + 5000);
    expect(fnSlice).toContain('const secured = await db.transaction(async (trx) => {');
    expect(fnSlice).toContain('.forUpdate()');
    expect(fnSlice).toContain('dbh: trx,');
    expect(fnSlice).toContain("await trx('appointment_card_requests')");
    const enroll = fs.readFileSync(path.join(__dirname, '../services/autopay-enrollment.js'), 'utf8');
    expect(enroll).toContain('dbh = db }');
    expect(enroll).toContain('await dbh.transaction(async (trx) => {');
  });
});

describe('activateLegacyOutboundReviewRowIfNeeded — direct-writer belt', () => {
  // The reschedule writers (SmartRebooker, update-details, the shared
  // notice sender) bypass transitionJobStatus — this helper is their
  // activation seam for legacy pending review rows (Codex #3361 r2 P0).
  const makeDb = (row, { stampRows = 1, reminderRow } = {}) => {
    const state = { updates: [] };
    const fn = (table) => {
      const q = {};
      ['where', 'whereNotIn', 'whereNull', 'whereIn', 'whereRaw', 'orderBy', 'limit'].forEach((m) => { q[m] = jest.fn(() => q); });
      q.first = jest.fn(async () => {
        if (table === 'scheduled_services') return row;
        if (table === 'appointment_reminders') {
          return reminderRow === undefined ? reminderRowFor(row) : reminderRow;
        }
        return null;
      });
      q.select = jest.fn(async () => []);
      q.update = jest.fn(async (vals) => { state.updates.push({ table, vals }); return table === 'scheduled_services' ? stampRows : 1; });
      return q;
    };
    fn.fn = { now: () => new Date() };
    fn.transaction = async (cb) => cb(fn);
    fn.raw = jest.fn(async () => ({}));
    fn._state = state;
    return fn;
  };
  const legacyRow = {
    id: 'svc1',
    source_action: CALL_OUTBOUND_REVIEW_SOURCE_ACTION,
    status: 'pending',
    customer_confirmed: false,
    customer_id: 'cust1',
    scheduled_date: '2026-08-12',
    window_start: '09:00',
    service_type: 'pest_control',
    source_call_log_id: null,
    is_callback: false,
    estimated_price: 100,
  };

  beforeEach(() => jest.clearAllMocks());

  test('activates a legacy pending row: stamps customer_confirmed and runs the confirm hook', async () => {
    const db = makeDb({ ...legacyRow });
    const activated = await activateLegacyOutboundReviewRowIfNeeded(db, 'svc1', 'test');
    expect(activated).toBe(true);
    expect(db._state.updates.some((u) => u.table === 'scheduled_services' && u.vals.customer_confirmed === true)).toBe(true);
    expect(AppointmentReminders.registerAppointment).toHaveBeenCalledWith(
      'svc1', 'cust1', '2026-08-12T09:00', 'pest_control', 'admin_manual', { sendConfirmation: false, closeReminderWindows: false },
    );
  });

  test('a silently-lost reminder row fails verification — activation stays unstamped and retryable (r27 pre-push P1)', async () => {
    // registerAppointment's mock "succeeds", but the persisted-row read
    // finds nothing (the fail-soft insert did not land): the verify must
    // fail the core leg, or the stamp would mark reminders armed that
    // never exist and the self-heal would recreate them pre-confirmed.
    const db = makeDb({ ...legacyRow }, { reminderRow: null });
    const activated = await activateLegacyOutboundReviewRowIfNeeded(db, 'svc1', 'test');
    expect(activated).toBe(false);
    expect(db._state.updates.some((u) => u.table === 'scheduled_services' && u.vals.customer_confirmed === true)).toBe(false);
  });

  test('no-ops for a non-review row and for an already-confirmed row', async () => {
    expect(await activateLegacyOutboundReviewRowIfNeeded(
      makeDb({ ...legacyRow, source_action: 'ai_call_pipeline' }), 'svc1', 'test',
    )).toBe(false);
    expect(await activateLegacyOutboundReviewRowIfNeeded(
      makeDb({ ...legacyRow, customer_confirmed: true }), 'svc1', 'test',
    )).toBe(false);
    expect(AppointmentReminders.registerAppointment).not.toHaveBeenCalled();
  });

  test('a lost stamp race (0 rows) reports false — hook legs ran but are idempotent by contract', async () => {
    // Hook-first, stamp-on-success (Codex #3361 r3 P1): the loser of the
    // stamp race has already run the idempotent hook legs; the guarded
    // UPDATE keeps the stamp itself at-most-once.
    const db = makeDb({ ...legacyRow }, { stampRows: 0 });
    expect(await activateLegacyOutboundReviewRowIfNeeded(db, 'svc1', 'test')).toBe(false);
    expect(AppointmentReminders.registerAppointment).toHaveBeenCalled();
  });

  test('the hourly sweep activates a worked-but-unstamped legacy row (durable retry, Codex r5 P1)', async () => {
    const state = { updates: [] };
    const workedRow = { ...legacyRow, status: 'completed' };
    const fn = (table) => {
      const q = {};
      ['where', 'whereNot', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'orWhere',
        'whereRaw', 'orderBy', 'limit', 'modify', 'leftJoin'].forEach((m) => { q[m] = jest.fn(() => q); });
      q.select = jest.fn(async (col) => (table === 'scheduled_services' && col === 'id' ? [{ id: 'svc1' }] : []));
      q.first = jest.fn(async () => {
        if (table === 'scheduled_services') return { ...workedRow };
        if (table === 'appointment_reminders') return reminderRowFor(workedRow);
        return null;
      });
      q.update = jest.fn(async (vals) => { state.updates.push({ table, vals }); return 1; });
      q.insert = jest.fn(async () => 1);
      q.del = jest.fn(async () => 1);
      return q;
    };
    fn.fn = { now: () => new Date() };
    fn.transaction = async (cb) => cb(fn);
    fn.raw = jest.fn(async () => ({}));

    const result = await sweepStrandedLegacyOutboundActivations(fn, { limit: 5 });
    expect(result).toEqual({ candidates: 1, activated: 1 });
    expect(state.updates.some((u) => u.table === 'scheduled_services' && u.vals.customer_confirmed === true)).toBe(true);
    expect(AppointmentReminders.registerAppointment).toHaveBeenCalled();
  });
});

// ⭐ THE VOICE-AGENT ROW TAKES THE SAME ACTIVATION PATH — the P0 this branch
// shipped with. 'voice_agent' was added to OFFICE_REVIEW_PENDING_SOURCE_ACTIONS
// (and honoured by the dispatch/schedule confirm routes and tech-track), but the
// LAZY-ACTIVATION machinery still matched the single outbound marker. #3361
// removed the office-review dispatch/reschedule hold, so SmartRebooker can flip
// a pending voice booking straight to confirmed with a direct UPDATE — and the
// completion that followed skipped reminder arming, lead/card resolution and the
// inspection-credit evidence: the half-activated completion job-status.js itself
// classifies P0. These assert a voice_agent row behaves EXACTLY like an
// ai_call_outbound_review one.
describe('voice-agent bookings share the office-review activation path', () => {
  const { VOICE_AGENT_BOOKING_SOURCE_ACTION } = require('../services/call-booking-source-actions');
  const InspectionCredit = require('../services/inspection-credit');

  const voiceRow = (extra = {}) => ({
    id: 'svc-v1',
    source_action: VOICE_AGENT_BOOKING_SOURCE_ACTION,
    status: 'pending',
    customer_confirmed: false,
    customer_id: 'cust-v1',
    scheduled_date: '2026-08-20',
    window_start: '09:00',
    service_type: 'General Pest Control',
    source_call_log_id: 'cl-v1',
    is_callback: false,
    estimated_price: 150,
    ...extra,
  });

  // Table-aware knex-ish handle shared by the helper and the transition writer.
  const makeHandle = (row, { rows = null } = {}) => {
    const state = { updates: [], raws: [] };
    const fn = (table) => {
      const q = {};
      ['where', 'whereNot', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'orWhere',
        'whereRaw', 'orderBy', 'limit', 'modify', 'leftJoin'].forEach((m) => { q[m] = jest.fn(() => q); });
      q.select = jest.fn(async (col) => (table === 'scheduled_services' && col === 'id' && rows ? rows : []));
      q.first = jest.fn(async () => {
        if (table === 'scheduled_services') return { ...row };
        if (table === 'appointment_reminders') return reminderRowFor(row);
        // The review card the voice booking wrote, carrying the lead capture_lead
        // created on the same call.
        if (table === 'triage_items') return { payload: JSON.stringify({ lead_id: 'lead-v1' }) };
        if (table === 'scheduled_services as s') {
          return {
            job_id: row.id, customer_id: row.customer_id, tech_id: null, service_type: row.service_type,
            scheduled_date: row.scheduled_date, window_start: row.window_start, window_end: null,
            notes: null, internal_notes: null, updated_at: new Date(),
          };
        }
        return null;
      });
      q.update = jest.fn(async (vals) => { state.updates.push({ table, vals }); return 1; });
      q.insert = jest.fn(async () => 1);
      q.del = jest.fn(async () => 1);
      return q;
    };
    fn.fn = { now: () => new Date() };
    fn.transaction = async (cb) => cb(fn);
    fn.raw = jest.fn(async (...args) => { state.raws.push(args); return {}; });
    fn.executionPromise = Promise.resolve();
    fn._state = state;
    return fn;
  };

  beforeEach(() => jest.clearAllMocks());

  test('a SmartRebooker-style direct flip activates it: reminders armed, lead converted, card resolved, stamped', async () => {
    // The rebooker moves the visit with a direct UPDATE (status 'confirmed'),
    // then calls this helper — which used to no-op for a voice row.
    const db = makeHandle(voiceRow({ status: 'confirmed' }));
    const activated = await activateLegacyOutboundReviewRowIfNeeded(db, 'svc-v1', 'rebooker-reschedule');

    expect(activated).toBe(true);
    expect(AppointmentReminders.registerAppointment).toHaveBeenCalledWith(
      'svc-v1', 'cust-v1', '2026-08-20T09:00', 'General Pest Control', 'admin_manual',
      { sendConfirmation: false, closeReminderWindows: false },
    );
    expect(convertCallLeadOnPhoneBooking).toHaveBeenCalledWith(db, expect.objectContaining({
      customerId: 'cust-v1', scheduledServiceId: 'svc-v1',
    }));
    expect(db._state.updates.some((u) => u.table === 'triage_items' && u.vals.status === 'resolved')).toBe(true);
    expect(db._state.updates.some((u) => u.table === 'scheduled_services' && u.vals.customer_confirmed === true)).toBe(true);
  });

  test('completing an unstamped voice row writes the inspection-credit evidence IN the transition trx', async () => {
    // The billing moment. Without the shared set here the completion committed
    // with no credit evidence at all.
    const row = voiceRow({ status: 'confirmed' });
    const trx = makeHandle(row);
    const db = require('../models/db');
    const dbHandle = makeHandle(row);
    db.mockImplementation(dbHandle);
    db.transaction = dbHandle.transaction;
    db.fn = dbHandle.fn;
    db.raw = dbHandle.raw;

    await transitionJobStatus({
      jobId: 'svc-v1', fromStatus: 'confirmed', toStatus: 'completed', transitionedBy: 'tech1', trx,
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(InspectionCredit.markBookingForInspectionCredit).toHaveBeenCalledWith(
      trx,
      expect.objectContaining({
        customerId: 'cust-v1', scheduledServiceId: 'svc-v1', source: 'phone_call',
        recoveryStatusIn: ['completed'],
      }),
    );
    // …and the post-commit activation still ran the rest of the legs.
    expect(AppointmentReminders.registerAppointment).toHaveBeenCalled();
    expect(dbHandle._state.updates.some((u) => u.table === 'scheduled_services' && u.vals.customer_confirmed === true)).toBe(true);
  });

  test('a pending voice row going straight to en_route activates instead of going half-armed', async () => {
    const row = voiceRow();
    const trx = makeHandle(row);
    const db = require('../models/db');
    const dbHandle = makeHandle(row);
    db.mockImplementation(dbHandle);
    db.transaction = dbHandle.transaction;
    db.fn = dbHandle.fn;
    db.raw = dbHandle.raw;

    await transitionJobStatus({
      jobId: 'svc-v1', fromStatus: 'pending', toStatus: 'en_route', transitionedBy: 'tech1', trx,
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(AppointmentReminders.registerAppointment).toHaveBeenCalled();
    expect(dbHandle._state.updates.some((u) => u.table === 'scheduled_services' && u.vals.customer_confirmed === true)).toBe(true);
  });

  // ⭐ THE ONE CONSUMER WHERE FULL MEMBERSHIP WOULD BE WRONG. The hourly sweep
  // is not a touch-driven activation: it drains the LEGACY population outright,
  // never-touched pending rows included, which is correct only because that
  // hold was removed collectively and the population only shrinks. Voice rows
  // are created pending ON PURPOSE with an outbound_booking_review card for the
  // office — and this hook RESOLVES that card, arms customer reminders and
  // converts the lead. So voice rows enter the sweep only in the state it
  // exists to repair: already moved off 'pending', still unstamped.
  test('the sweep takes STRANDED voice rows but never a never-touched pending one', async () => {
    const db = makeHandle(voiceRow({ status: 'completed' }), { rows: [{ id: 'svc-v1' }] });
    const result = await sweepStrandedLegacyOutboundActivations(db, { limit: 5 });
    expect(result).toEqual({ candidates: 1, activated: 1 });
    expect(AppointmentReminders.registerAppointment).toHaveBeenCalled();

    // The predicate itself: the voice branch is scoped to rows that are no
    // longer 'pending'.
    const predicates = [];
    const probe = (table) => {
      const q = {};
      ['whereNotIn', 'whereNull', 'whereNotNull', 'orderBy', 'limit', 'whereRaw'].forEach((m) => { q[m] = jest.fn(() => q); });
      q.where = jest.fn((arg, val) => {
        if (typeof arg === 'function') { predicates.push({ op: 'group' }); arg(q); } else predicates.push({ op: 'where', arg, val });
        return q;
      });
      q.orWhere = jest.fn((arg, val) => {
        if (typeof arg === 'function') { predicates.push({ op: 'orGroup' }); arg(q); } else predicates.push({ op: 'orWhere', arg, val });
        return q;
      });
      q.whereNot = jest.fn((arg, val) => { predicates.push({ op: 'whereNot', arg, val }); return q; });
      q.select = jest.fn(async () => []);
      return q;
    };
    probe.raw = jest.fn(() => ({}));
    await sweepStrandedLegacyOutboundActivations(probe, { limit: 5 });
    // The legacy marker keeps its unscoped membership; the voice marker sits in
    // an OR group that also carries the not-pending scope.
    expect(predicates).toContainEqual({ op: 'where', arg: 'source_action', val: CALL_OUTBOUND_REVIEW_SOURCE_ACTION });
    const orGroupAt = predicates.findIndex((p) => p.op === 'orGroup');
    expect(orGroupAt).toBeGreaterThan(-1);
    expect(predicates.slice(orGroupAt)).toContainEqual({ op: 'where', arg: 'source_action', val: 'voice_agent' });
    expect(predicates.slice(orGroupAt)).toContainEqual({ op: 'whereNot', arg: 'status', val: 'pending' });
  });
});

// A hand-built knex-ish db mock for the confirm hook: table-aware first()/
// select()/update() so the triage-payload path and the fallback lead lookup
// can be exercised independently.
function confirmHookDb({ cardPayload = null, fallbackLeads = [], leadRow = null, callRow = null, svcRow = { status: 'confirmed', scheduled_date: '2026-07-14', window_start: '09:00' } } = {}) {
  const state = { triageResolved: false, updates: [] };
  const fn = (table) => {
    const q = {};
    ['where', 'whereNotIn', 'whereNull', 'whereIn', 'whereRaw', 'orderBy', 'limit'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.select = jest.fn(async () => fallbackLeads);
    q.first = jest.fn(async () => {
      if (table === 'triage_items') return cardPayload ? { payload: JSON.stringify(cardPayload) } : null;
      if (table === 'call_log') return callRow;
      if (table === 'leads') return leadRow;
      // The hook re-reads the row's CURRENT status at entry and after the
      // legs (cancellation-race guard) — a non-terminal row by default.
      if (table === 'scheduled_services') return svcRow;
      // The post-registration slot verify compares the PERSISTED reminder row
      // against the service's current slot — armed at exactly that instant.
      if (table === 'appointment_reminders' && svcRow && svcRow.window_start) {
        const { parseETDateTime } = require('../utils/datetime-et');
        return {
          id: 'ar-verify-1',
          appointment_time: parseETDateTime(`${svcRow.scheduled_date}T${svcRow.window_start}`),
          windows_preclosed: false,
        };
      }
      return null;
    });
    q.update = jest.fn(async (vals) => {
      state.updates.push({ table, vals });
      if (table === 'triage_items') state.triageResolved = true;
      return 1;
    });
    return q;
  };
  fn.fn = { now: () => new Date() };
  // Same-conn transaction passthrough + raw — the triage resolver now runs
  // inside a transaction that takes the shared per-call advisory lock.
  fn.transaction = async (cb) => cb(fn);
  fn.raw = jest.fn(async () => ({}));
  fn._state = state;
  return fn;
}

describe('runOutboundReviewConfirmHook — shared confirm side effects', () => {
  const svc = {
    id: 'svc1',
    customer_id: 'cust1',
    scheduled_date: '2026-07-14',
    window_start: '09:00',
    service_type: 'pest_control',
    source_call_log_id: 'call1',
  };

  beforeEach(() => jest.clearAllMocks());

  test('converts the ORIGINATING lead from the card payload (a reused unclaimed lead has no customer_id)', async () => {
    const db = confirmHookDb({
      cardPayload: { lead_id: 'lead-9', keep_open_for_quote: true },
      leadRow: { status: 'new' },
    });
    await runOutboundReviewConfirmHook(db, svc, 'test');
    expect(convertCallLeadOnPhoneBooking).toHaveBeenCalledWith(db, expect.objectContaining({
      leadId: 'lead-9',
      customerId: 'cust1',
      scheduledServiceId: 'svc1',
      keepOpenForQuote: true,
    }));
    // Reminders armed without a confirmation send; card resolved.
    expect(AppointmentReminders.registerAppointment).toHaveBeenCalledWith(
      'svc1', 'cust1', '2026-07-14T09:00', 'pest_control', 'admin_manual', { sendConfirmation: false, closeReminderWindows: false },
    );
    expect(db._state.triageResolved).toBe(true);
  });

  test('a carried lead that moved mid-estimate stays OPEN even without the booking-time flag', async () => {
    const db = confirmHookDb({
      cardPayload: { lead_id: 'lead-9', keep_open_for_quote: false },
      leadRow: { status: 'estimate_sent' },
    });
    await runOutboundReviewConfirmHook(db, svc, 'test');
    expect(convertCallLeadOnPhoneBooking).toHaveBeenCalledWith(db, expect.objectContaining({
      leadId: 'lead-9',
      keepOpenForQuote: true,
    }));
  });

  test('pre-payload rows fall back to the single-active-lead heuristic', async () => {
    const db = confirmHookDb({ fallbackLeads: [{ id: 'lead-1', status: 'new' }] });
    await runOutboundReviewConfirmHook(db, svc, 'test');
    expect(convertCallLeadOnPhoneBooking).toHaveBeenCalledWith(db, expect.objectContaining({
      leadId: 'lead-1',
      keepOpenForQuote: false,
    }));
  });

  // ⭐ A VOICE CARD WITH NO lead_id IS AN ANSWER, NOT A GAP. The fallback above
  // exists for cards written before the payload carried lead_id; a voice card
  // always carries the key, so a null means the call identified no lead
  // (capture_lead never ran, or it matched an existing customer and created
  // none). Guessing "their single active lead" would mark an unrelated open
  // quote WON — a booked ants visit closing a termite estimate.
  test('a voice card with no lead_id converts NOTHING (no single-active-lead guess)', async () => {
    const db = confirmHookDb({
      cardPayload: { origin: 'voice_agent', lead_id: null },
      fallbackLeads: [{ id: 'lead-unrelated', status: 'estimate_sent' }],
    });
    await runOutboundReviewConfirmHook(db, svc, 'test');
    expect(convertCallLeadOnPhoneBooking).not.toHaveBeenCalled();
    // The rest of the confirm still runs — this is a lead decision, not a halt.
    expect(AppointmentReminders.registerAppointment).toHaveBeenCalled();
    expect(db._state.triageResolved).toBe(true);
  });

  // ⭐ …BUT A BACKFILL THAT FAILED IS NOT AN ANSWER. The lead id reaches the
  // card by a best-effort update after capture_lead; one transient failure and
  // a lead that really exists would be skipped forever. The call stamps its own
  // CallSid on the lead, so the confirm asks the call directly — exact, not the
  // single-active-lead guess the case above rules out.
  test('a null lead_id is RECOVERED via call_log.metadata.relay_lead_id before it is believed', async () => {
    // NOT by leads.twilio_call_sid — that column is set at INSERT only, so a
    // lead reused by phone keeps its ORIGINAL call's sid and a sid-keyed
    // lookup silently missed every reuse.
    const db = confirmHookDb({
      cardPayload: { origin: 'voice_agent', lead_id: null },
      callRow: { twilio_call_sid: 'CA-voice-1', metadata: { relay_lead_id: 'lead-recovered' } },
      leadRow: { id: 'lead-recovered', status: 'new' },
      fallbackLeads: [{ id: 'lead-unrelated', status: 'estimate_sent' }],
    });
    await runOutboundReviewConfirmHook(db, svc, 'test');
    expect(convertCallLeadOnPhoneBooking).toHaveBeenCalledWith(db, expect.objectContaining({
      leadId: 'lead-recovered',
    }));
  });

  test('a voice card that DOES carry a lead still converts exactly that lead', async () => {
    const db = confirmHookDb({
      cardPayload: { origin: 'voice_agent', lead_id: 'lead-v9' },
      leadRow: { status: 'new' },
      fallbackLeads: [{ id: 'lead-unrelated', status: 'new' }],
    });
    await runOutboundReviewConfirmHook(db, svc, 'test');
    expect(convertCallLeadOnPhoneBooking).toHaveBeenCalledWith(db, expect.objectContaining({ leadId: 'lead-v9' }));
  });

  // ⭐ THE ROW'S CURRENT STATUS, NOT THE CALLER'S SNAPSHOT. On the sweep path
  // the snapshot can be an hour old; a cancellation that landed since must
  // stand — activating it would arm reminders that TEXT the customer about a
  // visit nobody is making. The stamp guard alone only stopped the receipt.
  test('a row cancelled since the snapshot stands the whole activation down', async () => {
    const db = confirmHookDb({
      fallbackLeads: [{ id: 'lead-1', status: 'new' }],
      svcRow: { status: 'cancelled', scheduled_date: '2026-07-14', window_start: '09:00' },
    });
    const ok = await runOutboundReviewConfirmHook(db, svc, 'test');
    expect(ok).toBe(false); // unstamped — and the sweep excludes rejections
    expect(AppointmentReminders.registerAppointment).not.toHaveBeenCalled();
    expect(convertCallLeadOnPhoneBooking).not.toHaveBeenCalled();
    expect(db._state.triageResolved).toBe(false);
  });

  // ⭐ A SKIP OR RESCHEDULE THAT COMMITS DURING THE LEGS CLOSES THE REMINDER
  // TOO. handleCancellation no-ops unless the visit is still exactly
  // 'cancelled' — so the post-legs cleanup for skipped/rescheduled rows must
  // close the just-armed reminder directly, or it may text for a superseded
  // visit (its own path's cleanup ran before this reminder existed).
  test('a visit that went SKIPPED during the legs closes the just-armed reminder directly', async () => {
    const base = confirmHookDb({ fallbackLeads: [] });
    let svcReads = 0;
    const wrapped = (table) => {
      const q = base(table);
      if (table === 'scheduled_services') {
        const orig = q.first;
        q.first = jest.fn(async (...a) => {
          const row = await orig(...a);
          svcReads += 1;
          // Entry read sees the live row; everything after sees the skip.
          return svcReads === 1 ? row : { ...row, status: 'skipped' };
        });
      }
      return q;
    };
    Object.assign(wrapped, { fn: base.fn, transaction: base.transaction, raw: base.raw, _state: base._state });

    const ok = await runOutboundReviewConfirmHook(wrapped, svc, 'test');
    expect(ok).toBe(false); // unstamped — stood down
    const reminderCloses = base._state.updates.filter(
      (u) => u.table === 'appointment_reminders' && u.vals && u.vals.cancelled === true,
    );
    expect(reminderCloses.length).toBeGreaterThanOrEqual(1);
  });

  test('an unreadable current status refuses to activate (retryable), never guesses', async () => {
    const db = confirmHookDb({ fallbackLeads: [], svcRow: null });
    const ok = await runOutboundReviewConfirmHook(db, svc, 'test');
    expect(ok).toBe(false);
    expect(AppointmentReminders.registerAppointment).not.toHaveBeenCalled();
  });

  test('an unreadable POST-hook status refuses the stamp too (fail closed, retryable)', async () => {
    // Entry read succeeds; the post-legs re-read throws. An unreadable status
    // cannot prove the cancellation race did not happen, so the activation
    // must not report complete — false leaves the row unstamped for the sweep.
    // The harness mints a fresh builder per db(table) call, so count reads by
    // wrapping the db fn itself. The LAST scheduled_services .first() of a
    // clean run is the post-hook re-read this test wants to fail.
    const countingDb = (failAt) => {
      const base = confirmHookDb({ fallbackLeads: [] });
      const state = { reads: 0 };
      const wrapped = (table) => {
        const q = base(table);
        if (table === 'scheduled_services') {
          const orig = q.first;
          q.first = jest.fn(async (...a) => {
            state.reads += 1;
            if (state.reads === failAt) throw new Error('db gone');
            return orig(...a);
          });
        }
        return q;
      };
      Object.assign(wrapped, { fn: base.fn, transaction: base.transaction, raw: base.raw, _state: base._state });
      return { wrapped, state };
    };

    const probe = countingDb(Infinity);
    expect(await runOutboundReviewConfirmHook(probe.wrapped, svc, 'test')).toBe(true);
    const totalReads = probe.state.reads;
    expect(totalReads).toBeGreaterThan(1);

    const failing = countingDb(totalReads); // ONLY the post-hook re-read throws
    const ok = await runOutboundReviewConfirmHook(failing.wrapped, svc, 'test');
    expect(ok).toBe(false);
    expect(failing.state.reads).toBe(totalReads);
  });

  test('skipCardRequest:true (field confirm) skips the card-on-file leg; default keeps it', async () => {
    // Owner decision 2026-08-11: a tech-tap-confirmed booking collects the
    // card in person, so the funnel leg is skipped on the tech-track path —
    // and ONLY there; the office confirm paths keep the full funnel.
    const db = confirmHookDb({ fallbackLeads: [] });
    await runOutboundReviewConfirmHook(db, svc, 'test', { skipCardRequest: true });
    expect(requestCardForAppointment).not.toHaveBeenCalled();
    // A field confirm never stamps the call-level clearance either — the
    // tech collects in person, and the pre-visit sweep must not text later.
    expect(db._state.updates.some((u) => u.table === 'scheduled_services' && u.vals.call_sms_cleared_at)).toBe(false);
    await runOutboundReviewConfirmHook(db, svc, 'test');
    expect(requestCardForAppointment).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledServiceId: 'svc1', trigger: 'outbound_review_confirm' }),
    );
  });

  test('the office-confirm clearance stamp lands FIRST — a failed leg cannot strand it (Codex r28 P1)', async () => {
    // The calling route already committed the confirmation, so a process
    // exit inside any best-effort leg leaves the row customer_confirmed
    // with no retry rail (the legacy sweep skips stamped rows) — an
    // unstamped clearance would lock the card invite out of the pre-visit
    // sweep forever. Simulate the worst leg failure and require the stamp.
    AppointmentReminders.registerAppointment.mockResolvedValueOnce(null);
    const db = confirmHookDb({ fallbackLeads: [] });
    const ok = await runOutboundReviewConfirmHook(db, svc, 'test');
    expect(ok).toBe(false); // the failed leg still reports retryable
    expect(db._state.updates.some((u) => u.table === 'scheduled_services' && u.vals.call_sms_cleared_at)).toBe(true);
  });

  // ⭐ THE STAMP IS A RECEIPT, NOT A UI FLAG. customer_confirmed is what
  // activateLegacyOutboundReviewRowIfNeeded and the hourly sweep both key on,
  // so an office confirm that stamped inside its own transaction and then lost
  // a core leg (or the process) left a half-armed row both rails skip forever.
  describe('runOfficeConfirmActivation — hook first, stamp on success', () => {
    const { runOfficeConfirmActivation } = require('../services/outbound-review-confirm');

    function stampOf(db) {
      return db._state.updates.find((u) => u.table === 'scheduled_services' && u.vals.customer_confirmed === true);
    }

    test('stamps customer_confirmed only after the core legs succeed', async () => {
      const db = confirmHookDb({ fallbackLeads: [] });
      const ok = await runOfficeConfirmActivation(db, svc, 'test');
      expect(ok).toBe(true);
      expect(AppointmentReminders.registerAppointment).toHaveBeenCalled();
      expect(stampOf(db)).toBeTruthy();
      expect(stampOf(db).vals.confirmed_at).toBeInstanceOf(Date);
    });

    // ⭐ THE CLEARANCE STAMP IS A CORE LEG. A row stamped confirmed WITHOUT it
    // falls between both rails: the legacy sweep skips it (already confirmed)
    // and the pre-visit card sweep excludes it (no clearance).
    test('a failed clearance stamp leaves the row unstamped too', async () => {
      const base = confirmHookDb({ fallbackLeads: [] });
      const db = (table) => {
        const q = base(table);
        if (table === 'scheduled_services') {
          const inner = q.update;
          q.update = jest.fn(async (vals) => {
            if (vals.call_sms_cleared_at) throw new Error('clearance write failed');
            return inner(vals);
          });
        }
        return q;
      };
      Object.assign(db, base);
      const ok = await runOfficeConfirmActivation(db, svc, 'test');
      expect(ok).toBe(false);
      expect(stampOf(db)).toBeUndefined();
    });

    test('a failed core leg leaves the row UNSTAMPED so the sweep retries it', async () => {
      AppointmentReminders.registerAppointment.mockResolvedValueOnce(null);
      const db = confirmHookDb({ fallbackLeads: [] });
      const ok = await runOfficeConfirmActivation(db, svc, 'test');
      expect(ok).toBe(false);
      expect(stampOf(db)).toBeUndefined();
    });

    test('a stamp write that fails reports false — the sweep still owns the row', async () => {
      const base = confirmHookDb({ fallbackLeads: [] });
      const db = (table) => {
        const q = base(table);
        if (table === 'scheduled_services') {
          const inner = q.update;
          q.update = jest.fn(async (vals) => {
            if (vals.customer_confirmed) throw new Error('write failed');
            return inner(vals);
          });
        }
        return q;
      };
      Object.assign(db, base);
      const ok = await runOfficeConfirmActivation(db, svc, 'test');
      expect(ok).toBe(false);
      expect(stampOf(db)).toBeUndefined();
    });
  });

  test('an ambiguous fallback (two active leads) converts NOTHING', async () => {
    const db = confirmHookDb({ fallbackLeads: [{ id: 'lead-1', status: 'new' }, { id: 'lead-2', status: 'contacted' }] });
    await runOutboundReviewConfirmHook(db, svc, 'test');
    expect(convertCallLeadOnPhoneBooking).not.toHaveBeenCalled();
    // The other side effects still run.
    expect(AppointmentReminders.registerAppointment).toHaveBeenCalled();
    expect(db._state.triageResolved).toBe(true);
  });
});

describe('isPendingOutboundReviewBooking — dispatch-implies-confirm detection', () => {
  // tech-track's en-route/on-site auto-confirm (PR #3356) keys on this
  // helper; the legacy-activation seams (PR #3361) share its condition
  // (source_action + pending + !customer_confirmed).
  const base = {
    source_action: CALL_OUTBOUND_REVIEW_SOURCE_ACTION,
    status: 'pending',
    customer_confirmed: false,
  };

  test('matches a pending, unconfirmed outbound-review row', () => {
    expect(isPendingOutboundReviewBooking(base)).toBe(true);
  });

  test('does NOT match other source_actions, non-pending status, confirmed rows, or missing rows', () => {
    expect(isPendingOutboundReviewBooking({ ...base, source_action: 'ai_call_pipeline' })).toBe(false);
    expect(isPendingOutboundReviewBooking({ ...base, source_action: CALL_FOLLOWUP_SOURCE_ACTION })).toBe(false);
    expect(isPendingOutboundReviewBooking({ ...base, status: 'confirmed' })).toBe(false);
    expect(isPendingOutboundReviewBooking({ ...base, status: 'cancelled' })).toBe(false);
    expect(isPendingOutboundReviewBooking({ ...base, customer_confirmed: true })).toBe(false);
    expect(isPendingOutboundReviewBooking(null)).toBe(false);
    expect(isPendingOutboundReviewBooking(undefined)).toBe(false);
  });
});

describe('confirm-hook reminder resync — explicit null-start guard (Codex r21 P2)', () => {
  const fs = require('fs');
  const path = require('path');

  test('handleReschedule expectGuard enforces window_start IS NULL for an asserted windowless slot', () => {
    // A date-only move observed windowless must not overwrite a
    // concurrently-assigned real window with the fabricated 09:00 fallback:
    // the guard distinguishes "windowStart key absent" (date-only check)
    // from "explicitly null" (IS NULL required).
    const reminders = fs.readFileSync(path.join(__dirname, '../services/appointment-reminders.js'), 'utf8');
    expect(reminders).toContain("Object.prototype.hasOwnProperty.call(options.expectSchedule, 'windowStart')");
    expect(reminders).toContain("else if (hasStartAssertion) q.whereNull('scheduled_services.window_start');");
  });

  test('the confirm hook passes the observed null start explicitly (not an omitted key)', () => {
    const hook = fs.readFileSync(path.join(__dirname, '../services/outbound-review-confirm.js'), 'utf8');
    expect(hook).toContain('windowStart: postSlot.window_start || null,');
  });
});

describe('legacy evidence recovery — commit proof for pre-existing rows (Codex r22 P1)', () => {
  const fs = require('fs');
  const path = require('path');

  test('the fast recovery leg requires the transition status when the caller passes recoveryStatusIn', () => {
    // For pre-existing rows (legacy status transitions) row visibility is
    // NOT commit proof — a rolled-back completion leaves the row visible
    // as pending and the retry would leak completion evidence.
    const credit = fs.readFileSync(path.join(__dirname, '../services/inspection-credit.js'), 'utf8');
    expect(credit).toContain("q.whereIn('status', recoveryStatusIn);");
  });

  test('both job-status evidence sites pass their committed-transition status set', () => {
    const jobStatus = fs.readFileSync(path.join(__dirname, '../services/job-status.js'), 'utf8');
    expect(jobStatus).toContain("recoveryStatusIn: ['completed'],");
    expect(jobStatus).toContain("recoveryStatusIn: ['confirmed', 'en_route', 'on_site', 'completed'],");
  });
});

describe('windowless repair — canonical placeholder conversion (Codex r22 P2)', () => {
  const fs = require('fs');
  const path = require('path');

  test('the concurrent-windowless repair writes the durable placeholder markers, not a flag-only close', () => {
    // A flag-only close is undone by the sync trigger's recompute on the
    // next date-only move; only windows_preclosed rows hold placeholder
    // semantics durably (and the marker invariant requires suppression).
    const hook = fs.readFileSync(path.join(__dirname, '../services/outbound-review-confirm.js'), 'utf8');
    expect(hook).toContain('suppressed_by_sibling: true,');
    expect(hook).toContain('windows_preclosed: true,');
    // Demoting an armed owner must promote a suppressed sibling exactly as
    // the trigger's slot-departure path does — no trigger event fires for
    // this app-side demotion.
    expect(hook).toContain('SELECT promote_suppressed_reminder_sibling(');
    // The promotion's slot date/window are the ET decomposition of the
    // armed row's OWN appointment_time (Codex r23 P2) — never the post-move
    // service slot, which misses the pre-move sibling when the windowless
    // edit landed before the stale-read registration inserted.
    expect(hook).toContain("((?::timestamptz) AT TIME ZONE 'America/New_York')::date");
    expect(hook).toContain("((?::timestamptz) AT TIME ZONE 'America/New_York')::time");
    expect(hook).not.toContain('NULL::time');
    // Slot advisory lock first, same order as registration and the trigger.
    expect(hook).toContain('pg_advisory_xact_lock(reminder_slot_lock_key(?::uuid, ?::timestamptz))');
  });
});

describe('same-key replay — consent-blocked email confirmation repair (Codex r23 P2)', () => {
  const fs = require('fs');
  const path = require('path');

  test('a replay with SMS consent-blocked but email permitted retries the email leg, evidence-gated', () => {
    const callProc = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');
    // The branch exists, scoped to the partial TCPA block AND to visits
    // that still have an arrival time (a windowless visit has no time to
    // confirm — Codex r24 P1; the start comes from the FRESH slot re-read,
    // not the reuse-trx snapshot — Codex r25 P2).
    expect(callProc).toContain('} else if (replaySlotVerified && replaySlotStart && v2SmsBlocked && !v2EmailBlocked) {');
    // Evidence gate on the email audit ledger before re-sending, and the
    // repair goes through the channel-aware helper (opt-out + prefs
    // fail-closed enforced there) with the SMS leg stubbed off.
    const branchAt = callProc.indexOf('} else if (replaySlotVerified && replaySlotStart && v2SmsBlocked && !v2EmailBlocked) {');
    const branchSlice = callProc.slice(branchAt, branchAt + 3000);
    expect(branchSlice).toContain("interaction_type: 'email_outbound'");
    expect(branchSlice).toContain('smsPermanentlyBlocked: true,');
    expect(branchSlice).toContain('smsAttempt: async () => false,');
    // It must never re-arm the SMS sweep (that rail has no consent context).
    expect(branchSlice).not.toContain('confirmation_sent: false');
  });
});

describe('live-booking confirmation — TCPA-blocked SMS email fallback (Codex r21 P1)', () => {
  const fs = require('fs');
  const path = require('path');

  test('the call pipeline flags the v2 TCPA SMS block as permanent so the default-sms channel emails instead', () => {
    // Behavior coverage lives in appointment-notification-channels.test.js
    // (deliverConfirmationByChannel smsPermanentlyBlocked cases); this pins
    // the pipeline wiring: only the TCPA gate (email still permitted) sets
    // the flag — the implied-consent non-ANI hold keeps its Needs Review
    // card instead.
    const callProc = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');
    expect(callProc).toContain('smsPermanentlyBlocked: v2SmsBlocked && !v2EmailBlocked,');
  });
});

describe('round 27 — clearance is stamped, side effects wait for commits, repairs verify their slot (Codex r27)', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

  test('office confirm stamps call_sms_cleared_at; lazy activation never does (P1)', () => {
    // The pre-visit sweep admits an outbound-review row ONLY on the durable
    // clearance stamp now — status 'confirmed' also arrives via lazy
    // activation of a silently-rescheduled legacy row, which is not a
    // customer trust point. The stamp is written on the office-confirm card
    // leg (the !suppressCardAskWithoutClearance branch), never overwriting a
    // processor stamp; the suppressed lazy path only READS the stamp.
    const hook = read('../services/outbound-review-confirm.js');
    expect(hook).toContain(".whereNull('call_sms_cleared_at')");
    expect(hook).toContain('if (!opts.suppressCardAskWithoutClearance && !opts.skipCardRequest) {');
    const sweep = read('../services/previsit-card-request-sweep.js');
    expect(sweep).not.toContain("outboundConfirmed");
    expect(sweep).toContain("orWhereNotNull('s.call_sms_cleared_at')");
  });

  test('the auto-secure enrollment email fires only after the OUTER commit (P1)', () => {
    // enrollConsentedMethod in savepoint mode returns the send as a
    // callback instead of firing it when the savepoint releases; the
    // auto-secure caller invokes it only on the committed auto_secured
    // path. Behavior coverage: autopay-enrollment.test.js (savepoint mode).
    const enroll = read('../services/autopay-enrollment.js');
    expect(enroll).toContain('const runningInCallerTrx = dbh.isTransaction === true;');
    expect(enroll).toContain('required: true,');
    const card = read('../services/appointment-card-request.js');
    expect(card).toContain('let deferredEnrollmentEmail = null;');
    expect(card).toContain("if (secured?.action === 'auto_secured' && deferredEnrollmentEmail) {");
  });

  test('a failed replay slot verify gates BOTH confirmation repairs (P2)', () => {
    // Both repairs are built on replaySlotStart; with the verify unrepaired
    // that slot may be stale, and re-arming the sweep (or emailing) from it
    // would send the customer an obsolete time.
    const callProc = read('../services/call-recording-processor.js');
    expect(callProc).toContain('replaySlotVerified && replaySlotStart && !v2SmsBlocked');
    expect(callProc).toContain('replaySlotVerified && replaySlotStart && v2SmsBlocked');
  });

  test('the replay email repair re-checks visit liveness inside the shared sender (P2)', () => {
    // A cancellation committing after the reused-row snapshot must win —
    // the sender re-reads the status immediately before each delivery leg
    // and fails CLOSED on a read error.
    const callProc = read('../services/call-recording-processor.js');
    expect(callProc).toContain('requireLiveVisitStatus: true,');
    const reminders = read('../services/appointment-reminders.js');
    expect(reminders).toContain('requireLiveVisitStatus = false }');
    expect(reminders).toContain('const visitStillLive = async () => {');
  });

  test('the shared slot verify checks the PERSISTED reminder row, not just the registration args (P2)', () => {
    // An activation retry whose earlier attempt armed the row at stale slot
    // A re-registers with current slot B and the dedupe returns the A row
    // untouched — an args-only comparison declares success while the
    // reminder keeps quoting A.
    const hook = read('../services/outbound-review-confirm.js');
    expect(hook).toContain("first('id', 'appointment_time', 'windows_preclosed')");
    expect(hook).toContain('persistedSlotStale');
    expect(hook).toContain('needsWindowlessConversion');
  });
});
