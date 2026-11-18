// The stale-app live check (owner 2026-11-18): a visit whose notices all went as
// app push, no text, to a customer whose app was not opened in 30 days becomes one
// self-closing ops digest; a clean run retires it; a failed query never does.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/ops-digest', () => ({ deliverOpsDigest: jest.fn(async () => ({ sent: true })) }));
jest.mock('../services/ops-digest-fall-off', () => ({ retireIfClean: jest.fn(async () => 0) }));
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: () => true, sendOne: jest.fn() }));

const { deliverOpsDigest } = require('../services/ops-digest');
const { retireIfClean } = require('../services/ops-digest-fall-off');
const Check = require('../services/app-first-stale-notice-check');

const pushRow = (over = {}) => ({
  id: 'row-1', customer_id: 'cust-1', first_name: 'Sample', last_name: 'Tester', visit_id: 'visit-stale-1',
  created_at: new Date('2026-11-18T14:00:00Z'), checked_in_at: new Date('2026-10-10T14:00:00Z'), message_type: 'tech_en_route',
  days_since_app_use: 39, scheduled_date: '2026-11-18', ...over,
});
const dbReturning = (rows) => ({ raw: jest.fn(async () => ({ rows })) });
const stale = [pushRow({ id: 'r1', message_type: 'reminder_72h' }), pushRow({ id: 'r2', message_type: 'tech_en_route' }), pushRow({ id: 'r3', message_type: 'tech_arrived', days_since_app_use: 39 })];

beforeEach(() => { jest.clearAllMocks(); });

test('stale-stamped pushes for one visit make one digest item (visit:<id>) with the notice types and days since app use', async () => {
  const result = await Check.runAppFirstStaleNoticeCheck({ database: dbReturning(stale) });
  expect(result.found).toBe(1);
  expect(deliverOpsDigest).toHaveBeenCalledTimes(1);
  const arg = deliverOpsDigest.mock.calls[0][0];
  expect(arg).toMatchObject({ fallOff: true, key: Check.OPS_DIGEST_KEY, dedupeKey: Check.OPS_DIGEST_KEY, refreshOnDedupe: true, itemKeys: ['visit:visit-stale-1'] });
  expect(arg.subject).toBe('FIX: 1 visit got app-only notices on an app not opened in 30+ days');
  expect(arg.text).toContain('2026-11-18 · Sample T. · reminder_72h, tech_en_route, tech_arrived · 39 days since app use');
  expect(arg.text).toContain('/admin/customers/cust-1');
  expect(arg.link).toBe('/admin/customers/cust-1');
  expect(retireIfClean).not.toHaveBeenCalled();
});

test('a push with no visit is its own item (sms:<row id>)', async () => {
  await Check.runAppFirstStaleNoticeCheck({ database: dbReturning([pushRow({ id: 'row-77', visit_id: null, scheduled_date: null })]) });
  expect(deliverOpsDigest.mock.calls[0][0].itemKeys).toEqual(['sms:row-77']);
});

test('no stale-stamped push (fresh stamp, no stamp, an explicit App choice or a malformed stamp are all excluded by the query): no digest, the standing row retires', async () => {
  const result = await Check.runAppFirstStaleNoticeCheck({ database: dbReturning([]) });
  expect(result).toMatchObject({ found: 0, digest: { skipped: 'clean' } });
  expect(deliverOpsDigest).not.toHaveBeenCalled();
  expect(retireIfClean).toHaveBeenCalledWith(Check.OPS_DIGEST_KEY);
});

test('a failed query neither raises nor retires', async () => {
  const result = await Check.runAppFirstStaleNoticeCheck({ database: { raw: jest.fn(async () => { throw new Error('boom'); }) } });
  expect(result).toEqual({ skipped: 'query_failed' });
  expect(deliverOpsDigest).not.toHaveBeenCalled();
  expect(retireIfClean).not.toHaveBeenCalled();
});

test('the query reads only the send-time stamp: a 48 hour window, the 30 day bound, automatic replacements only, read only', async () => {
  const database = dbReturning([]);
  await Check.findStaleAppNoticeVisits({ database, now: new Date('2026-11-18T20:30:00Z') });
  const [sql, bindings] = database.raw.mock.calls[0];
  expect(bindings).toEqual([new Date('2026-11-16T20:30:00Z'), 30]);
  expect(sql).toContain("requestedChannel' = 'sms'");
  expect(sql).toContain("app_checked_in_at' IS NOT NULL");
  expect(sql).not.toMatch(/customer_page_views|customer_refresh_tokens|push_subscriptions/);
  expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
});

describe('mail guards sit inside sendEmail, so the in-app row is always written', () => {
  const sendgrid = require('../services/sendgrid-mail');
  afterEach(() => { delete process.env.APP_FIRST_STALE_NOTICE_DIGEST_EMAIL; sendgrid.isConfigured = () => true; });

  test('an outside recipient: digest still delivered, the mail call returns ok:false and sends nothing', async () => {
    process.env.APP_FIRST_STALE_NOTICE_DIGEST_EMAIL = 'someone@outside-example.invalid';
    await Check.postStaleAppNoticeDigest(Check.groupByVisit(stale));
    expect(deliverOpsDigest).toHaveBeenCalledTimes(1);
    expect(await deliverOpsDigest.mock.calls[0][0].sendEmail()).toEqual({ ok: false, error: 'recipient_not_internal' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('no mailer key: digest still delivered, the mail call returns ok:false', async () => {
    sendgrid.isConfigured = () => false;
    await Check.postStaleAppNoticeDigest(Check.groupByVisit(stale));
    expect(deliverOpsDigest).toHaveBeenCalledTimes(1);
    expect(await deliverOpsDigest.mock.calls[0][0].sendEmail()).toEqual({ ok: false, error: 'mailer_unconfigured' });
  });
});
