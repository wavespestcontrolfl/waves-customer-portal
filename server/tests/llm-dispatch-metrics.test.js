// Locks the LLM dispatch observability contract: recording is a no-op while
// the gate is off, never throws into the dispatcher's hot path even when the
// DB insert fails, labels policies by their registry `name` (twin policies
// with identical resolved routes must NOT merge), and the exception detector
// only fires on all-providers-failed, fallback-rate spikes, and gone-silent
// policies. The daily digest FAILS the cron job when its exception email
// cannot be delivered (a swallowed send error would silently lose the alert).

const mockInsert = jest.fn();
const mockDb = jest.fn(() => ({ insert: mockInsert }));
// db.raw serves two roles: a synchronous SQL-fragment token inside
// loadStats' aggregations, and the awaited `SELECT 1` reachability confirm in
// alertRecorderUnreachable. Routing it through a jest fn lets tests reject
// the confirm to simulate a genuine outage.
const mockDbRaw = jest.fn((sql) => sql);
jest.mock('../models/db', () => {
  const db = (...args) => mockDb(...args);
  db.raw = (...args) => mockDbRaw(...args);
  return db;
});
const mockEmailSend = jest.fn();
jest.mock('../services/email', () => ({ send: (...args) => mockEmailSend(...args) }));
// The reachability confirm uses a DEDICATED pg.Client (never the shared knex
// pool — pool saturation must not read as a database outage).
const mockPgConnect = jest.fn();
const mockPgQuery = jest.fn();
jest.mock('pg', () => ({
  Client: jest.fn(() => ({
    connect: (...a) => mockPgConnect(...a),
    query: (...a) => mockPgQuery(...a),
    end: jest.fn(() => Promise.resolve()),
  })),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const MODELS = require('../config/models');

const ORIGINAL_ENV = { ...process.env };

function load() {
  let mod;
  jest.isolateModules(() => { mod = require('../services/llm-dispatch-metrics'); });
  return mod;
}

// Thenable knex-chain stub: every builder method returns the chain, awaiting
// it resolves `rows`, and .del() resolves `delCount` for the prune call.
function makeChain(rows, delCount = 0, { insertError = null, first = null, selectError = null } = {}) {
  const chain = {};
  for (const m of ['where', 'andWhere', 'whereNot', 'groupBy', 'select', 'count', 'sum']) {
    chain[m] = jest.fn(() => chain);
  }
  chain.del = jest.fn(() => Promise.resolve(delCount));
  chain.insert = jest.fn(() => (insertError ? Promise.reject(new Error(insertError)) : Promise.resolve([1])));
  chain.first = jest.fn(() => (selectError ? Promise.reject(new Error(selectError)) : Promise.resolve(first)));
  chain.then = (onResolve, onReject) => (selectError
    ? Promise.reject(new Error(selectError)).then(onResolve, onReject)
    : Promise.resolve(rows).then(onResolve, onReject));
  return chain;
}

describe('llm-dispatch-metrics', () => {
  beforeEach(() => {
    // The service lazy-requires feature-gates at call time (not load time), so
    // the registry must reset per test or the first test's gate value caches.
    jest.resetModules();
    jest.clearAllMocks();
    // clearAllMocks does NOT drain a mockReturnValueOnce queue. A test whose
    // digest short-circuits (gate off, or a probe insert that throws before
    // its cleanup delete) leaves queued chains behind, and they would shift
    // every db() call in the NEXT test by one. mockReset drains the queue.
    mockDb.mockReset();
    mockDb.mockImplementation(() => ({ insert: mockInsert }));
    mockDbRaw.mockReset();
    mockDbRaw.mockImplementation((sql) => sql);
    mockPgConnect.mockReset();
    mockPgConnect.mockResolvedValue(undefined);
    mockPgQuery.mockReset();
    mockPgQuery.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    mockInsert.mockReturnValue(Promise.resolve());
    process.env = { ...ORIGINAL_ENV };
    delete process.env.GATE_LLM_DISPATCH_METRICS;
  });
  afterAll(() => { process.env = ORIGINAL_ENV; });

  describe('policyLabel', () => {
    it('names TEXT_POLICIES entries by their registry key', () => {
      const { policyLabel } = load();
      expect(policyLabel(MODELS.TEXT_POLICIES.report)).toBe('report');
      expect(policyLabel(MODELS.TEXT_POLICIES.fastStructured)).toBe('fastStructured');
    });

    it('keeps twin policies with identical resolved routes distinct', () => {
      // With current defaults customerCopy/visionAnalysis (and highStakes/
      // deepAnalysis) resolve to the SAME provider+model pairs — labeling must
      // come from the registry name, never from the route signature, or their
      // stats merge and a gone-silent twin hides behind the other's traffic.
      const { policyLabel } = load();
      expect(policyLabel(MODELS.TEXT_POLICIES.customerCopy)).toBe('customerCopy');
      expect(policyLabel(MODELS.TEXT_POLICIES.visionAnalysis)).toBe('visionAnalysis');
      expect(policyLabel(MODELS.TEXT_POLICIES.highStakes)).toBe('highStakes');
      expect(policyLabel(MODELS.TEXT_POLICIES.deepAnalysis)).toBe('deepAnalysis');
    });

    it('prefers an explicit name on ad-hoc policies (distinct lanes can share routes)', () => {
      const { policyLabel } = load();
      const named = { name: 'callExtraction', primary: { provider: 'openai', model: 'model-a' }, fallback: { provider: 'anthropic', model: 'model-b' } };
      expect(policyLabel(named)).toBe('callExtraction');
    });

    it('labels anonymous policies by the FULL route pair, never primary alone', () => {
      // Two lanes sharing a primary but differing in fallback must not merge.
      const { policyLabel } = load();
      const a = { primary: { provider: 'openai', model: 'model-a' }, fallback: { provider: 'anthropic', model: 'model-b' } };
      const b = { primary: { provider: 'openai', model: 'model-a' }, fallback: { provider: 'anthropic', model: 'model-c' } };
      expect(policyLabel(a)).toBe('openai/model-a→anthropic/model-b');
      expect(policyLabel(b)).toBe('openai/model-a→anthropic/model-c');
      expect(policyLabel(a)).not.toBe(policyLabel(b));
      expect(policyLabel({ primary: { provider: 'openai', model: 'model-a' } })).toBe('openai/model-a');
      expect(policyLabel(null)).toBe('unknown');
    });
  });

  describe('recordDispatch', () => {
    it('is a no-op while the gate is off', () => {
      const { recordDispatch } = load();
      recordDispatch(MODELS.TEXT_POLICIES.report, { ok: true, provider: 'openai', model: 'model-x' });
      expect(mockDb).not.toHaveBeenCalled();
    });

    it('inserts one row per chain when the gate is on', () => {
      process.env.GATE_LLM_DISPATCH_METRICS = 'true';
      const { recordDispatch } = load();
      recordDispatch(MODELS.TEXT_POLICIES.report, {
        ok: true,
        provider: 'anthropic',
        model: 'model-x',
        fallbackUsed: true,
        failures: [{ provider: 'openai', model: 'model-y', reason: 'openai_429' }],
      });
      expect(mockDb).toHaveBeenCalledWith('llm_dispatch_log');
      const row = mockInsert.mock.calls[0][0];
      expect(row).toMatchObject({
        policy: 'report',
        ok: true,
        provider: 'anthropic',
        model: 'model-x',
        fallback_used: true,
      });
      expect(JSON.parse(row.failure_reasons)).toEqual([
        { provider: 'openai', model: 'model-y', reason: 'openai_429' },
      ]);
    });

    it('tags dispatches inside runAsReplay with a replay lane', async () => {
      process.env.GATE_LLM_DISPATCH_METRICS = 'true';
      const { recordDispatch, runAsReplay } = load();
      await runAsReplay(async () => {
        recordDispatch(MODELS.TEXT_POLICIES.report, { ok: true, provider: 'openai', model: 'model-x' });
      });
      expect(mockInsert.mock.calls[0][0].policy).toBe('report:replay');
    });

    it('keeps an explicit workload lane instead of double-tagging', async () => {
      process.env.GATE_LLM_DISPATCH_METRICS = 'true';
      const { recordDispatch, runAsReplay } = load();
      const sealed = { name: 'smsShadow:openai:sealed', primary: { provider: 'openai', model: 'model-x' } };
      await runAsReplay(async () => {
        recordDispatch(sealed, { ok: true, provider: 'openai', model: 'model-x' });
      });
      expect(mockInsert.mock.calls[0][0].policy).toBe('smsShadow:openai:sealed');
    });

    it('never leaks the replay lane onto concurrent live traffic', async () => {
      process.env.GATE_LLM_DISPATCH_METRICS = 'true';
      const { recordDispatch, runAsReplay } = load();
      const live = { name: 'liveLane', primary: { provider: 'openai', model: 'model-x' } };
      const replayed = { name: 'replayedLane', primary: { provider: 'openai', model: 'model-x' } };
      await Promise.all([
        runAsReplay(async () => {
          await new Promise((r) => setTimeout(r, 5)); // interleave with the live call
          recordDispatch(replayed, { ok: true, provider: 'openai', model: 'model-x' });
        }),
        (async () => {
          recordDispatch(live, { ok: true, provider: 'openai', model: 'model-x' });
        })(),
      ]);
      const labels = mockInsert.mock.calls.map((c) => c[0].policy).sort();
      expect(labels).toEqual(['liveLane', 'replayedLane:replay']);
    });

    it('records failed chains without a provider and never throws on DB errors', () => {
      process.env.GATE_LLM_DISPATCH_METRICS = 'true';
      mockInsert.mockReturnValue(Promise.reject(new Error('db down')));
      const { recordDispatch } = load();
      expect(() => recordDispatch(MODELS.TEXT_POLICIES.report, {
        ok: false,
        reason: 'all_providers_failed',
        failures: [{ provider: 'openai', model: 'model-y', reason: 'openai_500' }],
      })).not.toThrow();
      const row = mockInsert.mock.calls[0][0];
      expect(row.ok).toBe(false);
      expect(row.provider).toBeNull();
    });
  });

  describe('detectExceptions', () => {
    it('flags all-providers-failed chains at any volume', () => {
      const { detectExceptions } = load();
      const out = detectExceptions([{ policy: 'report', total: 2, fallbacks: 0, failed: 1 }], []);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ policy: 'report', kind: 'all_providers_failed' });
    });

    it('flags fallback-rate spikes only above threshold AND volume', () => {
      const { detectExceptions, FALLBACK_MIN_VOLUME } = load();
      const spike = detectExceptions([{ policy: 'customerCopy', total: 10, fallbacks: 4, failed: 0 }], []);
      expect(spike).toHaveLength(1);
      expect(spike[0].kind).toBe('fallback_rate');
      // Below minimum volume: same rate, no exception.
      const lowVolume = detectExceptions(
        [{ policy: 'customerCopy', total: FALLBACK_MIN_VOLUME - 1, fallbacks: FALLBACK_MIN_VOLUME - 1, failed: 0 }],
        []
      );
      expect(lowVolume).toHaveLength(0);
      // Below rate threshold: no exception.
      const lowRate = detectExceptions([{ policy: 'customerCopy', total: 100, fallbacks: 5, failed: 0 }], []);
      expect(lowRate).toHaveLength(0);
    });

    it('flags a previously busy policy that went silent, but not quiet ones', () => {
      const { detectExceptions, SILENT_MIN_WEEKLY } = load();
      // Yesterday must show SOME traffic: one policy going quiet is only
      // meaningful if the recorder itself is provably alive. A wholly empty
      // day is the not_recording case instead.
      const out = detectExceptions([{ policy: 'report', total: 30, fallbacks: 0, failed: 0 }], [
        { policy: 'contentDraft', total: SILENT_MIN_WEEKLY },
        { policy: 'rarePolicy', total: SILENT_MIN_WEEKLY - 1 },
        { policy: 'report', total: 200 },
      ]);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ policy: 'contentDraft', kind: 'gone_silent' });
    });

    it('never flags episodic lanes (:sealed/:backfill/:replay) as gone silent — they burst then quiet by design', () => {
      const { detectExceptions, SILENT_MIN_WEEKLY } = load();
      // Live traffic present, so the recorder is provably alive and the
      // per-policy silence checks apply.
      const out = detectExceptions([{ policy: 'report', total: 30, fallbacks: 0, failed: 0 }], [
        { policy: 'smsShadow:openai:sealed', total: SILENT_MIN_WEEKLY * 2 },
        { policy: 'smsShadow:anthropic:backfill', total: SILENT_MIN_WEEKLY * 2 },
        { policy: 'callExtraction:replay', total: SILENT_MIN_WEEKLY * 2 },
        { policy: 'smsShadow:openai', total: SILENT_MIN_WEEKLY * 2 },
        { policy: 'report', total: 200 },
      ]);
      // Only the LIVE lane fires; episodic twins with identical volume do not.
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ policy: 'smsShadow:openai', kind: 'gone_silent' });
    });

    it('episodic lanes still report failures and fallback spikes', () => {
      const { detectExceptions } = load();
      const out = detectExceptions(
        [{ policy: 'smsShadow:anthropic:backfill', total: 10, fallbacks: 4, failed: 1 }],
        []
      );
      expect(out.map((e) => e.kind).sort()).toEqual(['all_providers_failed', 'fallback_rate']);
    });

    it('reports a FAILED WRITE PROBE as not_recording — silence must not read as healthy', () => {
      const { detectExceptions } = load();
      const out = detectExceptions([], [{ policy: 'report', total: 200 }], 'permission denied for table');
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ kind: 'not_recording' });
      expect(out[0].detail).toMatch(/permission denied for table/);
    });

    it('does NOT alarm on a genuinely quiet day when the probe succeeded', () => {
      // The SMS canary uses bare dispatch (writes no row) and every other
      // instrumented job is candidate-driven, so an empty day is a legitimate
      // quiet-day state — not evidence the recorder broke. Inferring breakage
      // from volume would email a false alarm every quiet weekend.
      const { detectExceptions } = load();
      expect(detectExceptions([], [], null)).toHaveLength(0);
    });

    it('suppresses gone-silent (an absence signal) when the probe failed, but nothing else', () => {
      const { detectExceptions, SILENT_MIN_WEEKLY } = load();
      const out = detectExceptions([], [
        { policy: 'report', total: SILENT_MIN_WEEKLY * 3 },
        { policy: 'customerCopy', total: SILENT_MIN_WEEKLY * 3 },
        { policy: 'contentDraft', total: SILENT_MIN_WEEKLY * 3 },
      ], 'connection refused');
      // A dead recorder fully explains three absent policies — reporting all
      // three would be duplicate symptoms of one root cause.
      expect(out).toHaveLength(1);
      expect(out[0].kind).toBe('not_recording');
    });

    it('still reports REAL provider incidents recorded yesterday when the probe fails', () => {
      // A transient probe blip must never hide an all-providers-failed or
      // fallback spike that is sitting in yesterday's rows — those come from
      // rows that exist, so they are true regardless of recorder health.
      const { detectExceptions } = load();
      const out = detectExceptions(
        [{ policy: 'report', total: 10, fallbacks: 5, failed: 2 }],
        [],
        'connection refused'
      );
      expect(out.map((e) => e.kind).sort()).toEqual(['all_providers_failed', 'fallback_rate', 'not_recording']);
    });

    it('returns nothing on a green day', () => {
      const { detectExceptions } = load();
      const out = detectExceptions(
        [{ policy: 'report', total: 40, fallbacks: 1, failed: 0 }],
        [{ policy: 'report', total: 200 }]
      );
      expect(out).toHaveLength(0);
    });
  });

  describe('recordHeartbeat', () => {
    it('is a no-op while the gate is off', async () => {
      const { recordHeartbeat } = load();
      await expect(recordHeartbeat()).resolves.toEqual({ skipped: 'gate_off' });
      expect(mockDb).not.toHaveBeenCalled();
    });

    it('writes one heartbeat row through the real insert path', async () => {
      process.env.GATE_LLM_DISPATCH_METRICS = 'true';
      const chain = makeChain([]);
      mockDb.mockReturnValueOnce(chain);
      const { recordHeartbeat, HEARTBEAT_POLICY } = load();
      await expect(recordHeartbeat()).resolves.toEqual({ ok: true });
      expect(chain.insert).toHaveBeenCalledWith(expect.objectContaining({ policy: HEARTBEAT_POLICY, ok: true }));
    });

    it('throws on failure so the cron logs it (not the hot path)', async () => {
      process.env.GATE_LLM_DISPATCH_METRICS = 'true';
      mockDb.mockReturnValueOnce(makeChain([], 0, { insertError: 'disk full' }));
      const { recordHeartbeat } = load();
      await expect(recordHeartbeat()).rejects.toThrow(/disk full/);
    });
  });

  describe('alertRecorderUnreachable', () => {
    it('emails when the INDEPENDENT connection probe fails (a genuine outage)', async () => {
      process.env.GATE_LLM_DISPATCH_METRICS = 'true';
      mockEmailSend.mockResolvedValue({ ok: true });
      mockPgConnect.mockRejectedValue(new Error('connection refused'));
      const { alertRecorderUnreachable } = load();
      await expect(alertRecorderUnreachable('no_connection')).resolves.toEqual({ ok: true });
      expect(mockEmailSend.mock.calls[0][0].body).toMatch(/database was unreachable/);
    });

    it('stands down when a FRESH connection succeeds — pool saturation is not an outage', async () => {
      // The confirm must bypass the shared knex pool: a saturated pool would
      // queue (and time out) a pooled SELECT 1 even though PostgreSQL itself
      // is healthy. The dedicated pg.Client answers the real question.
      process.env.GATE_LLM_DISPATCH_METRICS = 'true';
      const { alertRecorderUnreachable } = load();
      await expect(alertRecorderUnreachable('no_connection')).resolves.toEqual({ skipped: 'db_reachable' });
      expect(mockPgConnect).toHaveBeenCalled();
      // And it never touched the shared pool's raw().
      expect(mockDbRaw).not.toHaveBeenCalledWith('SELECT 1');
      expect(mockEmailSend).not.toHaveBeenCalled();
    });

    it('honors the kill switch', async () => {
      const { alertRecorderUnreachable } = load();
      await expect(alertRecorderUnreachable('no_connection')).resolves.toEqual({ skipped: 'gate_off' });
      expect(mockEmailSend).not.toHaveBeenCalled();
    });
  });

  describe('runLlmDispatchDigest', () => {
    // db() call order in runLlmDispatchDigest: retention prune FIRST (it runs
    // even when the gate is off), then yesterday stats, prior-week stats, and
    // the heartbeat count for the day being summarized. `heartbeats` defaults
    // to a healthy day; 0 means the recorder was dead during that day.
    function armDb({
      yesterdayRows, priorRows, delCount = 3,
      heartbeats = 24, priorHeartbeats = 168, pruneError = null, statsError = null,
    }) {
      const prune = makeChain([], delCount);
      if (pruneError) prune.del = jest.fn(() => Promise.reject(new Error(pruneError)));
      mockDb
        .mockReturnValueOnce(prune)
        .mockReturnValueOnce(makeChain(yesterdayRows, 0, { selectError: statsError }))
        .mockReturnValueOnce(makeChain(priorRows))
        .mockReturnValueOnce(makeChain([], 0, { first: { n: String(heartbeats) } }))
        .mockReturnValueOnce(makeChain([], 0, { first: { n: String(priorHeartbeats) } }));
      return { prune };
    }

    it('skips stats and email while the gate is off, but STILL prunes retention', async () => {
      const prune = makeChain([], 7);
      mockDb.mockReturnValueOnce(prune);
      const { runLlmDispatchDigest } = load();
      await expect(runLlmDispatchDigest()).resolves.toEqual({ skipped: 'gate_off', pruned: 7 });
      // Exactly one db call (the prune) — no stats queries, no email.
      expect(mockDb).toHaveBeenCalledTimes(1);
      expect(prune.del).toHaveBeenCalled();
      expect(mockEmailSend).not.toHaveBeenCalled();
    });

    it('sends the exception email and prunes on a degraded day', async () => {
      process.env.GATE_LLM_DISPATCH_METRICS = 'true';
      mockEmailSend.mockResolvedValue({ ok: true });
      const { prune } = armDb({ yesterdayRows: [{ policy: 'report', total: '3', fallbacks: '0', failed: '1' }], priorRows: [] });
      const { runLlmDispatchDigest } = load();
      const out = await runLlmDispatchDigest();
      expect(out).toMatchObject({ emailed: true, pruned: 3 });
      expect(mockEmailSend).toHaveBeenCalledTimes(1);
      expect(mockEmailSend.mock.calls[0][0].to).toBe('contact@wavespestcontrol.com');
      expect(prune.del).toHaveBeenCalled();
    });

    it('emails not_recording when the day had NO heartbeats, even with zero rows', async () => {
      // The gap this lane closes: a day the recorder was dead must produce an
      // email, where before it produced silence.
      process.env.GATE_LLM_DISPATCH_METRICS = 'true';
      mockEmailSend.mockResolvedValue({ ok: true });
      armDb({ yesterdayRows: [], priorRows: [], heartbeats: 0 });
      const { runLlmDispatchDigest } = load();
      const out = await runLlmDispatchDigest();
      expect(out.emailed).toBe(true);
      expect(out.exceptions[0].kind).toBe('not_recording');
      expect(mockEmailSend.mock.calls[0][0].body).toMatch(/no heartbeat rows were recorded/);
    });

    it('an overnight recovery cannot hide a lost day', async () => {
      // Recorder broken all day, healthy again by 06:25. A digest-time probe
      // would pass and report the lost day clean; heartbeats from the day
      // itself are what make this detectable.
      process.env.GATE_LLM_DISPATCH_METRICS = 'true';
      mockEmailSend.mockResolvedValue({ ok: true });
      armDb({ yesterdayRows: [], priorRows: [{ policy: 'report', total: 300 }], heartbeats: 0 });
      const { runLlmDispatchDigest } = load();
      const out = await runLlmDispatchDigest();
      expect(out.emailed).toBe(true);
      expect(out.exceptions.map((e) => e.kind)).toContain('not_recording');
    });

    it('sends a SELF-QUALIFYING notice when no coverage has ever existed — never indefinite silence', async () => {
      // A recorder broken from first deploy (or an outage older than the
      // 7-day lookback) must not be silent forever. The stateless answer is a
      // notice that explains itself: expected once on enablement day, and its
      // daily repetition IS the outage signal.
      process.env.GATE_LLM_DISPATCH_METRICS = 'true';
      mockEmailSend.mockResolvedValue({ ok: true });
      armDb({ yesterdayRows: [], priorRows: [], heartbeats: 0, priorHeartbeats: 0 });
      const { runLlmDispatchDigest } = load();
      const out = await runLlmDispatchDigest();
      expect(out.emailed).toBe(true);
      expect(mockEmailSend.mock.calls[0][0].body).toMatch(/expected if GATE_LLM_DISPATCH_METRICS was enabled/);
      expect(mockEmailSend.mock.calls[0][0].body).toMatch(/repeats tomorrow/);
    });

    it('counts DISTINCT HOURS, so replica duplicates cannot inflate coverage', async () => {
      // Two replicas covering only the morning would produce ~20 heartbeat
      // ROWS but only ~10 distinct hours — a half-dead day must not read as
      // fully covered. The query is what enforces this; assert its shape.
      process.env.GATE_LLM_DISPATCH_METRICS = 'true';
      mockEmailSend.mockResolvedValue({ ok: true });
      const hb = makeChain([], 0, { first: { n: '10' } });
      mockDb
        .mockReturnValueOnce(makeChain([], 1))
        .mockReturnValueOnce(makeChain([]))
        .mockReturnValueOnce(makeChain([{ policy: 'report', total: '300', fallbacks: '0', failed: '0' }]))
        .mockReturnValueOnce(hb)
        .mockReturnValueOnce(makeChain([], 0, { first: { n: '168' } }));
      const { runLlmDispatchDigest } = load();
      const out = await runLlmDispatchDigest();
      expect(hb.count).toHaveBeenCalledWith({ n: expect.stringMatching(/DISTINCT date_trunc\('hour', created_at\)/) });
      // 10 distinct hours is below MIN_DAY_COVERAGE → absence not judged
      // (no gone_silent), and the partial coverage is itself surfaced.
      expect(out.exceptions.map((e) => e.kind)).toEqual(['not_recording']);
      expect(out.exceptions[0].detail).toMatch(/only 10 of ~24 hours/);
    });

    it('surfaces a PARTIALLY covered day and still skips gone-silent', async () => {
      // Most of a day's metrics can be lost while a few late heartbeats
      // exist; that must email (codex r7) — but "policy X recorded nothing"
      // on an incomplete window still proves nothing, so gone_silent stays
      // off and only the coverage exception is reported.
      process.env.GATE_LLM_DISPATCH_METRICS = 'true';
      mockEmailSend.mockResolvedValue({ ok: true });
      armDb({
        yesterdayRows: [],
        priorRows: [{ policy: 'report', total: '300', fallbacks: '0', failed: '0' }],
        heartbeats: 3,
        priorHeartbeats: 168,
      });
      const { runLlmDispatchDigest } = load();
      const out = await runLlmDispatchDigest();
      expect(out.exceptions.map((e) => e.kind)).toEqual(['not_recording']);
      expect(out.exceptions[0].detail).toMatch(/only 3 of ~24 hours/);
      expect(mockEmailSend).toHaveBeenCalledTimes(1);
    });

    it('states UNKNOWN rather than asserting breakage on a zero-heartbeat day', async () => {
      // The gate may simply have been off for that day; claiming the recorder
      // failed would be a guess. Reporting "cannot be read as healthy" is true
      // either way.
      process.env.GATE_LLM_DISPATCH_METRICS = 'true';
      mockEmailSend.mockResolvedValue({ ok: true });
      armDb({ yesterdayRows: [], priorRows: [], heartbeats: 0, priorHeartbeats: 168 });
      const { runLlmDispatchDigest } = load();
      const out = await runLlmDispatchDigest();
      expect(out.emailed).toBe(true);
      expect(mockEmailSend.mock.calls[0][0].body).toMatch(/UNKNOWN/);
      expect(mockEmailSend.mock.calls[0][0].body).toMatch(/failed or the feature was disabled/);
      // The wrapper must not re-assert breakage around the UNKNOWN wording.
      expect(mockEmailSend.mock.calls[0][0].body).not.toMatch(/could not write/);
    });

    it('does not run gone-silent on an unjudgeable day (only the coverage notice fires)', async () => {
      // No coverage means absence proves nothing — prior-week policies must
      // not each fire gone_silent just because the day recorded nothing.
      process.env.GATE_LLM_DISPATCH_METRICS = 'true';
      mockEmailSend.mockResolvedValue({ ok: true });
      armDb({
        yesterdayRows: [],
        priorRows: [{ policy: 'report', total: '300', fallbacks: '0', failed: '0' }],
        heartbeats: 0,
        priorHeartbeats: 0,
      });
      const { runLlmDispatchDigest } = load();
      const out = await runLlmDispatchDigest();
      expect(out.exceptions.map((e) => e.kind)).toEqual(['not_recording']);
      expect(out.exceptions.some((e) => e.kind === 'gone_silent')).toBe(false);
    });

    it('a prune failure is maintenance-only: logged, digest continues, no outage email', async () => {
      // DELETE deadlocking or losing its grant says nothing about recorder
      // health while INSERT/SELECT still work (codex r7) — the digest must
      // keep reading and reporting provider incidents.
      process.env.GATE_LLM_DISPATCH_METRICS = 'true';
      mockEmailSend.mockResolvedValue({ ok: true });
      armDb({
        yesterdayRows: [{ policy: 'report', total: '3', fallbacks: '0', failed: '1' }],
        priorRows: [],
        pruneError: 'deadlock detected',
      });
      const { runLlmDispatchDigest } = load();
      const out = await runLlmDispatchDigest();
      expect(out.pruneError).toMatch(/deadlock/);
      // The REAL provider incident was still evaluated and emailed; no
      // not_recording exception came from the prune.
      expect(out.exceptions.map((e) => e.kind)).toEqual(['all_providers_failed']);
    });

    it('respects the kill switch even when the prune throws (gate off = fully dark)', async () => {
      armDb({ yesterdayRows: [], priorRows: [], pruneError: 'connection terminated' });
      const { runLlmDispatchDigest } = load();
      await expect(runLlmDispatchDigest()).resolves.toMatchObject({ skipped: 'gate_off', pruneError: expect.stringMatching(/connection terminated/) });
      expect(mockEmailSend).not.toHaveBeenCalled();
    });

    it('logs when the DB-failure alert itself cannot be delivered', async () => {
      // email.send resolves { ok: false } rather than throwing, so an
      // unchecked result would silently lose the alert.
      process.env.GATE_LLM_DISPATCH_METRICS = 'true';
      mockEmailSend.mockResolvedValue({ ok: false, error: 'smtp unconfigured' });
      const logger = require('../services/logger');
      armDb({ yesterdayRows: [], priorRows: [], statsError: 'relation does not exist' });
      const { runLlmDispatchDigest } = load();
      await expect(runLlmDispatchDigest()).rejects.toThrow(/relation does not exist/);
      expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/ALERT UNDELIVERED.*smtp unconfigured/));
    });

    it('EMAILS when the table itself is unreadable, then fails the job', async () => {
      // The worst case must not be silent: if the retention DELETE throws
      // (missing table / dead DB) the alert has to go out over SMTP, which
      // does not depend on the database being reported on.
      process.env.GATE_LLM_DISPATCH_METRICS = 'true';
      mockEmailSend.mockResolvedValue({ ok: true });
      // A truly missing table fails the READS, not just the delete — this is
      // how the real failure presents (codex r3 caught the earlier version
      // simulating it via an impossible prune-only failure).
      armDb({ yesterdayRows: [], priorRows: [], statsError: 'relation "llm_dispatch_log" does not exist' });
      const { runLlmDispatchDigest } = load();
      await expect(runLlmDispatchDigest()).rejects.toThrow(/does not exist/);
      expect(mockEmailSend).toHaveBeenCalledTimes(1);
      expect(mockEmailSend.mock.calls[0][0].body).toMatch(/could not read llm_dispatch_log/);
    });

    it('marks its own already-alerted failures so the scheduler cannot double-email', async () => {
      // The scheduler catch fires alertRecorderUnreachable for throws that
      // never produced an alert (advisory-lock query death); failures the
      // digest ALREADY emailed for must carry err.alerted = true.
      process.env.GATE_LLM_DISPATCH_METRICS = 'true';
      mockEmailSend.mockResolvedValue({ ok: true });
      armDb({ yesterdayRows: [], priorRows: [], statsError: 'relation gone' });
      const { runLlmDispatchDigest } = load();
      const err = await runLlmDispatchDigest().catch((e) => e);
      expect(err.message).toMatch(/relation gone/);
      expect(err.alerted).toBe(true);
    });

    it('stays silent on a quiet day when heartbeats prove the recorder was alive', async () => {
      process.env.GATE_LLM_DISPATCH_METRICS = 'true';
      armDb({ yesterdayRows: [], priorRows: [], heartbeats: 24 });
      const { runLlmDispatchDigest } = load();
      const out = await runLlmDispatchDigest();
      expect(out).toMatchObject({ emailed: false });
      expect(mockEmailSend).not.toHaveBeenCalled();
    });

    it('stays silent on a green day', async () => {
      process.env.GATE_LLM_DISPATCH_METRICS = 'true';
      armDb({ yesterdayRows: [{ policy: 'report', total: '40', fallbacks: '1', failed: '0' }], priorRows: [] });
      const { runLlmDispatchDigest } = load();
      const out = await runLlmDispatchDigest();
      expect(out).toMatchObject({ emailed: false });
      expect(mockEmailSend).not.toHaveBeenCalled();
    });

    it('FAILS the job when the exception email cannot be sent (after pruning)', async () => {
      process.env.GATE_LLM_DISPATCH_METRICS = 'true';
      mockEmailSend.mockResolvedValue({ ok: false, error: 'smtp down' });
      const { prune } = armDb({ yesterdayRows: [{ policy: 'report', total: '3', fallbacks: '0', failed: '1' }], priorRows: [] });
      const { runLlmDispatchDigest } = load();
      await expect(runLlmDispatchDigest()).rejects.toThrow(/digest email failed.*smtp down/);
      // Retention pruning is independent of delivery and must still have run.
      expect(prune.del).toHaveBeenCalled();
    });
  });
});
