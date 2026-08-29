// Unrecorded-call watchdog (2026-08-29). Born from a 4:17 answered inbound
// call that Twilio bridged through the number's static voice-fallback TwiML
// (no <Dial record>) after the portal's DB pool starved the voice webhooks
// into 502s — call_log had the row and the duration, but no recording ever
// arrived, so no transcript/extraction/lead followed and the ingest watchdog
// (SID-known) saw nothing. These tests pin the classification predicate, the
// per-call vs aggregate bell paths with dedupe, and the gate-off no-op.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn(async (_name, fn) => fn()) }));
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
  runUnrecordedCallWatchdog,
  isUnrecordedCall,
  findUnrecordedCalls,
  MIN_DURATION_SECONDS,
  GRACE_MINUTES,
  AGGREGATE_THRESHOLD,
} = require('../services/unrecorded-call-watchdog');

const NOW = new Date('2026-08-29T14:00:00Z');
const OLD_ENOUGH = new Date(NOW.getTime() - (GRACE_MINUTES + 15) * 60 * 1000);
const TOO_RECENT = new Date(NOW.getTime() - 5 * 60 * 1000);

function row(over = {}) {
  return {
    id: 'row-1',
    twilio_call_sid: 'CAfa987fe4d9655eafbd7d1e59701ff941',
    direction: 'inbound',
    duration_seconds: 257,
    recording_sid: null,
    recording_url: null,
    answered_by: 'unknown',
    call_outcome: null,
    from_phone: '+12125550100',
    to_phone: '+19415550199',
    transcription_metadata: null,
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

  test('PAN-quarantined rows (recording deleted on purpose) are excluded, string or object metadata', () => {
    expect(isUnrecordedCall(row({ transcription_metadata: { pan_detected: true } }), { now: NOW })).toBe(false);
    expect(isUnrecordedCall(row({ transcription_metadata: JSON.stringify({ pan_detected: 'true' }) }), { now: NOW })).toBe(false);
    expect(isUnrecordedCall(row({ transcription_metadata: 'not json' }), { now: NOW })).toBe(true);
  });

  test('calls still inside the recording-callback grace window are not (yet) misses', () => {
    expect(isUnrecordedCall(row({ created_at: TOO_RECENT }), { now: NOW })).toBe(false);
    expect(isUnrecordedCall(row({ created_at: null }), { now: NOW })).toBe(false);
  });

  test('findUnrecordedCalls keeps only the misses', () => {
    const rows = [row(), row({ id: 'r2', twilio_call_sid: 'CArec', recording_sid: 'RE9' }), row({ id: 'r3', twilio_call_sid: 'CAvm', answered_by: 'voicemail' })];
    expect(findUnrecordedCalls(rows, { now: NOW }).map((r) => r.id)).toEqual(['row-1']);
  });
});

describe('runUnrecordedCallWatchdog', () => {
  afterEach(() => {
    mockGateOn = false;
    jest.clearAllMocks();
  });

  test('gated off (default) → no-op, no DB read', async () => {
    mockGateOn = false;
    const result = await runUnrecordedCallWatchdog({ now: NOW });
    expect(result).toEqual({ skipped: true, reason: 'gated_off' });
    expect(db).not.toHaveBeenCalled();
  });

  // Minimal knex stand-in: call_log resolves to `rows`; notifications
  // resolves to `alerted` (truthy = this dedupeKey/sid already rang).
  function installDb({ rows, alerted = null }) {
    db.mockImplementation((table) => {
      const chain = {};
      const self = () => chain;
      for (const m of ['where', 'whereNotNull', 'whereNull', 'whereRaw', 'orderBy']) chain[m] = jest.fn(self);
      chain.select = jest.fn(async () => (table === 'call_log' ? rows : []));
      chain.first = jest.fn(async () => (table === 'notifications' ? alerted : null));
      chain.catch = jest.fn(self);
      return chain;
    });
  }

  test('one fresh miss → one per-call bell with a stable dedupeKey and the caller number in metadata', async () => {
    mockGateOn = true;
    installDb({ rows: [row()] });
    const result = await runUnrecordedCallWatchdog({ now: NOW });
    expect(result).toEqual({ skipped: false, scanned: 1, missed: 1, alerted: 1 });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, title, body, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(category).toBe('alert');
    expect(title).toMatch(/no recording/i);
    expect(body).toContain('+12125550100');
    expect(opts.metadata).toEqual(expect.objectContaining({
      dedupeKey: 'unrecorded-call:CAfa987fe4d9655eafbd7d1e59701ff941',
      call_sid: 'CAfa987fe4d9655eafbd7d1e59701ff941',
    }));
  });

  test('an already-alerted sid never re-rings', async () => {
    mockGateOn = true;
    installDb({ rows: [row()], alerted: { id: 'n1' } });
    const result = await runUnrecordedCallWatchdog({ now: NOW });
    expect(result).toEqual({ skipped: false, scanned: 1, missed: 1, alerted: 0 });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('more than AGGREGATE_THRESHOLD fresh misses → ONE outage bell carrying every sid', async () => {
    mockGateOn = true;
    const rows = Array.from({ length: AGGREGATE_THRESHOLD + 1 }, (_, i) => row({ id: `r${i}`, twilio_call_sid: `CA${i}` }));
    installDb({ rows });
    const result = await runUnrecordedCallWatchdog({ now: NOW });
    expect(result).toEqual({ skipped: false, scanned: rows.length, missed: rows.length, alerted: 1, aggregate: true });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [, title, , opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(title).toMatch(/DOWN/);
    expect(opts.metadata.dedupeKey).toBe('unrecorded-call-outage:2026-08-29T14');
    expect(opts.metadata.unrecorded_call_sids).toEqual(rows.map((r) => r.twilio_call_sid));
  });

  test('recorded rows returned by the window query are classified out, not alerted', async () => {
    mockGateOn = true;
    installDb({ rows: [row({ answered_by: 'voicemail' }), row({ id: 'r2', twilio_call_sid: 'CAnew', created_at: TOO_RECENT })] });
    const result = await runUnrecordedCallWatchdog({ now: NOW });
    expect(result).toEqual({ skipped: false, scanned: 2, missed: 0, alerted: 0 });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });
});
