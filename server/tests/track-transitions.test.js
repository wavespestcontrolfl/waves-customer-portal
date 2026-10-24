jest.mock('../models/db', () => jest.fn());
// The shared field-advance seam asks the street-level hold predicate (fails closed on a bare fake db).
jest.mock('../services/street-level-hold', () => ({ isStreetLevelHoldVisit: jest.fn(async () => false) }));
jest.mock('../services/twilio', () => ({
  sendTechEnRoute: jest.fn(),
  sendTechArrived: jest.fn(),
}));
jest.mock('../services/tech-status', () => ({
  setTechJobStatus: jest.fn().mockResolvedValue({}),
  clearTechCurrentJob: jest.fn().mockResolvedValue({}),
}));
jest.mock('../services/job-status', () => ({
  transitionJobStatus: jest.fn().mockResolvedValue({}),
}));
jest.mock('../sockets', () => ({
  getIo: jest.fn(() => null),
}));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => true),
}));
const mockFence = jest.fn(async () => {});
jest.mock('../services/cancel-generation-fence', () => ({
  CancelFenceError: jest.requireActual('../services/cancel-generation-fence').CancelFenceError,
  assertCancelGeneration: (...a) => mockFence(...a),
  isCancelFence: (err) => Boolean(err) && err.code === 'CANCEL_FENCE',
}));

const db = require('../models/db');
const { sendTechArrived } = require('../services/twilio');
const { setTechJobStatus, clearTechCurrentJob } = require('../services/tech-status');
const { transitionJobStatus } = require('../services/job-status');
const { getIo } = require('../sockets');
const { isEnabled } = require('../config/feature-gates');
const trackTransitions = require('../services/track-transitions');

function query(result) {
  const q = {
    where: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    update: jest.fn().mockResolvedValue(result),
    first: jest.fn().mockResolvedValue(result),
  };
  // knex .modify(fn) — applies the builder callback (the already-complete
  // completed_at optimistic guard uses it) and keeps chaining.
  q.modify = jest.fn((fn) => { fn(q); return q; });
  q.whereRaw = jest.fn().mockReturnValue(q);
  return q;
}

function socketStub() {
  return { to: jest.fn(() => ({ emit: jest.fn() })) };
}

