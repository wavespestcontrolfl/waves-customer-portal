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

const staleRow = {
  visit_id: 'visit-stale-1', customer_id: 'cust-1', first_name: 'Sample', last_name: 'Tester',
  first_push: new Date('2026-11-17T14:00:00Z'), last_push: new Date('2026-11-18T16:00:00Z'),
  notice_types: ['reminder_72h', 'appointment_reminder', 'tech_en_route', 'tech_arrived'],
  last_app_use: new Date('2026-10-10T14:00:00Z'), days_since_app_use: 39, scheduled_date: '2026-11-18',
};
const dbReturning = (rows) => ({ raw: jest.fn(async () => ({ rows })) });

beforeEach(() => { jest.clearAllMocks(); });

test('a stale visit makes one digest carrying that visit id, the notice types and the days since app use', async () => {
  const result = await Check.runAppFirstStaleNoticeCheck({ database: dbReturning([staleRow]) });
  expect(result.found).toBe(1);
  expect(deliverOpsDigest).toHaveBeenCalledTimes(1);
  const arg = deliverOpsDigest.mock.calls[0][0];
  expect(arg).toMatchObject({ fallOff: true, key: Check.OPS_DIGEST_KEY, dedupeKey: Check.OPS_DIGEST_KEY, refreshOnDedupe: true, itemKeys: ['visit-stale-1'] });
  expect(arg.subject).toBe('FIX: 1 visit got app-only notices on an app not opened in 30+ days');
  expect(arg.text).toContain('2026-11-18 · Sample T. · reminder_72h, appointment_reminder, tech_en_route, tech_arrived · 39 days since app use');
  expect(arg.text).toContain('/admin/customers/cust-1');
  expect(arg.link).toBe('/admin/customers/cust-1');
  expect(retireIfClean).not.toHaveBeenCalled();
});

test('no problem visit (a customer who opened the app 5 days before, or got a text): no digest, the standing row retires', async () => {
  // The SQL excludes both cases, so the seam returns no rows.
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

test('the query is bound to a 48 hour window, the 30 day bound and the 4 day text look-back, and only reads', async () => {
  const database = dbReturning([]);
  const now = new Date('2026-11-18T20:30:00Z');
  await Check.findStaleAppNoticeVisits({ database, now });
  const [sql, bindings] = database.raw.mock.calls[0];
  expect(bindings).toEqual([new Date('2026-11-16T20:30:00Z'), 30, 4]);
  expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
});

test('the mail fallback stays internal: an outside recipient sends nothing', async () => {
  process.env.APP_FIRST_STALE_NOTICE_DIGEST_EMAIL = 'someone@outside-example.invalid';
  try {
    expect(await Check.postStaleAppNoticeDigest([staleRow])).toEqual({ skipped: 'recipient' });
    expect(deliverOpsDigest).not.toHaveBeenCalled();
  } finally {
    delete process.env.APP_FIRST_STALE_NOTICE_DIGEST_EMAIL;
  }
});
