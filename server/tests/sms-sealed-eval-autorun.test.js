/**
 * Auto-run sweep — version-coverage detection, spend rails, failed-run
 * resume, lock/race behavior, and the single digest bell.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ mocked: true })));
jest.mock('../services/sms-shadow-drafter', () => ({
  PROMPT_VERSION: 'house_voice_v9_test',
  generateGroundedDraft: jest.fn(),
}));
jest.mock('../services/sms-shadow-judge', () => ({ judgeOne: jest.fn() }));
jest.mock('../utils/cron-lock', () => ({
  runExclusive: jest.fn(async (_name, fn) => fn()),
}));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async () => undefined),
}));

const { runExclusive } = require('../utils/cron-lock');
const NotificationService = require('../services/notification-service');
const logger = require('../services/logger');
const { runAutoExamSweep, EXAM_LEGS } = require('../services/sms-sealed-eval');

const CURRENT = 'house_voice_v9_test';

function makeDbi({ runningRow = null, activeCount = 15, existingByLeg = {}, pendingProposals = 2 } = {}) {
  return jest.fn((table) => {
    const b = { _kv: {}, _table: table };
    b.where = jest.fn((arg, val) => {
      if (typeof arg === 'object') Object.assign(b._kv, arg);
      else b._kv[arg] = val;
      return b;
    });
    b.whereIn = jest.fn(() => b);
    b.orderBy = jest.fn(() => b);
    b.count = jest.fn((spec) => {
      if (table === 'sms_sealed_eval_items') return Promise.resolve([{ count: activeCount }]);
      b._counted = true;
      return b;
    });
    b.first = jest.fn(async () => {
      if (table === 'sms_sealed_eval_runs' && b._kv.status === 'running') return runningRow;
      if (table === 'sms_sealed_eval_runs' && b._kv.provider_leg) return existingByLeg[b._kv.provider_leg] || null;
      if (table === 'sms_patch_proposals') return { n: pendingProposals };
      return null;
    });
    return b;
  });
}

const summaryBothClean = async () => ({
  currentVersion: CURRENT,
  items: { active: 15, total: 15 },
  legs: {
    anthropic: { unsafeCount: 0, itemsJudged: 15, unsafeRate: 0, baselineRunId: null, significance: null },
    openai: { unsafeCount: 2, itemsJudged: 15, unsafeRate: 0.133, baselineRunId: 'base-1', significance: { significant: false } },
  },
  runs: [],
});

describe('runAutoExamSweep', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks keeps implementations — restore the defaults that
    // earlier tests override (lock pass-through, quiet bell).
    runExclusive.mockImplementation(async (_name, fn) => fn());
    NotificationService.notifyAdmin.mockImplementation(async () => undefined);
  });

  test('runs BOTH legs when the current version has no runs, one digest bell', async () => {
    const examRunner = jest.fn(async () => ({ ok: true }));
    const dbi = makeDbi();
    const result = await runAutoExamSweep({ dbi, examRunner, summaryFn: summaryBothClean });
    expect(result.ran).toBe(2);
    expect(examRunner).toHaveBeenCalledTimes(2);
    expect(examRunner).toHaveBeenCalledWith(expect.objectContaining({ providerLeg: 'anthropic', triggeredBy: 'auto:prompt-watch' }));
    expect(examRunner).toHaveBeenCalledWith(expect.objectContaining({ providerLeg: 'openai', triggeredBy: 'auto:prompt-watch' }));
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, title, body] = NotificationService.notifyAdmin.mock.calls[0];
    expect(category).toBe('agents');
    expect(title).toContain(CURRENT);
    expect(body).toContain('anthropic: 0/15 unsafe');
    expect(body).toContain('2 pathology patch proposals pending review');
  });

  test('both legs already complete -> full no-op, no LLM spend, no bell', async () => {
    const examRunner = jest.fn();
    const dbi = makeDbi({
      existingByLeg: {
        anthropic: { id: 'r1', status: 'complete' },
        openai: { id: 'r2', status: 'complete' },
      },
    });
    const result = await runAutoExamSweep({ dbi, examRunner, summaryFn: summaryBothClean });
    expect(result.ran).toBe(0);
    expect(result.legs.anthropic.outcome).toBe('already_examined');
    expect(result.legs.openai.outcome).toBe('already_examined');
    expect(examRunner).not.toHaveBeenCalled();
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('failed same-version run is RESUMED (keeps paid results), not recreated', async () => {
    const examRunner = jest.fn(async () => ({ ok: true }));
    const dbi = makeDbi({
      existingByLeg: {
        anthropic: { id: 'failed-1', status: 'failed' },
        openai: { id: 'r2', status: 'complete' },
      },
    });
    const result = await runAutoExamSweep({ dbi, examRunner, summaryFn: summaryBothClean });
    expect(examRunner).toHaveBeenCalledTimes(1);
    expect(examRunner).toHaveBeenCalledWith(expect.objectContaining({ runId: 'failed-1' }));
    expect(result.legs.anthropic.outcome).toBe('resumed');
  });

  test('a run already in progress anywhere -> whole sweep skips', async () => {
    const examRunner = jest.fn();
    const dbi = makeDbi({ runningRow: { id: 'busy-1' } });
    const result = await runAutoExamSweep({ dbi, examRunner, summaryFn: summaryBothClean });
    expect(result.skipped).toBe('run_in_progress');
    expect(examRunner).not.toHaveBeenCalled();
  });

  test('pool below the minimum -> skips quietly', async () => {
    const examRunner = jest.fn();
    const dbi = makeDbi({ activeCount: 3 });
    const result = await runAutoExamSweep({ dbi, examRunner, summaryFn: summaryBothClean });
    expect(result.skipped).toBe('pool_too_small');
    expect(examRunner).not.toHaveBeenCalled();
  });

  test('pool above the spend cap -> refuses LOUDLY (logged, never silent)', async () => {
    const examRunner = jest.fn();
    const dbi = makeDbi({ activeCount: 500 });
    const result = await runAutoExamSweep({ dbi, examRunner, summaryFn: summaryBothClean });
    expect(result.skipped).toBe('spend_cap');
    expect(examRunner).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('spend cap'));
  });

  test('RUN_IN_PROGRESS race on one leg does not kill the other leg', async () => {
    const raced = new Error('in progress');
    raced.code = 'RUN_IN_PROGRESS';
    const examRunner = jest.fn()
      .mockRejectedValueOnce(raced)
      .mockResolvedValueOnce({ ok: true });
    const dbi = makeDbi();
    const result = await runAutoExamSweep({ dbi, examRunner, summaryFn: summaryBothClean });
    expect(result.legs.anthropic.outcome).toBe('run_in_progress');
    expect(result.legs.openai.outcome).toBe('ran');
    expect(result.ran).toBe(1);
  });

  test('leg error is recorded, sweep continues, digest still fires for the leg that ran', async () => {
    const examRunner = jest.fn()
      .mockRejectedValueOnce(new Error('provider down'))
      .mockResolvedValueOnce({ ok: true });
    const dbi = makeDbi();
    const result = await runAutoExamSweep({ dbi, examRunner, summaryFn: summaryBothClean });
    expect(result.legs.anthropic.outcome).toBe('error');
    expect(result.legs.openai.outcome).toBe('ran');
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  });

  test('manual sitting holds the advisory lock -> leg reports lock_busy, no double-run', async () => {
    runExclusive.mockResolvedValue({ skipped: true, reason: 'lease_held' });
    const examRunner = jest.fn();
    const dbi = makeDbi();
    const result = await runAutoExamSweep({ dbi, examRunner, summaryFn: summaryBothClean });
    expect(result.legs.anthropic.outcome).toBe('lock_busy');
    expect(result.legs.openai.outcome).toBe('lock_busy');
    expect(result.ran).toBe(0);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('exam runs under the SAME advisory lock name as the manual endpoint', async () => {
    const examRunner = jest.fn(async () => ({ ok: true }));
    const dbi = makeDbi();
    await runAutoExamSweep({ dbi, examRunner, summaryFn: summaryBothClean });
    expect(runExclusive).toHaveBeenCalledWith('sms-sealed-eval', expect.any(Function), { recordHealth: false });
  });

  test('digest notify failure never breaks the sweep result', async () => {
    NotificationService.notifyAdmin.mockRejectedValue(new Error('bell down'));
    const examRunner = jest.fn(async () => ({ ok: true }));
    const dbi = makeDbi();
    const result = await runAutoExamSweep({ dbi, examRunner, summaryFn: summaryBothClean });
    expect(result.ran).toBe(2);
  });

  test('regression wording appears when significance says regressed', async () => {
    const summaryRegressed = async () => ({
      currentVersion: CURRENT,
      items: { active: 15, total: 15 },
      legs: {
        anthropic: { unsafeCount: 5, itemsJudged: 15, unsafeRate: 0.333, baselineRunId: 'b1', significance: { significant: true, direction: 'regressed', pValue: 0.01 } },
        openai: { unsafeCount: 0, itemsJudged: 15, unsafeRate: 0, baselineRunId: null, significance: null },
      },
      runs: [],
    });
    const examRunner = jest.fn(async () => ({ ok: true }));
    const dbi = makeDbi();
    await runAutoExamSweep({ dbi, examRunner, summaryFn: summaryRegressed });
    const [, , body] = NotificationService.notifyAdmin.mock.calls[0];
    expect(body).toContain('REGRESSION vs baseline (p=0.01)');
  });

  test('sanity: EXAM_LEGS is the two-leg contract this sweep iterates', () => {
    expect(EXAM_LEGS).toEqual(['anthropic', 'openai']);
  });
});
