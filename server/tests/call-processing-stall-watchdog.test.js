// Stall watchdog classifier + the call-time SLA anchor. Fixtures are
// fictitious; phones are reserved 555-01xx numbers.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  computeStalledCalls,
  GRACE_MINUTES,
  MIN_DURATION_SECONDS,
  CLAIM_STALE_MINUTES,
} = require('../services/call-processing-stall-watchdog');
const CallRecordingProcessor = require('../services/call-recording-processor');
const { leadFirstContactAt } = CallRecordingProcessor._test;

const NOW = new Date('2026-08-31T15:00:00Z');
const mins = (n) => new Date(NOW.getTime() - n * 60000).toISOString();
const base = {
  recording_url: 'https://api.twilio.com/x.mp3',
  recording_duration_seconds: 60,
  duration_seconds: 65,
  transcription: null,
  transcription_metadata: null,
};

describe('computeStalledCalls', () => {
  test('a wedged claim past the grace window is stalled', () => {
    const rows = [{ ...base, created_at: mins(GRACE_MINUTES + 5), processing_status: 'processing' }];
    expect(computeStalledCalls(rows, { now: NOW })).toHaveLength(1);
  });

  test('a never-claimed recorded call past the grace window is stalled', () => {
    const rows = [{ ...base, created_at: mins(GRACE_MINUTES + 5), processing_status: null }];
    expect(computeStalledCalls(rows, { now: NOW })).toHaveLength(1);
  });

  test('a call still inside the grace window is left alone', () => {
    const rows = [{ ...base, created_at: mins(GRACE_MINUTES - 5), processing_status: 'processing' }];
    expect(computeStalledCalls(rows, { now: NOW })).toHaveLength(0);
  });

  test('terminal states are never stalled, whatever they are', () => {
    const rows = ['processed', 'voicemail', 'spam', 'no_transcription', 'extraction_failed']
      .map((st) => ({ ...base, created_at: mins(120), processing_status: st }));
    expect(computeStalledCalls(rows, { now: NOW })).toHaveLength(0);
  });

  test('recording-less rows are skipped unless PAN-quarantined', () => {
    const rows = [
      { ...base, recording_url: '', created_at: mins(120), processing_status: null },
      {
        ...base,
        recording_url: '',
        transcription: 'masked transcript',
        transcription_metadata: JSON.stringify({ pan_detected: true }),
        created_at: mins(120),
        processing_status: null,
      },
    ];
    const stalled = computeStalledCalls(rows, { now: NOW });
    expect(stalled).toHaveLength(1);
    expect(stalled[0].transcription).toBe('masked transcript');
  });

  test('a quarantined row WITHOUT its masked transcript cannot stall — the processor skips it', () => {
    // processAllPending's quarantine branch requires transcription NOT NULL.
    const quarantined = {
      ...base,
      recording_url: '',
      recording_duration_seconds: 0,
      duration_seconds: 0,
      transcription_metadata: { pan_detected: true },
      created_at: mins(120),
      processing_status: 'processing',
      processing_started_at: mins(120),
    };
    expect(computeStalledCalls([{ ...quarantined, transcription: null }], { now: NOW })).toHaveLength(0);
    expect(computeStalledCalls([{ ...quarantined, transcription: 'masked' }], { now: NOW })).toHaveLength(1);
  });

  test('a 0-second recording is authoritative — it never borrows the call duration', () => {
    // processAllPending uses COALESCE(recording_duration_seconds,
    // duration_seconds, 0), so this row is one the processor skips by design.
    const rows = [{
      ...base,
      recording_duration_seconds: 0,
      duration_seconds: 300,
      created_at: mins(120),
      processing_status: null,
    }];
    expect(computeStalledCalls(rows, { now: NOW })).toHaveLength(0);
  });

  test('a long call is not stalled the moment its recording lands', () => {
    // 30-minute call that ended 2 minutes ago: created_at is 32 minutes old,
    // but the recording could not have existed until the call ended, so the
    // pipeline has had 2 minutes, not 32.
    const rows = [{
      ...base,
      duration_seconds: 30 * 60,
      recording_duration_seconds: 30 * 60,
      created_at: mins(32),
      processing_status: null,
    }];
    expect(computeStalledCalls(rows, { now: NOW })).toHaveLength(0);
  });

  test('the same long call IS stalled once the grace window passes from call END', () => {
    const rows = [{
      ...base,
      duration_seconds: 30 * 60,
      recording_duration_seconds: 30 * 60,
      created_at: mins(30 + GRACE_MINUTES + 5),
      processing_status: null,
    }];
    expect(computeStalledCalls(rows, { now: NOW })).toHaveLength(1);
  });

  test('a just-recovered recording gets its window, however old the call is', () => {
    // recoverMissingRecentRecordings attached the recording a minute ago;
    // processAllPending deliberately waits 10 minutes from that write.
    const rows = [{
      ...base,
      created_at: mins(3 * 24 * 60),
      updated_at: mins(1),
      processing_status: null,
    }];
    expect(computeStalledCalls(rows, { now: NOW })).toHaveLength(0);
  });

  test('a recovered recording still alerts once its own window passes', () => {
    const rows = [{
      ...base,
      created_at: mins(3 * 24 * 60),
      updated_at: mins(GRACE_MINUTES + 5),
      processing_status: null,
    }];
    expect(computeStalledCalls(rows, { now: NOW })).toHaveLength(1);
  });

  test('a claimed row is aged from its claim, not from a claim-bumped updated_at', () => {
    const rows = [{
      ...base,
      created_at: mins(120),
      updated_at: mins(1),
      processing_status: 'processing',
      processing_started_at: mins(GRACE_MINUTES + 10),
    }];
    expect(computeStalledCalls(rows, { now: NOW })).toHaveLength(1);
  });

  test('a call processAllPending just reclaimed is working, not wedged', () => {
    const rows = [{
      ...base,
      created_at: mins(GRACE_MINUTES + 15),
      processing_status: 'processing',
      processing_started_at: mins(1),
    }];
    expect(computeStalledCalls(rows, { now: NOW })).toHaveLength(0);
  });

  test('a claim the processor itself would reclaim is wedged', () => {
    // The crash-reclaim loop that hid the 2026-08-31 wedge: the sweep resets
    // processing_started_at every cycle, so the claim never aged past the
    // 20-minute grace window — only past the processor's own 10-minute
    // reclaim threshold.
    const rows = [{
      ...base,
      created_at: mins(GRACE_MINUTES + 15),
      processing_status: 'processing',
      processing_started_at: mins(CLAIM_STALE_MINUTES + 2),
    }];
    expect(computeStalledCalls(rows, { now: NOW })).toHaveLength(1);
  });

  test('a claim age the processor would still call live is caught anyway', () => {
    // A perfectly-phased crash loop reclaims exactly as the claim hits the
    // processor's 10 minutes, so a threshold of 10 would never once observe
    // it stale. The bell is per-day, not permanent, which is what makes
    // calling a claim dead two minutes early safe.
    const rows = [{
      ...base,
      created_at: mins(GRACE_MINUTES + 15),
      processing_status: 'processing',
      processing_started_at: mins(9),
    }];
    expect(computeStalledCalls(rows, { now: NOW })).toHaveLength(1);
  });

  test('a healthy long pass is judged by its HEARTBEAT, not its start time', () => {
    // A long transcription is a pass working perfectly; aging it from
    // processing_started_at alone rang a false stall on it. Inside the
    // absolute ceiling, the beat is what decides.
    const rows = [{
      ...base,
      created_at: mins(GRACE_MINUTES + 30),
      processing_status: 'processing',
      processing_started_at: mins(15),
      processing_heartbeat_at: mins(1),
    }];
    expect(computeStalledCalls(rows, { now: NOW })).toHaveLength(0);
  });

  test('a claim whose heartbeat STOPPED is wedged, however recently it started', () => {
    const rows = [{
      ...base,
      created_at: mins(GRACE_MINUTES + 30),
      processing_status: 'processing',
      processing_started_at: mins(2),
      processing_heartbeat_at: mins(CLAIM_STALE_MINUTES + 2),
    }];
    expect(computeStalledCalls(rows, { now: NOW })).toHaveLength(1);
  });

  test('a hung pass that keeps beating is still a stall past the ceiling', () => {
    // The heartbeat is a timer: a provider call hung on an open socket keeps
    // the event loop alive and the beats coming. The absolute ceiling is what
    // stops that from being invisible here and unreclaimable there.
    const rows = [{
      ...base,
      created_at: mins(GRACE_MINUTES + 60),
      processing_status: 'processing',
      processing_started_at: mins(require('../utils/claim-ceiling').claimAbsoluteCeilingMinutes() + 5),
      processing_heartbeat_at: mins(1),
    }];
    expect(computeStalledCalls(rows, { now: NOW })).toHaveLength(1);
  });

  test('a claim the processor still considers live is honoured', () => {
    const rows = [{
      ...base,
      created_at: mins(GRACE_MINUTES + 15),
      processing_status: 'processing',
      processing_started_at: mins(CLAIM_STALE_MINUTES - 2),
    }];
    expect(computeStalledCalls(rows, { now: NOW })).toHaveLength(0);
  });

  test('a force-reprocess of an old call is a pass in flight, not a stall', () => {
    // A live claim is honoured however old the call is: alerting here would
    // settle the SID forever and silence the real wedge if this pass died.
    const rows = [{
      ...base,
      created_at: mins(90 * 24 * 60),
      processing_status: 'processing',
      processing_started_at: mins(1),
    }];
    expect(computeStalledCalls(rows, { now: NOW })).toHaveLength(0);
  });

  test('a months-old wedge is still stalled — no age cutoff hides it', () => {
    const rows = [{
      ...base,
      created_at: mins(52 * 24 * 60),
      processing_status: 'processing',
      processing_started_at: mins(52 * 24 * 60),
    }];
    expect(computeStalledCalls(rows, { now: NOW })).toHaveLength(1);
  });

  test('dead-air blips below the processing floor are skipped', () => {
    const rows = [{
      ...base,
      recording_duration_seconds: MIN_DURATION_SECONDS - 1,
      duration_seconds: MIN_DURATION_SECONDS - 1,
      created_at: mins(120),
      processing_status: null,
    }];
    expect(computeStalledCalls(rows, { now: NOW })).toHaveLength(0);
  });
});

