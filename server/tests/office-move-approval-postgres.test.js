// Office move approval against migrated PostgreSQL: any change to a visit's
// date or start clears scheduled_services.office_move_approved_for, so a
// visit moved away and back cannot revive an old approval (codex P1 #6039
// r1). Writes that leave date and start alone keep it.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
const { randomUUID } = require('node:crypto');

postgres('office move approval clears on move (migrated PostgreSQL)', () => {
  let database;
  let trx;
  let visitId;
  const APPROVED = new Date('2099-08-04T17:00:00.000Z'); // 2099-08-04 13:00 EDT

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 2 } });
  });

  beforeEach(async () => {
    trx = await database.transaction();
    const customerId = randomUUID();
    await trx('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Approval',
      email: `${customerId}@example.invalid`, phone: `fixture-${customerId.slice(0, 8)}`,
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000', active: true, pipeline_stage: 'active_customer' });
    visitId = randomUUID();
    await trx('scheduled_services').insert({ id: visitId, customer_id: customerId, service_type: 'Pest Control',
      status: 'confirmed', scheduled_date: '2099-08-04', window_start: '13:00', window_end: '14:00',
      office_move_approved_for: APPROVED });
  });
  afterEach(async () => { if (trx) await trx.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  const approval = async () => (await trx('scheduled_services').where({ id: visitId }).first('office_move_approved_for')).office_move_approved_for;

  test('a write that leaves date and start alone keeps the approval', async () => {
    await trx('scheduled_services').where({ id: visitId }).update({ window_end: '14:30', status: 'pending' });
    expect(new Date(await approval()).getTime()).toBe(APPROVED.getTime());
  });

  test('a start change clears it, and moving back does not revive it', async () => {
    await trx('scheduled_services').where({ id: visitId }).update({ window_start: '15:00' });
    expect(await approval()).toBeNull();
    await trx('scheduled_services').where({ id: visitId }).update({ window_start: '13:00' });
    expect(await approval()).toBeNull();
  });

  test('a date change clears it', async () => {
    await trx('scheduled_services').where({ id: visitId }).update({ scheduled_date: '2099-08-05' });
    expect(await approval()).toBeNull();
  });
});
