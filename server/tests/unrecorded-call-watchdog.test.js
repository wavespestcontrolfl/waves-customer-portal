// Unrecorded-call alert (2026-08-29). Born from a 4:17 answered inbound call
// that Twilio bridged through the number's static voice-fallback TwiML (no
// <Dial record>) after the portal's DB pool starved the voice webhooks into
// 502s — call_log had the row and the duration, the 5-min recovery sweep got
// `no_completed_recording` from Twilio on every pass, and nothing rang. These
// tests pin the classification predicate (grace measured from call END), the
// per-call vs aggregate bell paths with dedupe, the bell:true site tag, the
// "silenced write is not an alert" rule, and the gate-off no-op.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n-new' })) }));
// The gate registry snapshots process.env at load; flip the gate per test
// through the mocked isEnabled instead (name-checked so a typo in the
// service's gate lookup fails the suite rather than silently reading false).
let mockGateOn = false;
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn((gate) => (gate === 'unrecordedCallWatchdog' ? mockGateOn : false)),
}));

const db = require('../models/db');
const NotificationService = require('../services/notification-service');
const {
  alertUnrecordedCalls,
  isUnrecordedCall,
  findUnrecordedCalls,
  MIN_DURATION_SECONDS,
  GRACE_MINUTES,
  AGGREGATE_THRESHOLD,
} = require('../services/unrecorded-call-watchdog');

const NOW = new Date('2026-08-29T14:00:00Z');
const DURATION = 257;
// Grace runs from the call END (created_at + duration), not its start.
const endedAgo = (minutes) => new Date(NOW.getTime() - minutes * 60 * 1000 - DURATION * 1000);
const OLD_ENOUGH = endedAgo(GRACE_MINUTES + 15);
const TOO_RECENT = endedAgo(GRACE_MINUTES - 5);

function row(over = {}) {
  return {
    twilio_call_sid: 'CAfa987fe4d9655eafbd7d1e59701ff941',
    direction: 'inbound',
    duration_seconds: DURATION,
    recording_sid: null,
    recording_url: null,
    answered_by: 'unknown',
    call_outcome: null,
    from_phone: '+12125550100',
    to_phone: '+19415550199',
    created_at: OLD_ENOUGH,
    ...over,
  };
}

describe('isUnrecordedCall — answered inbound call with no Twilio recording', () => {
  test('the 2026-08-29 fallback-bridged call is a miss', () => {
    expect(isUnrecordedCall(row(), { now: NOW })).toBe(true);
  });

  test('a recorded call (sid or url) is not a miss', () => {
    expect(isUnrecordedCall(row({ recording_sid: 'RE1' }), { now: NOW })).toBe(false);
    expect(isUnrecordedCall(row({ recording_url: 'https://api.twilio.com/x.mp3' }), { now: NOW })).toBe(false);
  });

  test('short calls, outbound calls, and rows without a Twilio SID are excluded', () => {
    expect(isUnrecordedCall(row({ duration_seconds: MIN_DURATION_SECONDS - 1 }), { now: NOW })).toBe(false);
    expect(isUnrecordedCall(row({ direction: 'outbound' }), { now: NOW })).toBe(false);
    expect(isUnrecordedCall(row({ twilio_call_sid: null }), { now: NOW })).toBe(false);
  });

  test('voicemail and AI-relay legs carry no dial-leg recording by design', () => {
    expect(isUnrecordedCall(row({ answered_by: 'voicemail' }), { now: NOW })).toBe(false);
    expect(isUnrecordedCall(row({ call_outcome: 'voicemail' }), { now: NOW })).toBe(false);
    expect(isUnrecordedCall(row({ answered_by: 'ai_agent' }), { now: NOW })).toBe(false);
  });

  test('grace is measured from the call END: a long call that just ended is not (yet) a miss', () => {
    expect(isUnrecordedCall(row({ created_at: TOO_RECENT }), { now: NOW })).toBe(false);
    // Started 45 min ago but lasted 40 min → ended 5 min ago → inside grace,
    // even though created_at alone is well past the 30-min grace.
    const longCall = row({ duration_seconds: 40 * 60, created_at: new Date(NOW.getTime() - 45 * 60 * 1000) });
    expect(isUnrecordedCall(longCall, { now: NOW })).toBe(false);
    // Same call once 30 min have passed since it ended.
    expect(isUnrecordedCall(longCall, { now: new Date(NOW.getTime() + 26 * 60 * 1000) })).toBe(true);
    expect(isUnrecordedCall(row({ created_at: null }), { now: NOW })).toBe(false);
  });

  test('findUnrecordedCalls keeps only the misses', () => {
    const rows = [row(), row({ twilio_call_sid: 'CArec', recording_sid: 'RE9' }), row({ twilio_call_sid: 'CAvm', answered_by: 'voicemail' })];
    expect(findUnrecordedCalls(rows, { now: NOW }).map((r) => r.twilio_call_sid)).toEqual(['CAfa987fe4d9655eafbd7d1e59701ff941']);
  });
});

