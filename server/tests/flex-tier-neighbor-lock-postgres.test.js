// FLEX-TIER apply-time neighbor read against real PostgreSQL (Codex #4995
// P1): the series fence (the recurring-series-maintenance advisory lock)
// never stops an ORDINARY single-occurrence reschedule — rebooker.reschedule,
// as reschedule-public.js drives it — so the authoritative neighbor read
// row-locks the series' live rows (loadSeriesNeighbors { lock: true } — FOR
// SHARE NOWAIT). Two connections:
//   - flex reads first: a concurrent reschedule of the neighbor WAITS for the
//     flex transaction and lands only after it commits (serialized, never
//     interleaved with a stale bound);
//   - the neighbor edit is in flight first: the flex read refuses at once
//     (no wait), and checkFlexOwnBounds turns that into a fail-closed
//     refusal — while the unlocked planning read still just sees the
//     committed date.
const { randomUUID } = require('crypto');

const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
// apply.js pulls in the rebooker/visit-groups graph on first require.
const HOOK_TIMEOUT_MS = 60000;

postgres('flex-tier neighbor row lock against PostgreSQL', () => {
  let flexDb; let otherDb; let flexTier; let checkFlexOwnBounds;
  const customerId = randomUUID();
  const parentId = randomUUID();
  const aId = randomUUID();
  const bId = randomUUID();
  const A = { id: aId, recurring_parent_id: parentId };

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Use a disposable local database');
    flexTier = require('../services/auto-dispatch/flex-tier');
    ({ checkFlexOwnBounds } = require('../services/auto-dispatch/apply'));
    flexDb = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 1 } });
    otherDb = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 1 } });
    await flexDb('customers').insert({
      id: customerId, first_name: 'Synthetic', last_name: 'Fixture', phone: `fixture-${customerId.slice(0, 8)}`,
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000',
    });
    const base = {
      customer_id: customerId, service_type: 'Monthly Pest Control Service', status: 'pending',
      is_recurring: true, recurring_pattern: 'monthly', window_start: '09:00',
    };
    await flexDb('scheduled_services').insert({ ...base, id: parentId, scheduled_date: '2040-11-03' });
    await flexDb('scheduled_services').insert([
      { ...base, id: aId, recurring_parent_id: parentId, scheduled_date: '2040-11-10' },
      { ...base, id: bId, recurring_parent_id: parentId, scheduled_date: '2040-11-17' },
    ]);
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    if (flexDb) {
      const ids = [aId, bId, parentId];
      if (await flexDb.schema.hasTable('appointment_reminders')) {
        await flexDb('appointment_reminders').whereIn('scheduled_service_id', ids).del();
      }
      await flexDb('scheduled_services').whereIn('id', [aId, bId]).del();
      await flexDb('scheduled_services').where({ id: parentId }).del();
      await flexDb('customers').where({ id: customerId }).del();
    }
    await flexDb?.destroy();
    await otherDb?.destroy();
    // apply.js loads the shared app pool (models/db) — close it too.
    await require('../models/db').destroy();
  }, HOOK_TIMEOUT_MS);

  afterEach(async () => {
    await otherDb('scheduled_services').where({ id: bId }).update({ scheduled_date: '2040-11-17' });
  });

  // Polls until `pid` is blocked on a lock (pg_stat_activity), or times out.
  async function waitUntilLockWaiting(conn, pid) {
    for (let i = 0; i < 100; i++) {
      const { rows } = await conn.raw('SELECT wait_event_type FROM pg_stat_activity WHERE pid = ?', [pid]);
      if (rows[0] && rows[0].wait_event_type === 'Lock') return true;
      await new Promise((r) => { setTimeout(r, 50); });
    }
    return false;
  }

  test('flex reads first: a concurrent reschedule of the neighbor waits for the flex commit, never interleaves', async () => {
    const { rows: [{ pid: otherPid }] } = await otherDb.raw('SELECT pg_backend_pid() AS pid');
    const trx = await flexDb.transaction();
    let otherLanded = false;
    let other;
    try {
      const map = await flexTier.loadSeriesNeighbors(trx, [A], { lock: true });
      expect(map.get(aId)).toEqual({ prev: '2040-11-03', next: '2040-11-17' });
      other = otherDb('scheduled_services').where({ id: bId }).update({ scheduled_date: '2040-11-12' })
        .then(() => { otherLanded = true; });
      expect(await waitUntilLockWaiting(trx, otherPid)).toBe(true);
      expect(otherLanded).toBe(false); // blocked behind the flex read's row lock
      await trx.commit();
    } catch (err) {
      await trx.rollback();
      throw err;
    }
    await other;
    expect(otherLanded).toBe(true); // lands only after the flex transaction
    const b = await flexDb('scheduled_services').where({ id: bId }).first('scheduled_date');
    expect(flexTier.seriesPosition({ scheduled_date: b.scheduled_date })).toBe('2040-11-12');
  }, HOOK_TIMEOUT_MS);

  test('neighbor edit in flight first: the locked read refuses at once (fail closed), the planning read sees the committed date', async () => {
    const edit = await otherDb.transaction();
    try {
      await edit('scheduled_services').where({ id: bId }).update({ scheduled_date: '2040-11-12' });
      // Planning read (no lock): the committed 11-17, no wait.
      const planning = await flexTier.loadSeriesNeighbors(flexDb, [A]);
      expect(planning.get(aId)).toEqual({ prev: '2040-11-03', next: '2040-11-17' });
      const trx = await flexDb.transaction();
      try {
        const started = Date.now();
        await expect(flexTier.loadSeriesNeighbors(trx, [A], { lock: true })).resolves.toBeNull();
        expect(Date.now() - started).toBeLessThan(2000);
      } finally {
        await trx.rollback();
      }
      const trx2 = await flexDb.transaction();
      try {
        const row = {
          id: aId, recurring_parent_id: parentId, is_recurring: true, scheduled_date: '2040-11-10', window_start: '09:00',
        };
        const refuse = (id, why) => Object.assign(new Error(`refused ${id}: ${why}`), { id, why });
        await expect(checkFlexOwnBounds(trx2, row, { date: '2040-11-14', start_time: '09:00' }, 'flex', refuse, { date: '2040-11-14', windowStart: '09:00' }))
          .rejects.toMatchObject({ id: aId, why: expect.stringContaining('being edited') });
      } finally {
        await trx2.rollback();
      }
    } finally {
      await edit.rollback();
    }
  }, HOOK_TIMEOUT_MS);
});
