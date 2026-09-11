/** Real route conversion and allocation writes in a synthetic private schema. */
const { createCapacityDbFixture, describeDb } = require('./helpers/scheduling-capacity-db');
const { randomUUID } = require('node:crypto');
jest.setTimeout(30000);

describeDb('scheduling capacity allocation on PostgreSQL', () => {
  const f = createCapacityDbFixture('scheduling_capacity_allocation');

  test('conversion keeps companions beside their anchor ahead of the next appointment', async () => {
    const { persistCapacityAllocation, groupRouteStops } = require('../services/scheduling/arrival-route');
    const visit_id = randomUUID();
    const anchor = f.baseStop({ visit_id, route_order: 1 });
    const companion = f.baseStop({ visit_id, service_type: 'Lawn Care', route_order: null });
    const next = f.baseStop({ window_start: '12:00', window_end: '12:30', route_order: 2 });
    await f.db('scheduled_services').insert([anchor, companion, next]);
    await f.db.transaction(trx => persistCapacityAllocation(trx, anchor, [anchor.id, companion.id]));
    const rows = await f.db('scheduled_services').orderBy('route_order');
    expect(rows.map(row => row.id)).toEqual([anchor.id, companion.id, next.id]);
    expect(groupRouteStops(rows)[0].memberIds).toEqual([anchor.id, companion.id]);
    expect(await f.db('audit_log').where({ action: 'schedule.capacity_allocated' })).toHaveLength(1);
  });

  test('allocation refuses a busy tech-day fence without waiting behind its row locks', async () => {
    const { persistCapacityAllocation } = require('../services/scheduling/arrival-route');
    const { lockTechDays } = require('../services/scheduling/tech-day-lock');
    const anchor = f.baseStop({ route_order: 1 });
    const companion = f.baseStop({ service_type: 'Lawn Care', route_order: null });
    await f.db('scheduled_services').insert([anchor, companion]);
    const reorder = await f.db.transaction();
    try {
      await lockTechDays(reorder, [{ techId: f.ids.technician, date: f.date }]);
      await expect(f.db.transaction(trx => persistCapacityAllocation(trx, anchor, [anchor.id, companion.id])))
        .rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
      expect((await f.db('scheduled_services').where({ id: companion.id }).first()).route_order).toBeNull();
    } finally { await reorder.rollback(); }
  });

  test('same-day insertion persists the completed prefix before pending work', async () => {
    const { evaluateArrivalPlacement, persistArrivalOrder } = require('../services/scheduling/arrival-route');
    const { lockTechDays } = require('../services/scheduling/tech-day-lock');
    const { parseETDateTime } = require('../utils/datetime-et');
    const first = f.baseStop({ status: 'completed', route_order: 1,
      actual_end_time: parseETDateTime(`${f.date}T08:30`) });
    const second = f.baseStop({ status: 'completed', window_start: '09:00', window_end: '09:30', route_order: 2,
      actual_end_time: parseETDateTime(`${f.date}T09:30`) });
    const pending = f.baseStop({ window_start: '13:00', window_end: '13:30', route_order: 3 });
    const candidate = f.baseStop({ window_start: '12:00', window_end: '12:30', route_order: null });
    const fit = evaluateArrivalPlacement({ date: f.date, now: parseETDateTime(`${f.date}T11:00`),
      target: { ...candidate, id: '__candidate__' }, rows: [first, second, pending], prospective: true },
    { windowStart: '12:00', windowEnd: '12:30', durationMinutes: 30 });
    expect(fit.feasible).toBe(true);
    expect(fit.routeOrder).toEqual([first.id, second.id, '__candidate__', pending.id]);
    await f.db('scheduled_services').insert([first, second, pending, candidate]);
    await f.db.transaction(async trx => {
      await lockTechDays(trx, [{ techId: f.ids.technician, date: f.date }]);
      await persistArrivalOrder(trx, fit, candidate.id);
    });
    const rows = await f.db('scheduled_services').orderBy('route_order');
    expect(rows.map(row => row.id)).toEqual([first.id, second.id, candidate.id, pending.id]);
    expect(rows.map(row => row.route_order)).toEqual([1, 2, 3, 4]);
  });
});
