/**
 * _sendBlogDroughtSms — the operator's target is a blog post every day, but
 * the engine's designed response to thin demand is silence. This alert turns
 * a no-blog day into an SMS with the dominant reason. Default ON, killed by
 * AUTONOMOUS_BLOG_DROUGHT_ALERT=false; a started blog (published, or parked
 * awaiting its PR merge) suppresses it.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn() }));

const db = require('../models/db');
const twilio = require('../services/twilio');
const runner = require('../services/content/autonomous-runner');

// db is a bare jest.fn() in this suite: the sms_log day-dedupe lookup
// throws synchronously (db('sms_log') → undefined.where) and the sender
// fails OPEN — which is exactly the prod contract (a dedupe lookup error
// must never suppress the alert). Tests below that exercise the dedupe
// give db a chainable implementation, then reset it.
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

test('no runs at all (skipped_no_opportunity day): drought SMS fires with the floor reason', async () => {
  await runner._sendBlogDroughtSms([{ outcome: 'skipped_no_opportunity' }]);

  expect(twilio.sendSMS).toHaveBeenCalledTimes(1);
  const [, body, opts] = twilio.sendSMS.mock.calls[0];
  expect(body).toMatch(/NO blog post today/);
  expect(body).toMatch(/no blog opportunity cleared the score floor/);
  expect(opts).toMatchObject({ messageType: 'internal_alert' });
});

test('a blog parked awaiting PR merge counts as started — no SMS', async () => {
  await runner._sendBlogDroughtSms([blogStarted]);
  expect(twilio.sendSMS).not.toHaveBeenCalled();
});

test('a directly published blog counts as started — no SMS', async () => {
  await runner._sendBlogDroughtSms([
    { action_type: 'new_supporting_blog', outcome: 'completed_published' },
  ]);
  expect(twilio.sendSMS).not.toHaveBeenCalled();
});

test('blog attempts that all gated/failed: SMS carries the dominant reason', async () => {
  await runner._sendBlogDroughtSms([
    { action_type: 'new_supporting_blog', outcome: 'skipped_gate_fail', skip_reason: 'gate_fail' },
    { action_type: 'new_supporting_blog', outcome: 'failed_agent', failure_message: 'BLOG_HERO_IMAGE_FAILED' },
    { action_type: 'refresh_existing_page', outcome: 'completed_pending_review', skip_reason: 'trust_build_1_of_3' },
  ]);

  expect(twilio.sendSMS).toHaveBeenCalledTimes(1);
  const [, body] = twilio.sendSMS.mock.calls[0];
  expect(body).toMatch(/gate_fail×1/);
  expect(body).toMatch(/BLOG_HERO_IMAGE_FAILED×1/);
});

test('non-blog publishes do NOT suppress the drought alert', async () => {
  await runner._sendBlogDroughtSms([
    { action_type: 'refresh_existing_page', outcome: 'completed_published' },
  ]);
  expect(twilio.sendSMS).toHaveBeenCalledTimes(1);
});

test('kill switch AUTONOMOUS_BLOG_DROUGHT_ALERT=false silences it', async () => {
  process.env.AUTONOMOUS_BLOG_DROUGHT_ALERT = 'false';
  await runner._sendBlogDroughtSms([{ outcome: 'skipped_no_opportunity' }]);
  expect(twilio.sendSMS).not.toHaveBeenCalled();
});

test('gate-failed attempt with reviewer_notes: SMS names the failing checks', async () => {
  await runner._sendBlogDroughtSms([
    {
      action_type: 'new_supporting_blog',
      outcome: 'skipped_gate_fail',
      skip_reason: 'auto_publish_gate_fail',
      reviewer_notes: 'quality: hard=hub_link_present soft=none score=51/51',
    },
  ]);

  expect(twilio.sendSMS).toHaveBeenCalledTimes(1);
  const [, body] = twilio.sendSMS.mock.calls[0];
  expect(body).toMatch(/auto_publish_gate_fail×1/);
  expect(body).toMatch(/Detail: quality: hard=hub_link_present/);
});

test('reviewer_notes detail is truncated to keep the SMS bounded', async () => {
  await runner._sendBlogDroughtSms([
    {
      action_type: 'new_supporting_blog',
      outcome: 'skipped_gate_fail',
      skip_reason: 'auto_publish_gate_fail',
      reviewer_notes: 'x'.repeat(500),
    },
  ]);

  const [, body] = twilio.sendSMS.mock.calls[0];
  const detail = body.split('Detail: ')[1];
  expect(detail.length).toBeLessThanOrEqual(160);
});

test('no reviewer_notes on any attempt: body unchanged (no Detail clause)', async () => {
  await runner._sendBlogDroughtSms([
    { action_type: 'new_supporting_blog', outcome: 'skipped_gate_fail', skip_reason: 'gate_fail' },
  ]);

  const [, body] = twilio.sendSMS.mock.calls[0];
  expect(body).not.toMatch(/Detail:/);
});

test('day-dedupe: a drought alert already in notifications today suppresses the duplicate', async () => {
  // internal_alert sends redirect to the in-app notification system and
  // never reach sms_log — the bell entry in `notifications` is the marker.
  const chain = {
    where: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue({ id: 7 }),
  };
  db.mockImplementation(() => chain);

  await runner._sendBlogDroughtSms([{ outcome: 'skipped_no_opportunity' }]);

  expect(twilio.sendSMS).not.toHaveBeenCalled();
  expect(db).toHaveBeenCalledWith('notifications');
  expect(chain.where).toHaveBeenCalledWith('recipient_type', 'admin');
  expect(chain.where).toHaveBeenCalledWith('title', 'like', 'Waves content engine: NO blog post today%');
});

test('day-dedupe: no prior SMS in sms_log today → alert sends', async () => {
  const chain = {
    where: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(undefined),
  };
  db.mockImplementation(() => chain);

  await runner._sendBlogDroughtSms([{ outcome: 'skipped_no_opportunity' }]);

  expect(twilio.sendSMS).toHaveBeenCalledTimes(1);
});

test('day-dedupe lookup failure fails OPEN — the alert still sends', async () => {
  db.mockImplementation(() => { throw new Error('db down'); });

  await runner._sendBlogDroughtSms([{ outcome: 'skipped_no_opportunity' }]);

  expect(twilio.sendSMS).toHaveBeenCalledTimes(1);
});
