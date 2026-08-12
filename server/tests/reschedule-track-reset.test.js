/**
 * Stale tracker-lifecycle rewind on reschedule (2026-08-11 incident).
 *
 * A visit started on an earlier day, aborted, and moved to a new date could
 * keep the old attempt's track_state + lifecycle stamps. The next day's En
 * Route tap then silently no-op'd (markEnRoute's atomic guard saw an
 * "already advanced" state): no en_route_at, no track-link SMS, and the
 * customer report rendered the aborted attempt's timestamps.
 *
 * Three layers under test:
 *  1. rebooker.needsLifecycleRewind — evidence-based rewind test the movers
 *     use instead of status-only wasLive.
 *  2. track-transitions.markEnRoute self-heal — day-of tap on a row whose
 *     lifecycle evidence predates today ET rewinds and takes a fresh flip.
 *  3. visit-timeline stale-timestamp guard — en-route/on-site timestamps
 *     implausibly far before completion never render.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/twilio', () => ({
  sendTechEnRoute: jest.fn().mockResolvedValue({ success: false }),
  sendTechArrived: jest.fn().mockResolvedValue({ success: false }),
}));
jest.mock('../services/tech-status', () => ({
  setTechJobStatus: jest.fn().mockResolvedValue({}),
  clearTechCurrentJob: jest.fn().mockResolvedValue({}),
}));
jest.mock('../services/job-status', () => ({
  transitionJobStatus: jest.fn().mockResolvedValue({}),
}));
jest.mock('../sockets', () => ({
  getIo: jest.fn(() => ({ to: jest.fn(() => ({ emit: jest.fn() })) })),
}));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => true),
}));
jest.mock('../services/recurring-app-intro-email', () => ({
  maybeSendOnEnRoute: jest.fn().mockResolvedValue(undefined),
}));

const db = require('../models/db');
const { transitionJobStatus } = require('../services/job-status');
const trackTransitions = require('../services/track-transitions');
const { needsLifecycleRewind, LIVE_LIFECYCLE_RESET } = require('../services/rebooker');
const { buildVisitTimeline } = require('../services/service-report/visit-timeline');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');

function query(result) {
  const q = {
    where: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    update: jest.fn().mockResolvedValue(result),
    insert: jest.fn().mockResolvedValue(result),
    first: jest.fn().mockResolvedValue(result),
  };
  q.modify = jest.fn((fn) => { fn(q); return q; });
  q.whereRaw = jest.fn().mockReturnValue(q);
  return q;
}

// Dynamic dates: hardcoded fixtures time-bomb suites when the calendar
// catches up (see rebooker-live-reschedule-override.test.js).
const todayStr = etDateString();
const isoDaysAgo = (n, time = 'T14:00') => parseETDateTime(`${etDateString(addETDays(parseETDateTime(`${todayStr}T12:00`), -n))}${time}`).toISOString();

describe('needsLifecycleRewind', () => {
  test('live operational status rewinds', () => {
    expect(needsLifecycleRewind({ status: 'en_route' })).toBe(true);
    expect(needsLifecycleRewind({ status: 'on_site' })).toBe(true);
  });

  test('live track_state rewinds even when status was never synced', () => {
    expect(needsLifecycleRewind({ status: 'confirmed', track_state: 'en_route' })).toBe(true);
    expect(needsLifecycleRewind({ status: 'pending', track_state: 'on_property' })).toBe(true);
  });

  test('any leftover lifecycle stamp rewinds (partial-reset residue)', () => {
    expect(needsLifecycleRewind({ status: 'pending', track_state: 'on_property', actual_start_time: isoDaysAgo(7) })).toBe(true);
    expect(needsLifecycleRewind({ status: 'confirmed', track_state: 'scheduled', en_route_at: isoDaysAgo(1) })).toBe(true);
    expect(needsLifecycleRewind({ status: 'confirmed', track_state: 'scheduled', arrived_at: isoDaysAgo(1) })).toBe(true);
    expect(needsLifecycleRewind({ status: 'confirmed', track_state: 'scheduled', check_in_time: isoDaysAgo(1) })).toBe(true);
  });

  test('leftover SMS guards alone rewind (they would suppress the new day\'s texts)', () => {
    expect(needsLifecycleRewind({ status: 'confirmed', track_state: 'scheduled', track_sms_sent_at: isoDaysAgo(7) })).toBe(true);
    expect(needsLifecycleRewind({ status: 'pending', track_state: 'scheduled', arrival_sms_sent_at: isoDaysAgo(7) })).toBe(true);
  });

  test('clean scheduled row does not rewind', () => {
    expect(needsLifecycleRewind({ status: 'confirmed', track_state: 'scheduled' })).toBe(false);
    expect(needsLifecycleRewind({ status: 'pending' })).toBe(false);
  });
});

describe('isStaleLiveAttempt (route-facing detector)', () => {
  test('stale advanced state detected; same-day and terminal shapes are not', () => {
    expect(trackTransitions.isStaleLiveAttempt({
      status: 'on_site', track_state: 'on_property', scheduled_date: todayStr, actual_start_time: isoDaysAgo(7),
    })).toBe(true);
    // Same-day evidence = today's genuine attempt.
    expect(trackTransitions.isStaleLiveAttempt({
      status: 'on_site', track_state: 'on_property', scheduled_date: todayStr, actual_start_time: isoDaysAgo(0, 'T09:00'),
    })).toBe(false);
    // Terminal status never qualifies.
    expect(trackTransitions.isStaleLiveAttempt({
      status: 'completed', track_state: 'on_property', scheduled_date: todayStr, actual_start_time: isoDaysAgo(7),
    })).toBe(false);
    // Non-advanced tracker never qualifies.
    expect(trackTransitions.isStaleLiveAttempt({
      status: 'pending', track_state: 'scheduled', scheduled_date: todayStr, actual_start_time: isoDaysAgo(7),
    })).toBe(false);
    // A stale SMS guard alone is not lifecycle evidence.
    expect(trackTransitions.isStaleLiveAttempt({
      status: 'pending', track_state: 'on_property', scheduled_date: todayStr, track_sms_sent_at: isoDaysAgo(7),
    })).toBe(false);
    // Mixed evidence: ANY current-day stamp proves a genuine live attempt —
    // one stale sibling field never marks the whole attempt stale.
    expect(trackTransitions.isStaleLiveAttempt({
      status: 'on_site',
      track_state: 'on_property',
      scheduled_date: todayStr,
      en_route_at: isoDaysAgo(0, 'T08:05'),
      actual_start_time: isoDaysAgo(7),
    })).toBe(false);
  });
});

describe('markEnRoute stale-attempt self-heal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // The status-rewind heal runs its write + history insert in one trx;
    // the mock hands the same db queue to the callback.
    db.transaction = jest.fn(async (fn) => fn(db));
  });

  test('stale on_property from an earlier ET day is rewound and the flip proceeds', async () => {
    // The incident row's shape: track_state advanced, en_route_at/arrived_at
    // wiped by a partial reset, actual_start_time still carrying the aborted
    // attempt. Scheduled today so the future-date guard passes.
    const staleSvc = {
      id: 'job-stale',
      customer_id: 'cust-1',
      technician_id: null,
      status: 'pending',
      track_state: 'on_property',
      scheduled_date: todayStr,
      en_route_at: null,
      arrived_at: null,
      actual_start_time: isoDaysAgo(7),
      track_sms_sent_at: isoDaysAgo(7),
      cancelled_at: null,
    };
    const healedSvc = {
      ...staleSvc,
      track_state: 'scheduled',
      actual_start_time: null,
      track_sms_sent_at: null,
    };
    const healUpdate = query(1);
    const flipUpdate = query(1);
    db
      .mockReturnValueOnce(query(staleSvc)) // loadService (first call)
      .mockReturnValueOnce(healUpdate) // stale-heal rewind UPDATE
      .mockReturnValueOnce(query(healedSvc)) // loadService (recursed call)
      .mockReturnValueOnce(flipUpdate); // en-route flip UPDATE

    const result = await trackTransitions.markEnRoute('job-stale');

    expect(result.ok).toBe(true);
    expect(result.state).toBe('en_route');
    expect(result.alreadyEnRoute).toBe(false);
    expect(result.enRouteAt).toEqual(expect.any(Date));
    // The heal rewound the tracker and cleared exactly the STALE fields,
    // guarded on the FULL observed snapshot (status, schedule day, and
    // every lifecycle/SMS field). (Per-field: null columns are not
    // "stale", so they are simply absent from the write.)
    expect(healUpdate.where).toHaveBeenCalledWith(expect.objectContaining({
      id: 'job-stale',
      status: 'pending',
      scheduled_date: todayStr,
    }));
    // applyTrackLifecycleCas: track_state via where, null stamps via
    // whereNull, non-null stamps via ms-truncated whereRaw.
    expect(healUpdate.where).toHaveBeenCalledWith({ track_state: 'on_property' });
    expect(healUpdate.whereNull).toHaveBeenCalledWith('en_route_at');
    expect(healUpdate.whereRaw).toHaveBeenCalledWith(
      expect.stringContaining("date_trunc('milliseconds'"),
      ['actual_start_time', expect.any(Date)],
    );
    const healPayload = healUpdate.update.mock.calls[0][0];
    expect(healPayload).toMatchObject({
      track_state: 'scheduled',
      actual_start_time: null,
      track_sms_sent_at: null,
    });
    expect(healPayload).not.toHaveProperty('status');
    // The fresh flip stamped en_route_at.
    expect(flipUpdate.update.mock.calls[0][0]).toMatchObject({
      track_state: 'en_route',
      en_route_at: expect.any(Date),
    });
  });

  test('same-day evidence is a genuine re-tap: no heal, idempotent path', async () => {
    const sameDaySvc = {
      id: 'job-today',
      customer_id: 'cust-2',
      technician_id: null,
      status: 'en_route',
      track_state: 'en_route',
      scheduled_date: todayStr,
      en_route_at: new Date().toISOString(),
      cancelled_at: null,
    };
    db.mockReturnValueOnce(query(sameDaySvc));

    const result = await trackTransitions.markEnRoute('job-today');

    expect(result.ok).toBe(true);
    expect(result.alreadyEnRoute).toBe(true);
    // Only the loadService call — no heal UPDATE, no second flip.
    expect(db).toHaveBeenCalledTimes(1);
  });

  test('advanced state with no evidence stamps is left alone', async () => {
    const noEvidenceSvc = {
      id: 'job-bare',
      customer_id: 'cust-3',
      technician_id: null,
      status: 'pending',
      track_state: 'on_property',
      scheduled_date: todayStr,
      en_route_at: null,
      arrived_at: null,
      actual_start_time: null,
      cancelled_at: null,
    };
    db.mockReturnValueOnce(query(noEvidenceSvc));

    const result = await trackTransitions.markEnRoute('job-bare');

    expect(result.ok).toBe(true);
    expect(result.state).toBe('on_property');
    expect(db).toHaveBeenCalledTimes(1);
  });

  test('overnight overdue attempt is NOT healed: evidence on its own scheduled day', async () => {
    // Visit scheduled yesterday, genuinely started late yesterday evening,
    // re-tapped after midnight. Evidence date == scheduled_date proves it is
    // that day's real attempt (overdue completions are deliberately
    // allowed), so no rewind — the idempotent path answers.
    const yesterday = etDateString(addETDays(parseETDateTime(`${todayStr}T12:00`), -1));
    const overnightSvc = {
      id: 'job-overnight',
      customer_id: 'cust-5',
      technician_id: null,
      status: 'on_site',
      track_state: 'on_property',
      scheduled_date: yesterday,
      en_route_at: isoDaysAgo(1, 'T22:40'),
      arrived_at: isoDaysAgo(1, 'T23:05'),
      actual_start_time: isoDaysAgo(1, 'T23:05'),
      cancelled_at: null,
    };
    db.mockReturnValueOnce(query(overnightSvc));

    const result = await trackTransitions.markEnRoute('job-overnight');

    expect(result.ok).toBe(true);
    expect(result.state).toBe('on_property');
    expect(db).toHaveBeenCalledTimes(1); // no heal UPDATE
  });

  test('complete track_state never heals', async () => {
    const completeSvc = {
      id: 'job-done',
      customer_id: 'cust-4',
      technician_id: null,
      status: 'completed',
      track_state: 'complete',
      scheduled_date: todayStr,
      actual_start_time: isoDaysAgo(7),
      cancelled_at: null,
    };
    db.mockReturnValueOnce(query(completeSvc));

    const result = await trackTransitions.markEnRoute('job-done');

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('terminal_status: completed');
    expect(db).toHaveBeenCalledTimes(1);
  });

  test('completed status with a stuck on_property track_state never heals', async () => {
    // Completion persists operational status BEFORE the best-effort
    // markComplete tracker flip — a crash between the two leaves exactly
    // this row. It is a finished visit: no rewind, no SMS.
    const stuckDoneSvc = {
      id: 'job-stuck-done',
      customer_id: 'cust-6',
      technician_id: null,
      status: 'completed',
      track_state: 'on_property',
      scheduled_date: todayStr,
      arrived_at: isoDaysAgo(7),
      actual_start_time: isoDaysAgo(7),
      cancelled_at: null,
    };
    db.mockReturnValueOnce(query(stuckDoneSvc));

    const result = await trackTransitions.markEnRoute('job-stuck-done');

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('terminal_status: completed');
    expect(db).toHaveBeenCalledTimes(1); // no heal UPDATE
  });

  test('a failed heal transaction surfaces an error, not phantom idempotent success', async () => {
    const staleSvc = {
      id: 'job-heal-err',
      customer_id: 'cust-16',
      technician_id: null,
      status: 'on_site',
      track_state: 'on_property',
      scheduled_date: todayStr,
      arrived_at: isoDaysAgo(7),
      cancelled_at: null,
    };
    db.mockReturnValueOnce(query(staleSvc));
    db.transaction = jest.fn(async () => { throw new Error('history insert boom'); });

    const result = await trackTransitions.markEnRoute('job-heal-err');

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('stale_heal_failed');
  });

  test('CAS miss with the row still scheduled surfaces a conflict, not success', async () => {
    // A concurrent reschedule moved the status/date tuple between the read
    // and the flip while track_state stayed 'scheduled': nobody went en
    // route, no SMS fired — the caller must not be told it succeeded.
    const svc = {
      id: 'job-cas-miss',
      customer_id: 'cust-11',
      technician_id: null,
      status: 'confirmed',
      track_state: 'scheduled',
      scheduled_date: todayStr,
      cancelled_at: null,
    };
    db
      .mockReturnValueOnce(query(svc)) // loadService
      .mockReturnValueOnce(query(0)) // flip UPDATE misses (tuple changed)
      .mockReturnValueOnce(query({ ...svc, scheduled_date: null, track_state: 'scheduled' })); // re-read: still scheduled

    const result = await trackTransitions.markEnRoute('job-cas-miss');

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('concurrent_update');
  });

  test('completion racing the heal cannot be flipped en route (status-first window)', async () => {
    // The exact race the heal recursion creates: heal reset track_state to
    // 'scheduled', a concurrent completion then persisted status='completed'
    // before the recursive reload. The terminal-status guard rejects it.
    const racedSvc = {
      id: 'job-raced',
      customer_id: 'cust-10',
      technician_id: null,
      status: 'completed',
      track_state: 'scheduled',
      scheduled_date: todayStr,
      cancelled_at: null,
    };
    db.mockReturnValueOnce(query(racedSvc));

    const result = await trackTransitions.markEnRoute('job-raced');

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('terminal_status: completed');
    expect(db).toHaveBeenCalledTimes(1); // no flip UPDATE, no SMS
  });

  test('scheduled track_state with stale stamps: flip clears them atomically and un-suppresses the SMS', async () => {
    // A partial reset put track_state back to 'scheduled' but left the old
    // attempt's start stamp and SMS guards. The flip must clear them in the
    // same write (or completion books a days-long duration) and the stale
    // track_sms_sent_at must not suppress today's track SMS.
    const partialResetSvc = {
      id: 'job-partial',
      customer_id: 'cust-8',
      technician_id: null,
      status: 'pending',
      track_state: 'scheduled',
      scheduled_date: todayStr,
      en_route_at: null,
      arrived_at: null,
      actual_start_time: isoDaysAgo(7),
      check_in_time: null,
      track_sms_sent_at: isoDaysAgo(7),
      track_view_token: 'a'.repeat(64),
      cancelled_at: null,
    };
    const flipUpdate = query(1);
    db
      .mockReturnValueOnce(query(partialResetSvc)) // loadService
      .mockReturnValueOnce(flipUpdate); // flip UPDATE (with clears)

    const result = await trackTransitions.markEnRoute('job-partial');

    expect(result.ok).toBe(true);
    expect(result.state).toBe('en_route');
    const flipPayload = flipUpdate.update.mock.calls[0][0];
    expect(flipPayload).toMatchObject({
      track_state: 'en_route',
      en_route_at: expect.any(Date),
      actual_start_time: null,
      track_sms_sent_at: null,
    });
    // Per-field: columns that were already null are not re-written.
    expect(flipPayload).not.toHaveProperty('arrived_at');
    // The stale guard did not suppress the send attempt.
    const { sendTechEnRoute } = require('../services/twilio');
    expect(sendTechEnRoute).toHaveBeenCalled();
  });

  test('scheduled track_state with same-day stamps flips without clearing anything', async () => {
    const sameDayStamps = {
      id: 'job-clean-flip',
      customer_id: 'cust-9',
      technician_id: null,
      status: 'confirmed',
      track_state: 'scheduled',
      scheduled_date: todayStr,
      actual_start_time: isoDaysAgo(0, 'T08:15'),
      track_sms_sent_at: new Date().toISOString(),
      cancelled_at: null,
    };
    const flipUpdate = query(1);
    db
      .mockReturnValueOnce(query(sameDayStamps))
      .mockReturnValueOnce(flipUpdate);

    const result = await trackTransitions.markEnRoute('job-clean-flip');

    expect(result.ok).toBe(true);
    const payload = flipUpdate.update.mock.calls[0][0];
    expect(payload).toMatchObject({ track_state: 'en_route' });
    expect(payload).not.toHaveProperty('actual_start_time');
    expect(payload).not.toHaveProperty('track_sms_sent_at');
    // Recent guard still suppresses the send.
    const { sendTechEnRoute } = require('../services/twilio');
    expect(sendTechEnRoute).not.toHaveBeenCalled();
  });

  test('stale check_in_time alone is enough evidence to heal', async () => {
    const checkInOnlySvc = {
      id: 'job-checkin',
      customer_id: 'cust-7',
      technician_id: null,
      status: 'pending',
      track_state: 'on_property',
      scheduled_date: todayStr,
      en_route_at: null,
      arrived_at: null,
      actual_start_time: null,
      check_in_time: isoDaysAgo(7),
      track_sms_sent_at: null,
      cancelled_at: null,
    };
    const healedSvc = { ...checkInOnlySvc, track_state: 'scheduled', check_in_time: null };
    const healUpdate = query(1);
    db
      .mockReturnValueOnce(query(checkInOnlySvc))
      .mockReturnValueOnce(healUpdate)
      .mockReturnValueOnce(query(healedSvc))
      .mockReturnValueOnce(query(1));

    const result = await trackTransitions.markEnRoute('job-checkin');

    expect(result.ok).toBe(true);
    expect(result.state).toBe('en_route');
    expect(healUpdate.update.mock.calls[0][0]).toMatchObject({
      track_state: 'scheduled',
      check_in_time: null,
    });
  });

  test('heal rewinds a stale live OPERATIONAL status to confirmed with a history row', async () => {
    // Legacy move shape: both status AND track_state stayed live. The
    // re-entry cannot sync status backward, so the heal itself lands it on
    // 'confirmed' and appends the same history entry the movers record.
    const liveStatusSvc = {
      id: 'job-live-status',
      customer_id: 'cust-12',
      technician_id: null,
      status: 'on_site',
      track_state: 'on_property',
      scheduled_date: todayStr,
      arrived_at: isoDaysAgo(7),
      actual_start_time: isoDaysAgo(7),
      track_sms_sent_at: isoDaysAgo(7),
      cancelled_at: null,
    };
    const healedSvc = {
      ...liveStatusSvc,
      status: 'confirmed',
      track_state: 'scheduled',
      arrived_at: null,
      actual_start_time: null,
      track_sms_sent_at: null,
    };
    const healUpdate = query(1);
    const historyInsert = query(1);
    const flipUpdate = query(1);
    db
      .mockReturnValueOnce(query(liveStatusSvc)) // loadService
      .mockReturnValueOnce(healUpdate) // heal UPDATE
      .mockReturnValueOnce(historyInsert) // job_status_history insert
      .mockReturnValueOnce(query(healedSvc)) // recursed loadService
      .mockReturnValueOnce(flipUpdate); // flip UPDATE

    const result = await trackTransitions.markEnRoute('job-live-status');

    expect(result.ok).toBe(true);
    expect(result.state).toBe('en_route');
    expect(healUpdate.update.mock.calls[0][0]).toMatchObject({
      track_state: 'scheduled',
      status: 'confirmed',
      arrived_at: null,
      actual_start_time: null,
      track_sms_sent_at: null,
    });
    expect(historyInsert.insert).toHaveBeenCalledWith(expect.objectContaining({
      job_id: 'job-live-status',
      from_status: 'on_site',
      to_status: 'confirmed',
    }));
  });

  test('delegated stale-on_site heal syncs the operational side back to en_route', async () => {
    // tech-track's delegation path: it skips its own status flip and passes
    // syncOperationalStatus, so after the heal rewinds on_site→confirmed
    // the re-entry transitions confirmed→en_route with history.
    const staleSvc = {
      id: 'job-delegated',
      customer_id: 'cust-15',
      technician_id: null,
      status: 'on_site',
      track_state: 'on_property',
      scheduled_date: todayStr,
      arrived_at: isoDaysAgo(7),
      actual_start_time: isoDaysAgo(7),
      track_sms_sent_at: isoDaysAgo(7),
      cancelled_at: null,
    };
    const healedSvc = {
      ...staleSvc,
      status: 'confirmed',
      track_state: 'scheduled',
      arrived_at: null,
      actual_start_time: null,
      track_sms_sent_at: null,
    };
    db
      .mockReturnValueOnce(query(staleSvc)) // loadService
      .mockReturnValueOnce(query(1)) // heal UPDATE (in trx)
      .mockReturnValueOnce(query(1)) // job_status_history insert (in trx)
      .mockReturnValueOnce(query(healedSvc)) // recursed loadService
      .mockReturnValueOnce(query(1)); // flip UPDATE

    const result = await trackTransitions.markEnRoute('job-delegated', { syncOperationalStatus: true });

    expect(result.ok).toBe(true);
    expect(result.state).toBe('en_route');
    expect(transitionJobStatus).toHaveBeenCalledWith(expect.objectContaining({
      jobId: 'job-delegated',
      fromStatus: 'confirmed',
      toStatus: 'en_route',
    }));
  });

  test('caller-set en_route status is preserved through the heal (status-first route sequence)', async () => {
    // tech-track/admin routes transition status to en_route BEFORE calling
    // markEnRoute. The heal must not rewrite that fresh transition to
    // 'confirmed' — no status key in the write, no history row; after the
    // re-entry flips track_state, both sides read en_route.
    const routeSequenceSvc = {
      id: 'job-route-seq',
      customer_id: 'cust-14',
      technician_id: null,
      status: 'en_route',
      track_state: 'on_property',
      scheduled_date: todayStr,
      arrived_at: isoDaysAgo(7),
      actual_start_time: isoDaysAgo(7),
      track_sms_sent_at: isoDaysAgo(7),
      cancelled_at: null,
    };
    const healedSvc = {
      ...routeSequenceSvc,
      track_state: 'scheduled',
      arrived_at: null,
      actual_start_time: null,
      track_sms_sent_at: null,
    };
    const healUpdate = query(1);
    const flipUpdate = query(1);
    db
      .mockReturnValueOnce(query(routeSequenceSvc)) // loadService
      .mockReturnValueOnce(healUpdate) // heal UPDATE (no history insert follows)
      .mockReturnValueOnce(query(healedSvc)) // recursed loadService
      .mockReturnValueOnce(flipUpdate); // flip UPDATE

    const result = await trackTransitions.markEnRoute('job-route-seq');

    expect(result.ok).toBe(true);
    expect(result.state).toBe('en_route');
    const healPayload = healUpdate.update.mock.calls[0][0];
    expect(healPayload).toMatchObject({ track_state: 'scheduled', arrived_at: null });
    expect(healPayload).not.toHaveProperty('status');
    expect(db).toHaveBeenCalledTimes(4); // no job_status_history insert
  });

  test('mixed evidence: stale fields clear IN PLACE, the live attempt is preserved', async () => {
    // Partial-reset residue next to a genuine current-day en-route: the
    // stale start is cleared without any state/status rewind, the fresh
    // en_route_at and today's SMS guard survive, the idempotent branch
    // answers, and the customer is NOT double-texted.
    const mixedSvc = {
      id: 'job-mixed',
      customer_id: 'cust-13',
      technician_id: null,
      status: 'confirmed',
      track_state: 'en_route',
      scheduled_date: todayStr,
      en_route_at: isoDaysAgo(0, 'T08:05'),
      actual_start_time: isoDaysAgo(7),
      track_sms_sent_at: isoDaysAgo(0, 'T08:05'),
      cancelled_at: null,
    };
    const cleanupUpdate = query(1);
    db
      .mockReturnValueOnce(query(mixedSvc)) // loadService
      .mockReturnValueOnce(cleanupUpdate); // in-place stale-field cleanup

    const result = await trackTransitions.markEnRoute('job-mixed');

    expect(result.ok).toBe(true);
    expect(result.state).toBe('en_route');
    expect(result.alreadyEnRoute).toBe(true);
    const cleanupPayload = cleanupUpdate.update.mock.calls[0][0];
    expect(cleanupPayload).toMatchObject({ actual_start_time: null });
    // No rewind: state, status, and today's stamps stay.
    expect(cleanupPayload).not.toHaveProperty('track_state');
    expect(cleanupPayload).not.toHaveProperty('status');
    expect(cleanupPayload).not.toHaveProperty('en_route_at');
    expect(cleanupPayload).not.toHaveProperty('track_sms_sent_at');
    // No duplicate track SMS.
    const { sendTechEnRoute } = require('../services/twilio');
    expect(sendTechEnRoute).not.toHaveBeenCalled();
  });
});

describe('markOnProperty stale-attempt repair (arrival-first signals)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.transaction = jest.fn(async (fn) => fn(db));
  });

  test('entirely-old on_property row rewinds before a fresh arrival flip', async () => {
    const staleSvc = {
      id: 'job-op-stale',
      customer_id: 'cust-20',
      technician_id: null,
      status: 'pending',
      track_state: 'on_property',
      scheduled_date: todayStr,
      arrived_at: isoDaysAgo(7),
      actual_start_time: isoDaysAgo(7),
      arrival_sms_sent_at: isoDaysAgo(7),
      cancelled_at: null,
    };
    const healedSvc = {
      ...staleSvc,
      track_state: 'scheduled',
      arrived_at: null,
      actual_start_time: null,
      arrival_sms_sent_at: null,
    };
    const healUpdate = query(1);
    const flipUpdate = query(1);
    const claimUpdate = query(1);
    db
      .mockReturnValueOnce(query(staleSvc)) // loadService
      .mockReturnValueOnce(healUpdate) // rewind UPDATE
      .mockReturnValueOnce(query(healedSvc)) // recursed loadService
      .mockReturnValueOnce(flipUpdate) // on_property flip
      .mockReturnValueOnce(claimUpdate); // arrival SMS claim

    const result = await trackTransitions.markOnProperty('job-op-stale');

    expect(result.ok).toBe(true);
    expect(result.state).toBe('on_property');
    expect(healUpdate.update.mock.calls[0][0]).toMatchObject({
      track_state: 'scheduled',
      arrived_at: null,
      actual_start_time: null,
      arrival_sms_sent_at: null,
    });
    expect(flipUpdate.update.mock.calls[0][0]).toMatchObject({
      track_state: 'on_property',
      arrived_at: expect.any(Date),
    });
  });

  test('flip CAS miss with a non-on_property fresh row surfaces a conflict', async () => {
    const svc = {
      id: 'job-op-conflict',
      customer_id: 'cust-21',
      technician_id: null,
      status: 'confirmed',
      track_state: 'en_route',
      scheduled_date: todayStr,
      en_route_at: isoDaysAgo(0, 'T09:00'),
      cancelled_at: null,
    };
    db
      .mockReturnValueOnce(query(svc)) // loadService
      .mockReturnValueOnce(query(0)) // flip UPDATE misses (reschedule rewrote the row)
      .mockReturnValueOnce(query({ ...svc, track_state: 'scheduled', en_route_at: null })); // re-read

    const result = await trackTransitions.markOnProperty('job-op-conflict');

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('concurrent_update');
  });
});

describe('visit timeline stale-timestamp guard', () => {
  const config = { enabled: true, showOnCustomerReports: true };

  test('on-site from a week before completion never renders (incident shape)', () => {
    const timeline = buildVisitTimeline({
      service: {
        status: 'completed',
        scheduled_date: todayStr,
        completed_at: isoDaysAgo(0, 'T13:28'),
        actual_start_time: isoDaysAgo(7, 'T14:54'),
        en_route_at: null,
        arrived_at: null,
      },
      serviceLine: 'lawn',
      config,
    });
    const onSite = timeline.events.find((e) => e.type === 'technician_on_site');
    expect(onSite).toBeUndefined();
    const completed = timeline.events.find((e) => e.type === 'service_completed');
    expect(completed).toBeDefined();
  });

  test('stale en-route is dropped too', () => {
    const timeline = buildVisitTimeline({
      service: {
        status: 'completed',
        completed_at: isoDaysAgo(0, 'T13:28'),
        en_route_at: isoDaysAgo(7, 'T14:36'),
      },
      serviceLine: 'lawn',
      config,
    });
    expect(timeline.events.find((e) => e.type === 'technician_en_route')).toBeUndefined();
  });

  test('same-day timestamps render normally', () => {
    const timeline = buildVisitTimeline({
      service: {
        status: 'completed',
        completed_at: isoDaysAgo(0, 'T13:28'),
        en_route_at: isoDaysAgo(0, 'T12:26'),
        arrived_at: isoDaysAgo(0, 'T12:40'),
      },
      serviceLine: 'lawn',
      config,
    });
    expect(timeline.events.map((e) => e.type)).toEqual([
      'technician_en_route',
      'technician_on_site',
      'service_completed',
    ]);
  });

  test('backfill day-only closeout keeps its same-day afternoon arrival', () => {
    // Backdated quiet closeout: completion is the day-scale ET-noon instant,
    // which sits BEFORE the real afternoon arrival. The guard only drops
    // timestamps implausibly far BEFORE completion, so this shape survives.
    const timeline = buildVisitTimeline({
      service: {
        status: 'completed',
        completed_at: isoDaysAgo(3, 'T12:00'),
        arrived_at: isoDaysAgo(3, 'T14:54'),
      },
      structured: { backfill: true },
      serviceLine: 'lawn',
      config,
    });
    const onSite = timeline.events.find((e) => e.type === 'technician_on_site');
    expect(onSite).toBeDefined();
    const completed = timeline.events.find((e) => e.type === 'service_completed');
    expect(completed.occurredAt).toBeNull();
  });

  test('stale canonical column does not shadow a genuine fallback timestamp', () => {
    // The staleness check applies per candidate: actual_start_time from the
    // aborted attempt is skipped and the current-attempt arrival carried by
    // a workflow event still renders.
    const freshArrival = isoDaysAgo(0, 'T12:40');
    const timeline = buildVisitTimeline({
      service: {
        status: 'completed',
        completed_at: isoDaysAgo(0, 'T13:28'),
        actual_start_time: isoDaysAgo(7, 'T14:54'),
      },
      workflowEvents: [
        { type: 'technician_on_site', status: 'completed', timestamp: freshArrival },
      ],
      serviceLine: 'lawn',
      config,
    });
    const onSite = timeline.events.find((e) => e.type === 'technician_on_site');
    expect(onSite).toBeDefined();
    expect(onSite.occurredAt).toBe(new Date(freshArrival).toISOString());
  });

  test('in-progress visit (no completion) keeps its timestamps', () => {
    const timeline = buildVisitTimeline({
      service: {
        status: 'en_route',
        scheduled_date: todayStr,
        en_route_at: isoDaysAgo(0, 'T12:26'),
      },
      serviceLine: 'lawn',
      config,
    });
    expect(timeline.events.find((e) => e.type === 'technician_en_route')).toBeDefined();
  });

  test('16h-gap reschedule is still caught by the scheduled-day boundary', () => {
    // Aborted 5 PM yesterday, moved to today, completed 9 AM: only 16 hours
    // apart, so an elapsed-gap bound alone would render it — the scheduled
    // ET day catches it.
    const timeline = buildVisitTimeline({
      service: {
        status: 'completed',
        scheduled_date: todayStr,
        completed_at: isoDaysAgo(0, 'T09:00'),
        actual_start_time: isoDaysAgo(1, 'T17:00'),
      },
      serviceLine: 'lawn',
      config,
    });
    expect(timeline.events.find((e) => e.type === 'technician_on_site')).toBeUndefined();
  });

  test('overnight overdue completion keeps its previous-evening stamps', () => {
    // Scheduled yesterday, started late evening, completed after midnight —
    // the stamps are on the visit's own scheduled day and survive.
    const yesterday = etDateString(addETDays(parseETDateTime(`${todayStr}T12:00`), -1));
    const timeline = buildVisitTimeline({
      service: {
        status: 'completed',
        scheduled_date: yesterday,
        completed_at: isoDaysAgo(0, 'T00:30'),
        arrived_at: isoDaysAgo(1, 'T23:05'),
        en_route_at: isoDaysAgo(1, 'T22:40'),
      },
      serviceLine: 'lawn',
      config,
    });
    expect(timeline.events.map((e) => e.type)).toContain('technician_on_site');
    expect(timeline.events.map((e) => e.type)).toContain('technician_en_route');
  });

  test('sanitized arrival drives on_site_min: no raw started_at fallback resurrects a stale start', () => {
    // Covered at the buildVisitTimeline level indirectly; the report-data
    // metric contract is asserted here via the timeline's duration field
    // with showDuration on — a stale-only arrival yields NO duration.
    const timeline = buildVisitTimeline({
      service: {
        status: 'completed',
        scheduled_date: todayStr,
        completed_at: isoDaysAgo(0, 'T13:28'),
        started_at: isoDaysAgo(7, 'T14:54'),
      },
      serviceLine: 'lawn',
      config: { ...config, showDuration: true },
    });
    expect(timeline.durationMinutes).toBeNull();
  });

  test('early project closeout (completed before the scheduled day) keeps its stamps', () => {
    // markComplete allowFutureDate: visit scheduled next week, deliberately
    // completed today — completion predates the scheduled day, so the
    // scheduled-day boundary is inert and the gap fallback governs.
    const nextWeek = etDateString(addETDays(parseETDateTime(`${todayStr}T12:00`), 7));
    const timeline = buildVisitTimeline({
      service: {
        status: 'completed',
        scheduled_date: nextWeek,
        completed_at: isoDaysAgo(0, 'T15:00'),
        arrived_at: isoDaysAgo(0, 'T13:00'),
      },
      serviceLine: 'lawn',
      config,
    });
    expect(timeline.events.find((e) => e.type === 'technician_on_site')).toBeDefined();
  });
});
