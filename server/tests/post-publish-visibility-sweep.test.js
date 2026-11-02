/**
 * sweepRecentlyPublished — the daily visibility-backstop cron entrypoint.
 * Re-checks blogs that recently went live AND autonomous_runs publishes
 * (which have no blog_posts row); bounded batch, never throws.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/seo/sitemap-manager', () => ({}));
jest.mock('../services/seo/indexnow-submit', () => ({}));
jest.mock('../services/content/ai-visibility-gate', () => ({ evaluate: jest.fn(), _internals: {} }));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn() }));
// The real owner-alerts composer runs (a copy that breaks the notification rule throws under test); only the
// row write is stubbed.
jest.mock('../services/ops-digest', () => ({
  ...jest.requireActual('../services/ops-digest'),
  deliverOpsDigest: jest.fn(async () => ({ ok: true, channel: 'in_app', id: 'n-1' })),
}));

let mockState;

jest.mock('../models/db', () => {
  const dbFn = jest.fn((table) => {
    const q = {
      where: jest.fn(() => q),
      whereIn: jest.fn(() => q),
      whereNotNull: jest.fn(() => q),
      orderBy: jest.fn(() => q),
      limit: jest.fn((n) => { mockState.limits[table] = n; return q; }),
      select: jest.fn(() => (mockState.rejects[table]
        ? Promise.reject(new Error(`query failed: ${table}`))
        : Promise.resolve(mockState.rows[table] || []))),
      update: jest.fn((u) => {
        mockState.updates.push({ table, updates: u });
        return Promise.resolve(1);
      }),
    };
    return q;
  });
  return dbFn;
});

const logger = require('../services/logger');
const worker = require('../services/content/post-publish-visibility-worker');

beforeEach(() => {
  mockState = { rows: {}, rejects: {}, limits: {}, updates: [] };
  jest.clearAllMocks();
});

describe('sweepRecentlyPublished', () => {
  test('checks recent live blog_posts and autonomous_runs publishes, bounded', async () => {
    mockState.rows.blog_posts = [
      { id: 1, slug: 'a', title: 'A', keyword: 'k', astro_live_url: 'https://www.wavespestcontrol.com/blog/a/' },
    ];
    mockState.rows.autonomous_runs = [
      { id: 'run-1', published_url: 'https://www.wavespestcontrol.com/blog/auto/' },
    ];
    const runPost = jest.fn().mockResolvedValue({ ok: true });
    const runUrl = jest.fn().mockResolvedValue({ ok: true });

    const res = await worker.sweepRecentlyPublished({ runPost, runUrl, limit: 5 });

    expect(runPost).toHaveBeenCalledTimes(1);
    expect(runPost).toHaveBeenCalledWith(mockState.rows.blog_posts[0]);
    expect(runUrl).toHaveBeenCalledTimes(1);
    // post-like context (no `id`!) so visibility failures alert as
    // engine-published content while content_registry keeps URL matching
    expect(runUrl).toHaveBeenCalledWith(
      'https://www.wavespestcontrol.com/blog/auto/',
      { post: { source: 'autonomous_run', run_id: 'run-1' } },
    );
    expect(runUrl.mock.calls[0][1].post.id).toBeUndefined();
    expect(res.checked).toBe(2);
    expect(mockState.limits.blog_posts).toBe(5);
    expect(mockState.limits.autonomous_runs).toBe(5);
  });

  test('one failing check logs and never aborts the rest of the sweep', async () => {
    mockState.rows.blog_posts = [
      { id: 1, astro_live_url: 'https://x/1/' },
      { id: 2, astro_live_url: 'https://x/2/' },
    ];
    mockState.rows.autonomous_runs = [{ id: 'run-1', published_url: 'https://x/3/' }];
    const runPost = jest.fn()
      .mockRejectedValueOnce(new Error('fetch blew up'))
      .mockResolvedValue({ ok: true });
    const runUrl = jest.fn().mockResolvedValue({ ok: true });

    const res = await worker.sweepRecentlyPublished({ runPost, runUrl });

    expect(runPost).toHaveBeenCalledTimes(2);
    expect(runUrl).toHaveBeenCalledTimes(1);
    expect(res.checked).toBe(3);
    expect(res.results[0].error).toMatch(/fetch blew up/);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('fetch blew up'));
  });

  test('a query failure logs and resolves instead of throwing out of the cron', async () => {
    mockState.rejects.blog_posts = true;
    mockState.rows.autonomous_runs = [{ id: 'run-1', published_url: 'https://x/3/' }];
    const runPost = jest.fn();
    const runUrl = jest.fn().mockResolvedValue({ ok: true });

    const res = await worker.sweepRecentlyPublished({ runPost, runUrl });

    expect(runPost).not.toHaveBeenCalled();
    expect(runUrl).toHaveBeenCalledTimes(1);
    expect(res.checked).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('query failed: blog_posts'));
  });

  // finalizeMerged writes indexnow_status in a separate post-claim patch; a
  // crash between claim and patch left it blank forever (prod: runs for astro
  // PRs #371/#376). The sweep already (re)submits via runForUrl — it now also
  // backfills the run row so blank status stops reading as "never submitted".
  test('backfills blank AND transient-failure indexnow_status from the sweep submission (success-ish only)', async () => {
    mockState.rows.autonomous_runs = [
      { id: 'run-blank', published_url: 'https://x/a/', indexnow_status: null },
      { id: 'run-err-swept', published_url: 'https://x/b/', indexnow_status: null },
      { id: 'run-set', published_url: 'https://x/c/', indexnow_status: 'ok' },
      { id: 'run-stale-error', published_url: 'https://x/d/', indexnow_status: 'error' },
    ];
    const runUrl = jest.fn()
      .mockResolvedValueOnce({ ok: true, snapshot: { indexnow_status: 'ok' } })
      .mockResolvedValueOnce({ ok: true, snapshot: { indexnow_status: 'error' } })
      .mockResolvedValueOnce({ ok: true, snapshot: { indexnow_status: 'ok' } })
      .mockResolvedValueOnce({ ok: true, snapshot: { indexnow_status: 'ok' } });

    await worker.sweepRecentlyPublished({ runPost: jest.fn(), runUrl });

    // run-blank backfilled; run-err-swept left blank (failed submit retries
    // tomorrow); run-set untouched; run-stale-error REPAIRED (codex r2 —
    // a recorded transient failure was previously permanent).
    const backfills = mockState.updates.filter((u) => u.table === 'autonomous_runs');
    expect(backfills).toHaveLength(2);
    expect(backfills.every((u) => u.updates.indexnow_status === 'ok')).toBe(true);
  });
});

describe('alertStuckAutonomousPrs', () => {
  const twilio = require('../services/twilio');
  const { deliverOpsDigest } = require('../services/ops-digest');

  afterEach(() => {
    delete process.env.AUTONOMOUS_PR_STUCK_ALERT;
    delete process.env.AUTONOMOUS_PR_STUCK_ALERT_HOURS;
  });

  // It was a text to the owner's phone that reached nobody since about 2026-09-01; now one quiet owner alert row.
  test('parked PRs past the threshold write ONE quiet owner alert for the day with deduped URLs, and no text', async () => {
    mockState.rows.autonomous_runs = [
      { id: 'r1', astro_pr_url: 'https://github.com/o/r/pull/10', updated_at: new Date(0) },
      { id: 'r2', astro_pr_url: 'https://github.com/o/r/pull/10', updated_at: new Date(0) }, // same PR
      { id: 'r3', astro_pr_url: 'https://github.com/o/r/pull/11', updated_at: new Date(0) },
    ];

    const res = await worker.alertStuckAutonomousPrs();

    expect(res).toMatchObject({ alerted: 1, stuck: 2 });
    expect(deliverOpsDigest).toHaveBeenCalledTimes(1);
    const digest = deliverOpsDigest.mock.calls[0][0];
    expect(digest).toMatchObject({
      headline: 'Content — merge or close 2 stuck content pull requests',
      summary: '2 autonomous pull requests have waited over 12 hours to merge.',
      audience: 'fyi',
      dedupeKey: expect.stringMatching(/^owner-alert:content-pr-stuck:\d{4}-\d{2}-\d{2}$/),
      itemKeys: ['https://github.com/o/r/pull/10', 'https://github.com/o/r/pull/11'],
    });
    expect(digest.text).toMatch(/2 autonomous PR\(s\) stuck unmerged >12h/);
    expect(digest.metadata).toMatchObject({ ownerAlert: 'content-pr-stuck', severity: 'needs-you' });
    expect(twilio.sendSMS).not.toHaveBeenCalled();
  });

  test('nothing stuck → no alert', async () => {
    mockState.rows.autonomous_runs = [];
    const res = await worker.alertStuckAutonomousPrs();
    expect(res).toMatchObject({ alerted: 0 });
    expect(deliverOpsDigest).not.toHaveBeenCalled();
  });

  test('threshold hours are env-tunable and appear in the alert', async () => {
    process.env.AUTONOMOUS_PR_STUCK_ALERT_HOURS = '6';
    mockState.rows.autonomous_runs = [
      { id: 'r1', astro_pr_url: 'https://github.com/o/r/pull/12', updated_at: new Date(0) },
    ];

    await worker.alertStuckAutonomousPrs();

    const digest = deliverOpsDigest.mock.calls[0][0];
    expect(digest.headline).toBe('Content — merge or close a stuck content pull request');
    expect(digest.summary).toBe('An autonomous pull request has waited over 6 hours to merge.');
    expect(digest.text).toMatch(/>6h/);
  });

  test('an alert row that could not be written reports alerted 0', async () => {
    deliverOpsDigest.mockResolvedValueOnce({ ok: false, channel: 'email', error: 'owner alerts have no email path' });
    mockState.rows.autonomous_runs = [
      { id: 'r1', astro_pr_url: 'https://github.com/o/r/pull/14', updated_at: new Date(0) },
    ];

    const res = await worker.alertStuckAutonomousPrs();

    expect(res).toMatchObject({ alerted: 0, stuck: 1, error: 'owner alerts have no email path' });
  });

  test('kill switch AUTONOMOUS_PR_STUCK_ALERT=false skips entirely', async () => {
    process.env.AUTONOMOUS_PR_STUCK_ALERT = 'false';
    mockState.rows.autonomous_runs = [
      { id: 'r1', astro_pr_url: 'https://github.com/o/r/pull/13', updated_at: new Date(0) },
    ];

    const res = await worker.alertStuckAutonomousPrs();

    expect(res).toMatchObject({ alerted: 0, skipped: true });
    expect(deliverOpsDigest).not.toHaveBeenCalled();
  });

  test('query failure logs and resolves without throwing or alerting', async () => {
    mockState.rejects.autonomous_runs = true;
    const res = await worker.alertStuckAutonomousPrs();
    expect(res.alerted).toBe(0);
    expect(res.error).toBeTruthy();
    expect(deliverOpsDigest).not.toHaveBeenCalled();
  });
});

describe('visibility alert for an auto-published page', () => {
  const twilio = require('../services/twilio');
  const { deliverOpsDigest } = require('../services/ops-digest');
  const alert = (...args) => worker._internals.maybeAlertVisibilityFailure(...args);
  const p0 = { findings: [{ severity: 'P0', code: 'noindex' }, { severity: 'P2', code: 'thin' }] };

  afterEach(() => { delete process.env.AUTONOMOUS_CONTENT_VISIBILITY_ALERT; });

  // It was a text to the owner's phone that reached nobody since about 2026-09-01.
  test('a live page with a P0 writes one quiet owner alert per page, and no text', async () => {
    await alert('https://example.com/blog/a', { live_ok: true }, p0, { id: 'post-1' });

    expect(deliverOpsDigest).toHaveBeenCalledTimes(1);
    const digest = deliverOpsDigest.mock.calls[0][0];
    expect(digest).toMatchObject({
      headline: 'Content — fix or revert an auto-published page',
      summary: 'An auto-published page is live with a problem that keeps it out of search.',
      audience: 'fyi',
      dedupeKey: 'owner-alert:content-visibility:post-1',
    });
    expect(digest.text).toContain('P0 noindex');
    expect(digest.text).toContain('https://example.com/blog/a');
    expect(twilio.sendSMS).not.toHaveBeenCalled();
  });

  test('a page that is not live says so', async () => {
    await alert('https://example.com/blog/b', { live_ok: false, http_status: 404 }, { findings: [] }, { id: 'post-2' });
    const digest = deliverOpsDigest.mock.calls[0][0];
    expect(digest.summary).toBe('An auto-published page is not loading.');
    expect(digest.text).toContain('not live (http 404)');
  });

  test('an ad-hoc URL audit (no post) and the kill switch write nothing', async () => {
    await alert('https://example.com/blog/c', { live_ok: true }, p0, null);
    process.env.AUTONOMOUS_CONTENT_VISIBILITY_ALERT = 'false';
    await alert('https://example.com/blog/c', { live_ok: true }, p0, { id: 'post-3' });
    expect(deliverOpsDigest).not.toHaveBeenCalled();
  });
});