describe('post-call rows: created_at is NOT the call start', () => {
  const POST_CALL = {
    ...base,
    duration_seconds: 10 * 60,
    recording_duration_seconds: 10 * 60,
    metadata: JSON.stringify({ source: 'status_callback' }),
  };

  test('the watchdog does not count a post-call row\'s duration twice', () => {
    // Inserted 5 minutes ago, AFTER a 10-minute call: readiness is the
    // insert moment, not 10 minutes into the future.
    const rows = [{ ...POST_CALL, created_at: mins(5), processing_status: null }];
    expect(computeStalledCalls(rows, { now: NOW })).toHaveLength(0);
    const later = [{ ...POST_CALL, created_at: mins(GRACE_MINUTES + 5), processing_status: null }];
    expect(computeStalledCalls(later, { now: NOW })).toHaveLength(1);
  });

  test('the SLA clock backs the call length out of a post-call row', () => {
    const created = new Date(Date.now() - 5 * 60000);
    const anchored = leadFirstContactAt({ ...POST_CALL, created_at: created.toISOString() });
    // The caller dialled 10 minutes before the row was inserted.
    expect(Math.round((created.getTime() - anchored.getTime()) / 60000)).toBe(10);
  });

  test('a post-call row with duration_seconds 0 uses the recording duration', () => {
    // The fallback insert stores 0 when Twilio's CallDuration was missing and
    // picks the recording duration up later; taking the 0 would place the
    // call's start at its completion.
    const created = new Date(Date.now() - 5 * 60000);
    const anchored = leadFirstContactAt({
      ...POST_CALL,
      duration_seconds: 0,
      recording_duration_seconds: 10 * 60,
      created_at: created.toISOString(),
    });
    expect(Math.round((created.getTime() - anchored.getTime()) / 60000)).toBe(10);
  });

  test('a /voice row is untouched — its created_at IS the call start', () => {
    const created = new Date(Date.now() - 5 * 60000);
    const anchored = leadFirstContactAt({
      ...base,
      duration_seconds: 10 * 60,
      created_at: created.toISOString(),
      metadata: JSON.stringify({ source: 'voice_webhook' }),
    });
    expect(anchored.getTime()).toBe(created.getTime());
  });
});

