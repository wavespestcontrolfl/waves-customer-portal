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
  const PUSH_AT = daysBefore(1);

  beforeAll(() => {
    const target = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    db = require('../models/db');
    Check = require('../services/app-first-stale-notice-check');
  });

  // One automatic app push for one synthetic visit; `stamp` is the metadata app_checked_in_at as written.
  async function seed(trx, { stamp, requestedChannel = 'sms', types = ['reminder_72h', 'tech_en_route'] } = {}) {
    const customerId = randomUUID();
    const visitId = randomUUID();
    await trx('customers').insert({ id: customerId, first_name: 'Sample', last_name: 'Tester', phone: '+19415550143', email: `${customerId}@example.invalid` });
    for (const [i, type] of types.entries()) {
      await trx('sms_log').insert({
        customer_id: customerId, direction: 'outbound', from_phone: 'push', to_phone: '9415550143', message_body: 'Synthetic notice',
        status: 'sent', message_type: type, created_at: new Date(PUSH_AT.getTime() + i * 3600000),
        metadata: JSON.stringify({ channel: 'push', requestedChannel, scheduled_service_id: visitId, ...(stamp === undefined ? {} : { app_checked_in_at: stamp }) }),
      });
    }
    return { customerId, visitId };
  }

  const find = async (trx, visitId) => (await Check.findStaleAppNoticeVisits({ database: trx, now: NOW })).filter((i) => i.visit_id === visitId);

  test('a stamp 39 days before the push is found as one visit item; 5 days, no stamp, an explicit App choice and a malformed stamp are not, and never throw', async () => {
    const trx = await db.transaction();
    try {
      const stale = await seed(trx, { stamp: daysBefore(39, PUSH_AT).toISOString() });
      const items = await find(trx, stale.visitId);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ key: `visit:${stale.visitId}`, customer_id: stale.customerId, first_name: 'Sample', days_since_app_use: 39 });
      expect([...items[0].notice_types].sort()).toEqual(['reminder_72h', 'tech_en_route']);

      expect(await find(trx, (await seed(trx, { stamp: daysBefore(5, PUSH_AT).toISOString() })).visitId)).toHaveLength(0);
      expect(await find(trx, (await seed(trx, {})).visitId)).toHaveLength(0);
      expect(await find(trx, (await seed(trx, { stamp: daysBefore(39, PUSH_AT).toISOString(), requestedChannel: 'push' })).visitId)).toHaveLength(0);
      expect(await find(trx, (await seed(trx, { stamp: 'not-a-date' })).visitId)).toHaveLength(0);
      // An impossible calendar date next to a valid stale row: only the valid one is reported, and nothing throws.
      const impossible = await seed(trx, { stamp: '2026-02-31T12:00:00Z' });
      expect(await find(trx, impossible.visitId)).toHaveLength(0);
      expect(await find(trx, stale.visitId)).toHaveLength(1);
    } finally {
      await trx.rollback();
    }
  });
});
