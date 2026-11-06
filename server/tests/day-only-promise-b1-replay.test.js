// GATE_DAY_ONLY_PROMISE part B1 (Codex round 7): the morning replay of a queued DAY-ONLY body is revalidated through the
// same chokepoint a bounce recovery uses (revalidateDelayedDaySend). The replay holds only the frozen body of one contact, so a
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

describe('the morning replay of a queued day-only body', () => {
  test('still valid (early, nothing newer, gate on, 24-hour reminder on): it goes, with its day marker and level day', async () => {
    const verdict = await recheckDeferredReplay(ENTRY, queuedMeta);
    expect(verdict).toEqual({ eligible: true });
    // What the scheduler then sends: the stored body with the saved fields, which the reader reads as a day promise.
    expect(promiseMetaOf(queuedMeta)).toEqual({ promise_level: 'day', window_unknown: true, guard_slot_ms: queuedMeta.guard_slot_ms, promised_date: '2026-06-22' });
    expect(timePromise.dayOnlySendDecision).toHaveBeenCalledTimes(1);
    expect(timePromise.dayOnlySendDecision.mock.calls[0][1]).toMatchObject({ id: 'ss-1', reminder24hEnabled: true });
  });

  test('after the 24-hour text delivered the window (the latest promise is an hour): suppressed, never a newer day promise', async () => {
    timePromise.loadPromiseLevels.mockResolvedValue(new Map([['ss-1', 'hour']]));
    expect(await recheckDeferredReplay(ENTRY, queuedMeta)).toEqual({ eligible: false, reason: 'day-promise-superseded' });
    expect(timePromise.dayOnlySendDecision).not.toHaveBeenCalled();
  });

  test('the gate was turned off since it was queued: suppressed (no window copy can be rendered from a frozen body)', async () => {
    delete process.env.GATE_DAY_ONLY_PROMISE;
    expect(await recheckDeferredReplay(ENTRY, queuedMeta)).toEqual({ eligible: false, reason: 'day-promise-no-longer-valid' });
    expect(timePromise.dayOnlySendDecision).not.toHaveBeenCalled();
  });

  test('the 24-hour reminder was switched off since: suppressed', async () => {
    prefsRow = { sms_enabled: true, service_reminder_24h: false };
    expect(await recheckDeferredReplay(ENTRY, queuedMeta)).toEqual({ eligible: false, reason: 'day-promise-no-longer-valid' });
    expect(timePromise.dayOnlySendDecision.mock.calls[0][1].reminder24hEnabled).toBe(false);
  });

  test('texts switched off with a text-only 24-hour channel: suppressed', async () => {
    prefsRow = { sms_enabled: false, service_reminder_24h: true, service_reminder_24h_channel: 'sms' };
    expect((await recheckDeferredReplay(ENTRY, queuedMeta)).eligible).toBe(false);
  });

  test('inside the cutoff by replay time: suppressed', async () => {
    jest.setSystemTime(new Date('2026-06-21T20:00:00.000Z')); // 17 h before the visit
    expect(await recheckDeferredReplay(ENTRY, queuedMeta)).toEqual({ eligible: false, reason: 'day-promise-no-longer-valid' });
  });

  test('the promise cannot be read: suppressed (fail closed)', async () => {
    timePromise.loadPromiseLevels.mockRejectedValue(new Error('read failed'));
    expect((await recheckDeferredReplay(ENTRY, queuedMeta)).eligible).toBe(false);
  });

  test('a queued WINDOW body is not revalidated: today\'s checks only, no promise read', async () => {
    const { promise_level: _p, window_unknown: _w, guard_slot_ms: _g, promised_date: _d, ...windowMeta } = queuedMeta;
    expect(await recheckDeferredReplay(ENTRY, windowMeta)).toEqual({ eligible: true });
    expect(timePromise.loadPromiseLevels).not.toHaveBeenCalled();
    expect(timePromise.dayOnlySendDecision).not.toHaveBeenCalled();
  });

  test('the visit checks still come first: a cancelled visit is stale before any promise read', async () => {
    db.mockImplementation((table) => (table === 'scheduled_services'
      ? chain({ status: 'cancelled', scheduled_date: '2026-06-22', window_start: '09:00:00' }) : chain(null)));
    expect((await recheckDeferredReplay(ENTRY, queuedMeta)).reason).toBe('visit-cancelled');
    expect(timePromise.loadPromiseLevels).not.toHaveBeenCalled();
  });
});
