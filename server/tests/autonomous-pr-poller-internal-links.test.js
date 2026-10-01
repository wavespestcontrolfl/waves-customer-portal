jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/content/internal-link-pr-executor', () => ({ runAutoMerge: jest.fn() }));
jest.mock('../services/content-astro/pages-poll', () => ({
  latestDeploymentForBranch: jest.fn(),
  extractStatus: jest.fn((d) => ({ status: d?.latest_stage?.status || null })),
  deploymentCommitSha: jest.fn((d) => d?.deployment_trigger?.metadata?.commit_hash || null),
}));

const executor = require('../services/content/internal-link-pr-executor');
const pagesPoll = require('../services/content-astro/pages-poll');
const poller = require('../services/content/autonomous-pr-poller');

const HEAD = 'a'.repeat(40);
const pr = { head: { ref: 'content/internal-link-x', sha: HEAD } };

describe('internal-link lane on the autonomous PR poller tick', () => {
  test('passes the tick\'s remaining merge allowance through', async () => {
    executor.runAutoMerge.mockResolvedValueOnce({ status: 'merged', pr_number: 7 });
    expect(await poller._internals.pollInternalLinkPr({ allowMerge: false })).toEqual({ status: 'merged', pr_number: 7 });
    expect(executor.runAutoMerge).toHaveBeenCalledWith({ allowMerge: false });
  });

  test('a link-lane error never escapes into blog reconciliation', async () => {
    executor.runAutoMerge.mockRejectedValueOnce(new Error('github down'));
    expect(await poller._internals.pollInternalLinkPr({ allowMerge: true })).toEqual({ status: 'error', reason: 'github down' });
  });
});

describe('previewGate (shared by the blog and internal-link lanes)', () => {
  test('green build of the current head passes', async () => {
    pagesPoll.latestDeploymentForBranch.mockResolvedValueOnce({ latest_stage: { status: 'success' }, deployment_trigger: { metadata: { commit_hash: HEAD } } });
    expect(await poller.previewGate(pr)).toEqual({ ok: true });
  });

  test('a stale-commit green build holds; a red build of the head is a definitive failure', async () => {
    pagesPoll.latestDeploymentForBranch.mockResolvedValueOnce({ latest_stage: { status: 'success' }, deployment_trigger: { metadata: { commit_hash: 'b'.repeat(40) } } });
    expect(await poller.previewGate(pr)).toMatchObject({ ok: false, reason: 'preview_build_stale_commit' });
    pagesPoll.latestDeploymentForBranch.mockResolvedValueOnce({ latest_stage: { status: 'failure' }, deployment_trigger: { metadata: { commit_hash: HEAD } } });
    expect(await poller.previewGate(pr)).toMatchObject({ ok: false, failed: true });
    pagesPoll.latestDeploymentForBranch.mockResolvedValueOnce({ latest_stage: { status: 'failure' }, deployment_trigger: { metadata: { commit_hash: 'b'.repeat(40) } } });
    expect(await poller.previewGate(pr)).toMatchObject({ ok: false, failed: false });
  });

  test('a canceled or skipped build of the head is terminal (abandoned), not a hold forever', async () => {
    pagesPoll.latestDeploymentForBranch.mockResolvedValueOnce({ latest_stage: { status: 'canceled' }, deployment_trigger: { metadata: { commit_hash: HEAD } } });
    expect(await poller.previewGate(pr)).toMatchObject({ ok: false, abandoned: true, failed: false });
    pagesPoll.latestDeploymentForBranch.mockResolvedValueOnce({ latest_stage: { status: 'skipped' }, deployment_trigger: { metadata: { commit_hash: HEAD } } });
    expect(await poller.previewGate(pr)).toMatchObject({ ok: false, abandoned: true });
  });

  test('no deployment yet is a transient hold', async () => {
    pagesPoll.latestDeploymentForBranch.mockResolvedValueOnce(null);
    expect(await poller.previewGate(pr)).toMatchObject({ ok: false, transient: true, reason: 'preview_build_pending' });
  });
});