describe('alertUnrecordedCalls', () => {
  afterEach(() => {
    mockGateOn = false;
    jest.clearAllMocks();
    NotificationService.notifyAdmin.mockImplementation(async () => ({ id: 'n-new' }));
  });

  // Minimal knex stand-in for the notifications dedupe read: `alerted`
  // truthy = this dedupeKey/sid already rang.
  function installDb({ alerted = null } = {}) {
    db.mockImplementation((table) => {
      const chain = {};
      const self = () => chain;
      for (const m of ['where', 'whereRaw']) chain[m] = jest.fn(self);
      chain.first = jest.fn(async () => (table === 'notifications' ? alerted : null));
      chain.catch = jest.fn(self);
      return chain;
    });
  }

  test('gated off (default) → no-op, no DB read, no bell', async () => {
    mockGateOn = false;
    installDb();
    const result = await alertUnrecordedCalls([row()], { now: NOW });
    expect(result).toEqual({ skipped: true, reason: 'gated_off' });
    expect(db).not.toHaveBeenCalled();
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('one fresh miss → one per-call bell, bell:true, stable dedupeKey, caller number in metadata', async () => {
    mockGateOn = true;
    installDb();
    const result = await alertUnrecordedCalls([row()], { now: NOW });
    expect(result).toEqual({ skipped: false, scanned: 1, missed: 1, alerted: 1 });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, title, body, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(category).toBe('alert');
    expect(title).toMatch(/no recording/i);
    expect(body).toContain('+12125550100');
    // 'alert' is silenced under GATE_ADMIN_BELL_POLICY; the explicit site
    // tag is what lets this lane's only output ring.
    expect(opts.bell).toBe(true);
    expect(opts.metadata).toEqual(expect.objectContaining({
      dedupeKey: 'unrecorded-call:CAfa987fe4d9655eafbd7d1e59701ff941',
      call_sid: 'CAfa987fe4d9655eafbd7d1e59701ff941',
    }));
  });

  test('an already-alerted sid never re-rings', async () => {
    mockGateOn = true;
    installDb({ alerted: { id: 'n1' } });
    const result = await alertUnrecordedCalls([row()], { now: NOW });
    expect(result).toEqual({ skipped: false, scanned: 1, missed: 1, alerted: 0 });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('a silenced or failed notification write is NOT reported as alerted', async () => {
    mockGateOn = true;
    installDb();
    NotificationService.notifyAdmin.mockImplementation(async () => ({ id: null, suppressed: true, reason: 'bell_policy' }));
    expect(await alertUnrecordedCalls([row()], { now: NOW })).toEqual({ skipped: false, scanned: 1, missed: 1, alerted: 0, failed: 1 });
    NotificationService.notifyAdmin.mockImplementation(async () => null);
    expect(await alertUnrecordedCalls([row()], { now: NOW })).toEqual({ skipped: false, scanned: 1, missed: 1, alerted: 0, failed: 1 });
  });

  test('more than AGGREGATE_THRESHOLD fresh misses → ONE outage bell, keyed per pass, carrying every sid', async () => {
    mockGateOn = true;
    const rows = Array.from({ length: AGGREGATE_THRESHOLD + 1 }, (_, i) => row({ twilio_call_sid: `CA${i}` }));
    installDb();
    const result = await alertUnrecordedCalls(rows, { now: NOW });
    expect(result).toEqual({ skipped: false, scanned: rows.length, missed: rows.length, alerted: 1, aggregate: true });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [, title, , opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(title).toMatch(/DOWN/);
    expect(opts.bell).toBe(true);
    expect(opts.metadata.dedupeKey).toBe(`unrecorded-call-outage:${NOW.toISOString()}`);
    expect(opts.metadata.unrecorded_call_sids).toEqual(rows.map((r) => r.twilio_call_sid));

    // A later pass with its own >3 NEW misses gets a distinct key — it is
    // never swallowed by the earlier aggregate, so its SIDs get settled.
    const later = new Date(NOW.getTime() + 30 * 60 * 1000);
    const moreRows = Array.from({ length: AGGREGATE_THRESHOLD + 1 }, (_, i) => row({ twilio_call_sid: `CAlater${i}` }));
    await alertUnrecordedCalls(moreRows, { now: later });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(2);
    expect(NotificationService.notifyAdmin.mock.calls[1][3].metadata.dedupeKey).toBe(`unrecorded-call-outage:${later.toISOString()}`);
  });

  test('rows the sweep passes that are not misses (voicemail, inside grace) are classified out, not alerted', async () => {
    mockGateOn = true;
    installDb();
    const result = await alertUnrecordedCalls([row({ answered_by: 'voicemail' }), row({ twilio_call_sid: 'CAnew', created_at: TOO_RECENT })], { now: NOW });
    expect(result).toEqual({ skipped: false, scanned: 2, missed: 0, alerted: 0 });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });
});
