jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/seo/seo-pipeline-runs', () => ({
  DEFAULT_PIPELINE_DAYS_BACK: 7,
  claimQueuedPipelineRun: jest.fn(),
}));
jest.mock('../services/seo/seo-pipeline-runner', () => ({
  runClaimedSeoPipeline: jest.fn(),
}));

const { claimQueuedPipelineRun } = require('../services/seo/seo-pipeline-runs');
const { runClaimedSeoPipeline } = require('../services/seo/seo-pipeline-runner');
const {
  processNextQueuedPipelineRun,
  _internals,
} = require('../services/seo/seo-pipeline-worker');

afterEach(() => {
  jest.clearAllMocks();
});

describe('SEO pipeline worker', () => {
  test('claims queued runs and passes queued daysBack into the shared runner', async () => {
    claimQueuedPipelineRun.mockResolvedValue({
      claimed: true,
      run: {
        id: 'run-1',
        domain: 'wavespestcontrol.com',
        result: { options: { days_back: 12 } },
      },
    });
    let claimedResolved = false;
    const onClaimed = jest.fn(async () => {
      await Promise.resolve();
      claimedResolved = true;
    });
    const onSettled = jest.fn();
    runClaimedSeoPipeline.mockImplementation(async () => {
      expect(claimedResolved).toBe(true);
      return {
        status: 'completed',
        succeeded: 12,
        failed: 0,
        duration_ms: 1000,
      };
    });

    const result = await processNextQueuedPipelineRun({
      logPrefix: 'test-worker',
      onClaimed,
      onSettled,
    });

    expect(runClaimedSeoPipeline).toHaveBeenCalledWith({
      pipelineRun: expect.objectContaining({ id: 'run-1' }),
      domain: 'wavespestcontrol.com',
      daysBack: 12,
      logPrefix: 'test-worker',
    });
    expect(onClaimed).toHaveBeenCalledWith(expect.objectContaining({ id: 'run-1' }));
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ id: 'run-1' }));
    expect(result).toEqual(expect.objectContaining({
      status: 'completed',
      run_id: 'run-1',
      domain: 'wavespestcontrol.com',
      daysBack: 12,
      succeeded: 12,
      failed: 0,
    }));
  });

  test('returns idle when no queued run is claimable', async () => {
    claimQueuedPipelineRun.mockResolvedValue({ claimed: false, run: null });

    await expect(processNextQueuedPipelineRun()).resolves.toEqual({ status: 'idle' });
    expect(runClaimedSeoPipeline).not.toHaveBeenCalled();
  });

  test('uses safe worker defaults', () => {
    expect(_internals.workerPollMs('1500')).toBe(1500);
    expect(_internals.workerPollMs('0')).toBe(30000);
    expect(_internals.runDaysBack({ result: { options: { days_back: '9' } } })).toBe(9);
    expect(_internals.runDaysBack({ result: {} })).toBe(7);
  });
});
