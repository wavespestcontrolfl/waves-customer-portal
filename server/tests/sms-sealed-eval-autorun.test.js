/**
 * Auto-run sweep — version-coverage detection, spend rails (new runs only),
 * failed-run resume, stranded-run recovery, complete-beats-failed
 * precedence, failed-result accounting, and the single digest bell.
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
  isLocked: jest.fn(async () => false),
}));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async () => undefined),
}));

const { runExclusive, isLocked } = require('../utils/cron-lock');
const NotificationService = require('../services/notification-service');
const logger = require('../services/logger');
const { runAutoExamSweep, EXAM_LEGS } = require('../services/sms-sealed-eval');

const CURRENT = 'house_voice_v9_test';

function makeDbi({
  runningRow = null,
  activeCount = 15,
  completeByLeg = {},
  failedByLeg = {},
  pendingProposals = 2,
} = {}) {
  return jest.fn((table) => {
    const b = { _kv: {} };
    b.where = jest.fn((arg, val) => {
      if (typeof arg === 'object') Object.assign(b._kv, arg);
      else b._kv[arg] = val;
      return b;
    });
    b.orderBy = jest.fn(() => b);
    b.count = jest.fn(() => {
      if (table === 'sms_sealed_eval_items') return Promise.resolve([{ count: activeCount }]);
      return b;
    });
    b.first = jest.fn(async () => {
      if (table === 'sms_sealed_eval_runs' && b._kv.status === 'running') return runningRow;
      if (table === 'sms_sealed_eval_runs' && b._kv.status === 'complete') return completeByLeg[b._kv.provider_leg] || null;
      if (table === 'sms_sealed_eval_runs' && b._kv.status === 'failed') return failedByLeg[b._kv.provider_leg] || null;
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
    // individual tests override (lock pass-through, quiet bell, free lock).
    runExclusive.mockImplementation(async (_name, fn) => fn());
    isLocked.mockImplementation(async () => false);
    NotificationService.notifyAdmin.mockImplementation(async () => undefined);
  });

  test('runs BOTH legs when the current version has no runs, one digest bell', async () => {
    const examRunner = jest.fn(async () => ({ status: 'complete' }));
    const result = await runAutoExamSweep({ dbi: makeDbi(), examRunner, summaryFn: summaryBothClean });
    expect(result.ran).toBe(2);
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
      completeByLeg: { anthropic: { id: 'r1' }, openai: { id: 'r2' } },
    });
    const result = await runAutoExamSweep({ dbi, examRunner, summaryFn: summaryBothClean });
    expect(result.ran).toBe(0);
    expect(result.legs.anthropic.outcome).toBe('already_examined');
    expect(result.legs.openai.outcome).toBe('already_examined');
    expect(examRunner).not.toHaveBeenCalled();
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('COMPLETE beats a NEWER failed rerun — no re-spend on a covered version (codex P2)', async () => {
    const examRunner = jest.fn();
    const dbi = makeDbi({
      completeByLeg: { anthropic: { id: 'done-1' }, openai: { id: 'done-2' } },
      failedByLeg: { anthropic: { id: 'newer-failed' }, openai: { id: 'newer-failed-2' } },
    });
    const result = await runAutoExamSweep({ dbi, examRunner, summaryFn: summaryBothClean });
    expect(result.legs.anthropic.outcome).toBe('already_examined');
    expect(examRunner).not.toHaveBeenCalled();
  });

  test('failed same-version run is RESUMED (keeps paid results), not recreated', async () => {
    const examRunner = jest.fn(async () => ({ status: 'complete' }));
    const dbi = makeDbi({
      completeByLeg: { openai: { id: 'r2' } },
      failedByLeg: { anthropic: { id: 'failed-1' } },
    });
    const result = await runAutoExamSweep({ dbi, examRunner, summaryFn: summaryBothClean });
    expect(examRunner).toHaveBeenCalledTimes(1);
    expect(examRunner).toHaveBeenCalledWith(expect.objectContaining({ runId: 'failed-1' }));
    expect(result.legs.anthropic.outcome).toBe('resumed');
  });

  test('resume is NOT pool-gated — oversized pool still finishes a paid cohort (codex P2)', async () => {
    const examRunner = jest.fn(async () => ({ status: 'complete' }));
    const dbi = makeDbi({
      activeCount: 500, // way over the cap
      failedByLeg: { anthropic: { id: 'failed-1' } },
    });
    const result = await runAutoExamSweep({ dbi, examRunner, summaryFn: summaryBothClean });
    expect(result.legs.anthropic.outcome).toBe('resumed');
    expect(examRunner).toHaveBeenCalledWith(expect.objectContaining({ runId: 'failed-1' }));
    // The other leg has no resumable run -> new-run creation IS capped.
    expect(result.legs.openai.outcome).toBe('spend_cap');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('spend cap'));
  });

  test('stranded running row + free lock -> RESUMED, not skipped (codex P2)', async () => {
    const examRunner = jest.fn(async () => ({ status: 'complete' }));
    const dbi = makeDbi({
      runningRow: { id: 'stranded-1', provider_leg: 'anthropic', prompt_version: CURRENT },
      completeByLeg: { openai: { id: 'r2' } },
    });
    const result = await runAutoExamSweep({ dbi, examRunner, summaryFn: summaryBothClean });
    expect(examRunner).toHaveBeenCalledWith(expect.objectContaining({ runId: 'stranded-1' }));
    expect(result.legs.anthropic.outcome).toBe('resumed_stranded');
    expect(result.ran).toBe(1);
  });

  test('stranded STALE-version row is recovered without shadowing the current-version leg', async () => {
    // Resume path retires stale-version rows then throws by contract.
    const retire = new Error('examined house_voice_v8 but the drafter is now house_voice_v9_test — start a new run');
    const examRunner = jest.fn()
      .mockRejectedValueOnce(retire)                      // stranded recovery
      .mockResolvedValue({ status: 'complete' });         // both fresh legs
    const dbi = makeDbi({
      runningRow: { id: 'old-run', provider_leg: 'anthropic', prompt_version: 'house_voice_v8' },
    });
    const result = await runAutoExamSweep({ dbi, examRunner, summaryFn: summaryBothClean });
    // The anthropic leg still got a FRESH current-version run.
    expect(examRunner).toHaveBeenCalledWith(expect.objectContaining({ providerLeg: 'anthropic', triggeredBy: 'auto:prompt-watch' }));
    expect(result.legs.anthropic.outcome).toBe('ran');
    expect(result.ran).toBe(2);
  });

  test('running row + lock actually HELD -> whole sweep skips (genuine sitting)', async () => {
    isLocked.mockResolvedValue(true);
    const examRunner = jest.fn();
    const dbi = makeDbi({ runningRow: { id: 'busy-1', provider_leg: 'openai', prompt_version: CURRENT } });
    const result = await runAutoExamSweep({ dbi, examRunner, summaryFn: summaryBothClean });
    expect(result.skipped).toBe('run_in_progress');
    expect(examRunner).not.toHaveBeenCalled();
  });

  test('exam resolving status=failed is NOT counted as ran and sends no digest (codex P2)', async () => {
    const examRunner = jest.fn(async () => ({ status: 'failed', error: 'anthropic leg unavailable?' }));
    const result = await runAutoExamSweep({ dbi: makeDbi(), examRunner, summaryFn: summaryBothClean });
    expect(result.ran).toBe(0);
    expect(result.legs.anthropic.outcome).toBe('exam_failed');
    expect(result.legs.openai.outcome).toBe('exam_failed');
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('ended failed'));
  });

  test('one leg failed-result + one leg success -> digest still fires for the success', async () => {
    const examRunner = jest.fn()
      .mockResolvedValueOnce({ status: 'failed', error: 'outage' })
      .mockResolvedValueOnce({ status: 'complete' });
    const result = await runAutoExamSweep({ dbi: makeDbi(), examRunner, summaryFn: summaryBothClean });
    expect(result.legs.anthropic.outcome).toBe('exam_failed');
    expect(result.legs.openai.outcome).toBe('ran');
    expect(result.ran).toBe(1);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  });

  test('pool below the minimum -> new runs skipped per leg, quietly', async () => {
    const examRunner = jest.fn();
    const result = await runAutoExamSweep({ dbi: makeDbi({ activeCount: 3 }), examRunner, summaryFn: summaryBothClean });
    expect(result.legs.anthropic.outcome).toBe('pool_too_small');
    expect(result.legs.openai.outcome).toBe('pool_too_small');
    expect(examRunner).not.toHaveBeenCalled();
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('RUN_IN_PROGRESS race on one leg does not kill the other leg', async () => {
    const raced = new Error('in progress');
    raced.code = 'RUN_IN_PROGRESS';
    const examRunner = jest.fn()
      .mockRejectedValueOnce(raced)
      .mockResolvedValueOnce({ status: 'complete' });
    const result = await runAutoExamSweep({ dbi: makeDbi(), examRunner, summaryFn: summaryBothClean });
    expect(result.legs.anthropic.outcome).toBe('run_in_progress');
    expect(result.legs.openai.outcome).toBe('ran');
    expect(result.ran).toBe(1);
  });

  test('manual sitting grabs the lock mid-sweep -> leg reports lock_busy, no double-run', async () => {
    runExclusive.mockResolvedValue({ skipped: true, reason: 'lease_held' });
    const examRunner = jest.fn();
    const result = await runAutoExamSweep({ dbi: makeDbi(), examRunner, summaryFn: summaryBothClean });
    expect(result.legs.anthropic.outcome).toBe('lock_busy');
    expect(result.legs.openai.outcome).toBe('lock_busy');
    expect(result.ran).toBe(0);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('exam runs under the SAME advisory lock name as the manual endpoint', async () => {
    const examRunner = jest.fn(async () => ({ status: 'complete' }));
    await runAutoExamSweep({ dbi: makeDbi(), examRunner, summaryFn: summaryBothClean });
    expect(runExclusive).toHaveBeenCalledWith('sms-sealed-eval', expect.any(Function), { recordHealth: false });
  });

  test('digest notify failure never breaks the sweep result', async () => {
    NotificationService.notifyAdmin.mockRejectedValue(new Error('bell down'));
    const examRunner = jest.fn(async () => ({ status: 'complete' }));
    const result = await runAutoExamSweep({ dbi: makeDbi(), examRunner, summaryFn: summaryBothClean });
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
    const examRunner = jest.fn(async () => ({ status: 'complete' }));
    await runAutoExamSweep({ dbi: makeDbi(), examRunner, summaryFn: summaryRegressed });
    const [, , body] = NotificationService.notifyAdmin.mock.calls[0];
    expect(body).toContain('REGRESSION vs baseline (p=0.01)');
  });

  test('sanity: EXAM_LEGS is the two-leg contract this sweep iterates', () => {
    expect(EXAM_LEGS).toEqual(['anthropic', 'openai']);
  });
});
