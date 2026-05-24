jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/seo/seo-pipeline-runs', () => ({
  completePipelineRun: jest.fn().mockResolvedValue(1),
  failPipelineRun: jest.fn().mockResolvedValue(1),
  heartbeatPipelineRun: jest.fn().mockResolvedValue(1),
}));
jest.mock('../services/seo/search-console-v2', () => ({
  syncDailyData: jest.fn().mockResolvedValue({ synced: true }),
}));
jest.mock('../services/seo/site-auditor', () => ({
  runSiteAudit: jest.fn().mockResolvedValue({ pages: 250 }),
}));
jest.mock('../services/seo/url-intelligence', () => ({
  refreshDomain: jest.fn().mockResolvedValue({ refreshed: 10 }),
  buildDuplicateClusters: jest.fn().mockResolvedValue({ pairs: 2 }),
  buildIntentMap: jest.fn().mockResolvedValue({ routes: 3 }),
  buildInternalLinkGraph: jest.fn().mockResolvedValue({ links: 4 }),
  detectCanonicalConflicts: jest.fn().mockResolvedValue({ conflicts: 0 }),
  refreshDiagnoses: jest.fn().mockResolvedValue({ refreshed: 10 }),
}));
jest.mock('../services/seo/sitemap-validator', () => ({
  validateDomain: jest.fn().mockResolvedValue({ checked: 1 }),
}));
jest.mock('../services/seo/cannibalization', () => ({
  detect: jest.fn().mockResolvedValue({ flagged: 5 }),
}));
jest.mock('../services/seo/seo-action-generator', () => ({
  generateActionsFromDiagnosis: jest.fn().mockResolvedValue({ created: 6 }),
  autoApprove: jest.fn().mockResolvedValue({ approved: 7 }),
}));

const SearchConsole = require('../services/seo/search-console-v2');
const SiteAuditor = require('../services/seo/site-auditor');
const {
  completePipelineRun,
  failPipelineRun,
  heartbeatPipelineRun,
} = require('../services/seo/seo-pipeline-runs');
const { runClaimedSeoPipeline, _internals } = require('../services/seo/seo-pipeline-runner');

afterEach(() => {
  delete process.env.SEO_PIPELINE_GSC_SYNC_TIMEOUT_MS;
  jest.useRealTimers();
  jest.clearAllMocks();
  SearchConsole.syncDailyData.mockResolvedValue({ synced: true });
  SiteAuditor.runSiteAudit.mockResolvedValue({ pages: 250 });
});

describe('SEO pipeline runner', () => {
  test('uses a safe heartbeat interval default', () => {
    expect(_internals.heartbeatIntervalMs('15000')).toBe(15000);
    expect(_internals.heartbeatIntervalMs('bad')).toBe(60000);
    expect(_internals.heartbeatIntervalMs('0')).toBe(60000);
    expect(_internals.gscSyncTimeoutMs('5000')).toBe(5000);
    expect(_internals.gscSyncTimeoutMs('bad')).toBe(600000);
    expect(_internals.gscSyncTimeoutMs('0')).toBe(600000);
  });

  test('runs the claimed pipeline and heartbeats site-audit progress', async () => {
    SiteAuditor.runSiteAudit.mockImplementation(async (options) => {
      await options.onProgress({
        audit_run_id: 'audit-1',
        pages_attempted: 25,
        pages_crawled: 24,
        total_pages: 250,
      });
      return { pages: 24 };
    });

    const result = await runClaimedSeoPipeline({
      pipelineRun: { id: 'pipeline-1' },
      domain: 'wavespestcontrol.com',
      daysBack: 8,
      logPrefix: 'test-pipeline',
    });

    expect(SearchConsole.syncDailyData).toHaveBeenCalledWith(
      8,
      'wavespestcontrol.com',
      expect.objectContaining({ signal: expect.any(Object) }),
    );
    expect(SiteAuditor.runSiteAudit).toHaveBeenCalledWith(expect.objectContaining({
      domain: 'wavespestcontrol.com',
      onProgress: expect.any(Function),
    }));
    expect(heartbeatPipelineRun).toHaveBeenCalledWith(
      'pipeline-1',
      expect.objectContaining({
        current_step: 'site_audit',
        options: { days_back: 8 },
        site_audit: expect.objectContaining({
          audit_run_id: 'audit-1',
          pages_attempted: 25,
          pages_crawled: 24,
          total_pages: 250,
        }),
      }),
    );
    expect(completePipelineRun).toHaveBeenCalledWith(
      'pipeline-1',
      expect.objectContaining({
        succeeded: 12,
        failed: 0,
        steps: expect.arrayContaining([
          expect.objectContaining({ step: 'site_audit', status: 'ok', pages: 24 }),
          expect.objectContaining({ step: 'cannibalization', status: 'ok', flagged: 5 }),
          expect.objectContaining({ step: 'auto_approve', status: 'ok', approved: 7 }),
        ]),
      }),
      'completed',
    );
    expect(failPipelineRun).not.toHaveBeenCalled();
    expect(result.status).toBe('completed');
  });

  test('continues the pipeline when GSC sync times out', async () => {
    process.env.SEO_PIPELINE_GSC_SYNC_TIMEOUT_MS = '5';
    SearchConsole.syncDailyData.mockImplementation(() => new Promise(() => {}));

    const result = await runClaimedSeoPipeline({
      pipelineRun: { id: 'pipeline-timeout' },
      domain: 'wavespestcontrol.com',
      daysBack: 7,
      logPrefix: 'test-timeout',
    });

    expect(SearchConsole.syncDailyData).toHaveBeenCalledWith(
      7,
      'wavespestcontrol.com',
      expect.objectContaining({ signal: expect.any(Object) }),
    );
    const timeoutSignal = SearchConsole.syncDailyData.mock.calls[0][2].signal;
    expect(timeoutSignal.aborted).toBe(true);
    expect(timeoutSignal.reason.message).toBe('GSC sync timed out after 5ms');
    expect(SiteAuditor.runSiteAudit).toHaveBeenCalledWith(expect.objectContaining({
      domain: 'wavespestcontrol.com',
    }));
    expect(completePipelineRun).toHaveBeenCalledWith(
      'pipeline-timeout',
      expect.objectContaining({
        failed: 1,
        steps: expect.arrayContaining([
          expect.objectContaining({
            step: 'gsc_sync',
            status: 'failed',
            error: 'GSC sync timed out after 5ms',
          }),
          expect.objectContaining({ step: 'site_audit', status: 'ok', pages: 250 }),
        ]),
      }),
      'completed_with_errors',
    );
    expect(result.status).toBe('completed_with_errors');
  });
});