describe('leadFirstContactAt — the SLA clock starts when the customer called', () => {
  test('a recent call anchors the lead at the call moment', () => {
    const callAt = new Date(Date.now() - 20 * 60000);
    expect(leadFirstContactAt({ created_at: callAt.toISOString() }).getTime()).toBe(callAt.getTime());
  });

  test('re-running an ALREADY-PROCESSED old call falls back to now', () => {
    const callAt = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const anchored = leadFirstContactAt(
      { created_at: callAt.toISOString() },
      { reprocessOfProcessed: true },
    );
    expect(Date.now() - anchored.getTime()).toBeLessThan(5000);
  });

  test('every COMPLETED state clamps, every retry state does not', () => {
    // Mirrors processRecording's COMPLETED_STATUSES: a months-old voicemail
    // re-read as a lead must not inject its original call time, while an
    // extraction_failed retry is unfinished work that kept waiting.
    const callAt = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const row = { created_at: callAt.toISOString() };
    for (const completed of [true, false]) {
      const anchored = leadFirstContactAt(row, { reprocessOfProcessed: completed });
      if (completed) expect(Date.now() - anchored.getTime()).toBeLessThan(5000);
      else expect(anchored.getTime()).toBe(callAt.getTime());
    }
  });

  test('a manual Process on a WEDGED old call keeps the real wait', () => {
    // The admin panel sends force=true for pending/wedged rows too, so
    // clamping on force would erase the wait from the very recovery the
    // stall watchdog's own alert asks the owner to perform.
    const callAt = new Date(Date.now() - 5 * 24 * 3600 * 1000);
    const anchored = leadFirstContactAt(
      { created_at: callAt.toISOString() },
      { reprocessOfProcessed: false },
    );
    expect(anchored.getTime()).toBe(callAt.getTime());
  });

  test('an ordinary pass keeps the true call time through a multi-day outage', () => {
    // The bug this whole change exists to fix: a call that sat through a
    // 3-day outage waited 3 days, and the SLA has to say so.
    const callAt = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    const anchored = leadFirstContactAt({ created_at: callAt.toISOString() });
    expect(anchored.getTime()).toBe(callAt.getTime());
  });

  test('a missing or unparseable call time falls back to now', () => {
    for (const call of [{}, { created_at: 'not a date' }, null]) {
      const anchored = leadFirstContactAt(call);
      expect(Date.now() - anchored.getTime()).toBeLessThan(5000);
    }
  });
});

