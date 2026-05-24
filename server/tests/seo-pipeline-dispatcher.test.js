jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/seo/seo-pipeline-runs', () => ({
  claimQueuedPipelineRun: jest.fn(),
  enqueuePipelineRun: jest.fn(),
}));
jest.mock('../services/seo/seo-pipeline-runner', () => ({
  runClaimedSeoPipeline: jest.fn().mockResolvedValue({ status: 'completed' }),
}));

const {
  claimQueuedPipelineRun,
  enqueuePipelineRun,
} = require('../services/seo/seo-pipeline-runs');
const { runClaimedSeoPipeline } = require('../services/seo/seo-pipeline-runner');
const {
  dispatchSeoPipeline,
  _internals,
} = require('../services/seo/seo-pipeline-dispatcher');

afterEach(() => {
  jest.clearAllMocks();
  delete process.env.SEO_PIPELINE_QUEUE_ONLY;
});

describe('SEO pipeline dispatcher', () => {
  test('keeps current deploy path functional by claiming queued runs inline by default', async () => {
    enqueuePipelineRun.mockResolvedValue({
      enqueued: true,
      run: { id: 'queued-run', status: 'queued', domain: 'wavespestcontrol.com' },
    });
    claimQueuedPipelineRun.mockResolvedValue({
      claimed: true,
      run: { id: 'queued-run', status: 'running', domain: 'wavespestcontrol.com' },
    });

    const result = await dispatchSeoPipeline({
      domain: 'wavespestcontrol.com',
      idempotencyKey: 'key-1',
      requestedBy: 'tech-1',
      daysBack: 8,
      logPrefix: 'test-pipeline',
    });

    expect(claimQueuedPipelineRun).toHaveBeenCalledWith({ id: 'queued-run' });
    expect(runClaimedSeoPipeline).toHaveBeenCalledWith({
      pipelineRun: expect.objectContaining({ id: 'queued-run' }),
      domain: 'wavespestcontrol.com',
      daysBack: 8,
      logPrefix: 'test-pipeline',
    });
    expect(result.statusCode).toBe(202);
    expect(result.payload).toEqual(expect.objectContaining({
      status: 'started',
      run_id: 'queued-run',
      domain: 'wavespestcontrol.com',
    }));
  });

  test('leaves runs queued when queue-only mode is enabled for a worker service', async () => {
    process.env.SEO_PIPELINE_QUEUE_ONLY = 'true';
    enqueuePipelineRun.mockResolvedValue({
      enqueued: true,
      run: { id: 'queued-run', status: 'queued', domain: 'wavespestcontrol.com' },
    });

    const result = await dispatchSeoPipeline({
      domain: 'wavespestcontrol.com',
      idempotencyKey: 'key-1',
      daysBack: 8,
    });

    expect(claimQueuedPipelineRun).not.toHaveBeenCalled();
    expect(runClaimedSeoPipeline).not.toHaveBeenCalled();
    expect(result.statusCode).toBe(202);
    expect(result.payload).toEqual(expect.objectContaining({
      status: 'queued',
      run_id: 'queued-run',
    }));
  });

  test('queue-only parser accepts explicit true values only', () => {
    expect(_internals.queueOnlyEnabled('true')).toBe(true);
    expect(_internals.queueOnlyEnabled('1')).toBe(true);
    expect(_internals.queueOnlyEnabled('false')).toBe(false);
    expect(_internals.pendingStatus('running')).toBe(true);
    expect(_internals.pendingStatus('completed')).toBe(false);
  });
});
