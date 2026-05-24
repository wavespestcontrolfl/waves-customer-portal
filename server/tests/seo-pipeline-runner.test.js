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
  jest.clearAllMocks();
});

describe('SEO pipeline runner', () => {
  test('uses a safe heartbeat interval default', () => {
    expect(_internals.heartbeatIntervalMs('15000')).toBe(15000);
    expect(_internals.heartbeatIntervalMs('bad')).toBe(60000);
    expect(_internals.heartbeatIntervalMs('0')).toBe(60000);
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

    expect(SearchConsole.syncDailyData).toHaveBeenCalledWith(8, 'wavespestcontrol.com');
    expect(SiteAuditor.runSiteAudit).toHaveBeenCalledWith(expect.objectContaining({
      domain: 'wavespestcontrol.com',
      onProgress: expect.any(Function),
    }));
    expect(heartbeatPipelineRun).toHaveBeenCalledWith(
      'pipeline-1',
      expect.objectContaining({
        current_step: 'site_audit',
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
});
