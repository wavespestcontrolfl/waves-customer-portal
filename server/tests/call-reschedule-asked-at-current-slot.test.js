// Local audit 2026-11-22: a caller who asks for the slot the visit already holds gets "the customer asked for this time"
// recorded on it (call-reschedule-apply.js recordAskedAtCurrentSlot), as a move to that slot records it, so the night jobs keep
// it now that a staff placement alone no longer holds a visit. Fake knex; synthetic ids; nothing is sent.
const { recordAskedAtCurrentSlot } = require('../services/call-reschedule-apply');

function fakeTrx(row) {
  const updates = [];
  const trx = (table) => {
    const chain = {
      where: () => chain,
      whereIn: () => chain,
      forUpdate: () => chain,
      first: async () => row,
      update: async (payload) => { updates.push({ table, payload }); return 1; },
    };
    return chain;
  };
  trx.raw = (sql) => ({ sql });
  trx.updates = updates;
  return trx;
}

const plan = { newDate: '2026-12-03', newWindow: { start: '09:00', end: '10:00' } };

describe('recordAskedAtCurrentSlot', () => {
  test('the locked row still holds the slot: records true with the database clock', async () => {
    const trx = fakeTrx({ scheduled_date: '2026-12-03', window_start: '09:00:00' });
    expect(await recordAskedAtCurrentSlot(trx, 'v1', plan)).toBe(true);
    expect(trx.updates).toEqual([{ table: 'scheduled_services', payload: { customer_asked_time: true, customer_asked_time_at: { sql: 'now()' } } }]);
  });

  test('a row that moved meanwhile, or no row: nothing is written', async () => {
    for (const row of [{ scheduled_date: '2026-12-04', window_start: '09:00:00' }, { scheduled_date: '2026-12-03', window_start: '13:00:00' }, null]) {
      const trx = fakeTrx(row);
      expect(await recordAskedAtCurrentSlot(trx, 'v1', plan)).toBe(false);
      expect(trx.updates).toEqual([]);
    }
  });

  test('a caller-locked row is used as is', async () => {
    const trx = fakeTrx(null);
    expect(await recordAskedAtCurrentSlot(trx, 'v1', plan, { scheduled_date: '2026-12-03', window_start: '09:00' })).toBe(true);
  });
});
