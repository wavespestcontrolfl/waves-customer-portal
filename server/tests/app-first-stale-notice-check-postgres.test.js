// The stale-app live check's SQL against live Postgres (runs only in CI, where
// DATABASE_URL is set). Everything runs in one rolled-back transaction.
const { randomUUID } = require('crypto');

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

afterAll(async () => { if (!SKIP) await require('../models/db').destroy(); });

maybeDescribe('stale-app notice check (live Postgres)', () => {
  let db;
  let Check;
  const NOW = new Date('2026-11-18T20:30:00Z');
  const daysBefore = (days, from = NOW) => new Date(from.getTime() - days * 86400000);
  const FIRST_PUSH = daysBefore(1);

  beforeAll(() => {
    const target = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    db = require('../models/db');
    Check = require('../services/app-first-stale-notice-check');
  });

  async function seed(trx, { appSeenDaysBeforeFirstPush, withText = false, pushTypes = ['reminder_72h', 'tech_en_route'] } = {}) {
    const customerId = randomUUID();
    const visitId = randomUUID();
    await trx('customers').insert({ id: customerId, first_name: 'Sample', last_name: 'Tester', phone: '+19415550143', email: `${customerId}@example.invalid` });
    if (appSeenDaysBeforeFirstPush != null) {
      await trx('push_subscriptions').insert({ customer_id: customerId, role: 'customer', platform: 'ios', device_token: `qa-${randomUUID()}`,
        subscription_data: '{}', active: true, updated_at: daysBefore(appSeenDaysBeforeFirstPush, FIRST_PUSH) });
    }
    const log = (extra) => trx('sms_log').insert({ customer_id: customerId, direction: 'outbound', to_phone: '9415550143', message_body: 'Synthetic notice',
      status: 'sent', metadata: JSON.stringify({ scheduled_service_id: visitId }), ...extra });
    for (const [i, type] of pushTypes.entries()) {
      await log({ from_phone: 'push', message_type: type, created_at: new Date(FIRST_PUSH.getTime() + i * 3600000) });
    }
    if (withText) await log({ from_phone: '+19415550000', message_type: 'appointment_reminder', created_at: daysBefore(2) });
    return { customerId, visitId };
  }

  const find = async (trx, visitId) => (await Check.findStaleAppNoticeVisits({ database: trx, now: NOW })).filter((r) => r.visit_id === visitId);

  test('an app last opened 39 days before the first push is found; 5 days before is not; a text for the visit clears it; no app record at all is found', async () => {
    const trx = await db.transaction();
    try {
      const stale = await seed(trx, { appSeenDaysBeforeFirstPush: 39 });
      const rows = await find(trx, stale.visitId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ customer_id: stale.customerId, first_name: 'Sample', days_since_app_use: 39 });
      expect([...rows[0].notice_types].sort()).toEqual(['reminder_72h', 'tech_en_route']);

      const fresh = await seed(trx, { appSeenDaysBeforeFirstPush: 5 });
      expect(await find(trx, fresh.visitId)).toHaveLength(0);

      const texted = await seed(trx, { appSeenDaysBeforeFirstPush: 39, withText: true });
      expect(await find(trx, texted.visitId)).toHaveLength(0);

      const never = await seed(trx, {});
      const neverRows = await find(trx, never.visitId);
      expect(neverRows).toHaveLength(1);
      expect(neverRows[0].days_since_app_use).toBeNull();

      // A page view 5 days before the first push counts as app activity.
      const viewer = await seed(trx, { appSeenDaysBeforeFirstPush: 39 });
      await trx('customer_page_views').insert({ customer_id: viewer.customerId, page: 'portal', viewed_at: daysBefore(5, FIRST_PUSH) });
      expect(await find(trx, viewer.visitId)).toHaveLength(0);
    } finally {
      await trx.rollback();
    }
  });
});