describe('track-transitions lifecycle side effects', () => {
  test('en-route retries share a visit attempt while a same-day restart gets a new notification', () => {
    const first = new Date('2030-04-08T13:00:00Z');
    const restart = new Date('2030-04-08T16:00:00Z');
    const key = trackTransitions.enRouteNotificationKey;
    expect(key({ id: 'job-1', visit_id: 'visit-1' }, first)).toBe(key({ id: 'job-2', visit_id: 'visit-1' }, first.toISOString()));
    expect(key({ id: 'job-1', visit_id: 'visit-1' }, first)).not.toBe(key({ id: 'job-1', visit_id: 'visit-1' }, restart));
    expect(key({ id: 'job-1' }, first)).not.toBe(key({ id: 'job-1' }, restart));
    expect(key({ id: 'job-1' }, null)).toBeNull();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // The tracker flip runs in a transaction that locks the visit row (raw) and rechecks the street-level hold.
    db.raw = jest.fn(async () => ({ rows: [] }));
    db.transaction = jest.fn(async (fn) => fn(db));
    transitionJobStatus.mockReset().mockResolvedValue({});
    getIo.mockReturnValue(socketStub());
    jest.useRealTimers();
  });

  test('markEnRoute sets tech_status current job without relying on Bouncie', async () => {
    const svc = {
      id: 'job-1',
      customer_id: 'cust-1',
      technician_id: 'tech-1',
      status: 'confirmed',
      track_state: 'scheduled',
      track_sms_sent_at: new Date(),
      track_view_token: 'a'.repeat(64),
    };
    db
      .mockReturnValueOnce(query(svc))
      .mockReturnValueOnce(query(1));

    const result = await trackTransitions.markEnRoute('job-1');

    expect(result.ok).toBe(true);
    expect(result.state).toBe('en_route');
    expect(setTechJobStatus).toHaveBeenCalledWith({
      tech_id: 'tech-1',
      status: 'en_route',
      current_job_id: 'job-1',
    });
  });

  test('markOnProperty accepts scheduled tracker state and syncs operational status', async () => {
    const svc = {
      id: 'job-2',
      technician_id: 'tech-2',
      status: 'pending',
      track_state: 'scheduled',
      cancelled_at: null,
      // Pre-stamped so the arrival-SMS block is skipped — keeps this test
      // focused on the state/operational-status side effects.
      arrival_sms_sent_at: new Date(),
    };
    const load = query(svc);
    const update = query(1);
    db
      .mockReturnValueOnce(load)
      .mockReturnValueOnce(update);

    const result = await trackTransitions.markOnProperty('job-2');

    expect(result.ok).toBe(true);
    expect(result.state).toBe('on_property');
    expect(transitionJobStatus).toHaveBeenCalledWith({
      jobId: 'job-2',
      fromStatus: 'pending',
      toStatus: 'on_site',
      transitionedBy: null,
    });
    expect(update.whereIn).toHaveBeenCalledWith('track_state', ['scheduled', 'en_route']);
    const payload = update.update.mock.calls[0][0];
    expect(payload).toMatchObject({
      track_state: 'on_property',
      actual_start_time: expect.any(Date),
      check_in_time: expect.any(Date),
      arrived_at: expect.any(Date),
    });
    expect(setTechJobStatus).toHaveBeenCalledWith({
      tech_id: 'tech-2',
      status: 'on_site',
      current_job_id: 'job-2',
    });
  });

  test('a hold that commits after the fast-path check is caught under the flip row lock: no write, no side effects', async () => {
    const { isStreetLevelHoldVisit } = require('../services/street-level-hold');
    for (const [fn, svc] of [
      ['markEnRoute', { id: 'job-h1', technician_id: 'tech-1', status: 'pending', track_state: 'scheduled' }],
      ['markOnProperty', { id: 'job-h2', technician_id: 'tech-2', status: 'pending', track_state: 'scheduled', arrival_sms_sent_at: new Date() }],
    ]) {
      // Unlocked fast path sees no hold; the recheck under the lock sees the promoted one.
      isStreetLevelHoldVisit.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      const load = query(svc);
      db.mockClear();
      db.mockReturnValueOnce(load);
      expect(await trackTransitions[fn](svc.id)).toEqual({ ok: false, reason: 'street_level_hold' });
      expect(db.raw).toHaveBeenLastCalledWith('SELECT 1 FROM scheduled_services WHERE id = ? FOR UPDATE', [svc.id]);
      expect(isStreetLevelHoldVisit).toHaveBeenLastCalledWith(svc.id, db);
      // Only the load ran: the CAS builder was never reached.
      expect(db).toHaveBeenCalledTimes(1);
      expect(load.update).not.toHaveBeenCalled();
    }
    expect(setTechJobStatus).not.toHaveBeenCalled();
    expect(transitionJobStatus).not.toHaveBeenCalled();
  });

  test('markOnProperty fires the arrival SMS once and claims arrival_sms_sent_at before sending', async () => {
    const svc = {
      id: 'job-6',
      customer_id: 'cust-6',
      technician_id: 'tech-6',
      status: 'confirmed',
      track_state: 'scheduled',
      cancelled_at: null,
      arrival_sms_sent_at: null,
    };
    sendTechArrived.mockResolvedValue({ success: true });
    const claim = query(1);
    db
      .mockReturnValueOnce(query(svc)) // loadService
      .mockReturnValueOnce(query(1)) // on_property flip update
      .mockReturnValueOnce(claim) // atomic claim of arrival_sms_sent_at
      .mockReturnValueOnce(query({ name: 'Bryan' })); // technician name lookup

    const result = await trackTransitions.markOnProperty('job-6');

    expect(result.ok).toBe(true);
    expect(result.state).toBe('on_property');
    expect(sendTechArrived).toHaveBeenCalledWith('cust-6', 'Bryan', expect.objectContaining({ scheduledServiceId: 'job-6' }));
    // Guard is claimed (NULL -> now()) before the send, not stamped after.
    expect(claim.whereNull).toHaveBeenCalledWith('arrival_sms_sent_at');
    expect(claim.update).toHaveBeenCalledWith({
      arrival_sms_sent_at: expect.any(Date),
    });
  });

  test('markOnProperty does not double-send when another arrival signal already claimed the guard', async () => {
    const svc = {
      id: 'job-c',
      customer_id: 'cust-c',
      technician_id: 'tech-c',
      status: 'on_site', // syncOperationalStatus no-op
      track_state: 'on_property', // idempotent branch
      cancelled_at: null,
      actual_start_time: new Date(),
      check_in_time: new Date(),
      arrived_at: new Date(),
      arrival_sms_sent_at: null,
    };
    db
      .mockReturnValueOnce(query(svc)) // loadService
      .mockReturnValueOnce(query(0)); // claim loses the race (0 rows updated)

    const result = await trackTransitions.markOnProperty('job-c');

    expect(result.ok).toBe(true);
    expect(sendTechArrived).not.toHaveBeenCalled();
  });

  test('markOnProperty releases the arrival guard when the send fails so a later signal retries', async () => {
    const svc = {
      id: 'job-f',
      customer_id: 'cust-f',
      technician_id: 'tech-f',
      status: 'confirmed',
      track_state: 'scheduled',
      cancelled_at: null,
      arrival_sms_sent_at: null,
    };
    sendTechArrived.mockResolvedValue({ success: false });
    const release = query(1);
    db
      .mockReturnValueOnce(query(svc)) // loadService
      .mockReturnValueOnce(query(1)) // flip
      .mockReturnValueOnce(query(1)) // claim
      .mockReturnValueOnce(query({ name: 'Dana' })) // tech lookup
      .mockReturnValueOnce(release); // release back to NULL

    const result = await trackTransitions.markOnProperty('job-f');

    expect(result.ok).toBe(true);
    expect(sendTechArrived).toHaveBeenCalled();
    expect(release.update).toHaveBeenCalledWith({ arrival_sms_sent_at: null });
  });

  test('markOnProperty keeps the arrival guard stamped when the customer opted out (no release)', async () => {
    const svc = {
      id: 'job-o',
      customer_id: 'cust-o',
      technician_id: 'tech-o',
      status: 'confirmed',
      track_state: 'scheduled',
      cancelled_at: null,
      arrival_sms_sent_at: null,
    };
    // Deterministic local suppression — handled, not retryable. The guard must
    // stay stamped so a later same-job signal can't fire a stale "has arrived"
    // if the pref flips while still on-site.
    sendTechArrived.mockResolvedValue({ success: false, suppressed: true, reason: 'opt_out' });
    db
      .mockReturnValueOnce(query(svc)) // loadService
      .mockReturnValueOnce(query(1)) // flip
      .mockReturnValueOnce(query(1)) // claim
      .mockReturnValueOnce(query({ name: 'Omar' })); // tech lookup — NO release after

    const result = await trackTransitions.markOnProperty('job-o');

    expect(result.ok).toBe(true);
    expect(sendTechArrived).toHaveBeenCalled();
    // A release would be a 5th db() call (UPDATE ... arrival_sms_sent_at = null).
    // Suppression is handled, so the guard stays stamped — exactly 4 db calls:
    // loadService, flip, claim, tech lookup.
    expect(db).toHaveBeenCalledTimes(4);
  });

  test('markOnProperty names the acting tech, not the stale assignment, in the arrival SMS', async () => {
    const svc = {
      id: 'job-a',
      customer_id: 'cust-a',
      technician_id: 'tech-assigned', // stale assignment after a crew swap
      status: 'confirmed',
      track_state: 'scheduled',
      cancelled_at: null,
      arrival_sms_sent_at: null,
    };
    sendTechArrived.mockResolvedValue({ success: true });
    const techLookup = query({ name: 'Acting Andy' });
    db
      .mockReturnValueOnce(query(svc)) // loadService
      .mockReturnValueOnce(query(1)) // flip
      .mockReturnValueOnce(query(1)) // claim
      .mockReturnValueOnce(techLookup); // tech name lookup

    const result = await trackTransitions.markOnProperty('job-a', { actingTechId: 'tech-acting' });

    expect(result.ok).toBe(true);
    // Name resolves from the acting tech the caller passed, not technician_id.
    expect(techLookup.where).toHaveBeenCalledWith({ id: 'tech-acting' });
    expect(sendTechArrived).toHaveBeenCalledWith('cust-a', 'Acting Andy', expect.objectContaining({ scheduledServiceId: 'job-a' }));
  });

  test('markOnProperty suppresses the arrival SMS on the timer-already-running path', async () => {
    const svc = {
      id: 'job-s',
      customer_id: 'cust-s',
      technician_id: 'tech-s',
      status: 'confirmed',
      track_state: 'scheduled',
      cancelled_at: null,
      arrival_sms_sent_at: null,
    };
    db
      .mockReturnValueOnce(query(svc)) // loadService
      .mockReturnValueOnce(query(1)); // flip

    const result = await trackTransitions.markOnProperty('job-s', { suppressArrivalSms: true });

    expect(result.ok).toBe(true);
    expect(result.state).toBe('on_property');
    expect(sendTechArrived).not.toHaveBeenCalled();
  });

  describe('markOnProperty late arrival (GPS sample delivered late, GATE_GPS_ARRIVAL_LATE_SAMPLES)', () => {
    const at = new Date(Date.now() - 40 * 60 * 1000);
    const enRouteAt = new Date(Date.now() - 60 * 60 * 1000);
    // A past schedule day keeps these rows clear of the future-date guard and of
    // the stale-attempt rule (en_route_at is on or after the scheduled day).
    const lateSvc = (id, overrides = {}) => ({
      id,
      customer_id: 'cust-late',
      technician_id: 'tech-late',
      status: 'en_route',
      track_state: 'en_route',
      cancelled_at: null,
      arrival_sms_sent_at: null,
      scheduled_date: '2026-10-01',
      en_route_at: enRouteAt,
      visit_id: null,
      ...overrides,
    });
    const lateOpts = (overrides = {}) => ({
      actingTechId: 'tech-late',
      expectTechnicianId: 'tech-late',
      suppressArrivalSms: true,
      lateArrival: { at, enRouteAt, scheduledDate: '2026-10-01', ...overrides },
    });

    test('stamps the sample time, marks the arrival handled in the same write and sends no text', async () => {
      const update = query(1);
      db
        .mockReturnValueOnce(query(lateSvc('job-l1')))
        .mockReturnValueOnce(update);

      const result = await trackTransitions.markOnProperty('job-l1', lateOpts());

      expect(result).toMatchObject({ ok: true, state: 'on_property', arrivedAt: at });
      expect(update.update.mock.calls[0][0]).toMatchObject({
        track_state: 'on_property',
        arrived_at: at,
        actual_start_time: at,
        check_in_time: at,
        // handled: a later manual start or geofence ENTER cannot text either
        arrival_sms_sent_at: expect.any(Date),
      });
      expect(transitionJobStatus).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-l1', fromStatus: 'en_route', toStatus: 'on_site' }));
      expect(sendTechArrived).not.toHaveBeenCalled();
    });

    test('flips the tech board with ONE conditional write bound to this visit', async () => {
      db
        .mockReturnValueOnce(query(lateSvc('job-l2')))
        .mockReturnValueOnce(query(1));

      await trackTransitions.markOnProperty('job-l2', lateOpts());

      expect(setTechJobStatus).toHaveBeenCalledTimes(1);
      expect(setTechJobStatus).toHaveBeenCalledWith({
        tech_id: 'tech-late',
        status: 'on_site',
        current_job_id: 'job-l2',
        ifCurrentJobId: 'job-l2',
      });
    });

    test('a technician who moved on is left alone: the conditional write changes nothing, the arrival stands', async () => {
      setTechJobStatus.mockResolvedValueOnce(null);
      db
        .mockReturnValueOnce(query(lateSvc('job-l3')))
        .mockReturnValueOnce(query(1));

      const result = await trackTransitions.markOnProperty('job-l3', lateOpts());

      expect(result).toMatchObject({ ok: true, state: 'on_property' });
      expect(setTechJobStatus.mock.calls[0][0]).toHaveProperty('ifCurrentJobId', 'job-l3');
    });

    test('the flip is pinned to the validated attempt: its en_route_at and the technician', async () => {
      const update = query(1);
      db
        .mockReturnValueOnce(query(lateSvc('job-l4')))
        .mockReturnValueOnce(update);

      await trackTransitions.markOnProperty('job-l4', lateOpts());

      expect(update.where).toHaveBeenCalledWith('technician_id', 'tech-late');
      expect(update.whereRaw).toHaveBeenCalledWith(expect.stringContaining('date_trunc'), ['en_route_at', enRouteAt]);
      expect(update.whereNull).toHaveBeenCalledWith('arrived_at');
    });

    test.each([
      ['restarted since the lookup (a new en_route_at)', { en_route_at: new Date(Date.now() - 5 * 60 * 1000) }, {}, 'attempt_changed'],
      ['rescheduled to another day since the lookup', { scheduled_date: '2026-10-02' }, {}, 'attempt_changed'],
      ['rewound to scheduled (en_route_at cleared)', { en_route_at: null, track_state: 'scheduled' }, {}, 'attempt_changed'],
      ['a grouped stop', { visit_id: 'visit-9' }, {}, 'late_arrival_grouped_stop'],
      ['an arrival instant in the future', {}, { at: new Date(Date.now() + 60 * 60 * 1000) }, 'late_arrival_time_invalid'],
      ['an unreadable arrival instant', {}, { at: 'not a time' }, 'late_arrival_time_invalid'],
      // en route the day BEFORE its scheduled day: a stale attempt a late sample never repairs
      ['a stale attempt', { en_route_at: new Date('2026-09-30T15:00:00Z') }, { enRouteAt: new Date('2026-09-30T15:00:00Z') }, 'stale_attempt'],
    ])('refuses %s before any write', async (_label, rowOverrides, lateOverrides, reason) => {
      db.mockReturnValueOnce(query(lateSvc('job-lr', rowOverrides)));

      const result = await trackTransitions.markOnProperty('job-lr', lateOpts(lateOverrides));

      expect(result).toEqual({ ok: false, reason });
      expect(db).toHaveBeenCalledTimes(1);
      expect(db.transaction).not.toHaveBeenCalled();
      expect(setTechJobStatus).not.toHaveBeenCalled();
      expect(transitionJobStatus).not.toHaveBeenCalled();
    });

    // What another signal leaves when it wins the flip with the guard open (a geofence drive-past).
    const onPropertyOpenGuard = (svc) => ({
      ...svc, track_state: 'on_property', status: 'on_site', arrived_at: new Date(), actual_start_time: new Date(), check_in_time: new Date(),
    });

    test('losing the flip to a signal that left the guard open: the late arrival stamps it, so a later signal cannot text', async () => {
      const svc = lateSvc('job-l5');
      const winner = onPropertyOpenGuard(svc);
      const stamp = query(1);
      db
        .mockReturnValueOnce(query(svc)) // load
        .mockReturnValueOnce(query(0)) // the flip is lost
        .mockReturnValueOnce(query(winner)) // fresh reload: on property, guard open
        .mockReturnValueOnce(stamp); // the late arrival's guard stamp

      const result = await trackTransitions.markOnProperty('job-l5', lateOpts());

      expect(result).toMatchObject({ ok: true, state: 'on_property' });
      expect(setTechJobStatus).toHaveBeenCalledWith(expect.objectContaining({ ifCurrentJobId: 'job-l5' }));
      // fenced to the visit on property, its day, the validated en-route attempt and the arrival it saw; open guard only
      expect(stamp.where).toHaveBeenCalledWith({ id: 'job-l5', track_state: 'on_property', scheduled_date: '2026-10-01' });
      expect(stamp.whereNull).toHaveBeenCalledWith('arrival_sms_sent_at');
      expect(stamp.whereRaw).toHaveBeenCalledWith(expect.stringContaining('en_route_at'), [enRouteAt]);
      expect(stamp.whereRaw).toHaveBeenCalledWith(expect.stringContaining('arrived_at'), [winner.arrived_at]);
      expect(stamp.update).toHaveBeenCalledWith({ arrival_sms_sent_at: expect.any(Date) });
      expect(sendTechArrived).not.toHaveBeenCalled();

      // The next real signal (a manual start) reads the row as the stamp left it and sends nothing.
      db.mockReturnValueOnce(query({ ...winner, arrival_sms_sent_at: stamp.update.mock.calls[0][0].arrival_sms_sent_at }));
      const next = await trackTransitions.markOnProperty('job-l5', { actingTechId: 'tech-late' });
      expect(next).toMatchObject({ ok: true, state: 'on_property', arrivalSms: 'already_handled' });
      expect(sendTechArrived).not.toHaveBeenCalled();
    });

    test('finding the visit already on property with the guard open (another signal won before the load): it stamps it too', async () => {
      const stamp = query(1);
      db
        .mockReturnValueOnce(query(onPropertyOpenGuard(lateSvc('job-l6')))) // load: already on property
        .mockReturnValueOnce(stamp);

      const result = await trackTransitions.markOnProperty('job-l6', lateOpts());

      expect(result).toMatchObject({ ok: true, state: 'on_property' });
      expect(stamp.update).toHaveBeenCalledWith({ arrival_sms_sent_at: expect.any(Date) });
      expect(setTechJobStatus).toHaveBeenCalledWith(expect.objectContaining({ ifCurrentJobId: 'job-l6' }));
      expect(sendTechArrived).not.toHaveBeenCalled();
    });

    test('a guard another signal already claimed is left as it is', async () => {
      const svc = lateSvc('job-l7');
      db
        .mockReturnValueOnce(query(svc))
        .mockReturnValueOnce(query(0))
        .mockReturnValueOnce(query({ ...onPropertyOpenGuard(svc), arrival_sms_sent_at: new Date() }));

      const result = await trackTransitions.markOnProperty('job-l7', lateOpts());

      expect(result).toMatchObject({ ok: true, state: 'on_property' });
      // load, lost flip, reload: no stamp write
      expect(db).toHaveBeenCalledTimes(3);
    });

    test('without lateArrival an arrival is unchanged: stamped now, guard left to the sender, plain board write', async () => {
      const before = Date.now();
      const update = query(1);
      // no en_route_at: a late arrival would be refused, an ordinary one is not fenced
      db
        .mockReturnValueOnce(query(lateSvc('job-live', { en_route_at: null })))
        .mockReturnValueOnce(update);

      const result = await trackTransitions.markOnProperty('job-live', { suppressArrivalSms: true });

      expect(result).toMatchObject({ ok: true, state: 'on_property' });
      const payload = update.update.mock.calls[0][0];
      expect(payload).not.toHaveProperty('arrival_sms_sent_at');
      expect(payload.arrived_at.getTime()).toBeGreaterThanOrEqual(before);
      expect(result.arrivedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(setTechJobStatus.mock.calls[0][0]).toStrictEqual({ tech_id: 'tech-late', status: 'on_site', current_job_id: 'job-live' });
    });
  });

  test('markOnProperty race-loser still sends the arrival SMS when the flip-winner suppressed it', async () => {
    // A geofence drive-past wins the scheduled->on_property flip with
    // suppressArrivalSms, leaving the guard NULL. A real (non-suppressed)
    // arrival for the same job loses the conditional flip (0 rows) — it must
    // still claim and send rather than returning on the stale "winner owns it"
    // assumption.
    const svc = {
      id: 'job-l',
      customer_id: 'cust-l',
      technician_id: 'tech-l',
      status: 'confirmed',
      track_state: 'scheduled', // loaded before the winner flipped it
      cancelled_at: null,
      arrival_sms_sent_at: null,
    };
    const fresh = {
      ...svc,
      track_state: 'on_property', // winner already flipped it
      arrival_sms_sent_at: null, // winner suppressed, so guard is still open
    };
    sendTechArrived.mockResolvedValue({ success: true });
    const claim = query(1);
    db
      .mockReturnValueOnce(query(svc)) // loadService
      .mockReturnValueOnce(query(0)) // conditional flip loses the race
      .mockReturnValueOnce(query(fresh)) // fresh reload in the race-loser branch
      .mockReturnValueOnce(claim) // atomic claim succeeds (winner left it NULL)
      .mockReturnValueOnce(query({ name: 'Lee' })); // technician name lookup

    const result = await trackTransitions.markOnProperty('job-l');

    expect(result.ok).toBe(true);
    expect(sendTechArrived).toHaveBeenCalledWith('cust-l', 'Lee', expect.objectContaining({ scheduledServiceId: 'job-l' }));
    expect(claim.whereNull).toHaveBeenCalledWith('arrival_sms_sent_at');
  });

  test('markOnProperty race-loser does NOT send when it is itself the suppressed signal', async () => {
    const svc = {
      id: 'job-ls',
      customer_id: 'cust-ls',
      technician_id: 'tech-ls',
      status: 'confirmed',
      track_state: 'scheduled',
      cancelled_at: null,
      arrival_sms_sent_at: null,
    };
    const fresh = { ...svc, track_state: 'on_property', arrival_sms_sent_at: null };
    db
      .mockReturnValueOnce(query(svc)) // loadService
      .mockReturnValueOnce(query(0)) // conditional flip loses the race
      .mockReturnValueOnce(query(fresh)); // fresh reload — no claim/send follows

    const result = await trackTransitions.markOnProperty('job-ls', { suppressArrivalSms: true });

    expect(result.ok).toBe(true);
    expect(sendTechArrived).not.toHaveBeenCalled();
  });

  test('markOnProperty does not re-send the arrival SMS when already stamped', async () => {
    const svc = {
      id: 'job-7',
      customer_id: 'cust-7',
      technician_id: 'tech-7',
      status: 'confirmed',
      track_state: 'scheduled',
      cancelled_at: null,
      arrival_sms_sent_at: new Date(),
    };
    db
      .mockReturnValueOnce(query(svc))
      .mockReturnValueOnce(query(1));

    const result = await trackTransitions.markOnProperty('job-7');

    expect(result.ok).toBe(true);
    expect(sendTechArrived).not.toHaveBeenCalled();
  });

  test('markOnProperty stamps the guard but sends nothing when the gate is off', async () => {
    // Post-deploy dark state: the arrival flips the tracker, the gate is off.
    // Claim the guard anyway (mark handled) so a same-job retap AFTER the gate
    // is enabled can't fire a stale "has arrived" for this already-past arrival.
    isEnabled.mockReturnValueOnce(false);
    const svc = {
      id: 'job-8',
      customer_id: 'cust-8',
      technician_id: 'tech-8',
      status: 'confirmed',
      track_state: 'scheduled',
      cancelled_at: null,
      arrival_sms_sent_at: null,
    };
    const claim = query(1);
    db
      .mockReturnValueOnce(query(svc)) // loadService
      .mockReturnValueOnce(query(1)) // flip
      .mockReturnValueOnce(claim); // claim — guard stamped, then gate-off returns

    const result = await trackTransitions.markOnProperty('job-8');

    expect(result.ok).toBe(true);
    // Guard claimed (NULL -> now) so a later gate-on retap is a no-op...
    expect(claim.whereNull).toHaveBeenCalledWith('arrival_sms_sent_at');
    expect(claim.update).toHaveBeenCalledWith({ arrival_sms_sent_at: expect.any(Date) });
    // ...but nothing goes out, and the claim is NOT released (no failed send to
    // retry — the feature is simply off).
    expect(sendTechArrived).not.toHaveBeenCalled();
    expect(claim.update).toHaveBeenCalledTimes(1);
  });

  test('markOnProperty retries the arrival SMS on a later on-site signal when the first send failed', async () => {
    const svc = {
      id: 'job-r',
      customer_id: 'cust-r',
      technician_id: 'tech-r',
      status: 'on_site', // syncOperationalStatus is a no-op (already in status)
      track_state: 'on_property', // already flipped — takes the idempotent branch
      cancelled_at: null,
      // lifecycle fields present so buildOnSiteLifecycleUpdates returns {}
      actual_start_time: new Date(),
      check_in_time: new Date(),
      arrived_at: new Date(),
      arrival_sms_sent_at: null, // prior send failed — should retry, not be dropped
    };
    sendTechArrived.mockResolvedValue({ success: true });
    const claim = query(1);
    db
      .mockReturnValueOnce(query(svc)) // loadService
      .mockReturnValueOnce(claim) // atomic claim of arrival_sms_sent_at
      .mockReturnValueOnce(query({ name: 'Casey' })); // technician name lookup

    const result = await trackTransitions.markOnProperty('job-r');

    expect(result.ok).toBe(true);
    expect(result.state).toBe('on_property');
    expect(sendTechArrived).toHaveBeenCalledWith('cust-r', 'Casey', expect.objectContaining({ scheduledServiceId: 'job-r' }));
    expect(claim.update).toHaveBeenCalledWith({
      arrival_sms_sent_at: expect.any(Date),
    });
  });

  test('markComplete writes end aliases and duration from the captured start time', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-15T14:45:00.000Z'));
    const start = new Date('2026-05-15T14:00:00.000Z');
    const svc = {
      id: 'job-3',
      technician_id: 'tech-3',
      track_state: 'on_property',
      actual_start_time: start,
      check_in_time: start,
      arrived_at: start,
    };
    const update = query(1);
    db
      .mockReturnValueOnce(query(svc))
      .mockReturnValueOnce(update);

    const result = await trackTransitions.markComplete('job-3');

    expect(result.ok).toBe(true);
    expect(result.state).toBe('complete');
    expect(update.whereIn).toHaveBeenCalledWith('track_state', ['scheduled', 'en_route', 'on_property']);
    expect(update.update.mock.calls[0][0]).toMatchObject({
      track_state: 'complete',
      completed_at: new Date('2026-05-15T14:45:00.000Z'),
      actual_end_time: new Date('2026-05-15T14:45:00.000Z'),
      check_out_time: new Date('2026-05-15T14:45:00.000Z'),
      service_time_minutes: 45,
      actual_duration_minutes: 45,
    });
    expect(clearTechCurrentJob).toHaveBeenCalledWith({
      tech_id: 'tech-3',
      current_job_id: 'job-3',
      status: 'idle',
    });
  });

  test('markComplete emits a customer refresh after the tracker state flips', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-15T14:45:00.000Z'));
    const emit = jest.fn();
    const to = jest.fn(() => ({ emit }));
    getIo.mockReturnValue({ to });
    const svc = {
      id: 'job-4',
      customer_id: 'cust-4',
      technician_id: 'tech-4',
      track_state: 'on_property',
    };
    db
      .mockReturnValueOnce(query(svc))
      .mockReturnValueOnce(query(1));

    const result = await trackTransitions.markComplete('job-4');

    expect(result.ok).toBe(true);
    expect(to).toHaveBeenCalledWith('customer:cust-4');
    expect(emit).toHaveBeenCalledWith('customer:job_update', {
      job_id: 'job-4',
      status: 'completed',
      eta: null,
      tech_id: 'tech-4',
      tech_first_name: null,
      updated_at: new Date('2026-05-15T14:45:00.000Z'),
    });
  });

  test('markComplete under untrustedLifecycleSpan with NO completedAt writes track_state/updated_at ONLY (defensive no-instant contract)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-19T16:00:00.000Z'));
    // The tracker's contract when the caller supplies no instant: write
    // NOTHING to completed_at — never a wall-clock fallback. (Since PR
    // #2897 fix round 9 the backfill route derives an instant for EVERY
    // shape — ET noon of the service day when the end is not operator-
    // stated, so Billing Recovery's completed_at window sees the visit —
    // but the tracker keeps this leg fail-safe: a null/invalid
    // opts.completedAt must not resurrect the wall-clock stamp that fed
    // the closeout date into pricing-reality-check's lookback COALESCE
    // and its minutesBetween(arrived_at, completed_at) fallback, Codex
    // P2 fix round 4.) The default rebuild would also stamp today's end
    // aliases and book the stale-start→now gap (weeks) as
    // service_time_minutes — equally suppressed under the flag.
    const staleStart = new Date('2026-06-20T14:00:00.000Z');
    const svc = {
      id: 'job-bf',
      technician_id: 'tech-bf',
      track_state: 'on_property',
      actual_start_time: staleStart,
      check_in_time: staleStart,
      arrived_at: staleStart,
      actual_end_time: null,
      check_out_time: null,
      service_time_minutes: null,
      actual_duration_minutes: null,
    };
    const update = query(1);
    db
      .mockReturnValueOnce(query(svc))
      .mockReturnValueOnce(update);

    const result = await trackTransitions.markComplete('job-bf', {
      actorType: 'admin',
      actorId: 'admin-1',
      untrustedLifecycleSpan: true,
    });

    expect(result.ok).toBe(true);
    expect(result.state).toBe('complete');
    expect(result.completedAt).toBeNull();
    const payload = update.update.mock.calls[0][0];
    // The tracker's own bookkeeping still lands…
    expect(payload).toMatchObject({
      track_state: 'complete',
      updated_at: new Date('2026-07-19T16:00:00.000Z'),
    });
    // …and NOTHING else: no completed_at completing the stale pair, no
    // today end stamps, no weeks-long duration for the costing guard, no
    // start rewrites.
    expect(Object.keys(payload).sort()).toEqual(['track_state', 'updated_at']);
    // Non-duration side effects are untouched by the flag.
    expect(clearTechCurrentJob).toHaveBeenCalledWith({
      tech_id: 'tech-bf',
      current_job_id: 'job-bf',
      status: 'idle',
    });
  });

  test('markComplete under the flag stamps completed_at from the caller-backdated instant — never the wall clock', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-19T16:00:00.000Z'));
    // The kept-end backfill shape: admin-dispatch derives the service-day
    // end instant (backfillCompletionEndInstant) and passes it through, so
    // the termite-bond sync, pricing-reality-check's window/month, and
    // billing recovery all see the visit's day — not the closeout day.
    const backdated = new Date('2026-06-20T14:45:00.000Z');
    const svc = {
      id: 'job-bd',
      technician_id: 'tech-bd',
      track_state: 'on_property',
      actual_start_time: new Date('2026-06-20T14:00:00.000Z'),
      service_time_minutes: 45,
      actual_duration_minutes: 45,
    };
    const update = query(1);
    db
      .mockReturnValueOnce(query(svc))
      .mockReturnValueOnce(update);

    const result = await trackTransitions.markComplete('job-bd', {
      untrustedLifecycleSpan: true,
      completedAt: backdated,
    });

    expect(result.ok).toBe(true);
    expect(result.completedAt).toEqual(backdated);
    const payload = update.update.mock.calls[0][0];
    expect(payload.completed_at).toEqual(backdated);
    // updated_at stays the real wall clock — it is row bookkeeping.
    expect(payload.updated_at).toEqual(new Date('2026-07-19T16:00:00.000Z'));
    expect(Object.keys(payload).sort()).toEqual(['completed_at', 'track_state', 'updated_at']);
  });

  test('markComplete under the flag never overwrites a typed backfill duration either', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-19T16:00:00.000Z'));
    // The operator typed 45 and the policy already persisted it in the
    // completion transaction — the tracker must not echo or re-derive it.
    const svc = {
      id: 'job-bt',
      technician_id: 'tech-bt',
      track_state: 'on_property',
      actual_start_time: new Date('2026-06-20T14:00:00.000Z'),
      service_time_minutes: 45,
      actual_duration_minutes: 45,
    };
    const update = query(1);
    db
      .mockReturnValueOnce(query(svc))
      .mockReturnValueOnce(update);

    const result = await trackTransitions.markComplete('job-bt', { untrustedLifecycleSpan: true });

    expect(result.ok).toBe(true);
    const payload = update.update.mock.calls[0][0];
    expect(payload).not.toHaveProperty('service_time_minutes');
    expect(payload).not.toHaveProperty('actual_duration_minutes');
    expect(payload).not.toHaveProperty('actual_end_time');
    expect(payload).not.toHaveProperty('check_out_time');
    expect(payload).not.toHaveProperty('completed_at');
  });

  test('markComplete WITHOUT the flag honors an explicit completedAt, wall clock only as fallback', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-19T16:00:00.000Z'));
    // Contract updated for the live admin time-on-site override (codex P2
    // #3152 round 11): a trusted caller that EXPLICITLY passes a finite
    // instant gets it stamped (the corrected end must reach completed_at so
    // date-window readers attribute the visit to the corrected day); every
    // caller that passes none keeps the wall clock exactly as before, so no
    // live caller shifts completed_at by accident.
    const svc = {
      id: 'job-nf',
      technician_id: 'tech-nf',
      track_state: 'on_property',
      actual_start_time: new Date('2026-07-19T15:00:00.000Z'),
    };
    const update = query(1);
    db
      .mockReturnValueOnce(query(svc))
      .mockReturnValueOnce(update);

    const result = await trackTransitions.markComplete('job-nf', {
      completedAt: new Date('2026-07-19T15:45:00.000Z'),
    });

    expect(result.ok).toBe(true);
    const payload = update.update.mock.calls[0][0];
    expect(payload.completed_at).toEqual(new Date('2026-07-19T15:45:00.000Z'));

    // No completedAt (every pre-existing live caller) → wall clock.
    const svc2 = { ...svc, id: 'job-nf2' };
    const update2 = query(1);
    db
      .mockReturnValueOnce(query(svc2))
      .mockReturnValueOnce(update2);
    const result2 = await trackTransitions.markComplete('job-nf2', {});
    expect(result2.ok).toBe(true);
    const payload2 = update2.update.mock.calls[0][0];
    expect(payload2.completed_at).toEqual(new Date('2026-07-19T16:00:00.000Z'));
  });

  test('markComplete re-emits refresh when already complete', async () => {
    const completedAt = new Date('2026-05-15T14:30:00.000Z');
    const emit = jest.fn();
    const to = jest.fn(() => ({ emit }));
    getIo.mockReturnValue({ to });
    db.mockReturnValueOnce(query({
      id: 'job-5',
      customer_id: 'cust-5',
      technician_id: 'tech-5',
      track_state: 'complete',
      completed_at: completedAt,
    }));

    const result = await trackTransitions.markComplete('job-5');

    expect(result).toEqual({ ok: true, state: 'complete', completedAt });
    expect(clearTechCurrentJob).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('customer:job_update', expect.objectContaining({
      job_id: 'job-5',
      status: 'completed',
      updated_at: completedAt,
    }));
  });

  test('the first transition leaves completed_at alone when a newer correction owns it (codex P2 #3152 round 15)', async () => {
    // Completion trx committed, track_state still on_property, and a
    // correction landed in between: the row's stamp (60) no longer matches
    // this caller's expectation (null — a plain timer completion), so the
    // transition must not stamp `now` over the correction's completed_at.
    jest.useFakeTimers().setSystemTime(new Date('2026-07-19T16:00:00.000Z'));
    const svc = {
      id: 'job-f15',
      technician_id: 'tech-f15',
      track_state: 'on_property',
      actual_start_time: new Date('2026-07-19T12:00:00.000Z'),
      actual_end_time: new Date('2026-07-19T13:00:00.000Z'),
      completed_at: new Date('2026-07-19T13:00:00.000Z'),
      time_on_site_adjusted_minutes: 60,
      time_on_site_correction_seq: 1,
    };
    const update = query(1);
    db
      .mockReturnValueOnce(query(svc))
      .mockReturnValueOnce(update);

    const result = await trackTransitions.markComplete('job-f15', { expectedCorrectionSeq: null });

    expect(result.ok).toBe(true);
    const payload = update.update.mock.calls[0][0];
    expect(payload).not.toHaveProperty('completed_at');
    expect(payload.track_state).toBe('complete');

    // Matching expectation (the correction's own follow-up) still stamps.
    const svcMatch = { ...svc, id: 'job-f15b' };
    const update2 = query(1);
    db
      .mockReturnValueOnce(query(svcMatch))
      .mockReturnValueOnce(update2);
    const result2 = await trackTransitions.markComplete('job-f15b', {
      expectedCorrectionSeq: 1,
      completedAt: new Date('2026-07-19T13:00:00.000Z'),
    });
    expect(result2.ok).toBe(true);
    expect(update2.update.mock.calls[0][0].completed_at).toEqual(new Date('2026-07-19T13:00:00.000Z'));
  });

  test('a mismatched in-memory stamp degrades to a transition-only flip — no lifecycle rewrite (codex P2 #3152 round 16)', async () => {
    // Round 15 fenced completed_at; round 16 extends the fence to the
    // correction-owned lifecycle columns: a stale finalizer must not rebuild
    // end/duration fields from its snapshot over a newer correction.
    jest.useFakeTimers().setSystemTime(new Date('2026-07-19T16:00:00.000Z'));
    const svc = {
      id: 'job-f16a',
      technician_id: 'tech-f16a',
      track_state: 'on_property',
      actual_start_time: new Date('2026-07-19T12:00:00.000Z'),
      actual_end_time: new Date('2026-07-19T13:00:00.000Z'),
      completed_at: new Date('2026-07-19T13:00:00.000Z'),
      time_on_site_adjusted_minutes: 45,
      time_on_site_correction_seq: 2,
    };
    const update = query(1);
    db
      .mockReturnValueOnce(query(svc))
      .mockReturnValueOnce(update);

    // Same minutes value (45) as the caller expects — only the monotonic
    // seq betrays the newer re-save (codex P2 round 17).
    const result = await trackTransitions.markComplete('job-f16a', { expectedCorrectionSeq: 1 });

    expect(result.ok).toBe(true);
    expect(result.completedAt).toBeNull();
    expect(Object.keys(update.update.mock.calls[0][0]).sort()).toEqual(['track_state', 'updated_at']);
  });

  test('the first-transition stamp fence is atomic: a fenced 0-row write retries transition-only (codex P2 #3152 round 16)', async () => {
    // The in-memory stamp matches the caller, but a correction commits
    // between the load and the UPDATE — the fenced write matches 0 rows.
    // The retry flips track_state without touching completed_at or the
    // lifecycle columns the correction now owns.
    jest.useFakeTimers().setSystemTime(new Date('2026-07-19T16:00:00.000Z'));
    const svc = {
      id: 'job-f16b',
      technician_id: 'tech-f16b',
      track_state: 'on_property',
      actual_start_time: new Date('2026-07-19T12:00:00.000Z'),
      time_on_site_adjusted_minutes: 45,
      time_on_site_correction_seq: 1,
    };
    const fencedUpdate = query(0);
    const retryUpdate = query(1);
    db
      .mockReturnValueOnce(query(svc))
      .mockReturnValueOnce(fencedUpdate)
      .mockReturnValueOnce(retryUpdate);

    const result = await trackTransitions.markComplete('job-f16b', {
      expectedCorrectionSeq: 1,
      completedAt: new Date('2026-07-19T12:45:00.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.completedAt).toBeNull();
    // The first write carried the atomic revision predicate (seq, not the
    // minutes value — codex P2 round 17).
    expect(fencedUpdate.whereRaw).toHaveBeenCalledWith(
      'time_on_site_correction_seq IS NOT DISTINCT FROM ?', [1],
    );
    // The retry wrote only the flip.
    expect(Object.keys(retryUpdate.update.mock.calls[0][0]).sort()).toEqual(['track_state', 'updated_at']);
  });

  test('the fence is ON for callers with no stated revision — status-route completions are protected too (codex P2 #3152 round 18)', async () => {
    // Ordinary PUT /:id/status completions pass no expectedCorrectionSeq,
    // but their loadService→UPDATE window races the correction PATCH all
    // the same. With no stated revision the fence uses the seq observed at
    // load: a correction committing inside the window turns the stale full
    // lifecycle write into the transition-only retry.
    jest.useFakeTimers().setSystemTime(new Date('2026-07-19T16:00:00.000Z'));
    // Never corrected (seq null): the default fence predicates on null and
    // the full lifecycle write runs — a correction committing mid-window
    // bumps the seq and the fenced write misses. (Any PRE-EXISTING revision
    // now degrades to transition-only up front — codex round 26 — so the
    // fenced-full-write path is exclusively the never-corrected shape.)
    const svc = {
      id: 'job-f18',
      technician_id: 'tech-f18',
      track_state: 'on_property',
      actual_start_time: new Date('2026-07-19T12:00:00.000Z'),
      time_on_site_correction_seq: null,
    };
    const fencedUpdate = query(0);
    const retryUpdate = query(1);
    db
      .mockReturnValueOnce(query(svc))
      .mockReturnValueOnce(fencedUpdate)
      .mockReturnValueOnce(retryUpdate);

    const result = await trackTransitions.markComplete('job-f18', {});

    expect(result.ok).toBe(true);
    expect(result.completedAt).toBeNull();
    expect(fencedUpdate.whereRaw).toHaveBeenCalledWith(
      'time_on_site_correction_seq IS NOT DISTINCT FROM ?', [null],
    );
    expect(Object.keys(retryUpdate.update.mock.calls[0][0]).sort()).toEqual(['track_state', 'updated_at']);

    // Un-raced default caller: the fenced write matches and the full
    // lifecycle update lands exactly as before.
    const svc2 = { ...svc, id: 'job-f18b' };
    const update2 = query(1);
    db
      .mockReturnValueOnce(query(svc2))
      .mockReturnValueOnce(update2);
    const result2 = await trackTransitions.markComplete('job-f18b', {});
    expect(result2.ok).toBe(true);
    expect(update2.whereRaw).toHaveBeenCalledWith(
      'time_on_site_correction_seq IS NOT DISTINCT FROM ?', [null],
    );
    expect(update2.update.mock.calls[0][0].completed_at).toEqual(new Date('2026-07-19T16:00:00.000Z'));
  });

  test('a prior correction WITHOUT a completed_at still owns the lifecycle — transition-only (codex P2 #3152 round 26)', async () => {
    // Clamped/no-start corrections bump the seq while deliberately
    // stamping NO end (unknown-end posture). A status-route completion
    // must not pair wall-clock end stamps with that corrected duration.
    jest.useFakeTimers().setSystemTime(new Date('2026-07-19T16:00:00.000Z'));
    const svc = {
      id: 'job-f26',
      technician_id: 'tech-f26',
      track_state: 'on_property',
      actual_start_time: new Date('2026-07-19T12:00:00.000Z'),
      time_on_site_adjusted_minutes: 720,
      time_on_site_correction_seq: 1,
      completed_at: null,
    };
    const update = query(1);
    db
      .mockReturnValueOnce(query(svc))
      .mockReturnValueOnce(update);

    const result = await trackTransitions.markComplete('job-f26', {});

    expect(result.ok).toBe(true);
    expect(result.completedAt).toBeNull();
    expect(Object.keys(update.update.mock.calls[0][0]).sort()).toEqual(['track_state', 'updated_at']);
  });

  test('a correction that committed BEFORE the load owns completed_at — the flip is transition-only (codex P2 #3152 round 20)', async () => {
    // Unclosed-timer flow: the admin corrected the running timer (the PATCH
    // stamped seq 1 and the derived completed_at), then the tech completes
    // through the status route with no stated revision. The seq predicate
    // only sees post-load movement, so this pre-load correction must be
    // preserved by inspection: no `now` over the corrected instant, no
    // lifecycle rebuild over the corrected columns.
    jest.useFakeTimers().setSystemTime(new Date('2026-07-19T16:00:00.000Z'));
    const svc = {
      id: 'job-f20',
      technician_id: 'tech-f20',
      track_state: 'on_property',
      actual_start_time: new Date('2026-07-19T12:00:00.000Z'),
      actual_end_time: new Date('2026-07-19T12:45:00.000Z'),
      completed_at: new Date('2026-07-19T12:45:00.000Z'),
      time_on_site_adjusted_minutes: 45,
      time_on_site_correction_seq: 1,
    };
    const update = query(1);
    db
      .mockReturnValueOnce(query(svc))
      .mockReturnValueOnce(update);

    const result = await trackTransitions.markComplete('job-f20', {});

    expect(result.ok).toBe(true);
    expect(result.completedAt).toBeNull();
    expect(Object.keys(update.update.mock.calls[0][0]).sort()).toEqual(['track_state', 'updated_at']);
  });

  test('a fenced 0-row write whose retry also matches 0 rows reloads instead of guessing (codex P2 #3152 round 16)', async () => {
    // Both writes miss → the state (not the stamp) moved: another writer
    // completed the visit. Report the fresh row, write nothing.
    const svc = {
      id: 'job-f16c',
      technician_id: 'tech-f16c',
      track_state: 'on_property',
      actual_start_time: new Date('2026-07-19T12:00:00.000Z'),
      time_on_site_adjusted_minutes: 45,
      time_on_site_correction_seq: 1,
    };
    const freshCompletedAt = new Date('2026-07-19T13:10:00.000Z');
    db
      .mockReturnValueOnce(query(svc))
      .mockReturnValueOnce(query(0))
      .mockReturnValueOnce(query(0))
      .mockReturnValueOnce(query({ ...svc, track_state: 'complete', completed_at: freshCompletedAt }));

    const result = await trackTransitions.markComplete('job-f16c', { expectedCorrectionSeq: 1 });

    expect(result).toEqual({ ok: true, state: 'complete', completedAt: freshCompletedAt });
    expect(clearTechCurrentJob).not.toHaveBeenCalled();
  });

  test('already-complete + a supplied finite instant still moves completed_at (codex P2 #3152 round 12)', async () => {
    // The status-route-first shape: the visit was marked completed earlier
    // (tracker stamped the wall clock), then the completion flow finalizes
    // it with a live time correction — the corrected end must land even
    // though the early return skips the transition update.
    const staleCompletedAt = new Date('2026-05-15T14:30:00.000Z');
    const correctedAt = new Date('2026-05-15T12:45:00.000Z');
    const emit = jest.fn();
    const to = jest.fn(() => ({ emit }));
    getIo.mockReturnValue({ to });
    const update = query(1);
    db
      .mockReturnValueOnce(query({
        id: 'job-6',
        customer_id: 'cust-6',
        technician_id: 'tech-6',
        track_state: 'complete',
        completed_at: staleCompletedAt,
      }))
      .mockReturnValueOnce(update);

    const result = await trackTransitions.markComplete('job-6', { completedAt: correctedAt });

    expect(result).toEqual({ ok: true, state: 'complete', completedAt: correctedAt });
    expect(update.update.mock.calls[0][0].completed_at).toEqual(correctedAt);
    // Same supplied instant on a retry → no second write (idempotent).
    db.mockReturnValueOnce(query({
      id: 'job-6',
      customer_id: 'cust-6',
      technician_id: 'tech-6',
      track_state: 'complete',
      completed_at: correctedAt,
    }));
    const retry = await trackTransitions.markComplete('job-6', { completedAt: correctedAt });
    expect(retry).toEqual({ ok: true, state: 'complete', completedAt: correctedAt });
  });
});

describe('future-scheduled-date stale-attempt guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // The tracker flip runs in a transaction that locks the visit row (raw) and rechecks the street-level hold.
    db.raw = jest.fn(async () => ({ rows: [] }));
    db.transaction = jest.fn(async (fn) => fn(db));
    transitionJobStatus.mockReset().mockResolvedValue({});
    getIo.mockReturnValue(socketStub());
    jest.useRealTimers();
  });

  // Fixed far-future / far-past dates keep these deterministic against
  // the real ET clock.
  const FUTURE = '2099-01-01';
  const PAST = '2000-01-01';

  function futureSvc(extra = {}) {
    return {
      id: 'job-9',
      customer_id: 'cust-9',
      technician_id: 'tech-9',
      status: 'confirmed',
      track_state: 'scheduled',
      scheduled_date: FUTURE,
      track_view_token: 'a'.repeat(64),
      cancelled_at: null,
      ...extra,
    };
  }

  test('isFutureScheduledDate discriminates future ET days only', () => {
    expect(trackTransitions.isFutureScheduledDate(FUTURE)).toBe(true);
    expect(trackTransitions.isFutureScheduledDate(new Date(`${FUTURE}T12:00:00Z`))).toBe(true);
    expect(trackTransitions.isFutureScheduledDate(PAST)).toBe(false);
    expect(trackTransitions.isFutureScheduledDate(null)).toBe(false);
    expect(trackTransitions.isFutureScheduledDate(undefined)).toBe(false);
  });

  test('markEnRoute refuses a future-dated job (stale tap / geofence)', async () => {
    db.mockReturnValueOnce(query(futureSvc()));

    const result = await trackTransitions.markEnRoute('job-9');

    expect(result).toEqual({ ok: false, reason: 'future_scheduled_date' });
    expect(setTechJobStatus).not.toHaveBeenCalled();
    expect(transitionJobStatus).not.toHaveBeenCalled();
  });

  test('markOnProperty refuses a future-dated job', async () => {
    db.mockReturnValueOnce(query(futureSvc()));

    const result = await trackTransitions.markOnProperty('job-9');

    expect(result).toEqual({ ok: false, reason: 'future_scheduled_date' });
    expect(setTechJobStatus).not.toHaveBeenCalled();
    expect(transitionJobStatus).not.toHaveBeenCalled();
  });

  test('markOnProperty / markEnRoute skip a live street-level hold: no state change, no throw, no write', async () => {
    const { isStreetLevelHoldVisit } = require('../services/street-level-hold');
    isStreetLevelHoldVisit.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    db.mockReturnValueOnce(query(futureSvc({ scheduled_date: '2020-01-01' }))).mockReturnValueOnce(query(futureSvc({ scheduled_date: '2020-01-01' })));
    expect(await trackTransitions.markOnProperty('job-9')).toEqual({ ok: false, reason: 'street_level_hold' });
    expect(await trackTransitions.markEnRoute('job-9')).toEqual({ ok: false, reason: 'street_level_hold' });
    expect(setTechJobStatus).not.toHaveBeenCalled();
    expect(transitionJobStatus).not.toHaveBeenCalled();
  });

  test('markComplete refuses a future-dated job', async () => {
    db.mockReturnValueOnce(query(futureSvc({ track_state: 'on_property' })));

    const result = await trackTransitions.markComplete('job-9');

    expect(result).toEqual({ ok: false, reason: 'future_scheduled_date' });
    expect(clearTechCurrentJob).not.toHaveBeenCalled();
  });

  test('markComplete allows a future-dated job with allowFutureDate (project closeout)', async () => {
    db
      .mockReturnValueOnce(query(futureSvc({ track_state: 'on_property' })))
      .mockReturnValueOnce(query(1));

    const result = await trackTransitions.markComplete('job-9', { allowFutureDate: true });

    expect(result.ok).toBe(true);
    expect(result.state).toBe('complete');
    expect(clearTechCurrentJob).toHaveBeenCalledWith(expect.objectContaining({
      tech_id: 'tech-9',
      current_job_id: 'job-9',
    }));
  });

  test('past-dated (overdue) jobs are not blocked', async () => {
    db
      .mockReturnValueOnce(query(futureSvc({ scheduled_date: PAST, track_state: 'on_property' })))
      .mockReturnValueOnce(query(1));

    const result = await trackTransitions.markComplete('job-9');

    expect(result.ok).toBe(true);
    expect(result.state).toBe('complete');
  });

  test('cancel cascades to the pending call-created follow-up child via transitionJobStatus', async () => {
    const svc = { id: 'job-1', customer_id: 'cust-1', technician_id: null, status: 'confirmed', track_state: 'scheduled' };
    const childrenSelect = {
      where: jest.fn().mockReturnThis(),
      whereRaw: jest.fn().mockReturnThis(),
      select: jest.fn().mockResolvedValue([{ id: 'child-1', status: 'pending' }]),
    };
    const trackingUpdate = query(1);
    const trx = jest.fn(() => trackingUpdate);
    db.transaction = jest.fn(async (callback) => callback(trx));
    db
      .mockReturnValueOnce(query(svc)) // loadService
      .mockReturnValueOnce(childrenSelect); // follow-up children lookup

    const result = await trackTransitions.cancel('job-1', { reason: 'customer moved' });

    expect(result.ok).toBe(true);
    expect(result.state).toBe('cancelled');
    // Cancel filter: the call-pipeline child while pending and never
    // customer-confirmed; the package child pending or confirmed whatever
    // the customer did — call-booking-catalog applyCallFollowUpCancelFilter.
    expect(childrenSelect.where).toHaveBeenCalledWith({ parent_service_id: 'job-1' });
    expect(childrenSelect.whereRaw).toHaveBeenCalledWith(
      "((source_action = ? AND status = 'pending' AND customer_confirmed = false) OR (source_action = ? AND status IN ('pending', 'confirmed', 'rescheduled')))",
      ['ai_call_pipeline_followup', 'package_followup_auto'],
    );
    // Status goes through the sole canonical writer (audit row + broadcast)
    // on the shared trx…
    expect(transitionJobStatus).toHaveBeenCalledWith(expect.objectContaining({
      jobId: 'job-1',
      fromStatus: 'confirmed',
      toStatus: 'cancelled',
      trx,
    }));
    expect(transitionJobStatus).toHaveBeenCalledWith(expect.objectContaining({
      jobId: 'child-1',
      fromStatus: 'pending',
      toStatus: 'cancelled',
      transitionedBy: null,
      trx,
    }));
    // …and the tracking columns ride the same trx (status itself is NOT
    // written directly here).
    expect(trackingUpdate.where).toHaveBeenCalledWith({ id: 'child-1' });
    expect(trackingUpdate.update.mock.calls.map(([payload]) => payload)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        track_state: 'cancelled',
        cancellation_reason: 'parent_call_booking_cancelled',
      }),
    ]));
    for (const [payload] of trackingUpdate.update.mock.calls) {
      expect(payload).not.toHaveProperty('status');
    }
  });

  test('a failed follow-up cascade is swallowed — the primary cancel still succeeds', async () => {
    const svc = { id: 'job-1', customer_id: 'cust-1', technician_id: null, status: 'confirmed', track_state: 'scheduled' };
    const childrenSelect = {
      where: jest.fn().mockReturnThis(),
      whereRaw: jest.fn().mockReturnThis(),
      select: jest.fn().mockResolvedValue([{ id: 'child-1', status: 'pending' }]),
    };
    db.transaction = jest.fn(async (callback) => callback(jest.fn(() => query(1))));
    transitionJobStatus.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('boom'));
    db
      .mockReturnValueOnce(query(svc))
      .mockReturnValueOnce(childrenSelect);

    const result = await trackTransitions.cancel('job-1', { reason: 'customer moved' });

    expect(result.ok).toBe(true);
    expect(result.state).toBe('cancelled');
  });

  test('an already-cancelled parent still cascades — a retry heals a cascade that died mid-flight', async () => {
    const cancelledAt = new Date('2026-07-01T15:00:00Z');
    const svc = { id: 'job-1', customer_id: 'cust-1', technician_id: null, status: 'cancelled', track_state: 'cancelled', cancelled_at: cancelledAt };
    const childrenSelect = {
      where: jest.fn().mockReturnThis(),
      whereRaw: jest.fn().mockReturnThis(),
      select: jest.fn().mockResolvedValue([{ id: 'child-1', status: 'pending' }]),
    };
    db.transaction = jest.fn(async (callback) => callback(jest.fn(() => query(1))));
    db
      .mockReturnValueOnce(query(svc)) // loadService — parent already cancelled, no update runs
      .mockReturnValueOnce(childrenSelect); // follow-up children lookup

    const result = await trackTransitions.cancel('job-1', { reason: 'retry' });

    expect(result.ok).toBe(true);
    expect(result.state).toBe('cancelled');
    expect(transitionJobStatus).toHaveBeenCalledWith(expect.objectContaining({
      jobId: 'child-1',
      toStatus: 'cancelled',
    }));
  });

  test('does not report success when legacy cancellation status repair rolls back', async () => {
    const svc = {
      id: 'job-1',
      customer_id: 'cust-1',
      technician_id: null,
      status: 'confirmed',
      track_state: 'cancelled',
      cancelled_at: new Date('2026-07-01T15:00:00Z'),
    };
    db.transaction = jest.fn(async (callback) => callback(jest.fn(() => query(1))));
    transitionJobStatus.mockRejectedValue(new Error('history insert failed'));
    db
      .mockReturnValueOnce(query(svc))
      .mockReturnValueOnce(query(svc));

    await expect(trackTransitions.cancel('job-1', { reason: 'retry' }))
      .rejects.toThrow('history insert failed');
  });

  test('a 0-row cancel race cascades when the parent ended cancelled', async () => {
    const svc = { id: 'job-1', customer_id: 'cust-1', technician_id: null, status: 'confirmed', track_state: 'scheduled' };
    const fresh = { ...svc, status: 'cancelled', track_state: 'cancelled', cancelled_at: new Date('2026-07-01T15:00:00Z') };
    const childrenSelect = {
      where: jest.fn().mockReturnThis(),
      whereRaw: jest.fn().mockReturnThis(),
      select: jest.fn().mockResolvedValue([{ id: 'child-1', status: 'pending' }]),
    };
    db.transaction = jest.fn(async (callback) => callback(jest.fn(() => query(0))));
    db
      .mockReturnValueOnce(query(svc)) // loadService
      .mockReturnValueOnce(query(fresh)) // loadService (fresh state)
      .mockReturnValueOnce(childrenSelect); // follow-up children lookup

    const result = await trackTransitions.cancel('job-1', { reason: 'customer moved' });

    expect(result.ok).toBe(true);
    expect(result.state).toBe('cancelled');
    expect(transitionJobStatus).toHaveBeenCalledWith(expect.objectContaining({
      jobId: 'child-1',
      toStatus: 'cancelled',
    }));
  });

  test('a 0-row cancel race does NOT cascade when the parent ended complete — visit 2 survives visit 1 completing', async () => {
    const svc = { id: 'job-1', customer_id: 'cust-1', technician_id: null, status: 'confirmed', track_state: 'scheduled' };
    const fresh = { ...svc, status: 'completed', track_state: 'complete' };
    db.transaction = jest.fn(async (callback) => callback(jest.fn(() => query(0))));
    db
      .mockReturnValueOnce(query(svc)) // loadService
      .mockReturnValueOnce(query(fresh)); // loadService (fresh state = complete)

    const result = await trackTransitions.cancel('job-1', { reason: 'customer moved' });

    expect(result.ok).toBe(true);
    expect(result.state).toBe('complete');
    expect(transitionJobStatus).toHaveBeenCalledWith(expect.objectContaining({
      jobId: 'job-1',
      fromStatus: 'confirmed',
      toStatus: 'cancelled',
    }));
  });

  test('does not cancel an operationally completed service when tracker state is stale', async () => {
    db.mockReturnValueOnce(query({
      id: 'job-1',
      customer_id: 'cust-1',
      technician_id: null,
      status: 'completed',
      track_state: 'on_property',
    }));

    const result = await trackTransitions.cancel('job-1', { reason: 'stale request' });

    expect(result).toEqual({ ok: false, reason: 'cannot_cancel_complete' });
    expect(transitionJobStatus).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('returns a conflict result for no-show cancellation attempts', async () => {
    db.mockReturnValueOnce(query({
      id: 'job-1',
      customer_id: 'cust-1',
      technician_id: null,
      status: 'no_show',
      track_state: 'scheduled',
    }));

    const result = await trackTransitions.cancel('job-1', { reason: 'stale request' });

    expect(result).toEqual({ ok: false, reason: 'cannot_cancel_no_show' });
    expect(transitionJobStatus).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });
});

