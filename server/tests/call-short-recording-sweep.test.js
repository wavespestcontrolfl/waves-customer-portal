// The recording sweep takes a short call a deploy stranded (owner 2026-11-19, "FIX").
//
// Why: on 2026-11-18 an 8-second cancel call never got a transcript. A deploy
// restarted the server 47 seconds after the recording was saved, so the
// in-memory processing timers died with the old container, and the 5-minute
// sweep (processAllPending), the restart-safe backstop, took only recordings
// over 10 seconds. GATE_SHORT_CALL_RECORDING_SWEEP lets the sweep take a
// shorter recording on its first pass while its call is under 24 hours old; a
// retry state or a finished one keeps the 10-second floor. One length rule
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
const WINDOW_SQL = "COALESCE(recording_duration_seconds, duration_seconds, 0) > 0 AND created_at > NOW() - INTERVAL '24 hours'"
  + " AND (processing_status IS NULL OR processing_status IN ('pending', 'processing'))";

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

  test('gate on: a short recording counts on its first pass while its call is under 24 hours old', async () => {
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

  test('gate on: a retry state or a finished one keeps the 10-second floor (the gate adds no retries)', async () => {
    await withGate('true', () => {
      // A first pass: never claimed, queued, or a claim the sweep may find stale.
      for (const status of [null, 'pending', 'processing']) {
        expect(sweepLengthOk(row(8, 1, { processing_status: status }), NOW)).toBe(true);
      }
      for (const status of ['no_transcription', 'extraction_failed', 'processed', 'voicemail', 'spam', 'customer_creation_failed', 'lead_creation_failed']) {
        expect(sweepLengthOk(row(8, 1, { processing_status: status }), NOW)).toBe(false);
        // Over 10 seconds the state does not matter, as before.
        expect(sweepLengthOk(row(11, 1, { processing_status: status }), NOW)).toBe(true);
      }
    });
  });

  test('the failure-report rule: the old floor gate off; gate on, any recording, so a short failure stays visible', async () => {
    const { failureReportLengthSql } = require('../config/call-extraction-retry');
    for (const value of [undefined, 'false', '1', 'TRUE']) {
      await withGate(value, () => expect(failureReportLengthSql()).toBe(OLD_FLOOR_SQL));
    }
    await withGate('true', () => {
      expect(failureReportLengthSql()).toBe('COALESCE(recording_duration_seconds, duration_seconds, 0) > 0');
      expect(failureReportLengthSql()).not.toContain('INTERVAL');
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

  test('every sweep pass asks its claim to re-check the candidate rule (a timer may change a row while it waits)', async () => {
    const select = jest.spyOn(processor, 'pendingCandidatesQuery').mockResolvedValue([{ twilio_call_sid: 'CAfixture01' }, { twilio_call_sid: 'CAfixture02' }]);
    const run = jest.spyOn(processor, 'processRecording').mockResolvedValue({ success: true });
    try {
      await processor.processAllPending();
      expect(run.mock.calls).toEqual([['CAfixture01', { sweep: true }], ['CAfixture02', { sweep: true }]]);
    } finally {
      select.mockRestore();
      run.mockRestore();
    }
  });

  test('the claim re-checks the very rule the sweep selects on, for a sweep pass only (the live-PG block below runs it)', () => {
    const src = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
    const query = src.slice(src.indexOf('  pendingCandidatesQuery() {'), src.indexOf('.limit(20);'));
    expect(query).toContain('.where(function sweepCandidate() { whereSweepCandidate(this); })');
    // Once: in the ordinary claim, the one every unattended pass takes (none of them sends force).
    expect(src.split('.where(function unattendedClaim() { whereUnattendedClaim(this, opts); })')).toHaveLength(2);
    expect(src).toContain('if (opts.sweep) qb.where(function sweepStillSelects() { whereSweepCandidate(this); });');
  });

  // The ordinary claim's fences for a pass nobody pressed a button for (whereUnattendedClaim; pre-push Codex rounds 4,
  // 5, 8, 9, 11 and 12): a sweep pass re-checks its candidate rule, and a webhook timer runs only on a row still owed a
  // pass. Any other caller gets neither fence.
  test('the unattended claim: a sweep pass re-checks its candidate rule; an overtaken timer runs only on a row still owed a pass', async () => {
    const sql = (opts) => db('call_log').where(function claim() { processor.whereUnattendedClaim(this, opts); }).toString();
    for (const value of [undefined, 'true']) {
      await withGate(value, () => {
        const sweep = sql({ sweep: true });
        expect(sweep).toContain(`"updated_at" < NOW() - INTERVAL '10 minutes'`);
        // A timer takes a first-pass state or a claim; a retry state only where the sweep would take it now (the very
        // rule a sweep pass re-checks, so the sweep's cap, backoff and length floor), overtaken or not; any other state
        // only if no pass claimed the row since its write.
        const candidate = sweep.replace(/^select \* from "call_log" where \(\((.*)\)\)$/s, '$1');
        expect(candidate).not.toBe(sweep);
        expect(sql({ scheduledGeneration: 4 })).toBe('select * from "call_log" where (("processing_status" is null'
          + ` or "processing_status" in ('pending', 'processing') or (${candidate})`
          + ` or ("processing_generation" <= 4 and "processing_status" not in ('no_transcription', 'extraction_failed'))))`);
      });
    }
    expect(sql({ operator: true })).toBe('select * from "call_log"');
  });

  test('no stuck-transcript fallback: the fresh branch takes only NULL / pending, the retry branches keep the cap', async () => {
    // Pre-push Codex P1, rounds 2 and 6: the fallback (transcription_status pending, no text) admitted an
    // at-cap no_transcription row every tick and a settled voicemail or spam row the claim would run again.
    for (const value of [undefined, 'true']) {
      const sql = await withGate(value, () => processor.pendingCandidatesQuery().toString());
      expect(sql).not.toContain('"transcription_status"');
      expect(sql).toContain(`("processing_status" is null or "processing_status" = 'pending') and "updated_at" < NOW() - INTERVAL '10 minutes'`);
      expect(sql).toContain(`"processing_status" = 'no_transcription' and COALESCE(extraction_attempts, 0) < 3`);
    }
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
  // No transcript after a try: the processor left transcription_status pending.
  const SID_SHORT_AT_CAP = sid('s5'); // 8 s, 3 tries (the cap), 2 h old: the claim refuses it, so it takes no slot
  const SID_SHORT_RETRY = sid('s6'); // 8 s, 1 try, 2 h old: a retry state keeps the 10-second floor, gate on or off
  const SID_LONG_AT_CAP = sid('s7'); // 60 s, 3 tries: never a candidate, gate on or off
  const SID_SHORT_DIED = sid('s8'); // 8 s, its first pass claimed it 30 min ago and stopped beating: a deploy killed the pass
  // Voicemail rows whose transcript was never stored (transcription_status pending, no text). The
  // ordinary claim accepts a voicemail row, so the sweep must never select or claim them again.
  const SID_SHORT_VOICEMAIL = sid('s9'); // 8 s
  const SID_LONG_VOICEMAIL = sid('sc'); // 60 s: the old stuck-transcript fallback took it after 10 minutes
  // A card number was read on the call: the quarantine nulled recording_url and kept the masked
  // transcript (a placeholder here, no digits). The sweep has no length floor for such a row.
  const PAN_QUARANTINED = {
    recording_url: null,
    transcription: '[masked transcript]',
    transcription_status: 'completed',
    transcription_metadata: JSON.stringify({ pan_detected: true, recording_quarantined: true, pan_notified: true }),
  };
  const SID_PAN_RETRY = sid('sa'); // 4 s, extraction failed once: the sweep's masked-transcript branch takes it, gate on or off
  const SID_PAN_FINISHED = sid('sb'); // 4 s, a timer finished it as voicemail: never swept, and a sweep pass's claim refuses it
  // A duplicate callback scheduled a webhook timer at generation 0; the sweep then claimed the stranded call
  // (generation 1) and finished it before the timer fired.
  const SID_SWEPT_VOICEMAIL = sid('sd'); // 8 s
  const SID_SWEPT_SPAM = sid('se'); // 8 s
  const SID_SWEPT_CUSTOMER_FAILED = sid('sf'); // 8 s: the office reviews a creation failure, nothing retries it
  const SID_SWEPT_LEAD_FAILED = sid('sg'); // 8 s
  // Also overtaken at generation 1, but still owed a pass, so the timer's fence lets them through.
  const SID_OVERTAKEN_FIRST = sid('sh'); // 8 s, NULL: another pass deferred and restored its first-pass state
  const SID_OVERTAKEN_RETRY = sid('si'); // 60 s, no_transcription after 1 try, past its backoff: the sweep retries it
  const SID_OVERTAKEN_CLAIM = sid('sj'); // 8 s, a pass holds it now (the claim's heartbeat rule decides)
  // Past the backoff and under the cap, but the sweep never retries a short call's failure, so no timer takes them:
  // not one a newer pass overtook (generation 0), nor a late duplicate delivery's (generation 1; pre-push Codex P1,
  // rounds 11 and 12).
  const SID_OVERTAKEN_SHORT_NO_TRANSCRIPT = sid('sk'); // 8 s, no_transcription after 1 try
  const SID_OVERTAKEN_SHORT_FAILED = sid('sl'); // 8 s, extraction_failed after 1 try
  // The candidate tests read the twelve rows above the timer group; the timer group has its own tests.
  const SWEEP_SIDS = [SID_SHORT, SID_SHORT_OLD, SID_SHORT_SETTLING, SID_LONG, SID_SHORT_AT_CAP, SID_SHORT_RETRY, SID_LONG_AT_CAP, SID_SHORT_DIED,
    SID_SHORT_VOICEMAIL, SID_PAN_RETRY, SID_PAN_FINISHED, SID_LONG_VOICEMAIL];
  const TIMER_SIDS = [SID_SWEPT_VOICEMAIL, SID_SWEPT_SPAM, SID_SWEPT_CUSTOMER_FAILED, SID_SWEPT_LEAD_FAILED,
    SID_OVERTAKEN_FIRST, SID_OVERTAKEN_RETRY, SID_OVERTAKEN_CLAIM, SID_OVERTAKEN_SHORT_NO_TRANSCRIPT, SID_OVERTAKEN_SHORT_FAILED];
  const ALL_SIDS = [...SWEEP_SIDS, ...TIMER_SIDS];
  const REC = 'RE' + '9'.repeat(32);
  const minutesAgo = (m) => new Date(Date.now() - m * 60 * 1000);

  const insertCall = (s, { seconds, createdMinutesAgo, updatedMinutesAgo, ...over }) => db('call_log').insert({
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
    ...over,
  });

  const candidates = async () => (await processor.pendingCandidatesQuery().whereIn('twilio_call_sid', SWEEP_SIDS))
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
    const noTranscript = (attempts) => ({ processing_status: 'no_transcription', extraction_attempts: attempts });
    await insertCall(SID_SHORT_AT_CAP, { seconds: 8, createdMinutesAgo: 120, updatedMinutesAgo: 60, ...noTranscript(3) });
    await insertCall(SID_SHORT_RETRY, { seconds: 8, createdMinutesAgo: 120, updatedMinutesAgo: 60, ...noTranscript(1) });
    await insertCall(SID_LONG_AT_CAP, { seconds: 60, createdMinutesAgo: 120, updatedMinutesAgo: 60, ...noTranscript(3) });
    await insertCall(SID_SHORT_DIED, {
      seconds: 8, createdMinutesAgo: 40, updatedMinutesAgo: 30,
      processing_status: 'processing', processing_started_at: minutesAgo(30), processing_heartbeat_at: minutesAgo(30),
    });
    await insertCall(SID_SHORT_VOICEMAIL, { seconds: 8, createdMinutesAgo: 120, updatedMinutesAgo: 60, processing_status: 'voicemail' });
    await insertCall(SID_LONG_VOICEMAIL, { seconds: 60, createdMinutesAgo: 120, updatedMinutesAgo: 60, processing_status: 'voicemail' });
    await insertCall(SID_PAN_RETRY, { seconds: 4, createdMinutesAgo: 120, updatedMinutesAgo: 60, ...PAN_QUARANTINED, processing_status: 'extraction_failed', extraction_attempts: 1 });
    await insertCall(SID_PAN_FINISHED, { seconds: 4, createdMinutesAgo: 120, updatedMinutesAgo: 60, ...PAN_QUARANTINED, processing_status: 'voicemail' });
    await insertCall(SID_SWEPT_VOICEMAIL, { seconds: 8, createdMinutesAgo: 40, updatedMinutesAgo: 1, processing_status: 'voicemail', processing_generation: 1 });
    await insertCall(SID_SWEPT_SPAM, { seconds: 8, createdMinutesAgo: 40, updatedMinutesAgo: 1, processing_status: 'spam', processing_generation: 1 });
    await insertCall(SID_SWEPT_CUSTOMER_FAILED, { seconds: 8, createdMinutesAgo: 40, updatedMinutesAgo: 1, processing_status: 'customer_creation_failed', processing_generation: 1 });
    await insertCall(SID_SWEPT_LEAD_FAILED, { seconds: 8, createdMinutesAgo: 40, updatedMinutesAgo: 1, processing_status: 'lead_creation_failed', processing_generation: 1 });
    await insertCall(SID_OVERTAKEN_FIRST, { seconds: 8, createdMinutesAgo: 40, updatedMinutesAgo: 1, processing_generation: 1 });
    await insertCall(SID_OVERTAKEN_RETRY, { seconds: 60, createdMinutesAgo: 40, updatedMinutesAgo: 20, processing_status: 'no_transcription', extraction_attempts: 1, processing_generation: 1 });
    await insertCall(SID_OVERTAKEN_SHORT_NO_TRANSCRIPT, { seconds: 8, createdMinutesAgo: 40, updatedMinutesAgo: 20, processing_status: 'no_transcription', extraction_attempts: 1, processing_generation: 1 });
    await insertCall(SID_OVERTAKEN_SHORT_FAILED, { seconds: 8, createdMinutesAgo: 40, updatedMinutesAgo: 20, processing_status: 'extraction_failed', extraction_attempts: 1, processing_generation: 1 });
    await insertCall(SID_OVERTAKEN_CLAIM, {
      seconds: 8, createdMinutesAgo: 40, updatedMinutesAgo: 1, processing_generation: 1,
      processing_status: 'processing', processing_started_at: minutesAgo(1), processing_heartbeat_at: minutesAgo(1),
    });
  });

  afterAll(async () => {
    await db('call_log').whereIn('twilio_call_sid', ALL_SIDS).del();
    await db.destroy();
  });

  test('gate off: only the long call and the quarantined retry are swept; a long call at the attempt cap or a long settled voicemail takes no slot', async () => {
    await withGate(undefined, async () => {
      expect(await candidates()).toEqual([SID_LONG, SID_PAN_RETRY].sort());
    });
  });

  test('gate on: a stranded short first pass is swept too; a day-old one, one still settling, and a short retry or finished row are not', async () => {
    await withGate('true', async () => {
      expect(await candidates()).toEqual([SID_SHORT, SID_LONG, SID_SHORT_DIED, SID_PAN_RETRY].sort());
    });
  });

  // A timer can finish a selected row before its turn. The ordinary claim accepts a voicemail row, and a
  // quarantined row has no length floor: the claim's re-check of the whole candidate rule is what
  // refuses these (pre-push Codex P1, rounds 4-6).
  test.each([
    ['a short voicemail with a stuck transcript', SID_SHORT_VOICEMAIL],
    ['a long voicemail with a stuck transcript', SID_LONG_VOICEMAIL],
    ['a card-number-quarantined voicemail', SID_PAN_FINISHED],
  ])('a sweep pass refuses %s, gate on or off, and changes nothing', async (_what, target) => {
    for (const value of [undefined, 'true']) {
      await withGate(value, async () => {
        const out = await processor.processRecording(target, { sweep: true });
        expect(out).toMatchObject({ success: false, skipped: true });
        const row = await db('call_log').where({ twilio_call_sid: target }).first('processing_status', 'processing_token');
        expect(row).toEqual({ processing_status: 'voicemail', processing_token: null });
      });
    }
  });

  // The ordering where the sweep finishes first (pre-push Codex P1, rounds 8 and 9): the claim accepts a voicemail,
  // spam or creation-failure row, so only the timer's generation fence refuses it.
  test.each([
    ['voicemail', SID_SWEPT_VOICEMAIL],
    ['spam', SID_SWEPT_SPAM],
    ['customer_creation_failed', SID_SWEPT_CUSTOMER_FAILED],
    ['lead_creation_failed', SID_SWEPT_LEAD_FAILED],
  ])('a webhook timer scheduled before the sweep finished the call as %s refuses it and changes nothing, gate on or off', async (status, target) => {
    for (const value of [undefined, 'true']) {
      await withGate(value, async () => {
        expect(await processor.processRecording(target, { scheduledGeneration: 0 })).toMatchObject({ success: false, skipped: true, reason: 'already_processing' });
        const row = await db('call_log').where({ twilio_call_sid: target }).first('processing_status', 'processing_token', 'processing_generation');
        expect(row).toEqual({ processing_status: status, processing_token: null, processing_generation: 1 });
      });
    }
  });

  // The fence on real rows (rounds 9, 11 and 12): a timer takes a first-pass state, a claim, or a retry state the sweep
  // would retry now, overtaken or not; never a short call's failure. Overtaken, it never takes a verdict or a creation
  // failure either; not overtaken, the claim's own rules decide those.
  test('an overtaken timer\'s fence admits only a row still owed a pass', async () => {
    const admitted = async (scheduledGeneration) => (await db('call_log').whereIn('twilio_call_sid', TIMER_SIDS)
      .where(function claim() { processor.whereUnattendedClaim(this, { scheduledGeneration }); })
      .pluck('twilio_call_sid')).sort();
    for (const value of [undefined, 'true']) {
      await withGate(value, async () => {
        expect(await admitted(0)).toEqual([SID_OVERTAKEN_FIRST, SID_OVERTAKEN_RETRY, SID_OVERTAKEN_CLAIM].sort());
        expect(await admitted(1)).toEqual(TIMER_SIDS.filter((t) => ![SID_OVERTAKEN_SHORT_NO_TRANSCRIPT, SID_OVERTAKEN_SHORT_FAILED].includes(t)).sort());
      });
    }
  });

  // The same refusal through the real claim (pre-push Codex P1, rounds 11 and 12): a short call's failure under the cap,
  // its backoff past, and a timer a newer pass overtook (generation 0) or a duplicate delivery scheduled after the
  // sweep's pass (generation 1). The sweep never retries such a row, so no timer does either.
  test.each([
    ['no_transcription', 'overtaken', SID_OVERTAKEN_SHORT_NO_TRANSCRIPT, 0],
    ['extraction_failed', 'overtaken', SID_OVERTAKEN_SHORT_FAILED, 0],
    ['no_transcription', 'a late duplicate\'s', SID_OVERTAKEN_SHORT_NO_TRANSCRIPT, 1],
    ['extraction_failed', 'a late duplicate\'s', SID_OVERTAKEN_SHORT_FAILED, 1],
  ])('a webhook timer refuses a short call\'s %s past its backoff (%s) and changes nothing, gate on or off', async (status, _which, target, scheduledGeneration) => {
    for (const value of [undefined, 'true']) {
      await withGate(value, async () => {
        expect(await processor.processRecording(target, { scheduledGeneration })).toMatchObject({ success: false, skipped: true, reason: 'already_processing' });
        const row = await db('call_log').where({ twilio_call_sid: target })
          .first('processing_status', 'processing_token', 'extraction_attempts', 'processing_generation');
        expect(row).toEqual({ processing_status: status, processing_token: null, extraction_attempts: 1, processing_generation: 1 });
      });
    }
  });

  test('gate on: the stats that mirror the sweep run on the same rule', async () => {
    await withGate('true', async () => {
      const stats = await processor.getStats();
      expect(stats.retrying).toEqual(expect.any(Number));
      expect(stats.oldestUnfinishedMinutes).toEqual(expect.any(Number));
    });
  });
});
