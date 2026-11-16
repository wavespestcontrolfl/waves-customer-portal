// GATE_DAY_ONLY_PROMISE part B2: EVERY delayed day-only MOVE recovery passes the move context to the one chokepoint
// (revalidateDelayedDaySend): a queued contact text (deferred-replay-registry) and a stored move email (dayOnlyStoredCopyStale).
// The old date's window confirmation is set aside; a genuinely newer promise still suppresses; a non-move day send keeps the
// plain rule (an older hour promise suppresses it). The chokepoint, the registry and the stored-copy check run for real; The replay holds only the frozen body of one contact, so a
// replay that is no longer valid as a day promise is SUPPRESSED (stale_replay), never sent. The registry's recheck and the
// chokepoint run for real; the promise reads and the shared eligibility decision are stubbed (their rules are pinned in
// day-only-promise-b1-eligibility.test.js). Synthetic data only.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: jest.fn() }));
jest.mock('../services/customer-contact', () => ({
  getAppointmentContacts: jest.fn(() => []),
  isServiceContactRole: jest.fn(() => false),
}));
jest.mock('../services/appointment-email', () => ({
  sendAppointmentConfirmationEmail: jest.fn(async () => ({ ok: true })),
  sendAppointmentReminderEmail: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));
jest.mock('../services/estimate-card-holds', () => ({ cardHoldReminderLine: jest.fn(async () => ''), cardHoldReminderNote: jest.fn(async () => '') }));
jest.mock('../services/reservation-arrival', () => ({ arrivalStartForService: jest.fn(async (_db, svc) => svc.window_start) }));
jest.mock('../services/time-promise', () => ({
  ...jest.requireActual('../services/time-promise'),
  loadPromiseLevels: jest.fn(),
  dayOnlySendDecision: jest.fn(),
}));

const db = require('../models/db');
const timePromise = require('../services/time-promise');
const { recheckDeferredReplay } = require('../services/messaging/deferred-replay-registry');
const { promiseMetaOf } = timePromise;

const ENTRY = 'appointment_notice_contact_deferred';
const OLD_GATE = process.env.GATE_DAY_ONLY_PROMISE;
let prefsRow;

function chain(first) {
  const q = {};
  ['where', 'whereIn', 'whereNot', 'whereNull', 'whereNotNull', 'whereRaw', 'orderBy', 'select', 'join', 'leftJoin'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => first);
  q.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
  return q;
}

const queuedMeta = {
  entry_point: ENTRY, scheduled_service_id: 'ss-1', customer_id: 'c1', replay_purpose: 'appointment_reminder_72h',
  appointment_contact_role: 'spouse', slot_scheduled_date: '2026-06-22', slot_window_start: '09:00',
  promise_level: 'day', window_unknown: true, guard_slot_ms: Date.parse('2026-06-22T13:00:00Z'), promised_date: '2026-06-22',
};

beforeEach(() => {
  jest.clearAllMocks();
  // Three days before the 9:00 ET visit: outside the 24.25 h cutoff.
  jest.useFakeTimers().setSystemTime(new Date('2026-06-19T14:00:00.000Z'));
  process.env.GATE_DAY_ONLY_PROMISE = 'true';
  prefsRow = { sms_enabled: true, service_reminder_24h: true };
  db.raw = jest.fn((sql) => sql);
  db.mockImplementation((table) => {
    if (table === 'scheduled_services') return chain({ id: 'ss-1', status: 'confirmed', scheduled_date: '2026-06-22', window_start: '09:00:00', reservation_service_mix: null });
    if (table === 'notification_prefs') return chain(prefsRow);
    if (table === 'customers') return chain({ id: 'c1', phone: '+19415550001' });
    return chain(null);
  });
  timePromise.loadPromiseLevels.mockImplementation(async (_conn, ids) => new Map(ids.map((id) => [id, 'none'])));
  timePromise.dayOnlySendDecision.mockImplementation(async (_conn, { startAt, reminder24hEnabled }) => ({
    dayOnly: jest.requireActual('../services/time-promise').shouldPromiseDayOnly({ startAt, now: new Date(), reminder24hEnabled, customerPicked: false, level: 'none' }),
    level: 'none', eligible: true,
  }));
});

afterEach(() => {
  jest.useRealTimers();
  if (OLD_GATE === undefined) delete process.env.GATE_DAY_ONLY_PROMISE; else process.env.GATE_DAY_ONLY_PROMISE = OLD_GATE;
});


const told = require('../services/auto-dispatch/told-visits');

const NOTICE_AT = '2026-06-18T12:00:00.000Z';
const moveMeta = { ...queuedMeta, replay_purpose: 'appointment_rescheduled', move_notice_at: NOTICE_AT };
const promise = (communicatedAt, startAt) => ({ visit_id: 'ss-1', start_at: startAt, communicated_at: communicatedAt, source: 'message' });
// The delivered window confirmation for the OLD date, sent before the move.
const OLD_WINDOW = promise('2026-06-10T12:00:00.000Z', '2026-06-15T13:00:00.000Z');
// The delivered 24-hour window for the NEW date, sent after the move.
const NEW_WINDOW = promise('2026-06-19T10:00:00.000Z', '2026-06-22T13:00:00.000Z');
const standing = (p) => jest.spyOn(told, 'resolvePromises').mockResolvedValue(new Map([['ss-1', p]]));

afterEach(() => { jest.restoreAllMocks(); });

describe('a queued contact text for a MOVE (appointment_notice_contact_deferred)', () => {
  test('promiseMetaOf carries the move stamp with the day fields, and only for a day body', () => {
    expect(promiseMetaOf(moveMeta)).toEqual({
      promise_level: 'day', window_unknown: true, guard_slot_ms: moveMeta.guard_slot_ms, promised_date: '2026-06-22', move_notice_at: NOTICE_AT,
    });
    expect(promiseMetaOf({ move_notice_at: NOTICE_AT })).toEqual({});
    expect(Object.keys(promiseMetaOf(queuedMeta))).not.toContain('move_notice_at');
  });

  test('over the old date\'s window confirmation: it still goes (the move replaced that promise), judged with the old level ignored', async () => {
    timePromise.loadPromiseLevels.mockResolvedValue(new Map([['ss-1', 'hour']]));
    standing(OLD_WINDOW);
    expect(await recheckDeferredReplay(ENTRY, moveMeta)).toEqual({ eligible: true });
    expect(timePromise.dayOnlySendDecision).toHaveBeenCalledTimes(1);
    expect(timePromise.dayOnlySendDecision.mock.calls[0][1]).toMatchObject({ id: 'ss-1', ignoreLevel: true });
  });

  test('a newer 24-hour window for the new date still suppresses it', async () => {
    timePromise.loadPromiseLevels.mockResolvedValue(new Map([['ss-1', 'hour']]));
    standing(NEW_WINDOW);
    expect(await recheckDeferredReplay(ENTRY, moveMeta)).toEqual({ eligible: false, reason: 'day-promise-superseded' });
    expect(timePromise.dayOnlySendDecision).not.toHaveBeenCalled();
  });

  test('a queued non-move day body (a 72-hour reminder): an older hour promise still suppresses, nothing is set aside', async () => {
    timePromise.loadPromiseLevels.mockResolvedValue(new Map([['ss-1', 'hour']]));
    const resolve = standing(OLD_WINDOW);
    expect(await recheckDeferredReplay(ENTRY, queuedMeta)).toEqual({ eligible: false, reason: 'day-promise-superseded' });
    expect(resolve).not.toHaveBeenCalled();
    expect(timePromise.dayOnlySendDecision).not.toHaveBeenCalled();
  });

  test('a move body with no readable promise stays suppressed (fail closed)', async () => {
    timePromise.loadPromiseLevels.mockResolvedValue(new Map([['ss-1', 'hour']]));
    jest.spyOn(told, 'resolvePromises').mockRejectedValue(new Error('read failed'));
    expect((await recheckDeferredReplay(ENTRY, moveMeta)).eligible).toBe(false);
  });
});

describe('a stored day-only EMAIL (dayOnlyStoredCopyStale)', () => {
  const moveEmail = {
    template_key: 'appointment.rescheduled_day', trigger_event_id: 'appointment.rescheduled:ss-1', recipient_type: 'customer', recipient_id: 'c1',
    idempotency_key: 'appointment.rescheduled:ss-1:day-2026-06-22:0123456789abcdef', created_at: NOTICE_AT,
  };
  const confirmation = {
    template_key: 'appointment.confirmation_day', trigger_event_id: 'appointment.confirmation:ss-1', recipient_type: 'customer', recipient_id: 'c1',
    idempotency_key: 'appointment.confirmation:ss-1:day-2026-06-22:0123456789abcdef', created_at: NOTICE_AT,
  };

  test('a move email over the old date\'s window confirmation: not stale, the stored copy may go', async () => {
    timePromise.loadPromiseLevels.mockResolvedValue(new Map([['ss-1', 'hour']]));
    standing(OLD_WINDOW);
    expect(await timePromise.dayOnlyStoredCopyStale(moveEmail)).toBe(false);
    expect(timePromise.dayOnlySendDecision.mock.calls[0][1]).toMatchObject({ id: 'ss-1', ignoreLevel: true });
  });

  test('a newer 24-hour window for the new date: stale', async () => {
    timePromise.loadPromiseLevels.mockResolvedValue(new Map([['ss-1', 'hour']]));
    standing(NEW_WINDOW);
    expect(await timePromise.dayOnlyStoredCopyStale(moveEmail)).toBe(true);
  });

  test('a non-move day confirmation with an older hour promise is still stale (and nothing is set aside)', async () => {
    timePromise.loadPromiseLevels.mockResolvedValue(new Map([['ss-1', 'hour']]));
    const resolve = standing(OLD_WINDOW);
    expect(await timePromise.dayOnlyStoredCopyStale(confirmation)).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });

  test('a move email with no creation time gets no context: the plain rule (an hour promise suppresses)', async () => {
    timePromise.loadPromiseLevels.mockResolvedValue(new Map([['ss-1', 'hour']]));
    const resolve = standing(OLD_WINDOW);
    expect(await timePromise.dayOnlyStoredCopyStale({ ...moveEmail, created_at: undefined })).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('the email rails today', () => {
  test('a move email carries MOVE_NOTICE_CATEGORY, which both stored-copy rails refuse before the day-only check (the context above is the second guard)', () => {
    const { MOVE_NOTICE_CATEGORY, staleStoredCopyReason } = require('../constants/email-replay-exclusions');
    expect(staleStoredCopyReason(['appointment_rescheduled', MOVE_NOTICE_CATEGORY])).toMatch(/Not re-sent from stored copy/);
    expect(require('fs').readFileSync(require('path').join(__dirname, '../services/appointment-email.js'), 'utf8'))
      .toContain("categories: ['appointment_rescheduled', MOVE_NOTICE_CATEGORY]");
  });
});
