// Real PostgreSQL rollback/concurrency checks, restricted to managed QA.
// A temporary, fixture-scoped trigger injects real child add-on SQL failures.
const { randomUUID } = require('node:crypto');
const mockRegister = jest.fn();
jest.mock('../services/appointment-reminders', () => ({
  registerAppointment: mockRegister, alertRegistrationFailure: jest.fn(),
}));

const enabled = !!process.env.DATABASE_URL;
(enabled ? describe : describe.skip)('recurring add-on atomicity (PostgreSQL)', () => {
  let db;
  let maintain;
  let parent;
  let service;
  let reminderSnapshots;
  const customerId = randomUUID();
  const parentId = randomUUID();
  const faultName = `qa_addon_${randomUUID().replaceAll('-', '')}`;

  async function removeFault() {
    await db.raw('DROP TRIGGER IF EXISTS ?? ON scheduled_service_addons', [faultName]);
    await db.raw('DROP FUNCTION IF EXISTS ??()', [faultName]);
  }

  // Import the route before timed DB hooks: a cold Jest transform of its
  // dependency graph can exceed the database setup budget on a busy runner.
  if (enabled) {
    const expected = `/waves_qa_${(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (process.env.WAVES_LOCAL_DEV !== '1' || !process.env.WAVES_WORKTREE_ID ||
        new URL(process.env.DATABASE_URL).pathname !== expected) {
      throw new Error('Use the managed worktree-owned QA database for PostgreSQL tests.');
    }
    db = require('../models/db');
    maintain = require('../routes/admin-schedule').runRecurringSeriesMaintenance;
  }

  beforeAll(async () => {
    service = await db('services').where({ service_key: 'pest_general_quarterly', is_active: true }).first();
    if (!service) throw new Error('Migrated general pest catalog is required.');
    await db('customers').insert({ id: customerId, first_name: 'QA', last_name: 'Recurring', phone: '+19415550102',
      email: `qa-recurring-${customerId}@example.invalid`, active: true, pipeline_stage: 'active_customer' });
  }, 30000);

  beforeEach(async () => {
    await removeFault();
    await db('scheduled_services').where({ customer_id: customerId }).whereNot('id', parentId).del();
    await db('scheduled_service_addons').where({ scheduled_service_id: parentId }).del();
    const { fixtureDates } = require('../../scripts/qa/fixtures');
    const data = { id: parentId, customer_id: customerId, service_id: service.id, service_type: service.name,
      scheduled_date: fixtureDates(new Date()).date, window_start: '09:00:00', window_end: '10:00:00',
      status: 'confirmed', is_recurring: true, recurring_ongoing: true, recurring_pattern: 'quarterly',
      estimated_price: 99, create_invoice_on_complete: true, estimated_duration_minutes: 60 };
    [parent] = await db('scheduled_services').insert(data).onConflict('id').merge(data).returning('*');
    await db('scheduled_service_addons').insert([
      { scheduled_service_id: parentId, service_name: 'QA Scope A', estimated_price: 12, base_price: 15, discount_dollars: 3 },
      { scheduled_service_id: parentId, service_name: 'QA Scope B', estimated_price: 18, base_price: 18, discount_dollars: 0 },
    ]);
    mockRegister.mockReset();
    reminderSnapshots = [];
    mockRegister.mockImplementation(async id => {
      // An independent connection must see all scope before reminder registration.
      reminderSnapshots.push({ visit: !!(await db('scheduled_services').where({ id }).first()),
        addons: (await db('scheduled_service_addons').where({ scheduled_service_id: id })).length });
    });
  }, 30000);

  afterAll(async () => {
    if (!db) return;
    try {
      await removeFault();
      await db('scheduled_services').where({ customer_id: customerId }).whereNot('id', parentId).del();
      await db('scheduled_services').where({ id: parentId, customer_id: customerId }).del();
      await db('customers').where({ id: customerId, email: `qa-recurring-${customerId}@example.invalid` }).del();
      expect(await db('scheduled_services').where({ customer_id: customerId })).toHaveLength(0);
      expect(await db('customers').where({ id: customerId }).first()).toBeUndefined();
    } finally { await db.destroy(); }
  }, 30000);

  test.each([0, 1])('failure after %i child add-ons rolls back the entire child; retry commits all scope', async failAfter => {
    // The trigger selects only this run's recurring children. Counting persisted
    // child lines makes first/second failure independent of parent read order.
    // Values are generated fixture IDs/integers and escaped by Knex toQuery;
    // CREATE FUNCTION bodies cannot accept PostgreSQL bind parameters.
    const body = db.raw(`BEGIN
      IF EXISTS (SELECT 1 FROM scheduled_services WHERE id = NEW.scheduled_service_id AND recurring_parent_id = ?::uuid)
        AND (SELECT count(*) FROM scheduled_service_addons WHERE scheduled_service_id = NEW.scheduled_service_id) >= ? THEN
        RAISE EXCEPTION 'QA child add-on failure';
      END IF;
      RETURN NEW;
    END`, [parentId, failAfter]).toQuery();
    await db.raw(db.raw('CREATE FUNCTION ??() RETURNS trigger LANGUAGE plpgsql AS ?', [faultName, body]).toQuery());
    await db.raw('CREATE TRIGGER ?? BEFORE INSERT ON scheduled_service_addons FOR EACH ROW EXECUTE FUNCTION ??()', [faultName, faultName]);
    let successfulInserts = 0;
    const recordInsert = (_result, query) => {
      if (/^insert into "scheduled_service_addons"/.test(query.sql)) successfulInserts++;
    };
    db.on('query-response', recordInsert);
    try { await expect(maintain(db, parent)).rejects.toThrow('QA child add-on failure'); }
    finally { db.removeListener('query-response', recordInsert); }
    expect(successfulInserts).toBe(failAfter);
    expect(await db('scheduled_services').where({ recurring_parent_id: parentId })).toHaveLength(0);
    expect(await db('scheduled_service_addons').where({ scheduled_service_id: parentId })).toHaveLength(2);
    expect(mockRegister).not.toHaveBeenCalled();
    await removeFault();
    await maintain(db, parent);
    const children = await db('scheduled_services').where({ recurring_parent_id: parentId });
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ customer_id: customerId, service_id: service.id, create_invoice_on_complete: true });
    const addons = await db('scheduled_service_addons').where({ scheduled_service_id: children[0].id }).orderBy('service_name');
    expect(addons.map(row => [row.service_name, Number(row.estimated_price), Number(row.base_price), Number(row.discount_dollars)]))
      .toEqual([['QA Scope A', 12, 15, 3], ['QA Scope B', 18, 18, 0]]);
    expect(mockRegister).toHaveBeenCalledTimes(1);
    expect(reminderSnapshots).toEqual([{ visit: true, addons: 2 }]);
    await maintain(db, parent);
    expect(await db('scheduled_services').where({ recurring_parent_id: parentId })).toHaveLength(1);
    expect(mockRegister).toHaveBeenCalledTimes(1);
  }, 60000);

  test('competing refill attempts create one complete child and register once', async () => {
    await Promise.all([maintain(db, parent), maintain(db, parent)]);
    const children = await db('scheduled_services').where({ recurring_parent_id: parentId });
    expect(children).toHaveLength(1);
    expect(await db('scheduled_service_addons').where({ scheduled_service_id: children[0].id })).toHaveLength(2);
    expect(mockRegister).toHaveBeenCalledTimes(1);
    expect(reminderSnapshots).toEqual([{ visit: true, addons: 2 }]);
  }, 60000);
});
