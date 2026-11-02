// CI's existing DB-gated step discovers this suite. Temporary tables copy
// migrated column types, contain synthetic records only, and roll back.
// Quick Move "let the customer pick a day" (owner 2026-11-01): the reschedule
// page's visit read (selectSvc) carries the hand-off columns, and the GET's
// customerPick / autoPlacedFromPick read the newest 'customer_pick'
// reschedule_log row on real PostgreSQL columns.
const SKIP = !process.env.DATABASE_URL;
const describeWithDatabase = SKIP ? describe.skip : describe;
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.transaction = (run) => db.connection.transaction(run);
  db.raw = (...args) => db.connection.raw(...args);
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

describeWithDatabase('reschedule page customer pick on PostgreSQL', () => {
  const { randomUUID } = require('crypto');
  const db = require('../models/db');
  const logger = require('../services/logger');
  const router = require('../routes/reschedule-public');
  const { loadById } = router._internals;
  const { customerPickFields } = router._test;
  let database;
  let trx;
  const customerId = randomUUID();
  const visitId = randomUUID();
  const pickBy = new Date('2099-11-05T01:00:00Z');
  const now = new Date('2099-11-04T15:00:00Z');

  beforeAll(async () => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && !ownedQA) {
      throw new Error('Use the disposable CI database or this managed worktree\'s private QA database');
    }
    database = require('knex')({ client: 'pg', connection });
    trx = await database.transaction();
    db.connection = trx;
    await trx.raw(`
      CREATE TEMP TABLE scheduled_services AS
        SELECT * FROM public.scheduled_services WITH NO DATA;
      CREATE TEMP TABLE customers AS
        SELECT * FROM public.customers WITH NO DATA;
      CREATE TEMP TABLE services AS
        SELECT * FROM public.services WITH NO DATA;
      CREATE TEMP TABLE reschedule_log AS
        SELECT * FROM public.reschedule_log WITH NO DATA;
    `);
    await trx('customers').insert({ id: customerId, active: true, first_name: 'Pat' });
    await trx('scheduled_services').insert({
      id: visitId, customer_id: customerId, status: 'pending', scheduled_date: '2099-11-12',
      window_start: null, window_end: null, service_type: 'Quarterly Pest Control Service',
      is_recurring: true, customer_pick_by: pickBy,
    });
    const logRow = (fields) => ({ id: randomUUID(), scheduled_service_id: visitId, customer_id: customerId, initiated_by: 'tech', ...fields });
    await trx('reschedule_log').insert([
      // An older hand-off of the same visit, in the first row shape (reason in notes): superseded by the newer one.
      logRow({ reason_code: 'customer_pick', original_date: '2099-10-20', original_window: '13:00:00-15:00:00', notes: 'running_late', created_at: new Date('2099-10-19T15:00:00Z') }),
      // The newest hand-off, as a Quick Move logs it: reason_code = why it moved, notes marks the hand-off.
      logRow({ reason_code: 'weather_rain', original_date: '2099-11-03', original_window: '09:00:00-11:00:00', notes: 'customer_pick', created_at: new Date('2099-11-03T15:00:00Z') }),
      // A newer row with another reason is not the hand-off row.
      logRow({ reason_code: 'weather_rain', original_date: '2099-11-04', original_window: '10:00:00-12:00:00', created_at: new Date('2099-11-04T09:00:00Z') }),
    ]);
  });
  afterAll(async () => {
    await trx?.rollback();
    await database?.destroy();
  });

  test('the visit read carries the marker and the Auto-Dispatch stamp; a waiting visit reads the newest hand-off row', async () => {
    const svc = await loadById(visitId);
    expect(svc.customer_pick_by).toEqual(pickBy);
    expect(svc).toHaveProperty('last_auto_dispatch_at', null);
    expect(svc.cust_first_name).toBe('Pat');

    expect(await customerPickFields(svc, now)).toEqual({
      customerPick: {
        pickBy: '2099-11-05T01:00:00.000Z',
        pickByLabel: 'Wed, Nov 4 at 8 PM',
        deadlinePassed: false,
        originalDate: '2099-11-03',
        originalWindowStart: '09:00',
        reasonCode: 'weather_rain',
      },
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('after an Auto-Dispatch placement past the deadline the visit reads as auto-placed', async () => {
    await trx('scheduled_services').where({ id: visitId }).update({
      scheduled_date: '2099-11-10', window_start: '10:00', window_end: '11:00', status: 'confirmed',
      last_auto_dispatch_at: new Date('2099-11-06T09:10:00Z'),
    });
    const svc = await loadById(visitId);
    expect(await customerPickFields(svc, new Date('2099-11-06T12:00:00Z'))).toEqual({
      autoPlacedFromPick: {
        from: { date: '2099-11-03', windowStart: '09:00' },
        to: { date: '2099-11-10', windowStart: '10:00' },
      },
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
