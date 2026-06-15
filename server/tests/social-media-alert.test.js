// Per-platform consecutive-failure alerting. The regression this guards:
// a post's status is 'published' when ANY platform succeeds, so Instagram can
// fail on every post (auth) while Facebook + GBP succeed and nothing alerts.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// ../config pulls in dotenv (absent in this worktree's partial install); only
// config.s3.* is read by social-media, and not at module-load time.
jest.mock('../config', () => ({ s3: {} }));

const db = require('../models/db');
const social = require('../services/social-media');
const { buildSocialFailureAlert, checkAndRaiseAlert } = social;

// Build a post row as stored: platforms_posted is a JSON string of the
// per-platform results array.
const post = (...entries) => ({ platforms_posted: JSON.stringify(entries) });
const fb = (ok, err) => ({ platform: 'facebook', success: ok, ...(err ? { error: err } : {}) });
const ig = (ok, err) => ({ platform: 'instagram', success: ok, ...(err ? { error: err } : {}) });
const gbp = (loc, ok, err) => ({ platform: 'gbp', location: loc, success: ok, ...(err ? { error: err } : {}) });

describe('buildSocialFailureAlert (pure detection)', () => {
  test('Instagram failing while Facebook + GBP succeed RAISES an IG alert (the masked regression)', () => {
    const rows = [
      post(fb(true), gbp('bradenton', true), ig(false, '(#10) Application does not have permission for this action')),
      post(fb(true), gbp('bradenton', true), ig(false, '(#10) Application does not have permission for this action')),
      post(fb(true), gbp('bradenton', true), ig(false, '(#10) Application does not have permission for this action')),
    ];
    const r = buildSocialFailureAlert(rows);
    expect(r.active).toBe(true);
    expect(r.platforms.map(p => p.platform)).toEqual(['instagram']);
    expect(r.platforms[0].consecutive_failures).toBe(3);
    expect(r.message).toContain('Instagram');
    expect(r.message).toContain('(#10)'); // latest error surfaced for a single broken platform
    // Facebook + GBP succeeded, so they must NOT be flagged.
    expect(r.message).not.toContain('Facebook');
    expect(r.message).not.toContain('Google Business');
  });

  test('a recent success resets the streak (2 fails then a success) — no alert', () => {
    // newest-first: fail, fail, success
    const rows = [
      post(fb(true), ig(false, 'x')),
      post(fb(true), ig(false, 'x')),
      post(fb(true), ig(true)),
    ];
    expect(buildSocialFailureAlert(rows).active).toBe(false);
  });

  test('fewer than threshold attempts → no alert (avoids early false alarms)', () => {
    const rows = [post(ig(false, 'x')), post(ig(false, 'x'))]; // only 2 IG attempts
    expect(buildSocialFailureAlert(rows).active).toBe(false);
  });

  test('skipped/disabled attempts are ignored, not counted as failures', () => {
    const rows = [
      post(fb(true), { platform: 'instagram', skipped: 'Disabled' }),
      post(fb(true), { platform: 'instagram', skipped: 'No public image URL' }),
      post(fb(true), { platform: 'instagram', skipped: 'Disabled' }),
    ];
    expect(buildSocialFailureAlert(rows).active).toBe(false);
  });

  test('dry-run attempts are ignored', () => {
    const rows = [
      post({ platform: 'instagram', dryRun: true, success: false }),
      post({ platform: 'instagram', dryRun: true, success: false }),
      post({ platform: 'instagram', dryRun: true, success: false }),
    ];
    expect(buildSocialFailureAlert(rows).active).toBe(false);
  });

  test('GBP: alert only when EVERY location fails across the streak', () => {
    const allFail = [
      post(gbp('bradenton', false, 'No GBP credentials'), gbp('venice', false, 'No GBP credentials')),
      post(gbp('bradenton', false, 'No GBP credentials'), gbp('venice', false, 'No GBP credentials')),
      post(gbp('bradenton', false, 'No GBP credentials'), gbp('venice', false, 'No GBP credentials')),
    ];
    const r = buildSocialFailureAlert(allFail);
    expect(r.active).toBe(true);
    expect(r.platforms.map(p => p.platform)).toEqual(['gbp']);
    expect(r.message).toContain('Google Business');
  });

  test('GBP: one location succeeding counts the post as a success (no alert)', () => {
    const rows = [
      post(gbp('bradenton', true), gbp('venice', false, 'No GBP credentials')),
      post(gbp('bradenton', false, 'x'), gbp('venice', false, 'x')),
      post(gbp('bradenton', false, 'x'), gbp('venice', false, 'x')),
    ];
    // newest post had a success → streak is 0
    expect(buildSocialFailureAlert(rows).active).toBe(false);
  });

  test('multiple broken platforms are listed together (no single-error suffix)', () => {
    const rows = [
      post(fb(false, 'fb auth'), ig(false, 'ig auth')),
      post(fb(false, 'fb auth'), ig(false, 'ig auth')),
      post(fb(false, 'fb auth'), ig(false, 'ig auth')),
    ];
    const r = buildSocialFailureAlert(rows);
    expect(r.platforms.map(p => p.platform)).toEqual(['facebook', 'instagram']);
    expect(r.message).toContain('Facebook, Instagram');
    expect(r.message).toContain('have 3+');
    expect(r.message).not.toContain('latest:'); // suffix only for a single platform
  });

  test('empty / no history → no alert', () => {
    expect(buildSocialFailureAlert([]).active).toBe(false);
    expect(buildSocialFailureAlert(undefined).active).toBe(false);
  });
});

