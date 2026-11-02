/**
 * _sendBlogDroughtSms — the operator's target is a blog post every day, but
 * the engine's designed response to thin demand is silence. This alert turns
 * a no-blog day into an owner alert with the dominant reason (a quiet row,
 * services/owner-alerts.js; it was a text to the owner's phone that reached
 * nobody since about 2026-09-01). Default ON, killed by
 * AUTONOMOUS_BLOG_DROUGHT_ALERT=false; a started blog (published, or parked
 * awaiting its PR merge) suppresses it.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn() }));
// The real owner-alerts composer runs (copy that breaks the notification rule throws under test); only the
// row write is stubbed.
jest.mock('../services/ops-digest', () => ({
  ...jest.requireActual('../services/ops-digest'),
  deliverOpsDigest: jest.fn(async () => ({ ok: true, channel: 'in_app', id: 'n-1' })),
}));

const db = require('../models/db');
const twilio = require('../services/twilio');
const { deliverOpsDigest } = require('../services/ops-digest');
const { etDateString } = require('../utils/datetime-et');
const runner = require('../services/content/autonomous-runner');

// db is a bare jest.fn() in this suite: the drought alert reads nothing; one
// row per ET day comes from its dedupe key.
afterEach(() => {
  jest.clearAllMocks();
  db.mockReset();
  delete process.env.AUTONOMOUS_BLOG_DROUGHT_ALERT;
});

const blogStarted = {
  action_type: 'new_supporting_blog',
  outcome: 'completed_pending_review',
  skip_reason: 'astro_pr_pending_merge',
};

test('no runs at all (skipped_no_opportunity day): drought alert fires with the floor reason', async () => {
  await runner._sendBlogDroughtSms([{ outcome: 'skipped_no_opportunity' }]);

  expect(deliverOpsDigest).toHaveBeenCalledTimes(1);
  const digest = deliverOpsDigest.mock.calls[0][0];
  const body = digest.text;
  expect(body).toMatch(/NO blog post today/);
  expect(body).toMatch(/no blog opportunity cleared the score floor/);
  expect(digest).toMatchObject({
    headline: 'Content — see why no blog post started today',
    summary: 'The daily content batch ended without starting a blog post.',
    audience: 'fyi',
  });
  expect(twilio.sendSMS).not.toHaveBeenCalled();
});

test('batch halted on non-blog failures before any blog attempt: alert names the halt, not the miner', async () => {
  const cityFail = { action_type: 'create_or_refresh_city_service_page', outcome: 'failed_agent', failure_message: 'streaming_failed: deadline' };
  await runner._sendBlogDroughtSms([cityFail, cityFail], {
    haltBeforeBlog: { failures: 2, lanes: ['create_or_refresh_city_service_page'] },
  });

  expect(deliverOpsDigest).toHaveBeenCalledTimes(1);
  const body = deliverOpsDigest.mock.calls[0][0].text;
  expect(body).toMatch(/batch halted after 2 failed create_or_refresh_city_service_page run\(s\) before any blog was attempted/);
  expect(body).not.toMatch(/miner found nothing actionable/);
});

test('a lone non-blog failure followed by an empty queue is a real drought, not a halt', async () => {
  await runner._sendBlogDroughtSms([
    { action_type: 'create_or_refresh_city_service_page', outcome: 'failed_agent', failure_message: 'streaming_failed: deadline' },
    { outcome: 'skipped_no_opportunity' },
  ]);

  expect(deliverOpsDigest).toHaveBeenCalledTimes(1);
  const body = deliverOpsDigest.mock.calls[0][0].text;
  expect(body).toMatch(/miner found nothing actionable/);
  expect(body).not.toMatch(/batch halted/);
});

test('a blog parked awaiting PR merge counts as started — no alert', async () => {
  await runner._sendBlogDroughtSms([blogStarted]);
  expect(deliverOpsDigest).not.toHaveBeenCalled();
});

test('a directly published blog counts as started — no alert', async () => {
  await runner._sendBlogDroughtSms([
    { action_type: 'new_supporting_blog', outcome: 'completed_published' },
  ]);
  expect(deliverOpsDigest).not.toHaveBeenCalled();
});

test('blog attempts that all gated/failed: alert carries the dominant reason', async () => {
  await runner._sendBlogDroughtSms([
    { action_type: 'new_supporting_blog', outcome: 'skipped_gate_fail', skip_reason: 'gate_fail' },
    { action_type: 'new_supporting_blog', outcome: 'failed_agent', failure_message: 'BLOG_HERO_IMAGE_FAILED' },
    { action_type: 'refresh_existing_page', outcome: 'completed_pending_review', skip_reason: 'trust_build_1_of_3' },
  ]);

  expect(deliverOpsDigest).toHaveBeenCalledTimes(1);
  const body = deliverOpsDigest.mock.calls[0][0].text;
  expect(body).toMatch(/gate_fail×1/);
  expect(body).toMatch(/BLOG_HERO_IMAGE_FAILED×1/);
});

test('non-blog publishes do NOT suppress the drought alert', async () => {
  await runner._sendBlogDroughtSms([
    { action_type: 'refresh_existing_page', outcome: 'completed_published' },
  ]);
  expect(deliverOpsDigest).toHaveBeenCalledTimes(1);
});

test('kill switch AUTONOMOUS_BLOG_DROUGHT_ALERT=false silences it', async () => {
  process.env.AUTONOMOUS_BLOG_DROUGHT_ALERT = 'false';
  await runner._sendBlogDroughtSms([{ outcome: 'skipped_no_opportunity' }]);
  expect(deliverOpsDigest).not.toHaveBeenCalled();
});

test('gate-failed attempt with reviewer_notes: alert names the failing checks', async () => {
  await runner._sendBlogDroughtSms([
    {
      action_type: 'new_supporting_blog',
      outcome: 'skipped_gate_fail',
      skip_reason: 'auto_publish_gate_fail',
      reviewer_notes: 'quality: hard=hub_link_present soft=none score=51/51',
    },
  ]);

  expect(deliverOpsDigest).toHaveBeenCalledTimes(1);
  const body = deliverOpsDigest.mock.calls[0][0].text;
  expect(body).toMatch(/auto_publish_gate_fail×1/);
  expect(body).toMatch(/Detail: quality: hard=hub_link_present/);
});

test('reviewer_notes detail is truncated to keep the alert bounded', async () => {
  await runner._sendBlogDroughtSms([
    {
      action_type: 'new_supporting_blog',
      outcome: 'skipped_gate_fail',
      skip_reason: 'auto_publish_gate_fail',
      reviewer_notes: 'x'.repeat(500),
    },
  ]);

  const body = deliverOpsDigest.mock.calls[0][0].text;
  const detail = body.split('Detail: ')[1];
  expect(detail.length).toBeLessThanOrEqual(160);
});

test('no reviewer_notes on any attempt: body unchanged (no Detail clause)', async () => {
  await runner._sendBlogDroughtSms([
    { action_type: 'new_supporting_blog', outcome: 'skipped_gate_fail', skip_reason: 'gate_fail' },
  ]);

  const body = deliverOpsDigest.mock.calls[0][0].text;
  expect(body).not.toMatch(/Detail:/);
});

test('day-dedupe: the key is the ET day, so the 1pm catch-up rewrites the morning row instead of adding one', async () => {
  await runner._sendBlogDroughtSms([{ outcome: 'skipped_no_opportunity' }]);
  await runner._sendBlogDroughtSms([]);

  expect(deliverOpsDigest).toHaveBeenCalledTimes(2);
  for (const [digest] of deliverOpsDigest.mock.calls) {
    expect(digest).toMatchObject({ dedupeKey: `owner-alert:content-drought:${etDateString()}`, refreshOnDedupe: true });
  }
  expect(db).not.toHaveBeenCalled();
});
