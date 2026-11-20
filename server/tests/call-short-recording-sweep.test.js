// The recording sweep takes a short call a deploy stranded (owner 2026-11-19, "FIX").
//
// Why: on 2026-11-18 an 8-second cancel call never got a transcript. A deploy
// restarted the server 47 seconds after the recording was saved, so the
// in-memory processing timers died with the old container, and the 5-minute
// sweep (processAllPending), the restart-safe backstop, took only recordings
// over 10 seconds. GATE_SHORT_CALL_RECORDING_SWEEP lets the sweep take a
// shorter recording while its call is under 24 hours old. One length rule
// (config/call-extraction-retry.js) feeds the sweep and every reader that
// mirrors it (getStats, the stall watchdog, the ops queue, the agent-control
// run list). Gate off, every rule is byte-identical to before.
//
// The sweep predicate is raw SQL a mocked builder cannot evaluate, so the
// behavior suite runs the REAL candidate query against real call_log rows
// (DATABASE_URL only). Fixtures are fictitious: 555-01xx numbers, fake SIDs,
// no transcript text.
const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const GATE = 'GATE_SHORT_CALL_RECORDING_SWEEP';
async function withGate(value, fn) {
  const before = process.env[GATE];
  if (value === undefined) delete process.env[GATE];
  else process.env[GATE] = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env[GATE];
    else process.env[GATE] = before;
  }
}

const OLD_FLOOR_SQL = 'COALESCE(recording_duration_seconds, duration_seconds, 0) > 10';
const WINDOW_SQL = "COALESCE(recording_duration_seconds, duration_seconds, 0) > 0 AND created_at > NOW() - INTERVAL '24 hours'";

describe('the sweep length rule', () => {
  const { sweepLengthSql, sweepLengthOk, SWEEP_MIN_SECONDS, SHORT_RECORDING_SWEEP_HOURS } = require('../config/call-extraction-retry');
  const NOW = new Date('2026-11-19T12:00:00Z');
  const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600 * 1000).toISOString();
  const row = (seconds, ageHours, extra = {}) => ({ recording_duration_seconds: seconds, duration_seconds: 29, created_at: hoursAgo(ageHours), ...extra });

  test('gate off (or not exactly "true"): the old 10-second floor, byte for byte', async () => {
    expect(SWEEP_MIN_SECONDS).toBe(10);
    expect(SHORT_RECORDING_SWEEP_HOURS).toBe(24);
    for (const value of [undefined, 'false', '1', 'TRUE']) {
      await withGate(value, () => {
        expect(sweepLengthSql()).toBe(OLD_FLOOR_SQL);
        expect(sweepLengthOk(row(11, 1), NOW)).toBe(true);
        expect(sweepLengthOk(row(10, 1), NOW)).toBe(false);
        expect(sweepLengthOk(row(8, 1), NOW)).toBe(false);
      });
    }
  });

  test('gate on: a short recording counts while its call is under 24 hours old', async () => {
    await withGate('true', () => {
      expect(sweepLengthSql()).toBe(`(${OLD_FLOOR_SQL} OR (${WINDOW_SQL}))`);
      expect(sweepLengthOk(row(8, 1), NOW)).toBe(true);
      expect(sweepLengthOk(row(1, 23.9), NOW)).toBe(true);
      expect(sweepLengthOk(row(8, 24), NOW)).toBe(false);
      expect(sweepLengthOk(row(8, 25), NOW)).toBe(false);
      // A long recording keeps no age limit.
      expect(sweepLengthOk(row(11, 500), NOW)).toBe(true);
      // Nothing to transcribe: a 0-second recording, or no length at all.
      expect(sweepLengthOk(row(0, 1, { duration_seconds: 0 }), NOW)).toBe(false);
      expect(sweepLengthOk({ created_at: hoursAgo(1) }, NOW)).toBe(false);
      // COALESCE semantics: a recorded 0 is authoritative, never the longer call length.
      expect(sweepLengthOk(row(0, 1, { duration_seconds: 60 }), NOW)).toBe(false);
      // No recording length yet: the call length stands in, as in the SQL.
      expect(sweepLengthOk(row(null, 1, { duration_seconds: 8 }), NOW)).toBe(true);
      // No creation time: never treated as recent.
      expect(sweepLengthOk({ recording_duration_seconds: 8 }, NOW)).toBe(false);
    });
  });

  test('the any-age rule, for a reader that reports a past failure: the old floor gate off, any recording gate on', async () => {
    const { sweepLengthAnyAgeSql } = require('../config/call-extraction-retry');
    for (const value of [undefined, 'false', '1', 'TRUE']) {
      await withGate(value, () => expect(sweepLengthAnyAgeSql()).toBe(OLD_FLOOR_SQL));
    }
    await withGate('true', () => {
      expect(sweepLengthAnyAgeSql()).toBe('COALESCE(recording_duration_seconds, duration_seconds, 0) > 0');
      expect(sweepLengthAnyAgeSql()).not.toContain('INTERVAL');
    });
  });
});