describe('checkAndRaiseAlert (db side effects)', () => {
  let settings; // current system_settings row for the alert key (or undefined)
  let ops;      // captured writes

  // recentRows drives the social_media_posts query result for each test.
  function mockDb(recentRows) {
    settings = undefined;
    ops = { inserted: null, updated: null, deleted: false };
    db.mockImplementation((table) => {
      if (table === 'social_media_posts') {
        return {
          orderBy: () => ({ limit: () => ({ select: async () => recentRows }) }),
        };
      }
      if (table === 'system_settings') {
        return {
          where: () => ({
            first: async () => settings,
            update: async (v) => { ops.updated = v; settings = { key: 'social_consecutive_failures_alert', value: v.value }; return 1; },
            del: async () => { ops.deleted = true; settings = undefined; return 1; },
          }),
          insert: async (row) => { ops.inserted = row; settings = row; return 1; },
        };
      }
      throw new Error(`unexpected table ${table}`);
    });
  }

  const igDown = () => ([
    post(fb(true), ig(false, '(#10) no permission')),
    post(fb(true), ig(false, '(#10) no permission')),
    post(fb(true), ig(false, '(#10) no permission')),
  ]);

  beforeEach(() => jest.clearAllMocks());

  test('raises (inserts) an alert when a platform is broken and none exists', async () => {
    mockDb(igDown());
    await checkAndRaiseAlert();
    expect(ops.inserted).toBeTruthy();
    expect(ops.deleted).toBe(false);
    const payload = JSON.parse(ops.inserted.value);
    expect(payload.message).toContain('Instagram');
    expect(payload.platforms[0].platform).toBe('instagram');
    expect(payload.raised_at).toBeTruthy();
  });

  test('clears the alert when nothing is broken', async () => {
    mockDb([post(fb(true), ig(true)), post(fb(true), ig(true)), post(fb(true), ig(true))]);
    settings = { key: 'social_consecutive_failures_alert', value: JSON.stringify({ raised_at: 'old', message: 'stale' }) };
    await checkAndRaiseAlert();
    expect(ops.deleted).toBe(true);
  });

  test('preserves the original raised_at when re-raising an active alert', async () => {
    mockDb(igDown());
    settings = { key: 'social_consecutive_failures_alert', value: JSON.stringify({ raised_at: '2026-06-01T00:00:00.000Z', message: 'old' }) };
    await checkAndRaiseAlert();
    expect(ops.updated).toBeTruthy();
    expect(JSON.parse(ops.updated.value).raised_at).toBe('2026-06-01T00:00:00.000Z');
  });
});
