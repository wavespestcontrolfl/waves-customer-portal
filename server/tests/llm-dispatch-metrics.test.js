// Locks the LLM dispatch observability contract: recording is a no-op while
// the gate is off, never throws into the dispatcher's hot path even when the
// DB insert fails, labels policies by their registry `name` (twin policies
// with identical resolved routes must NOT merge), and the exception detector
// only fires on all-providers-failed, fallback-rate spikes, and gone-silent
// policies. The daily digest FAILS the cron job when its exception email
// cannot be delivered (a swallowed send error would silently lose the alert).

const mockInsert = jest.fn();
const mockDb = jest.fn(() => ({ insert: mockInsert }));
jest.mock('../models/db', () => {
  const db = (...args) => mockDb(...args);
  db.raw = (sql) => sql;
  return db;
});
const mockEmailSend = jest.fn();
jest.mock('../services/email', () => ({ send: (...args) => mockEmailSend(...args) }));
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
function makeChain(rows, delCount = 0) {
  const chain = {};
  for (const m of ['where', 'andWhere', 'groupBy', 'select', 'count', 'sum']) {
    chain[m] = jest.fn(() => chain);
  }
  chain.del = jest.fn(() => Promise.resolve(delCount));
  chain.then = (onResolve, onReject) => Promise.resolve(rows).then(onResolve, onReject);
  return chain;
}

describe('llm-dispatch-metrics', () => {
  beforeEach(() => {
    // The service lazy-requires feature-gates at call time (not load time), so
    // the registry must reset per test or the first test's gate value caches.
    jest.resetModules();
    jest.clearAllMocks();
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

    it('labels ad-hoc policies by their primary route', () => {
      const { policyLabel } = load();
      const adHoc = { primary: { provider: 'openai', model: 'model-a' }, fallback: { provider: 'anthropic', model: 'model-b' } };
      expect(policyLabel(adHoc)).toBe('openai/model-a');
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
      const out = detectExceptions([], [
        { policy: 'contentDraft', total: SILENT_MIN_WEEKLY },
        { policy: 'rarePolicy', total: SILENT_MIN_WEEKLY - 1 },
      ]);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ policy: 'contentDraft', kind: 'gone_silent' });
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

  describe('runLlmDispatchDigest', () => {
    // db() is called three times per run: yesterday stats, prior-week stats,
    // then the retention prune.
    function armDb({ yesterdayRows, priorRows, delCount = 3 }) {
      const prune = makeChain([], delCount);
      mockDb
        .mockReturnValueOnce(makeChain(yesterdayRows))
        .mockReturnValueOnce(makeChain(priorRows))
        .mockReturnValueOnce(prune);
      return { prune };
    }

    it('skips entirely while the gate is off', async () => {
      const { runLlmDispatchDigest } = load();
      await expect(runLlmDispatchDigest()).resolves.toEqual({ skipped: 'gate_off' });
      expect(mockDb).not.toHaveBeenCalled();
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
