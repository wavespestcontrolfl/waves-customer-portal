// Single-source-of-truth contract for the customer arrival SMS.
//
// After six review rounds the arrival lifecycle was consolidated so EVERY
// signal (GPS webhook, geofence webhook, manual on-site tap, confirm-start)
// funnels through exactly ONE maybeSendArrivalSms call inside markOnProperty,
// self-serialized by the arrival_sms_sent_at CAS. This file locks that funnel's
// invariants as a table so the behavior is stated once, independent of the
// per-side-effect assertions in track-transitions.test.js.
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

// A row that already carries all three on-site lifecycle timestamps, so
// buildOnSiteLifecycleUpdates() returns {} and the idempotent on_property branch
// makes no extra UPDATE — keeps db() call counts deterministic.
function stampedOnProperty(overrides = {}) {
  return {
    id: 'job-1',
    customer_id: 'cust-1',
    technician_id: 'tech-1',
    status: 'on_site',
    track_state: 'on_property',
    cancelled_at: null,
    actual_start_time: new Date(),
    check_in_time: new Date(),
    arrived_at: new Date(),
    arrival_sms_sent_at: null,
    ...overrides,
  };
}

function scheduled(overrides = {}) {
  return {
    id: 'job-1',
    customer_id: 'cust-1',
    technician_id: 'tech-1',
    status: 'confirmed',
    track_state: 'scheduled',
    cancelled_at: null,
    arrival_sms_sent_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  getIo.mockReturnValue(socketStub());
});

describe('classifyArrivalSend — the suppressed-vs-retryable rule, in one place', () => {
  const { classifyArrivalSend } = trackTransitions._test;

  test.each([
    ['delivered', { success: true }, 'sent'],
    ['delivered even if flagged suppressed', { success: true, suppressed: true }, 'sent'],
    ['opt-out', { success: false, suppressed: true, reason: 'opt_out' }, 'suppressed'],
    ['sms disabled', { success: false, suppressed: true, reason: 'sms_disabled' }, 'suppressed'],
    ['no SMS-capable contact', { success: false, suppressed: true, reason: 'no_contacts' }, 'suppressed'],
    ['all sends blocked terminally (DNC / non-mobile)', { success: false, suppressed: true, reason: 'blocked' }, 'suppressed'],
    ['transient provider miss', { success: false }, 'retry'],
    ['template missing (empty results)', { success: false, results: [] }, 'retry'],
    ['undefined (threw / no return)', undefined, 'retry'],
    ['null', null, 'retry'],
  ])('%s', (_label, input, expected) => {
    expect(classifyArrivalSend(input)).toBe(expected);
  });
});

