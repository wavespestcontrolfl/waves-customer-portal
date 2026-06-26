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
  return {
    where: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    update: jest.fn().mockResolvedValue(result),
    first: jest.fn().mockResolvedValue(result),
  };
}

function socketStub() {
  return { to: jest.fn(() => ({ emit: jest.fn() })) };
}

describe('track-transitions lifecycle side effects', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
    expect(sendTechArrived).toHaveBeenCalledWith('cust-6', 'Bryan');
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
    expect(sendTechArrived).toHaveBeenCalledWith('cust-l', 'Lee');
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

  test('markOnProperty does not send the arrival SMS when the gate is off', async () => {
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
    db
      .mockReturnValueOnce(query(svc))
      .mockReturnValueOnce(query(1));

    const result = await trackTransitions.markOnProperty('job-8');

    expect(result.ok).toBe(true);
    expect(sendTechArrived).not.toHaveBeenCalled();
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
    expect(sendTechArrived).toHaveBeenCalledWith('cust-r', 'Casey');
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
});

describe('future-scheduled-date stale-attempt guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
});
