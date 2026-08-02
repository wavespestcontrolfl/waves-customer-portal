jest.mock('../models/db', () => jest.fn());
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
  beforeEach(() => {
    jest.clearAllMocks();
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
    expect(sendTechArrived).toHaveBeenCalledWith('cust-6', 'Bryan', { scheduledServiceId: 'job-6' });
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
    expect(sendTechArrived).toHaveBeenCalledWith('cust-a', 'Acting Andy', { scheduledServiceId: 'job-a' });
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
    expect(sendTechArrived).toHaveBeenCalledWith('cust-l', 'Lee', { scheduledServiceId: 'job-l' });
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
    expect(sendTechArrived).toHaveBeenCalledWith('cust-r', 'Casey', { scheduledServiceId: 'job-r' });
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
    const svc = {
      id: 'job-f18',
      technician_id: 'tech-f18',
      track_state: 'on_property',
      actual_start_time: new Date('2026-07-19T12:00:00.000Z'),
      time_on_site_correction_seq: 1,
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
      'time_on_site_correction_seq IS NOT DISTINCT FROM ?', [1],
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
      'time_on_site_correction_seq IS NOT DISTINCT FROM ?', [1],
    );
    expect(update2.update.mock.calls[0][0].completed_at).toEqual(new Date('2026-07-19T16:00:00.000Z'));
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
      select: jest.fn().mockResolvedValue([{ id: 'child-1' }]),
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
    // Narrow filter: only the call pipeline's pending, never-confirmed child.
    expect(childrenSelect.where).toHaveBeenCalledWith({
      parent_service_id: 'job-1',
      source_action: 'ai_call_pipeline_followup',
      status: 'pending',
      customer_confirmed: false,
    });
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
      select: jest.fn().mockResolvedValue([{ id: 'child-1' }]),
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
      select: jest.fn().mockResolvedValue([{ id: 'child-1' }]),
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
      select: jest.fn().mockResolvedValue([{ id: 'child-1' }]),
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