describe('arrival SMS funnel — markOnProperty fires through one self-serializing entry point', () => {
  test('fresh flip + gate on + delivered: claims once, sends, keeps the stamp', async () => {
    sendTechArrived.mockResolvedValue({ success: true });
    const claim = query(1);
    db
      .mockReturnValueOnce(query(scheduled())) // loadService
      .mockReturnValueOnce(query(1)) // flip scheduled -> on_property
      .mockReturnValueOnce(claim) // CAS claim
      .mockReturnValueOnce(query({ name: 'Bryan' })); // tech name lookup

    const result = await trackTransitions.markOnProperty('job-1');

    expect(result).toMatchObject({ ok: true, state: 'on_property' });
    expect(sendTechArrived).toHaveBeenCalledTimes(1);
    expect(claim.whereNull).toHaveBeenCalledWith('arrival_sms_sent_at');
    expect(claim.update).toHaveBeenCalledWith({ arrival_sms_sent_at: expect.any(Date) });
    // loadService, flip, claim, tech — and NO 5th (release) call: the stamp stands.
    expect(db).toHaveBeenCalledTimes(4);
  });

  test('CAS loser bails: a concurrent signal that loses the claim never double-sends', async () => {
    // Job is already on_property; another signal already claimed the guard, so
    // this caller's CAS updates 0 rows and must NOT send.
    db
      .mockReturnValueOnce(query(stampedOnProperty())) // loadService
      .mockReturnValueOnce(query(0)); // CAS claim loses (0 rows)

    const result = await trackTransitions.markOnProperty('job-1');

    expect(result).toMatchObject({ ok: true, state: 'on_property' });
    expect(sendTechArrived).not.toHaveBeenCalled();
    expect(db).toHaveBeenCalledTimes(2); // loadService + the lost claim; no tech lookup
  });

  test('gate OFF: claims the guard (handled) but sends nothing and does not release', async () => {
    isEnabled.mockReturnValueOnce(false);
    const claim = query(1);
    db
      .mockReturnValueOnce(query(scheduled())) // loadService
      .mockReturnValueOnce(query(1)) // flip
      .mockReturnValueOnce(claim); // claim, then gate-off returns

    const result = await trackTransitions.markOnProperty('job-1');

    expect(result.ok).toBe(true);
    expect(claim.update).toHaveBeenCalledWith({ arrival_sms_sent_at: expect.any(Date) });
    expect(sendTechArrived).not.toHaveBeenCalled();
    expect(db).toHaveBeenCalledTimes(3); // no tech lookup, no release
  });

  test('suppressArrivalSms (geofence drive-past): no claim, no send, guard left NULL', async () => {
    db
      .mockReturnValueOnce(query(scheduled())) // loadService
      .mockReturnValueOnce(query(1)); // flip only

    const result = await trackTransitions.markOnProperty('job-1', { suppressArrivalSms: true });

    expect(result).toMatchObject({ ok: true, state: 'on_property' });
    expect(sendTechArrived).not.toHaveBeenCalled();
    // Only loadService + flip ran — the funnel was never entered, so the guard
    // stays NULL for a later real arrival to claim and send.
    expect(db).toHaveBeenCalledTimes(2);
  });

  test('opt-out (suppressed outcome): keeps the claim stamped, no release', async () => {
    sendTechArrived.mockResolvedValue({ success: false, suppressed: true, reason: 'opt_out' });
    db
      .mockReturnValueOnce(query(scheduled())) // loadService
      .mockReturnValueOnce(query(1)) // flip
      .mockReturnValueOnce(query(1)) // claim
      .mockReturnValueOnce(query({ name: 'Bryan' })); // tech lookup

    const result = await trackTransitions.markOnProperty('job-1');

    expect(result.ok).toBe(true);
    expect(sendTechArrived).toHaveBeenCalledTimes(1);
    // A release would be a 5th db() call; suppression is handled, so there isn't one.
    expect(db).toHaveBeenCalledTimes(4);
  });

  test('retryable miss: releases the claim back to NULL so a later signal retries', async () => {
    sendTechArrived.mockResolvedValue({ success: false }); // transient provider miss
    const release = query(1);
    db
      .mockReturnValueOnce(query(scheduled())) // loadService
      .mockReturnValueOnce(query(1)) // flip
      .mockReturnValueOnce(query(1)) // claim
      .mockReturnValueOnce(query({ name: 'Bryan' })) // tech lookup
      .mockReturnValueOnce(release); // release

    const result = await trackTransitions.markOnProperty('job-1');

    expect(result.ok).toBe(true);
    expect(release.update).toHaveBeenCalledWith({ arrival_sms_sent_at: null });
  });

  test('acting tech precedence: the SMS names the passed tech, not the stale assignment', async () => {
    sendTechArrived.mockResolvedValue({ success: true });
    const techLookup = query({ name: 'Acting Andy' });
    db
      .mockReturnValueOnce(query(scheduled({ technician_id: 'tech-stale' }))) // loadService
      .mockReturnValueOnce(query(1)) // flip
      .mockReturnValueOnce(query(1)) // claim
      .mockReturnValueOnce(techLookup); // tech lookup

    await trackTransitions.markOnProperty('job-1', { actingTechId: 'tech-acting' });

    expect(techLookup.where).toHaveBeenCalledWith({ id: 'tech-acting' });
    expect(sendTechArrived).toHaveBeenCalledWith('cust-1', 'Acting Andy');
  });

  test('race-loser for an already-on_property job still funnels the send', async () => {
    // Lost the scheduled->on_property flip (0 rows). The fresh row is on_property
    // with a NULL guard (winner may have suppressed), so the loser must still
    // attempt the arrival; the CAS prevents a double-send.
    sendTechArrived.mockResolvedValue({ success: true });
    db
      .mockReturnValueOnce(query(scheduled())) // loadService
      .mockReturnValueOnce(query(0)) // flip loses
      .mockReturnValueOnce(query(stampedOnProperty())) // fresh reload, on_property
      .mockReturnValueOnce(query(1)) // claim
      .mockReturnValueOnce(query({ name: 'Bryan' })); // tech lookup

    const result = await trackTransitions.markOnProperty('job-1');

    expect(result).toMatchObject({ ok: true, state: 'on_property' });
    expect(sendTechArrived).toHaveBeenCalledTimes(1);
  });
});
