/**
 * The SiteOne deals bell's weekly AI-pass claim (GATE_SITEONE_DEAL_AI_END_DATE) on real
 * PostgreSQL. The first Monday run of an ET week claims the pass; a second run that week
 * (the deploy-overlap tick of the pre-push audit on b21fc449c9) finds it taken; the next
 * week claims again; and runs at the same moment get one claim between them.
 *
 * DB-gated like the other migrated-database suites: skips without DATABASE_URL, runs in CI
 * against the migrated database. It claims under its own test key, never the live
 * AI_PASS_KEY, so its cleanup cannot clear a real week's claim on a shared database
 * (pre-push audit on c9a07148db, P1). Nothing is sent and no model is called.
 */
const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;

jest.setTimeout(60000);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

describeDb('SiteOne deals: the weekly AI-pass claim on PostgreSQL', () => {
  const KEY = `siteone-deal-end-date-pass-test-${process.pid}`;
  let db;
  let claimAiPass;
  let AI_PASS_KEY;
  const clear = () => db('ops_email_send_state').where({ email_key: KEY }).del();
  const claim = (at) => claimAiPass(db, at, KEY);

  beforeAll(async () => {
    db = require('../models/db');
    ({ claimAiPass, AI_PASS_KEY } = require('../services/procurement/siteone-deals-digest'));
    expect(KEY).not.toBe(AI_PASS_KEY);
    await clear();
  });
  afterAll(async () => {
    await clear();
    await db.destroy();
  });

  test('one pass an ET week: the first run claims, later runs that week do not, the next week claims again', async () => {
    expect(await claim(new Date('2026-11-02T13:00:00Z'))).toBe(true); // Mon Nov 2, 8:00 AM ET
    expect(await claim(new Date('2026-11-02T13:12:00Z'))).toBe(false); // the same morning
    expect(await claim(new Date('2026-11-09T04:59:00Z'))).toBe(false); // Sun Nov 8, 11:59 PM ET
    expect(await claim(new Date('2026-11-09T13:00:00Z'))).toBe(true); // Mon Nov 9
    const row = await db('ops_email_send_state').where({ email_key: KEY }).first();
    expect(new Date(row.last_sent_at).toISOString()).toBe('2026-11-09T13:00:00.000Z');
  });

  test('runs at the same moment: one claim between them', async () => {
    await clear();
    const at = new Date('2026-11-16T13:00:00Z');
    const results = await Promise.all([claim(at), claim(at), claim(at)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
