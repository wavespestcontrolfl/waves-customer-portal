// shareUrlOnce: exactly-once social share for an already-live URL, serialized
// against the RSS auto-publish cron via the SAME advisory lock so the
// deterministic merge trigger (autonomous PR poller) and the 4-hourly RSS poll
// can never double-post the same URL.
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn();
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config', () => ({ s3: {} }));

const db = require('../models/db');
const social = require('../services/social-media');

const URL = 'https://www.wavespestcontrol.com/pest-control/drain-flies/';

// Wire db.transaction(cb) -> cb(trx); trx('social_media_posts') -> a builder
// whose .first() resolves the configured existing row (or null).
function withTrx(existingRow = null) {
  // The fake honors whereNotIn so exclusion semantics (dry_run/failed/
  // REJECTED rows never block) are actually exercised, not bypassed.
  let excluded = [];
  const builder = {
    where: jest.fn().mockReturnThis(),
    whereNotIn: jest.fn(function (col, vals) { if (col === 'status') excluded = vals; return this; }),
    first: jest.fn(async () => (existingRow && !excluded.includes(existingRow.status) ? existingRow : null)),
  };
  const trx = jest.fn(() => builder);
  trx.raw = jest.fn().mockResolvedValue({});
  db.transaction.mockImplementation(async (cb) => cb(trx));
  return { trx, builder };
}

describe('shareUrlOnce', () => {
  let publishSpy;
  beforeEach(() => {
    // SOCIAL_FLAGS reads process.env via getters — drive it that way.
    process.env.SOCIAL_AUTOMATION_ENABLED = 'true';
    publishSpy = jest.spyOn(social, 'publishToAll').mockResolvedValue({ success: true, platforms: [] });
  });
  afterEach(() => {
    delete process.env.SOCIAL_AUTOMATION_ENABLED;
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  test('acquires the RSS advisory lock, then publishes a brand-new URL', async () => {
    const { trx, builder } = withTrx(null);

    const res = await social.shareUrlOnce({ title: 'T', description: 'D', link: URL, source: 'autonomous_blog' });

    expect(trx.raw).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), expect.any(Array));
    // Dedup must NOT block on prior 'failed' rows (kept retryable) nor on
    // REJECTED studio drafts (admin killed the copy, not the URL).
    expect(builder.whereNotIn).toHaveBeenCalledWith('status', ['dry_run', 'failed', 'rejected']);
    expect(publishSpy).toHaveBeenCalledWith(expect.objectContaining({ source: 'autonomous_blog', noAiImage: true }));
    // The autonomous blog lane opts into EVERY platform explicitly — the
    // omitted-channels default excludes twitter (admin preview flow).
    expect(publishSpy.mock.calls[0][0].channels).toEqual(expect.arrayContaining(['facebook', 'instagram', 'linkedin', 'gbp', 'twitter']));
    expect(res).toMatchObject({ shared: true });
  });

  test('a REJECTED studio row does not block (admin killed the copy, not the URL)', async () => {
    withTrx({ id: 'sm-rej', status: 'rejected' });
    const res = await social.shareUrlOnce({ title: 'T', link: URL, source: 'autonomous_blog' });
    expect(publishSpy).toHaveBeenCalled();
    expect(res).toMatchObject({ shared: true });
  });

  test('skips publish when a row that already went out exists (published/scheduled)', async () => {
    const { trx } = withTrx({ id: 'sm-1', status: 'published' });

    const res = await social.shareUrlOnce({ title: 'T', link: URL, source: 'autonomous_blog' });

    expect(trx.raw).toHaveBeenCalled(); // dedup happens UNDER the lock
    expect(publishSpy).not.toHaveBeenCalled();
    expect(res).toEqual({ skipped: 'already_posted', blocking_status: 'published' });
  });

  test('passes the normalized URL to publishToAll as both link and guid', async () => {
    withTrx(null);

    await social.shareUrlOnce({ title: 'T', link: URL, source: 'autonomous_blog' });

    const arg = publishSpy.mock.calls[0][0];
    expect(arg.link).toBe(social.normalizeUrl(URL));
    expect(arg.guid).toBe(arg.link);
  });

  test('no lock taken and no publish when automation is disabled', async () => {
    process.env.SOCIAL_AUTOMATION_ENABLED = 'false';

    const res = await social.shareUrlOnce({ title: 'T', link: URL, source: 'autonomous_blog' });

    expect(db.transaction).not.toHaveBeenCalled();
    expect(publishSpy).not.toHaveBeenCalled();
    expect(res).toEqual({ skipped: 'automation_disabled' });
  });

  test('skips when the link is missing/unnormalizable', async () => {
    const res = await social.shareUrlOnce({ title: 'T', link: '', source: 'autonomous_blog' });

    expect(db.transaction).not.toHaveBeenCalled();
    expect(res).toEqual({ skipped: 'no_url' });
  });
});