describe('the sweep query text', () => {
  let processor;
  let db;
  beforeAll(() => {
    jest.isolateModules(() => {
      processor = require('../services/call-recording-processor');
      db = require('../models/db');
    });
  });
  afterAll(async () => {
    await db.destroy();
  });

  test('gate off keeps the 10-second floor; gate on adds the 24-hour window and keeps the 10-minute settle gate', async () => {
    // The length clause, with the PAN-quarantine exemption beside it (a quarantined row is never length-filtered).
    const PAN = "or (transcription_metadata::jsonb ->> 'pan_detected') = 'true')";
    const off = await withGate(undefined, () => processor.pendingCandidatesQuery().toString());
    expect(off).toContain(`(${OLD_FLOOR_SQL} ${PAN}`);
    expect(off).not.toContain("INTERVAL '24 hours'");
    const on = await withGate('true', () => processor.pendingCandidatesQuery().toString());
    expect(on).toContain(`((${OLD_FLOOR_SQL} OR (${WINDOW_SQL})) ${PAN}`);
    // The in-memory timers keep the first 10 minutes: the fresh branch still waits for the CDN settle.
    expect(on).toContain(`"updated_at" < NOW() - INTERVAL '10 minutes'`);
  });
});

maybeDescribe('the sweep picks up a short call a deploy stranded (live Postgres)', () => {
  let db;
  let processor;

  const sid = (tail) => 'CA' + '9'.repeat(30) + tail;
  const SID_SHORT = sid('s1'); // 8 s, never processed, 20 min old: the 2026-11-18 case
  const SID_SHORT_OLD = sid('s2'); // 8 s, never processed, 25 h old
  const SID_SHORT_SETTLING = sid('s3'); // 8 s, recording landed 3 min ago: its in-memory timer still owns it
  const SID_LONG = sid('s4'); // 60 s, never processed, 20 min old: the old floor already took it
  const ALL_SIDS = [SID_SHORT, SID_SHORT_OLD, SID_SHORT_SETTLING, SID_LONG];
  const REC = 'RE' + '9'.repeat(32);
  const minutesAgo = (m) => new Date(Date.now() - m * 60 * 1000);

  const insertCall = (s, { seconds, createdMinutesAgo, updatedMinutesAgo }) => db('call_log').insert({
    twilio_call_sid: s,
    direction: 'inbound',
    from_phone: '+15555550134',
    to_phone: '+15555550100',
    status: 'completed',
    duration_seconds: seconds + 21,
    recording_sid: REC,
    recording_url: `https://api.twilio.com/2010-04-01/Accounts/ACfixture/Recordings/${REC}.mp3`,
    recording_duration_seconds: seconds,
    transcription_status: 'pending',
    processing_status: null,
    created_at: minutesAgo(createdMinutesAgo),
    updated_at: minutesAgo(updatedMinutesAgo),
    metadata: JSON.stringify({ source: 'voice_webhook', fixture: 'short-recording-sweep' }),
  });

  const candidates = async () => (await processor.pendingCandidatesQuery().whereIn('twilio_call_sid', ALL_SIDS))
    .map((r) => r.twilio_call_sid).sort();

  beforeAll(async () => {
    jest.resetModules();
    db = require('../models/db');
    processor = require('../services/call-recording-processor');
    await db('call_log').whereIn('twilio_call_sid', ALL_SIDS).del();
    await insertCall(SID_SHORT, { seconds: 8, createdMinutesAgo: 20, updatedMinutesAgo: 19 });
    await insertCall(SID_SHORT_OLD, { seconds: 8, createdMinutesAgo: 25 * 60, updatedMinutesAgo: 25 * 60 - 1 });
    await insertCall(SID_SHORT_SETTLING, { seconds: 8, createdMinutesAgo: 4, updatedMinutesAgo: 3 });
    await insertCall(SID_LONG, { seconds: 60, createdMinutesAgo: 20, updatedMinutesAgo: 19 });
  });

  afterAll(async () => {
    await db('call_log').whereIn('twilio_call_sid', ALL_SIDS).del();
    await db.destroy();
  });

  test('gate off: only the long call is swept, as before', async () => {
    await withGate(undefined, async () => {
      expect(await candidates()).toEqual([SID_LONG]);
    });
  });

  test('gate on: the stranded short call is swept too; a day-old one and one still settling are not', async () => {
    await withGate('true', async () => {
      expect(await candidates()).toEqual([SID_SHORT, SID_LONG].sort());
    });
  });

  test('gate on: the stats that mirror the sweep run on the same rule', async () => {
    await withGate('true', async () => {
      const stats = await processor.getStats();
      expect(stats.retrying).toEqual(expect.any(Number));
      expect(stats.oldestUnfinishedMinutes).toEqual(expect.any(Number));
    });
  });
});
