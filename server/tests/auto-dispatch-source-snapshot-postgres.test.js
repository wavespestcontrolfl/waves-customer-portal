const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('crypto');
const knex = require('knex');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const {
  SOURCE_SNAPSHOT_STALE,
  _internals: { sourceSnapshot },
} = require('../services/auto-dispatch/candidate-slots');

(SKIP ? describe.skip : describe)('auto-dispatch source snapshot on PostgreSQL', () => {
  let database;
  let trx;
  const ids = {
    service: randomUUID(), customer: randomUUID(), parent: randomUUID(), tech: randomUUID(),
  };

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && !ownedQA) {
      throw new Error('Use the disposable CI database or this managed worktree\'s private QA database');
    }
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL });
    trx = await database.transaction();
    await trx.raw(`
      CREATE TEMP TABLE scheduled_services AS SELECT * FROM public.scheduled_services WITH NO DATA;
      CREATE TEMP TABLE customers AS SELECT * FROM public.customers WITH NO DATA;
    `);
  });

  afterAll(async () => {
    await trx?.rollback();
    await database?.destroy();
  });

  beforeEach(async () => {
    await trx.raw('TRUNCATE scheduled_services, customers');
    await trx('customers').insert({
      id: ids.customer, active: true, latitude: 27.43, longitude: -82.53,
      address_line1: '12 Palm Way', city: 'Bradenton', state: 'FL', zip: '34203',
    });
    await trx('scheduled_services').insert({
      id: ids.service, customer_id: ids.customer, recurring_parent_id: ids.parent,
      technician_id: ids.tech, scheduled_date: '2099-08-04',
      window_start: '09:00', window_end: '10:00', status: 'confirmed',
      is_recurring: true, estimated_duration_minutes: 60,
      auto_dispatch_locked: false, auto_dispatch_excluded: false,
      lat: null, lng: null,
    });
  });

  const service = () => ({
    id: ids.service, customer_id: ids.customer, recurring_parent_id: ids.parent,
    technician_id: ids.tech, scheduled_date: '2099-08-04',
    window_start: '09:00', window_end: '10:00', status: 'confirmed',
    is_recurring: true, lat: null, lng: null,
  });
  const grouped = () => ({
    db: trx,
    eligibilityContext: { flexTier: { enabled: true } },
    groupContext: { excludeIds: new Set([ids.service]), siblings: [], visitWindowStart: null },
  });

  test('keeps raw null service coordinates while routing on the joined customer pin', async () => {
    const result = await sourceSnapshot(service(), grouped());
    expect(result.geo).toEqual({ lat: 27.43, lng: -82.53 });
    expect(result.service).toMatchObject({ lat: null, lng: null });
    expect(Number(result.service.customer_latitude)).toBe(27.43);
    expect(Number(result.service.customer_longitude)).toBe(-82.53);
    expect(result.sourceDay[0].geo).toEqual({ lat: 27.43, lng: -82.53 });
  });

  test.each([
    ['en_route lifecycle', { status: 'en_route' }],
    ['on_site lifecycle', { status: 'on_site' }],
    ['non-recurring row', { is_recurring: false }],
    ['parent template', { recurring_parent_id: null }],
  ])('rejects a live %s before route discovery', async (_label, patch) => {
    await trx('scheduled_services').where({ id: ids.service }).update(patch);
    await expect(sourceSnapshot(service(), grouped()))
      .rejects.toMatchObject({ code: SOURCE_SNAPSHOT_STALE, skipEvaluation: true });
  });
});
