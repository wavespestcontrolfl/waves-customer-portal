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
  created_at: new Date('2026-11-18T14:00:00Z'), app_checked_in_at: '2026-10-10T14:00:00.000Z', message_type: 'tech_en_route',
  scheduled_date: '2026-11-18', ...over,
});
const dbReturning = (rows) => ({ raw: jest.fn(async () => ({ rows })) });
const stale = [pushRow({ id: 'r1', message_type: 'reminder_72h' }), pushRow({ id: 'r2', message_type: 'tech_en_route' }), pushRow({ id: 'r3', message_type: 'tech_arrived' })];
const staleItems = () => Check.groupByVisit(Check.staleRows(stale));

beforeEach(() => { jest.clearAllMocks(); });

test('stale-stamped pushes for one visit make one digest item (visit:<id>) with the notice types and days since app use', async () => {
  const result = await Check.runAppFirstStaleNoticeCheck({ database: dbReturning(stale) });
  expect(result.found).toBe(1);
  expect(deliverOpsDigest).toHaveBeenCalledTimes(1);
  const arg = deliverOpsDigest.mock.calls[0][0];
  expect(arg).toMatchObject({ fallOff: true, key: Check.OPS_DIGEST_KEY, dedupeKey: Check.OPS_DIGEST_KEY, refreshOnDedupe: true, itemKeys: ['visit:visit-stale-1'] });
  expect(arg.subject).toBe('FIX: 1 visit got app-only notices on an app not opened in 30+ days');
  expect(arg.text).toContain('2026-11-18 · Sample T. · reminder_72h, tech_en_route, tech_arrived · 39 days since app use');
  expect(arg.text).toContain('/admin/customers?customerId=cust-1');
  expect(arg.link).toBe('/admin/customers?customerId=cust-1');
  expect(retireIfClean).not.toHaveBeenCalled();
});

test('the stamp is judged in JS: fresh, impossible-date, malformed and 30-day-boundary stamps are not reported, and a valid stale row next to them is', async () => {
  const rows = [
    pushRow({ id: 'good', visit_id: 'v-good', app_checked_in_at: '2026-10-10T14:00:00.000Z' }),
    pushRow({ id: 'fresh', visit_id: 'v-fresh', app_checked_in_at: '2026-11-13T14:00:00.000Z' }),
    pushRow({ id: 'edge', visit_id: 'v-edge', app_checked_in_at: '2026-10-19T14:00:00.000Z' }),
    pushRow({ id: 'feb31', visit_id: 'v-feb31', app_checked_in_at: '2026-02-31T12:00:00Z' }),
    pushRow({ id: 'junk', visit_id: 'v-junk', app_checked_in_at: 'not-a-date' }),
    pushRow({ id: 'blank', visit_id: 'v-blank', app_checked_in_at: '' }),
  ];
  const result = await Check.runAppFirstStaleNoticeCheck({ database: dbReturning(rows) });
  expect(result.found).toBe(1);
  expect(deliverOpsDigest.mock.calls[0][0].itemKeys).toEqual(['visit:v-good']);
  expect(deliverOpsDigest.mock.calls[0][0].text).toContain('39 days since app use');
});

test('a failed digest send logs a controlled code, never the provider message (it can hold an address)', async () => {
  const logger = require('../services/logger');
  deliverOpsDigest.mockRejectedValueOnce(Object.assign(new Error('rejected for someone@example.invalid'), { code: 403 }));
  expect(await Check.postStaleAppNoticeDigest(staleItems())).toEqual({ sent: false, error: true });
  const logged = logger.error.mock.calls.map((c) => c[0]).join('\n');
  expect(logged).toContain('403');
  expect(logged).not.toContain('someone@example.invalid');
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
  expect(bindings).toEqual([new Date('2026-11-16T20:30:00Z')]);
  expect(sql).toContain("requestedChannel' = 'sms'");
  expect(sql).toContain("app_checked_in_at' IS NOT NULL");
  expect(sql).not.toContain('::timestamptz)');
  expect(sql).not.toMatch(/customer_page_views|customer_refresh_tokens|push_subscriptions/);
  expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
});

describe('mail guards sit inside sendEmail, so the in-app row is always written', () => {
  const sendgrid = require('../services/sendgrid-mail');
  afterEach(() => { delete process.env.APP_FIRST_STALE_NOTICE_DIGEST_EMAIL; sendgrid.isConfigured = () => true; });

  test('an outside recipient: digest still delivered, the mail call returns ok:false and sends nothing', async () => {
    process.env.APP_FIRST_STALE_NOTICE_DIGEST_EMAIL = 'someone@outside-example.invalid';
    await Check.postStaleAppNoticeDigest(staleItems());
    expect(deliverOpsDigest).toHaveBeenCalledTimes(1);
    expect(await deliverOpsDigest.mock.calls[0][0].sendEmail()).toEqual({ ok: false, error: 'recipient_not_internal' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('no mailer key: digest still delivered, the mail call returns ok:false', async () => {
    sendgrid.isConfigured = () => false;
    await Check.postStaleAppNoticeDigest(staleItems());
    expect(deliverOpsDigest).toHaveBeenCalledTimes(1);
    expect(await deliverOpsDigest.mock.calls[0][0].sendEmail()).toEqual({ ok: false, error: 'mailer_unconfigured' });
  });
});
