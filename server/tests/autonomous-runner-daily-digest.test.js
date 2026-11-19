/**
 * _sendDailyDigestSms — the content engine's daily summary is a quiet owner alert
 * (services/owner-alerts.js), one row per ET day. Each day's row closes the rows
 * earlier days left open (supersedePrior → ops-digest supersedeOlderDigests), so the
 * Activity feed keeps one summary instead of a week of them (owner 2026-11-19,
 * admin notification faults check, fault 5).
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn() }));
// The real owner-alerts composer runs; only the row write is stubbed.
jest.mock('../services/ops-digest', () => ({
  ...jest.requireActual('../services/ops-digest'),
  deliverOpsDigest: jest.fn(async () => ({ ok: true, channel: 'in_app', id: 'n-1' })),
}));

const { deliverOpsDigest } = require('../services/ops-digest');
const { etDateString } = require('../utils/datetime-et');
const runner = require('../services/content/autonomous-runner');

afterEach(() => {
  jest.clearAllMocks();
  delete process.env.AUTONOMOUS_CONTENT_DIGEST_SMS;
});

test('a notable day writes one summary row that closes the rows earlier days left open', async () => {
  process.env.AUTONOMOUS_CONTENT_DIGEST_SMS = 'true';
  await runner._sendDailyDigestSms([
    { outcome: 'completed_published', published_url: 'https://example.com/synthetic-post' },
    { outcome: 'skipped_gate_fail', skip_reason: 'synthetic_gate' },
  ]);

  expect(deliverOpsDigest).toHaveBeenCalledTimes(1);
  expect(deliverOpsDigest.mock.calls[0][0]).toMatchObject({
    key: 'owner-alert:content-daily-digest',
    dedupeKey: `owner-alert:content-daily-digest:${etDateString()}`,
    audience: 'fyi',
    supersedePrior: true,
  });
});
