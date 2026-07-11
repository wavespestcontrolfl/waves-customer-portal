// Call-ingest completeness watchdog (2026-07-11). Born from the Twilio ↔
// call_log reconciliation that found 391 Feb–Mar 2026 answered calls (and 11
// later stragglers, incl. real booked jobs) silently never ingested. These
// tests pin the pure diff logic — family-aware matching, duration/grace/
// direction filters — and the gate-off no-op.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));

const {
  runCallIngestWatchdog,
  computeMissedCalls,
  MIN_DURATION_SECONDS,
  GRACE_MINUTES,
} = require('../services/call-ingest-watchdog');

const NOW = new Date('2026-07-11T12:00:00Z');
const OLD_ENOUGH = new Date(NOW.getTime() - (GRACE_MINUTES + 30) * 60 * 1000).toISOString();
const TOO_RECENT = new Date(NOW.getTime() - 10 * 60 * 1000).toISOString();

function call(over = {}) {
  return {
    sid: 'CAparent1', parentCallSid: null, direction: 'inbound', status: 'completed',
    duration: 60, startTime: OLD_ENOUGH, from: '+19375551234', to: '+19413187612',
    ...over,
  };
}

describe('computeMissedCalls — family-aware Twilio↔call_log diff', () => {
  test('an answered inbound call with no family member in call_log is a miss', () => {
    const missed = computeMissedCalls([call()], new Set(), { now: NOW });
    expect(missed.map((c) => c.sid)).toEqual(['CAparent1']);
  });

  test('a parent SID known to call_log is not a miss', () => {
    expect(computeMissedCalls([call()], new Set(['CAparent1']), { now: NOW })).toHaveLength(0);
  });

  test('a KNOWN CHILD dial-leg clears its parent (call_log often stores the forwarded leg)', () => {
    const legs = [
      call(),
      call({ sid: 'CAchild1', parentCallSid: 'CAparent1', direction: 'outbound-dial' }),
    ];
    expect(computeMissedCalls(legs, new Set(['CAchild1']), { now: NOW })).toHaveLength(0);
  });

  test('child legs themselves are never counted (parents only)', () => {
    const legs = [call({ sid: 'CAchild9', parentCallSid: 'CAsomeparent', direction: 'outbound-dial' })];
    expect(computeMissedCalls(legs, new Set(), { now: NOW })).toHaveLength(0);
  });

  test('short, unanswered, and in-grace calls are excluded', () => {
    const legs = [
      call({ sid: 'CAshort', duration: MIN_DURATION_SECONDS - 1 }),
      call({ sid: 'CAbusy', status: 'busy' }),
      call({ sid: 'CAnoanswer', status: 'no-answer' }),
      call({ sid: 'CAfresh', startTime: TOO_RECENT }),
      call({ sid: 'CAnostart', startTime: null }),
    ];
    expect(computeMissedCalls(legs, new Set(), { now: NOW })).toHaveLength(0);
  });
});

describe('runCallIngestWatchdog — gate', () => {
  const OLD_GATE = process.env.GATE_CALL_INGEST_WATCHDOG;
  afterEach(() => {
    if (OLD_GATE === undefined) delete process.env.GATE_CALL_INGEST_WATCHDOG;
    else process.env.GATE_CALL_INGEST_WATCHDOG = OLD_GATE;
  });

  test('gated off (default) → no-op, no Twilio call', async () => {
    delete process.env.GATE_CALL_INGEST_WATCHDOG;
    const result = await runCallIngestWatchdog({ now: NOW });
    expect(result).toEqual({ skipped: true, reason: 'gated_off' });
  });
});