// ── runInner pagination ───────────────────────────────────────────────
// The scan pages OLDEST-first through unsettled candidates because
// eligibility lives in computeStalledCalls, not in SQL: a single capped
// query would let unsettled-but-ineligible rows (dead-air blips, calls
// still inside the grace window) own the cap and hide an old wedge forever.
describe('runCallProcessingStallWatchdog — paging past ineligible rows', () => {
  const PAGE_SIZE = require('../services/call-processing-stall-watchdog').PAGE_SIZE;
  let pages;
  let notified;

  beforeEach(() => {
    jest.resetModules();
    process.env.GATE_CALL_PROCESSING_STALL_WATCHDOG = 'true';
    pages = [];
    notified = [];
  });

  afterEach(() => {
    delete process.env.GATE_CALL_PROCESSING_STALL_WATCHDOG;
  });

  const load = () => {
    // Chainable stub: every builder method returns the builder; awaiting it
    // resolves the page at the requested offset.
    const dbMock = jest.fn(() => {
      const b = { _offset: 0 };
      const chain = new Proxy(b, {
        get(target, prop) {
          if (prop === 'then') {
            return (resolve) => resolve(pages[target._offset / PAGE_SIZE] || []);
          }
          if (prop === 'offset') return (n) => { target._offset = n; return chain; };
          if (prop in target) return target[prop];
          return () => chain;
        },
      });
      return chain;
    });
    dbMock.raw = jest.fn();
    jest.doMock('../models/db', () => dbMock);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../utils/cron-lock', () => ({ runExclusive: (_k, fn) => fn() }));
    jest.doMock('../services/notification-service', () => ({
      notifyAdmin: jest.fn(async (category, title, body, opts) => {
        notified.push({ title, body, opts });
        return { id: 'notif-1' };
      }),
    }));
    return require('../services/call-processing-stall-watchdog');
  };

  test('an old wedge behind a full page of ineligible rows still rings', async () => {
    const wedge = {
      ...base,
      twilio_call_sid: 'CA-wedge',
      from_phone: '+19415550100',
      created_at: new Date('2026-07-10T14:00:00Z').toISOString(),
      processing_status: 'processing',
      processing_started_at: new Date('2026-07-10T14:00:00Z').toISOString(),
    };
    // Page 0 is a full page of dead-air blips — unsettled forever, and the
    // rows a newest-first single query would have stopped at.
    pages = [
      Array.from({ length: PAGE_SIZE }, (_, i) => ({
        ...base,
        twilio_call_sid: `CA-blip-${i}`,
        recording_duration_seconds: MIN_DURATION_SECONDS - 1,
        duration_seconds: MIN_DURATION_SECONDS - 1,
        created_at: mins(120),
        processing_status: null,
      })),
      [wedge],
    ];
    const { runCallProcessingStallWatchdog } = load();
    const result = await runCallProcessingStallWatchdog({ now: NOW });
    expect(result).toMatchObject({ skipped: false, stalled: 1, alerted: 1 });
    expect(result.scanned).toBe(PAGE_SIZE + 1);
    expect(notified).toHaveLength(1);
    expect(notified[0].opts.dedupeKey).toBe('call-stall:CA-wedge:2026-08-31');
    expect(notified[0].opts.bell).toBe(true);
  });

  test('a silenced bell is reported as unannounced, never as alerted', async () => {
    pages = [[{
      ...base,
      twilio_call_sid: 'CA-silenced',
      created_at: mins(120),
      processing_status: 'processing',
      processing_started_at: mins(120),
    }]];
    jest.resetModules();
    const { runCallProcessingStallWatchdog } = load();
     
    require('../services/notification-service').notifyAdmin
      .mockResolvedValueOnce({ id: null, suppressed: true, reason: 'bell_policy' });
    const result = await runCallProcessingStallWatchdog({ now: NOW });
    expect(result).toMatchObject({ stalled: 1, alerted: 0, unannounced: 1 });
  });

  test('two aggregate batches in the same hour each ring — the key is the batch, not the clock', async () => {
    const batch = (prefix) => Array.from({ length: 4 }, (_, i) => ({
      ...base,
      twilio_call_sid: `CA-${prefix}-${i}`,
      created_at: mins(120),
      processing_status: 'processing',
      processing_started_at: mins(120),
    }));

    pages = [batch('first')];
    const first = load();
    const r1 = await first.runCallProcessingStallWatchdog({ now: NOW });
    expect(r1).toMatchObject({ alerted: 1, aggregate: true });

    // Same UTC hour, a wholly new set of stalled calls: the old hour-keyed
    // dedupe skipped the write and still reported alerted: 1.
    pages = [batch('second')];
    const second = load();
    const r2 = await second.runCallProcessingStallWatchdog({
      now: new Date(NOW.getTime() + 30 * 60000),
    });
    expect(r2).toMatchObject({ alerted: 1, aggregate: true });

    expect(notified).toHaveLength(2);
    expect(notified[0].opts.dedupeKey).not.toBe(notified[1].opts.dedupeKey);
    expect(notified[0].opts.dedupeKey).toMatch(/^call-stall-outage:2026-08-31:/);
    expect(notified[1].opts.metadata.stalled_call_sids).toEqual([
      'CA-second-0', 'CA-second-1', 'CA-second-2', 'CA-second-3',
    ]);
  });

  test('the demo/App Store review account never rings the bell', async () => {
    // notification-service's central suppression keys on a customer id in
    // the metadata, which an aggregate bell cannot carry — so these rows
    // must be dropped before alerting, not after.
    const { INTERNAL_TEST_CUSTOMER_IDS } = require('../services/internal-test-customers');
    const testId = [...INTERNAL_TEST_CUSTOMER_IDS][0];
    expect(testId).toBeTruthy();
    pages = [[{
      ...base,
      twilio_call_sid: 'CA-demo',
      customer_id: testId,
      created_at: mins(120),
      processing_status: 'processing',
      processing_started_at: mins(120),
    }]];
    const { runCallProcessingStallWatchdog } = load();
    const result = await runCallProcessingStallWatchdog({ now: NOW });
    expect(result.alerted).toBe(0);
    expect(notified).toHaveLength(0);
  });

  test('the day key is the ET calendar day, not UTC', async () => {
    // 2026-09-01T02:00Z is still 2026-08-31 at 10pm in Adam's day.
    pages = [[{
      ...base,
      twilio_call_sid: 'CA-late',
      created_at: mins(120),
      processing_status: 'processing',
      processing_started_at: mins(120),
    }]];
    const { runCallProcessingStallWatchdog } = load();
    await runCallProcessingStallWatchdog({ now: new Date('2026-09-01T02:00:00Z') });
    expect(notified[0].opts.dedupeKey).toBe('call-stall:CA-late:2026-08-31');
  });

  test('the gate off makes every tick a no-op', async () => {
    process.env.GATE_CALL_PROCESSING_STALL_WATCHDOG = 'false';
    const { runCallProcessingStallWatchdog } = load();
    expect(await runCallProcessingStallWatchdog({ now: NOW })).toEqual({ skipped: true, reason: 'gated_off' });
    expect(notified).toHaveLength(0);
  });
});
