/** Real offer/hold queries and lock ordering in a synthetic private schema. */
const { createCapacityDbFixture, describeDb } = require('./helpers/scheduling-capacity-db');
const { reserveSlot } = require('../services/slot-reservation');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const { lockTechDays } = require('../services/scheduling/tech-day-lock');
jest.setTimeout(30000);

describeDb('scheduling capacity holds on PostgreSQL', () => {
  const f = createCapacityDbFixture('scheduling_capacity_holds');

  async function waitForBlockedBy(blockerPid, message) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await f.admin.raw(
        'SELECT 1 FROM pg_stat_activity WHERE application_name = ? AND ?::int = ANY(pg_blocking_pids(pid))',
        [f.schema, blockerPid],
      );
      if (result.rows.length) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(message);
  }

  async function dispatchToUnassigned(trx, stopId) {
    await lockTechDays(trx, [
      { techId: f.ids.otherTech, date: f.date },
      { techId: null, date: f.date },
    ]);
    return trx('scheduled_services')
      .where({ id: stopId })
      .whereNotIn('status', ['completed', 'cancelled', 'skipped', 'no_show'])
      .whereRaw('technician_id IS NOT DISTINCT FROM ?', [f.ids.otherTech])
      .whereRaw("to_char(scheduled_date, 'YYYY-MM-DD') = ?", [f.date])
      .update({ technician_id: null, route_order: null, updated_at: trx.fn.now() })
      .returning('*');
  }

  test.each([
    ['pest_control', 30, null, '10:30'],
    ['lawn_care', 40, null, '10:40'],
    ['pest_control', 90, 90, '11:30'],
  ])('offer and hold retry retain %s work of %i minutes', async (service, duration, explicitDuration, expectedEnd) => {
    const data = f.estimateData([service]);
    if (explicitDuration) data.result.recurring.services[0].estimatedDurationMinutes = explicitDuration;
    await f.db('estimates').where({ id: f.ids.estimates[0] }).update({ estimate_data: data });
    const offers = await findAvailableSlots({ ...f.PIN, dateFrom: f.date, dateTo: f.date,
      technicianId: f.ids.technician, serviceType: service, durationMinutes: duration, includeWeekends: true, topN: 99 });
    expect(offers.slots.some(slot => slot.start_time === '10:00' && slot.end_time === expectedEnd)).toBe(true);
    expect(offers.slots.some(slot => slot.start_time >= '17:00')).toBe(false);
    const args = { estimateId: f.ids.estimates[0], slotId: f.signedSlot(f.ids.estimates[0], duration) };
    const hold = await reserveSlot(args);
    expect((await reserveSlot(args)).scheduledServiceId).toBe(hold.scheduledServiceId);
    expect(await f.db('scheduled_services').where({ id: hold.scheduledServiceId }).first()).toMatchObject({
      estimated_duration_minutes: duration, window_start: '10:00:00', window_end: `${expectedEnd}:00`, customer_id: null,
    });
  });

  test('a technician disabled after the offer returns a recoverable reservation conflict', async () => {
    await f.db('technicians').where({ id: f.ids.technician }).update({ field_dispatchable: false });
    try {
      await expect(reserveSlot({ estimateId: f.ids.estimates[0], slotId: f.signedSlot(f.ids.estimates[0]) }))
        .rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE', status: 409, reason: 'technician_unavailable' });
      expect(await f.db('scheduled_services')).toHaveLength(0);
    } finally {
      await f.db('technicians').where({ id: f.ids.technician }).update({ field_dispatchable: true });
    }
  });

  test('concurrent customers cannot both consume the final thirty minutes', async () => {
    await f.db('scheduled_services').insert(f.baseStop({ window_start: '08:00', window_end: '16:00',
      estimated_duration_minutes: 480, route_order: 1 }));
    await f.db('tech_schedule_blocks').insert({ id: require('node:crypto').randomUUID(), date: f.date,
      technician_id: f.ids.technician, block_type: 'blocked', start_time: '16:45', end_time: '18:00' });
    const outcomes = await Promise.allSettled(f.ids.estimates.map(estimateId => reserveSlot({
      estimateId, slotId: f.signedSlot(estimateId, 30, '16:00'),
    })));
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await f.db('scheduled_services').whereNotNull('reservation_expires_at')).toHaveLength(1);
  });

  test('invalid signed offers never prepare route traffic', async () => {
    const optimizer = require('../services/route-optimizer');
    const travel = jest.spyOn(optimizer, 'createSchedulingTravel');
    try {
      const good = f.signedSlot(f.ids.estimates[0]);
      const bad = good.slice(0, -1) + (good.endsWith('a') ? 'b' : 'a');
      await expect(reserveSlot({ estimateId: f.ids.estimates[0], slotId: bad }))
        .rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE', reason: 'invalid_offer' });
      expect(travel).not.toHaveBeenCalled();
    } finally { travel.mockRestore(); }
  });

  test('reserve holds selected and unassigned day fences through its outer commit', async () => {
    const stop = f.baseStop({ technician_id: f.ids.otherTech, window_start: '13:00', window_end: '13:30', route_order: 1 });
    await f.db('scheduled_services').insert(stop);
    let releaseReserve;
    const release = new Promise(resolve => { releaseReserve = resolve; });
    let bodyReady;
    const ready = new Promise(resolve => { bodyReady = resolve; });
    let reserve;
    let dispatch;
    f.beforeNextOuterCommit(async trx => {
      const { rows: [{ pid }] } = await trx.raw('SELECT pg_backend_pid()::int AS pid');
      bodyReady({ trx, pid });
      await release;
    });
    try {
      reserve = reserveSlot({ estimateId: f.ids.estimates[0], slotId: f.signedSlot(f.ids.estimates[0]) })
        .then(value => ({ value }), error => ({ error }));
      const { pid } = await Promise.race([ready, reserve.then((outcome) => {
        if (outcome.error) throw outcome.error;
        throw new Error('Reservation committed without reaching the outer-transaction pause');
      })]);
      for (const key of [`${f.ids.technician}:${f.date}`, `unassigned:${f.date}`]) {
        const result = await f.admin.raw(`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = ?::int
          AND locktype = 'advisory' AND granted AND classid = hashtext('slot-reserve')::oid
          AND objid = hashtext(?::text)::oid) AS held`, [pid, key]);
        expect(result.rows[0].held).toBe(true);
      }
      dispatch = f.db.transaction(trx => dispatchToUnassigned(trx, stop.id))
        .then(value => ({ value }), error => ({ error }));
      await waitForBlockedBy(pid, 'Dispatch unassignment never waited for the reservation fence');
      releaseReserve();
      expect((await reserve).value).toMatchObject({ scheduledServiceId: expect.anything() });
      expect((await dispatch).value).toHaveLength(1);
      expect((await f.db('scheduled_services').where({ id: stop.id }).first()).technician_id).toBeNull();
    } finally {
      releaseReserve();
      await Promise.allSettled([reserve, dispatch].filter(Boolean));
    }
  });

  test('dispatch-first unassignment fences reserve before row locks and invalidates its stale slot', async () => {
    const stop = f.baseStop({ technician_id: f.ids.otherTech, window_start: '10:00', window_end: '10:30', route_order: 1 });
    await f.db('scheduled_services').insert(stop);
    const dispatch = await f.db.transaction();
    let reserve;
    try {
      const { rows: [{ pid }] } = await dispatch.raw('SELECT pg_backend_pid()::int AS pid');
      expect(await dispatchToUnassigned(dispatch, stop.id)).toHaveLength(1);
      reserve = reserveSlot({ estimateId: f.ids.estimates[0], slotId: f.signedSlot(f.ids.estimates[0]) })
        .then(value => ({ value }), error => ({ error }));
      await waitForBlockedBy(pid, 'Reservation never waited for the unassigned day fence');

      const rowProbe = await f.db.transaction();
      try {
        await expect(rowProbe('estimates').where({ id: f.ids.estimates[0] }).forUpdate().noWait().first())
          .resolves.toMatchObject({ id: f.ids.estimates[0] });
        await rowProbe.commit();
      } finally { if (!rowProbe.isCompleted()) await rowProbe.rollback(); }

      await dispatch.commit();
      expect((await reserve).error).toMatchObject({ code: 'SLOT_UNAVAILABLE' });
      expect(await f.db('scheduled_services').whereNotNull('reservation_expires_at')).toHaveLength(0);
    } finally {
      if (!dispatch.isCompleted()) await dispatch.rollback();
      if (reserve) await reserve;
    }
  });
});