// The Intelligence Bar cancel recovery sweep passes cancelFence (services/cancel-generation-fence.js): cancel() would
// cancel a LIVE visit, so with a fence it only ever finishes the cancellation the card approved.
describe('cancel with a cancelFence (the cancel recovery sweep)', () => {
  const FENCE = { visitId: 'job-1', restorations: 0, hits: [] };
  const refuse = (fenceReason) => Object.assign(new Error(`cancellation fence: ${fenceReason}`), { code: 'CANCEL_FENCE', fenceReason });
  const svc = { id: 'job-1', customer_id: 'cust-1', technician_id: null, status: 'cancelled', track_state: 'scheduled' };

  beforeEach(() => {
    jest.clearAllMocks();
    mockFence.mockReset();
    mockFence.mockResolvedValue(undefined);
    db.raw = jest.fn(async () => ({ rows: [] }));
    transitionJobStatus.mockReset().mockResolvedValue({});
    getIo.mockReturnValue(socketStub());
  });
  afterEach(() => jest.restoreAllMocks());

  test('a visit that is no longer the approved cancel is left alone: no transaction, no transition, no cascade', async () => {
    mockFence.mockRejectedValueOnce(refuse('visit_is_confirmed'));
    db.transaction = jest.fn(async (fn) => fn(db));
    db.mockReturnValueOnce(query({ ...svc, status: 'confirmed' }));
    const cascade = jest.spyOn(require('../services/call-booking-catalog'), 'cancelCallFollowUpsForParentCancel');
    const result = await trackTransitions.cancel('job-1', { reason: 'x', cancelFence: FENCE });
    expect(result).toEqual({ ok: false, reason: 'cancel_fence' });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(transitionJobStatus).not.toHaveBeenCalled();
    expect(cascade).not.toHaveBeenCalled();
  });

  test('the fence is re-proved INSIDE the cancelling transaction, and the cascade carries it as parentFence', async () => {
    const trackingUpdate = query(1);
    const trx = jest.fn(() => trackingUpdate);
    db.transaction = jest.fn(async (callback) => callback(trx));
    db.mockReturnValueOnce(query(svc));
    const cascade = jest.spyOn(require('../services/call-booking-catalog'), 'cancelCallFollowUpsForParentCancel').mockResolvedValue(0);
    const result = await trackTransitions.cancel('job-1', { reason: 'x', cancelFence: FENCE });
    expect(result.ok).toBe(true);
    expect(mockFence).toHaveBeenCalledWith(db, FENCE);
    expect(mockFence).toHaveBeenCalledWith(trx, FENCE);
    expect(cascade).toHaveBeenCalledWith(expect.objectContaining({ parentServiceId: 'job-1', parentFence: FENCE }));
  });

  test('a restore that lands between the pre-check and the transaction stops the tracker write (the live visit is not cancelled)', async () => {
    mockFence.mockResolvedValueOnce(undefined).mockRejectedValueOnce(refuse('visit_busy'));
    const trackingUpdate = query(1);
    const trx = jest.fn(() => trackingUpdate);
    db.transaction = jest.fn(async (callback) => callback(trx));
    db
      .mockReturnValueOnce(query(svc)) // loadService
      .mockReturnValueOnce(query({ ...svc, status: 'confirmed' })); // the reconcile re-read after the refusal
    await expect(trackTransitions.cancel('job-1', { reason: 'x', cancelFence: FENCE })).rejects.toMatchObject({ code: 'CANCEL_FENCE' });
    expect(trackingUpdate.update).not.toHaveBeenCalled();
    expect(transitionJobStatus).not.toHaveBeenCalled();
  });

  // The share lock of the tracker transaction ends at its commit; the writes that follow stay under the same proof.
  test('the technician-state cleanup runs in a fenced transaction (proof first, tech_status NOWAIT), not on a bare connection', async () => {
    const svcWithTech = { ...svc, technician_id: 'tech-1' };
    const trackingUpdate = query(1);
    const trx = jest.fn(() => trackingUpdate);
    db.transaction = jest.fn(async (callback) => callback(trx));
    db.mockReturnValueOnce(query(svcWithTech));
    jest.spyOn(require('../services/call-booking-catalog'), 'cancelCallFollowUpsForParentCancel').mockResolvedValue(0);
    const order = [];
    mockFence.mockImplementation(async (conn) => { order.push(conn === db ? 'fence(pool)' : 'fence(trx)'); });
    clearTechCurrentJob.mockImplementation(async (args) => { order.push(['clear', args.conn === trx, args.noWait]); });
    const result = await trackTransitions.cancel('job-1', { reason: 'x', cancelFence: FENCE });
    expect(result.ok).toBe(true);
    expect(order).toEqual(['fence(pool)', 'fence(trx)', 'fence(trx)', ['clear', true, true], 'fence(pool)']);
    expect(clearTechCurrentJob).toHaveBeenCalledWith({ tech_id: 'tech-1', current_job_id: 'job-1', status: 'idle', conn: trx, noWait: true });
  });

  // The recovery read a live tracker, another writer (the dead request) flipped it first and died before clearing tech_status.
  test('a lost tracker race whose winner left the tech bound: the fenced cleanup still runs (and a bare cancel still does not clean)', async () => {
    const svcWithTech = { ...svc, technician_id: 'tech-1', status: 'confirmed', track_state: 'scheduled' };
    const fresh = { ...svcWithTech, status: 'cancelled', track_state: 'cancelled', cancelled_at: new Date('2026-07-01T15:00:00Z') };
    const trx = jest.fn(() => query(0));
    db.transaction = jest.fn(async (callback) => callback(trx));
    jest.spyOn(require('../services/call-booking-catalog'), 'cancelCallFollowUpsForParentCancel').mockResolvedValue(0);
    db.mockReturnValueOnce(query(svcWithTech)).mockReturnValueOnce(query(fresh));
    const result = await trackTransitions.cancel('job-1', { reason: 'x', cancelFence: FENCE });
    expect(result.ok).toBe(true);
    expect(clearTechCurrentJob).toHaveBeenCalledTimes(1);
    expect(clearTechCurrentJob).toHaveBeenCalledWith(expect.objectContaining({ tech_id: 'tech-1', current_job_id: 'job-1', noWait: true }));
    // Unchanged for every other caller: no fence, no cleanup after a lost race.
    clearTechCurrentJob.mockClear();
    db.transaction = jest.fn(async (callback) => callback(jest.fn(() => query(0))));
    db.mockReturnValueOnce(query(svcWithTech)).mockReturnValueOnce(query(fresh));
    await trackTransitions.cancel('job-1', { reason: 'x' });
    expect(clearTechCurrentJob).not.toHaveBeenCalled();
  });

  test('a restore that lands after the tracker commit stops the tech cleanup, the cascade and the stale cancelled refresh', async () => {
    const svcWithTech = { ...svc, technician_id: 'tech-1' };
    const trx = jest.fn(() => query(1));
    db.transaction = jest.fn(async (callback) => callback(trx));
    db.mockReturnValueOnce(query(svcWithTech));
    const cascade = jest.spyOn(require('../services/call-booking-catalog'), 'cancelCallFollowUpsForParentCancel').mockResolvedValue(0);
    // pre-check ok, tracker transaction ok, then the cleanup transaction's proof is refused.
    mockFence.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(refuse('visit_is_confirmed'));
    const io = socketStub();
    getIo.mockReturnValue(io);
    const result = await trackTransitions.cancel('job-1', { reason: 'x', cancelFence: FENCE });
    expect(result).toEqual({ ok: false, reason: 'cancel_fence' });
    expect(clearTechCurrentJob).not.toHaveBeenCalled();
    expect(cascade).not.toHaveBeenCalled();
    expect(io.to).not.toHaveBeenCalled();
  });

  test('a busy tech_status row (NOWAIT refused) is a fence hit to retry, not a silent skip or a wait', async () => {
    const svcWithTech = { ...svc, technician_id: 'tech-1' };
    db.transaction = jest.fn(async (callback) => callback(jest.fn(() => query(1))));
    db.mockReturnValueOnce(query(svcWithTech));
    jest.spyOn(require('../services/call-booking-catalog'), 'cancelCallFollowUpsForParentCancel').mockResolvedValue(0);
    clearTechCurrentJob.mockRejectedValueOnce(Object.assign(new Error('could not obtain lock'), { code: '55P03' }));
    const fence = { ...FENCE, hits: [] };
    const result = await trackTransitions.cancel('job-1', { reason: 'x', cancelFence: fence });
    expect(result).toEqual({ ok: false, reason: 'cancel_fence' });
    expect(fence.hits).toEqual(['tech_state_busy']);
  });

  test('a busy first attempt (the tracker flip already committed) is finished by the retry on the already-cancelled path', async () => {
    const trx = jest.fn(() => query(1));
    db.transaction = jest.fn(async (callback) => callback(trx));
    jest.spyOn(require('../services/call-booking-catalog'), 'cancelCallFollowUpsForParentCancel').mockResolvedValue(0);
    const fence = { ...FENCE, hits: [] };
    // First attempt: the tracker flips to cancelled, the tech_status row is busy.
    db.mockReturnValueOnce(query({ ...svc, technician_id: 'tech-1' }));
    clearTechCurrentJob.mockRejectedValueOnce(Object.assign(new Error('could not obtain lock'), { code: '55P03' }));
    expect(await trackTransitions.cancel('job-1', { reason: 'x', cancelFence: fence })).toEqual({ ok: false, reason: 'cancel_fence' });
    expect(clearTechCurrentJob).toHaveBeenCalledTimes(1);
    // The retry finds the tracker already cancelled and still runs the fenced cleanup, then finishes.
    db.mockReturnValueOnce(query({ ...svc, technician_id: 'tech-1', track_state: 'cancelled', cancelled_at: new Date() }));
    clearTechCurrentJob.mockResolvedValueOnce({});
    const retry = await trackTransitions.cancel('job-1', { reason: 'x', cancelFence: { ...FENCE, hits: [] } });
    expect(retry).toMatchObject({ ok: true, state: 'cancelled' });
    expect(clearTechCurrentJob).toHaveBeenCalledTimes(2);
    expect(clearTechCurrentJob).toHaveBeenLastCalledWith(expect.objectContaining({ tech_id: 'tech-1', current_job_id: 'job-1', conn: trx, noWait: true }));
  });

  test('a technician cleanup that FAILS (not a fence refusal) is a recorded fence hit for the sweep to retry, never a silent success', async () => {
    const trx = jest.fn(() => query(1));
    db.transaction = jest.fn(async (callback) => callback(trx));
    const cascade = jest.spyOn(require('../services/call-booking-catalog'), 'cancelCallFollowUpsForParentCancel').mockResolvedValue(0);
    const fence = { ...FENCE, hits: [] };
    db.mockReturnValueOnce(query({ ...svc, technician_id: 'tech-1' }));
    clearTechCurrentJob.mockRejectedValueOnce(new Error('connection terminated'));
    expect(await trackTransitions.cancel('job-1', { reason: 'x', cancelFence: fence })).toEqual({ ok: false, reason: 'cancel_fence' });
    expect(fence.hits).toEqual(['tech_state_error']);
    expect(cascade).not.toHaveBeenCalled();
    // Unfenced callers keep the best-effort behavior: logged, the cancel still succeeds.
    cascade.mockClear();
    db.mockReturnValueOnce(query({ ...svc, technician_id: 'tech-1' }));
    clearTechCurrentJob.mockRejectedValueOnce(new Error('connection terminated'));
    expect(await trackTransitions.cancel('job-1', { reason: 'x' })).toMatchObject({ ok: true, state: 'cancelled' });
  });

  test('a cascade that THROWS is a retryable hit under a fence (and only logged without one)', async () => {
    db.transaction = jest.fn(async (callback) => callback(jest.fn(() => query(1))));
    jest.spyOn(require('../services/call-booking-catalog'), 'cancelCallFollowUpsForParentCancel').mockRejectedValue(new Error('connection terminated'));
    const fence = { ...FENCE, hits: [] };
    db.mockReturnValueOnce(query({ ...svc, track_state: 'cancelled', status: 'cancelled', cancelled_at: new Date() }));
    expect(await trackTransitions.cancel('job-1', { reason: 'x', cancelFence: fence })).toMatchObject({ ok: true });
    expect(fence.hits).toEqual(['cascade_error']);
    db.mockReturnValueOnce(query({ ...svc, track_state: 'cancelled', status: 'cancelled', cancelled_at: new Date() }));
    expect(await trackTransitions.cancel('job-1', { reason: 'x' })).toMatchObject({ ok: true });
  });

  test('without a fence the already-cancelled path still does not touch the technician state (unchanged)', async () => {
    db.transaction = jest.fn(async (callback) => callback(jest.fn(() => query(1))));
    db.mockReturnValueOnce(query({ ...svc, technician_id: 'tech-1', track_state: 'cancelled', cancelled_at: new Date() }));
    jest.spyOn(require('../services/call-booking-catalog'), 'cancelCallFollowUpsForParentCancel').mockResolvedValue(0);
    await trackTransitions.cancel('job-1', { reason: 'x' });
    expect(clearTechCurrentJob).not.toHaveBeenCalled();
  });

  test('a restore detected just before the stale refresh suppresses it (already-cancelled tracker path too)', async () => {
    const trackerDone = { ...svc, track_state: 'cancelled', cancelled_at: new Date() };
    db.mockReturnValueOnce(query(trackerDone));
    jest.spyOn(require('../services/call-booking-catalog'), 'cancelCallFollowUpsForParentCancel').mockResolvedValue(0);
    mockFence.mockResolvedValueOnce(undefined).mockRejectedValueOnce(refuse('visit_restored_since'));
    const io = socketStub();
    getIo.mockReturnValue(io);
    const result = await trackTransitions.cancel('job-1', { reason: 'x', cancelFence: FENCE });
    expect(result).toEqual({ ok: false, reason: 'cancel_fence' });
    expect(io.to).not.toHaveBeenCalled();
  });

  test('without a fence the cancel never consults it', async () => {
    db.transaction = jest.fn(async (callback) => callback(jest.fn(() => query(1))));
    db.mockReturnValueOnce(query({ ...svc, status: 'confirmed' })).mockReturnValue(query([]));
    await trackTransitions.cancel('job-1', { reason: 'x' });
    expect(mockFence).not.toHaveBeenCalled();
  });
});
