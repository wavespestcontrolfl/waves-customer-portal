// Picked up by the existing DB-gated CI step; all synthetic writes roll back.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  return db;
});
const { randomUUID } = require('node:crypto');
const history = require('../services/review-ask-history');

postgres('review ask history against migrated PostgreSQL', () => {
  let database;
  let trx;
  let customerId;
  const at = new Date('2040-01-10T16:00:00Z');
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!local && !ownedQA) throw new Error('Use disposable CI or this worktree’s private QA database');
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
  });
  beforeEach(async () => {
    trx = await database.transaction();
    require('../models/db').connection = trx;
    customerId = randomUUID();
    await trx('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Fixture',
      email: `${customerId}@example.invalid`, phone: `fixture-${customerId.slice(0, 8)}`,
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000', active: true, pipeline_stage: 'active_customer' });
  });
  afterEach(async () => { await trx?.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  async function request(values = {}) {
    const [row] = await trx('review_requests').insert({ customer_id: customerId, token: randomUUID(),
      created_at: new Date('2039-01-01T16:00:00Z'), ...values }).returning('*');
    return row;
  }

  test('delivery time includes old queued rows and uses the later channel, excluding private check-ins', async () => {
    const latest = new Date(at.getTime() + 3600000);
    const row = await request({ sms_sent_at: at, sent_at: latest });
    await request({ sms_sent_at: new Date(latest.getTime() + 3600000), template_key: 'resolution_check' });
    await request();
    expect(await history.lastDeliveredAskAt(customerId, { since: at })).toEqual(latest);
    expect(await history.deliveredAskRows(customerId, { since: latest })).toEqual([]);
    expect(await history.lastDeliveredAskAt(customerId, { excludeRequestId: row.id })).toBeNull();
  });

  test('single-channel deliveries survive nulls and customer scoping', async () => {
    const row = await request({ sent_at: at });
    expect(await history.lastDeliveredAskAt(customerId)).toEqual(at);
    expect(await history.lastDeliveredAskAt(randomUUID())).toBeNull();
    await trx('review_requests').where({ id: row.id }).update({ sent_at: null, sms_sent_at: at });
    expect(await history.lastDeliveredAskAt(customerId)).toEqual(at);
  });

  test('only actual legacy follow-up delivery anchors history, not suppression', async () => {
    const row = await request({ sms_sent_at: at, followup_sent: true, followup_sent_at: new Date(at.getTime() + 86400000) });
    expect(await history.lastDeliveredAskAt(customerId)).toEqual(at);
    const deliveredAt = new Date(at.getTime() + 72 * 3600000);
    await trx('review_requests').where({ id: row.id }).update({ followup_delivered_at: deliveredAt });
    expect(await history.lastDeliveredAskAt(customerId, { since: at })).toEqual(deliveredAt);
    expect(await history.deliveredAskRows(customerId, { since: deliveredAt })).toEqual([]);
  });

  test.each(['bundled', 'declared'])('a delivered %s ask remains visible during finalize-only recovery', async kind => {
    await trx('sms_log').insert({ customer_id: customerId, direction: 'outbound',
      from_phone: '+12025550101', to_phone: '+12025550102', status: 'scheduled',
      created_at: at, message_body: 'Thank you: https://portal.test/l/abc123',
      metadata: { ...(kind === 'bundled' ? { bundled_review_request_id: randomUUID() } : { review_ask_delivered_at: at.toISOString() }), finalize_only: true } });
    expect(await history.lastManualAskAt(customerId, { since: at })).toEqual(at);
  });

  test('latest delivered manual ask excludes failed sends and acknowledgments', async () => {
    await request({ sms_sent_at: at });
    const manualAt = new Date(at.getTime() + 240000);
    await trx('sms_log').insert([
      { created_at: at, message_body: 'Please review us: https://g.page/r/example/review' },
      { created_at: manualAt, message_body: 'Please leave a Google review.' },
      { created_at: new Date(at.getTime() + 300000), message_body: 'Thanks for your Google review' },
      { created_at: new Date(at.getTime() + 360000), message_body: 'Please leave a Google review.', status: 'failed' },
    ].map(row => ({ customer_id: customerId, direction: 'outbound', from_phone: '+12025550101',
      to_phone: '+12025550102', status: 'sent', ...row })));
    expect(await history.lastManualAskAt(customerId, { since: at })).toEqual(manualAt);
  });
});
